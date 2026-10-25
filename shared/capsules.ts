// Vertical capsules: the collision of what's built (walls, posts, the things put up with the wrench), shared by server
// physics and client prediction. The shelters (shared/shelters.ts) collide with theirs in their own frame; the things
// put up on the sand or a shelter's floor (shared/placed.ts setPlaced) are kept here in a grid of cells, in world
// coordinates (collideOutdoor, in sim.ts step()), with their footprints on the sand where it's never dug (overPlaced).
//
// Same determinism rules as shared/scrap.ts: + - * /, Math.sqrt, Math.abs, Math.min/max, Math.floor only.

/**
 * Vertical capsule: segment centre ± half·(ax, az), radius r, spanning heights y0..top. Players entirely below y0 pass
 * under it; low ones can be stood on.
 */
export type Capsule = { x: number; z: number; ax: number; az: number; half: number; r: number; y0: number; top: number };

/** Push p out of a circle at (cx, cz) with radius R; true if it was in it. */
function pushCircle(p: { x: number; z: number; vx: number; vz: number }, cx: number, cz: number, R: number): boolean {
  let ex = p.x - cx, ez = p.z - cz;
  const d = Math.sqrt(ex * ex + ez * ez);
  if (d >= R - 1e-6) return false;
  if (d > 1e-9) { ex /= d; ez /= d; } else { ex = 1; ez = 0; }
  p.x = cx + ex * R;
  p.z = cz + ez * R;
  const vn = p.vx * ex + p.vz * ez;
  if (vn < 0) { p.vx -= vn * ex; p.vz -= vn * ez; }
  return true;
}

/**
 * The lowest point of a ceiling over a band, |a| < A and b0 < b < b1 (an opening, a room), whose height `profile`
 * falls off with |a| (an arch, a vault; or stays level), where a footprint (a disc of radius r round (a, b)) reaches
 * under it; Infinity where it doesn't. Exact: the disc's widest chord inside the band is the one nearest its centre.
 */
export function bandUnder(a: number, b: number, r: number, A: number, b0: number, b1: number, profile: (a: number) => number): number {
  const db = b < b0 ? b0 - b : b > b1 ? b - b1 : 0;
  if (db >= r) return Infinity;
  const h = Math.sqrt(r * r - db * db), aa = Math.abs(a);
  if (aa - h >= A) return Infinity;
  return profile(Math.min(aa + h, A));
}

/**
 * Arches, vaults and steps down in a ceiling are ceilings over a player's whole footprint, not walls: undo the move of
 * q from (px, pz) along each axis that would put the head into one (`blocked`), unless it was there already (then let
 * it out; the ceiling pushes it down). True if it moved q: collide it with the walls again, the axis put back was never
 * pushed out of them.
 */
export function keepUnder(q: { x: number; z: number; vx: number; vz: number }, px: number, pz: number, blocked: (x: number, z: number) => boolean): boolean {
  if (!blocked(q.x, q.z) || blocked(px, pz)) return false;
  if (!blocked(q.x, pz)) { q.z = pz; q.vz = 0; }
  else if (!blocked(px, q.z)) { q.x = px; q.vx = 0; }
  else { q.x = px; q.z = pz; q.vx = 0; q.vz = 0; }
  return true;
}

/** Passes over the capsules at most: in an inside corner one wall's push can put q back into the one before. */
const PUSH_PASSES = 4;

/** Push point q out of capsules (feet/head in the capsules' frame); returns the highest top under the feet, from
 *  `support` up. */
export function collideCapsules(q: { x: number; z: number; vx: number; vz: number }, caps: Capsule[], feet: number, head: number, radius: number,
  stepUp: number, support: number): number {
  for (let pass = 0, pushed = true; pushed && pass < PUSH_PASSES; pass++) {
    pushed = false;
    for (const c of caps) {
      const reach = c.half + c.r + radius;
      if (Math.abs(q.x - c.x) > reach || Math.abs(q.z - c.z) > reach) continue;
      if (head <= c.y0) continue;
      let t = (q.x - c.x) * c.ax + (q.z - c.z) * c.az;
      t = t < -c.half ? -c.half : t > c.half ? c.half : t;
      const cx = c.x + c.ax * t, cz = c.z + c.az * t;
      if (feet >= c.top - stepUp) {
        const ex = q.x - cx, ez = q.z - cz;
        if (ex * ex + ez * ez < c.r * c.r && c.top > support) support = c.top;
        continue;
      }
      if (pushCircle(q, cx, cz, c.r + radius)) pushed = true;
    }
  }
  return support;
}

/** Things players put up on the sand or a shelter's floor (world coordinates), in a grid of OUT_CELL squares: each
 *  capsule is in every cell its reach (plus OUT_MARGIN, more than any player's or bike's radius) touches, so a player
 *  only looks in the one cell they are in, however many things the world has. Their footprints on the sand (world
 *  [x0, z0, x1, z1]), where it is never dug (overPlaced). */
let outdoor = new Map<number, Capsule[]>();
let outdoorSpots: number[][] = [];
const OUT_CELL = 16;
const OUT_MARGIN = 1;
const outKey = (ix: number, iz: number) => ix * 65536 + iz;

/** The placed things' capsules (world) and their footprints on the sand (shared/placed.ts setPlaced). */
export function setPlacedCapsules(out: Capsule[], spots: number[][] = []) {
  outdoor = new Map();
  for (const c of out) {
    const reach = c.half + c.r + OUT_MARGIN;
    for (let iz = Math.floor((c.z - reach) / OUT_CELL); iz <= Math.floor((c.z + reach) / OUT_CELL); iz++) {
      for (let ix = Math.floor((c.x - reach) / OUT_CELL); ix <= Math.floor((c.x + reach) / OUT_CELL); ix++) {
        const k = outKey(ix, iz);
        const list = outdoor.get(k);
        if (list) list.push(c);
        else outdoor.set(k, [c]);
      }
    }
  }
  outdoorSpots = spots;
}

/** True over something put up on the sand (shared/placed.ts) + margin: no digging, it would undermine it. */
export function overPlaced(x: number, z: number, margin = 0): boolean {
  for (const r of outdoorSpots) if (x > r[0] - margin && x < r[2] + margin && z > r[1] - margin && z < r[3] + margin) return true;
  return false;
}

const local = { x: 0, z: 0, vx: 0, vz: 0 };

/** Collide a player (world position p, moved in place, velocity absorbed) with the things put up on the sand or a
 *  shelter's floor, only with what is in their grid cell. `y`/`prevY` are the feet heights this and last tick. Returns
 *  the height of what they stand on, or -Infinity. */
export function collideOutdoor(p: { x: number; z: number; vx: number; vz: number }, y: number, prevY: number, radius: number, height: number, stepUp: number): number {
  if (!outdoor.size) return -Infinity;
  const caps = outdoor.get(outKey(Math.floor(p.x / OUT_CELL), Math.floor(p.z / OUT_CELL)));
  if (!caps) return -Infinity;
  const q = local;
  q.x = p.x; q.z = p.z; q.vx = p.vx; q.vz = p.vz;
  const support = collideCapsules(q, caps, Math.max(y, prevY), Math.min(y, prevY) + height, radius, stepUp, -Infinity);
  p.x = q.x;
  p.z = q.z;
  p.vx = q.vx;
  p.vz = q.vz;
  return support;
}
