// The players' home base: an underground bunker under a flat pad in a dune pan. On the surface there is
// only a small entrance hut; inside its door a staircase goes straight down, then a short hallway leads
// into the main room, lit from above by a skylight, with a hand water pump in the middle.
// Shared by server physics and client prediction (collideBase() in sim.ts step()), the terrain (the pad
// in baseHeight, no digging over the bunker, holes cut in the sand) and the renderer (src/world/base.ts
// places the models from tools/blender/base/bunker.py with this layout).
//
// The terrain heightfield stays where it is, above the bunker: it is the bunker's roof. Down there the
// sand is not the ground (terrainHidden()), the bunker floors are; walls and ceilings only count for
// players at their height, so the surface over the bunker walks as normal.
//
// Same determinism rules as shared/scrap.ts: + - * /, Math.sqrt, Math.abs, Math.min/max only.
//
// Local frame: origin = the entrance's floor at its doorway centre line, axes = world axes (the base is
// not rotated). The door faces +Z, the bunker runs down -Z. Dimensions match tools/blender/base/bunker.py.

import { duneHeight, WORLD_SEED } from './dunes.ts';

/**
 * Where the base goes for a seed: the flattest spot of the dunes (least height range over the pad) within
 * 600 m of the origin, on a 16 m grid, with a slight pull towards the origin; its floor at the mean height
 * there, so the pad barely cuts or fills. Same pure arithmetic as baseHeight(), so client and server agree.
 */
function findBase(seed: number) {
  let best = { x: 0, z: 0, y: 0 }, bestScore = Infinity;
  for (let gz = -600; gz <= 600; gz += 16) {
    for (let gx = -600; gx <= 600; gx += 16) {
      const d = Math.sqrt(gx * gx + gz * gz);
      if (d > 600) continue;
      let lo = Infinity, hi = -Infinity, sum = 0, n = 0;
      for (let lz = -40; lz <= 20; lz += 10) {
        for (let lx = -20; lx <= 20; lx += 10) {
          const h = duneHeight(gx + lx, gz + lz, seed);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
          sum += h;
          n++;
        }
      }
      const score = hi - lo + d * 0.004;
      if (score < bestScore) {
        bestScore = score;
        best = { x: gx, z: gz, y: Math.round((sum / n) * 100) / 100 };
      }
    }
  }
  return best;
}

/** The base origin in world coordinates (the entrance hut's floor), picked from the world seed. */
export const BASE = findBase(WORLD_SEED);
/** Where new players appear: in front of the door, looking at it (yaw 0 looks down -Z). */
export const BASE_SPAWN = { x: BASE.x, z: BASE.z + 9 };

/** Wall thickness everywhere. */
export const WT = 0.3;
/** Half inner width of the entrance, the stairs and the hallway. */
export const W = 1.1;
/** Entrance hut, inner: from the back wall to the door, ceiling height, door half width; its thick walls
 *  (t) and outer height (top): a squat concrete block like a WW2 bunker. */
export const HUT = { z0: -4.0, z1: 2.0, h: 2.3, door: 0.7, t: 0.6, top: 2.75 };
/** Stairs: top edge (the landing ends here), steps (rise, run), bottom = the bunker floor. */
export const STAIRS = { z: 0.6, n: 32, rise: 0.25, run: 0.3 };
/** Bunker floor height (local). */
export const FLOOR = -STAIRS.n * STAIRS.rise;
/** Hallway ends here, where the room begins; its vault's crown above the floor. */
export const HALL = { z: -12, h: 3.3 };
/** Main room, inner: half width, far wall, ceiling height above the floor. */
export const ROOM = { w: 8, z: -28, h: 6 };
/** The room's centre: the pump stands here, under the skylight. */
export const ROOM_Z = (HALL.z + ROOM.z) / 2;
/** Skylight shaft: half width of the opening, collar half width (outer) and height above the pad. */
export const SKY = { w: 1.4, collar: 1.8, h: 0.5 };
/** Outer corner radii of the entrance hut and the skylight collar (rounded like a poured bunker). */
const HUT_R = 0.8, SKY_R = 0.6;
/** The main room's corners are rounded inside with this radius. */
export const ROOM_R = 1.5;
/** The stairs and the hallway are vaulted: walls up to the springing line, then a half circle of radius W.
 *  `headroom` is the crown above the stair line; `k` softens the bends where the slope meets the hallway. */
const VAULT = { headroom: 3.3, k: 1.5 };
/** Underground walls end just under the sand. */
const BURIED_TOP = -0.3;

/** Height of the stairs (a ramp half a step under the nosings) at local z, clamped to the landing/floor. */
export function stairY(lz: number): number {
  const y = -(STAIRS.z - lz) * (STAIRS.rise / STAIRS.run) - STAIRS.rise / 2;
  return lz >= STAIRS.z ? 0 : Math.max(FLOOR, Math.min(0, y));
}

/** Smooth max: max(a, b), rounded off where they are within k of each other. */
function smax(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k / 4;
}

/** Height (local) of the vault's crown over the stairs and the hallway at local z. */
export function vaultCrown(lz: number): number {
  const line = -(STAIRS.z - lz) * (STAIRS.rise / STAIRS.run) - STAIRS.rise / 2 + VAULT.headroom;
  return smax(line, FLOOR + HALL.h, VAULT.k);
}

/** The vault's underside at |x| = ax under a crown at height c. */
function vaultAt(ax: number, c: number): number {
  return c - W + Math.sqrt(Math.max(0, W * W - ax * ax));
}

/** The pad around the base is this flat, then blends back into the dunes (shared/terrain.ts). */
const PAD = { x0: -14, x1: 14, z0: -34, z1: 14, blend: 24 };
/** The pad's sand lies just under the entrance floor so they don't z-fight. */
const PAD_Y = BASE.y - 0.06;

/** Blend weight of the dunes at world (x, z): 0 on the pad, 1 away from it. */
export function padBlend(x: number, z: number): number {
  const lx = x - BASE.x, lz = z - BASE.z;
  const dx = Math.max(PAD.x0 - lx, 0, lx - PAD.x1);
  const dz = Math.max(PAD.z0 - lz, 0, lz - PAD.z1);
  if (dx === 0 && dz === 0) return 0;
  const t = Math.sqrt(dx * dx + dz * dz) / PAD.blend;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/** Terrain height with the pad: dunes `h` flattened towards the floor around the base. */
export function withPad(x: number, z: number, h: number): number {
  const w = padBlend(x, z);
  return w === 1 ? h : PAD_Y + (h - PAD_Y) * w;
}

/** Local point inside the bunker's footprint (entrance, tunnel, hallway, room, walls included) + margin. */
function inFootprint(lx: number, lz: number, m: number): boolean {
  if (Math.abs(lx) < W + HUT.t + m && lz > HALL.z - WT - m && lz < HUT.z1 + HUT.t + m) return true;
  return Math.abs(lx) < ROOM.w + WT + m && lz > ROOM.z - WT - m && lz < HALL.z + WT + m;
}

/** True over the bunker's footprint + margin (no digging: it would cut into the rooms). */
export function overBase(x: number, z: number, margin = 0): boolean {
  return inFootprint(x - BASE.x, z - BASE.z, margin);
}

/** True where a building stands on the surface (the entrance hut, the skylight's collar) + margin. */
export function insideBase(x: number, z: number, margin = 0): boolean {
  const lx = x - BASE.x, lz = z - BASE.z;
  if (Math.abs(lx) < W + HUT.t + margin && lz > HUT.z0 - HUT.t - margin && lz < HUT.z1 + HUT.t + margin) return true;
  return Math.abs(lx) < SKY.collar + margin && Math.abs(lz - ROOM_Z) < SKY.collar + margin;
}

/**
 * True for someone whose feet are at world `y` inside the base (+ margin): in or at the entrance hut, or
 * anywhere down in the bunker. Not on the sand over it.
 */
export function inBase(x: number, y: number, z: number, margin = 0): boolean {
  const lx = x - BASE.x, lz = z - BASE.z, ly = y - BASE.y;
  if (Math.abs(lx) < W + HUT.t + margin && lz > HUT.z0 - HUT.t - margin && lz < HUT.z1 + HUT.t + margin) return ly < HUT.h;
  return ly < BURIED_TOP && inFootprint(lx, lz, margin);
}

/** Holes cut in the terrain's surface (world x0, z0, x1, z1): the hut's floor and the skylight shaft. */
export const TERRAIN_HOLES: [number, number, number, number][] = [
  [BASE.x - W - WT / 2, BASE.z + HUT.z0 - WT / 2, BASE.x + W + WT / 2, BASE.z + HUT.z1 + WT / 2],
  [BASE.x - SKY.w - 0.2, BASE.z + ROOM_Z - SKY.w - 0.2, BASE.x + SKY.w + 0.2, BASE.z + ROOM_Z + SKY.w + 0.2],
];

/**
 * True where the sand is not the ground for someone whose feet were at `y` (world) last tick: inside the
 * entrance (its sand is cut away) and down in the bunker.
 */
export function terrainHidden(x: number, z: number, y: number): boolean {
  const lx = x - BASE.x, lz = z - BASE.z;
  if (Math.abs(lx) < W + WT / 2 && lz > HUT.z0 - WT / 2 && lz < HUT.z1 + WT / 2) return true;
  return y - BASE.y < BURIED_TOP && inFootprint(lx, lz, 0);
}

/**
 * A placed model: node name in its glb, position (local), facing (fx, fz): the model's front (+Z)
 * turns towards it. `y` lifts it. Things that block get a capsule hitbox: half extents (hx, hz) of their
 * footprint (before turning) and height h above `y`.
 */
export type BasePiece = { glb: string; node: string; x: number; z: number; fx: number; fz: number; y?: number; hx?: number; hz?: number; h?: number };

export const BASE_PIECES: BasePiece[] = [
  { glb: 'bunker', node: 'pump', x: 0, z: ROOM_Z, fx: 0, fz: 1, y: FLOOR, hx: 0.35, hz: 0.35, h: 1.2 },
  // Against the side walls, facing into the room (shared/stations.ts makes them interactable).
  { glb: 'bunker', node: 'workbench', x: -ROOM.w + 0.42, z: ROOM_Z, fx: 1, fz: 0, y: FLOOR, hx: 1.0, hz: 0.4, h: 0.95 },
  { glb: 'bunker', node: 'disassembly', x: ROOM.w - 0.47, z: ROOM_Z, fx: -1, fz: 0, y: FLOOR, hx: 0.8, hz: 0.45, h: 0.92 },
  // Storage chest against the back wall (shared/storage.ts).
  { glb: 'bunker', node: 'chest', x: 0, z: ROOM.z + 0.5, fx: 0, fz: 1, y: FLOOR, hx: 0.62, hz: 0.37, h: 0.62 },
];
const PUMP = BASE_PIECES[0];

/** The canteen fills only at the pump: feet within this (m, horizontally) of it, down on the bunker floor. */
export const PUMP_REACH = 1.6;

/** True for someone whose feet are at world (x, y, z) at the pump (+ margin), not on the skylight above it. */
export function atPump(x: number, y: number, z: number, margin = 0): boolean {
  const dx = x - BASE.x - PUMP.x, dz = z - BASE.z - PUMP.z, r = PUMP_REACH + margin;
  return y - BASE.y < FLOOR + 1 + margin && dx * dx + dz * dz < r * r;
}

/**
 * Vertical capsule in local coordinates: segment centre ± half·(ax, az), radius r, spanning heights
 * y0..top (local). Players entirely below y0 pass under it; low ones can be stood on.
 */
export type Capsule = { x: number; z: number; ax: number; az: number; half: number; r: number; y0: number; top: number };
/** Walls are taller than any jump. */
const WALL_H = 100;

const capsules: Capsule[] = [];
/** Wall of thickness 2r along its centre line from (x0, z0) to (x1, z1). */
function wall(x0: number, z0: number, x1: number, z1: number, y0: number, top: number, r = WT / 2) {
  const dx = x1 - x0, dz = z1 - z0, len = Math.sqrt(dx * dx + dz * dz);
  capsules.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, ax: dx / len, az: dz / len, half: len / 2, r, y0, top });
}
/** Unit quarter circle in three segments (0°, 30°, 60°, 90°), without trig. */
const QUARTER = [[1, 0], [Math.sqrt(3) / 2, 0.5], [0.5, Math.sqrt(3) / 2], [0, 1]];
/** Rounded corner of a wall ring: its centre line is a quarter circle of radius rc around (cx, cz), towards (sx, sz). */
function arc(cx: number, cz: number, rc: number, sx: number, sz: number, y0: number, top: number, r = WT / 2) {
  for (let i = 0; i < 3; i++) {
    const [a, b] = QUARTER[i], [c, d] = QUARTER[i + 1];
    wall(cx + sx * rc * a, cz + sz * rc * b, cx + sx * rc * c, cz + sz * rc * d, y0, top, r);
  }
}
{
  const xs = W + WT / 2, back = HUT.z0 - WT / 2;
  // Entrance hut: thick walls (their inner faces are the stairwell's too, all the way down), the doorway
  // in front, and the back wall stops over the tunnel's vault. Its outer corners are rounded.
  const r = HUT.t / 2, xh = W + r, fh = HUT.z1 + r, bh = HUT.z0 - r;
  const cx = W + HUT.t - HUT_R, rc = HUT_R - r;
  const cf = HUT.z1 + HUT.t - HUT_R, cb = HUT.z0 - HUT.t + HUT_R;
  wall(-xh, cb, -xh, cf, -Infinity, WALL_H, r);
  wall(xh, cb, xh, cf, -Infinity, WALL_H, r);
  wall(-cx, fh, -HUT.door - r, fh, -Infinity, WALL_H, r);
  wall(HUT.door + r, fh, cx, fh, -Infinity, WALL_H, r);
  wall(-cx, bh, cx, bh, vaultCrown(HUT.z0), WALL_H, r);
  for (const s of [-1, 1]) {
    arc(s * cx, cf, rc, s, 1, -Infinity, WALL_H, r);
    arc(s * cx, cb, rc, s, -1, -Infinity, WALL_H, r);
  }
  // Tunnel and hallway under the sand, into the room's front wall.
  const hz = HALL.z + WT / 2, rx = ROOM.w + WT / 2, rz = ROOM.z - WT / 2;
  wall(-xs, back, -xs, hz, -Infinity, BURIED_TOP);
  wall(xs, back, xs, hz, -Infinity, BURIED_TOP);
  // Main room, opening onto the hallway, its corners rounded.
  const ex = ROOM.w - ROOM_R, ef = HALL.z - ROOM_R, eb = ROOM.z + ROOM_R, rr = ROOM_R + WT / 2;
  wall(-ex, hz, -xs, hz, -Infinity, BURIED_TOP);
  wall(xs, hz, ex, hz, -Infinity, BURIED_TOP);
  wall(-ex, rz, ex, rz, -Infinity, BURIED_TOP);
  wall(-rx, ef, -rx, eb, -Infinity, BURIED_TOP);
  wall(rx, ef, rx, eb, -Infinity, BURIED_TOP);
  for (const s of [-1, 1]) {
    arc(s * ex, ef, rr, s, 1, -Infinity, BURIED_TOP);
    arc(s * ex, eb, rr, s, -1, -Infinity, BURIED_TOP);
  }
  // Skylight collar on the surface (its glass is a floor, below), outer corners rounded.
  const c = (SKY.collar + SKY.w) / 2, cr = (SKY.collar - SKY.w) / 2, k = SKY.collar - SKY_R;
  wall(-k, ROOM_Z - c, k, ROOM_Z - c, ROOM.h + FLOOR, SKY.h, cr);
  wall(-k, ROOM_Z + c, k, ROOM_Z + c, ROOM.h + FLOOR, SKY.h, cr);
  wall(-c, ROOM_Z - k, -c, ROOM_Z + k, ROOM.h + FLOOR, SKY.h, cr);
  wall(c, ROOM_Z - k, c, ROOM_Z + k, ROOM.h + FLOOR, SKY.h, cr);
  for (const s of [-1, 1]) {
    for (const t of [-1, 1]) arc(s * k, ROOM_Z + t * k, SKY_R - cr, s, t, ROOM.h + FLOOR, SKY.h, cr);
  }
}
for (const p of BASE_PIECES) {
  if (!p.hx || !p.hz || !p.h) continue;
  const fl = Math.sqrt(p.fx * p.fx + p.fz * p.fz), fx = p.fx / fl, fz = p.fz / fl;
  // Local +X turns to (fz, -fx), +Z to (fx, fz). The capsule runs along the longer side.
  const alongX = p.hx >= p.hz;
  const r = alongX ? p.hz : p.hx, half = (alongX ? p.hx : p.hz) - r;
  const y0 = p.y ?? 0;
  capsules.push({ x: p.x, z: p.z, ax: alongX ? fz : fx, az: alongX ? -fx : fz, half, r, y0, top: y0 + p.h });
}

/** Things players placed on the floor (shared/placed.ts setPlaced keeps these in step with its list). */
let withPlaced: Capsule[] = capsules;
export function setPlacedCapsules(caps: Capsule[]) {
  withPlaced = capsules.concat(caps);
}

/** Floor height at local (lx, lz) — landing, stairs, bunker floor, skylight glass — or -Infinity. */
function floorAt(lx: number, lz: number, feet: number, stepUp: number): number {
  let best = -Infinity;
  const ax = Math.abs(lx);
  if (ax < W + WT && lz > HALL.z - WT && lz < HUT.z1 + WT) best = stairY(lz);
  else if (ax < ROOM.w + WT && lz > ROOM.z - WT && lz < HALL.z + WT) best = FLOOR;
  // Walk on the skylight's glass, but don't get lifted onto it from below.
  if (ax < SKY.collar && Math.abs(lz - ROOM_Z) < SKY.collar && feet >= SKY.h - 0.05 - stepUp) best = SKY.h - 0.05;
  return best;
}

/** Push p out of a circle at local (cx, cz) with radius R. */
function pushCircle(p: { x: number; z: number; vx: number; vz: number }, cx: number, cz: number, R: number) {
  let ex = p.x - cx, ez = p.z - cz;
  const d = Math.sqrt(ex * ex + ez * ez);
  if (d >= R) return;
  if (d > 1e-9) { ex /= d; ez /= d; } else { ex = 1; ez = 0; }
  p.x = cx + ex * R;
  p.z = cz + ez * R;
  const vn = p.vx * ex + p.vz * ez;
  if (vn < 0) { p.vx -= vn * ex; p.vz -= vn * ez; }
}

const local = { x: 0, z: 0, vx: 0, vz: 0 };

/**
 * Collide a player (world position p, moved in place, velocity absorbed into walls) with the base.
 * `y`/`prevY` are the feet heights (world) this and last tick. Returns the height (world) of what the
 * player stands on (floor, stairs, something low), or -Infinity outside the base.
 */
export function collideBase(p: { x: number; z: number; vx: number; vz: number }, y: number, prevY: number, radius: number, height: number, stepUp: number): number {
  const lx0 = p.x - BASE.x, lz0 = p.z - BASE.z;
  if (!inFootprint(lx0, lz0, 1)) return -Infinity;
  const q = local;
  q.x = lx0; q.z = lz0; q.vx = p.vx; q.vz = p.vz;

  const feet = Math.max(y, prevY) - BASE.y;
  const head = Math.min(y, prevY) - BASE.y + height;
  let support = floorAt(q.x, q.z, feet, stepUp);
  for (const c of withPlaced) {
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
    pushCircle(q, cx, cz, c.r + radius);
  }

  p.x = q.x + BASE.x;
  p.z = q.z + BASE.z;
  p.vx = q.vx;
  p.vz = q.vz;
  return support === -Infinity ? support : support + BASE.y;
}

/** Ceiling (local) over local (lx, lz), or Infinity. */
function ceilingAt(lx: number, lz: number): number {
  const ax = Math.abs(lx);
  if (ax < W + WT && lz >= HUT.z0 && lz < HUT.z1 + WT) return HUT.h;
  if (ax < W + WT && lz > HALL.z && lz < HUT.z0) return vaultAt(ax, vaultCrown(lz));
  if (ax < ROOM.w + WT && lz > ROOM.z - WT && lz <= HALL.z) {
    return ax < SKY.w && Math.abs(lz - ROOM_Z) < SKY.w ? SKY.h - 0.1 : FLOOR + ROOM.h;
  }
  return Infinity;
}

/**
 * Highest the feet may go at world (x, z) for a player of this height whose feet were at `prevY` last
 * tick, or Infinity. Only ceilings the player is under count, not those of the rooms below them.
 */
export function baseCeiling(x: number, z: number, prevY: number, height: number): number {
  const c = ceilingAt(x - BASE.x, z - BASE.z);
  return prevY - BASE.y + height <= c + 0.05 ? c + BASE.y - height : Infinity;
}
