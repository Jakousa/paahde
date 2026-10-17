// The players' home base: a domed hall with a glass greenhouse wing, on a flat pad in a dune pan.
// Shared by server physics and client prediction (collideBase() in sim.ts step()), the terrain (the pad
// in baseHeight, no digging under the floor) and the renderer (src/world/base.ts places the models
// from tools/blender/base/ with this layout).
//
// Same determinism rules as shared/scrap.ts: + - * /, Math.sqrt, Math.abs, Math.min/max only; facing
// directions are plain vectors, the renderer turns them into angles.
//
// Local frame: origin = hall centre on the floor, axes = world axes (the base is not rotated). The front
// door faces +Z, the greenhouse runs along -X. Dimensions match tools/blender/base/shell.py.

/** Hall centre in world coordinates, and the floor height. */
export const BASE = { x: -28, z: 120, y: 9.8 };
/** Where new players appear: in front of the door, looking at it (yaw 0 looks down -Z). */
export const BASE_SPAWN = { x: BASE.x, z: BASE.z + 16 };

/** Hall wall: inner radius, thickness. */
export const HALL_R = 7.0;
const HALL_T = 0.6;
const HALL_MID = HALL_R + HALL_T / 2;
const HALL_HALF_T = HALL_T / 2;
/** Greenhouse footprint (outer). */
const GH = { x0: -21, x1: -6.9, z: 4 };
const GH_T = 0.3;

/** Floor surface (y = BASE.y) covers the hall, the greenhouse and the porch slab. */
function onFloor(lx: number, lz: number): boolean {
  if (lx * lx + lz * lz < HALL_MID * HALL_MID) return true;
  if (lx > GH.x0 && lx < GH.x1 + 1 && Math.abs(lz) < GH.z) return true;
  return lz > 0 && lz < 9 && Math.abs(lx) < 1.6;
}

/** The pad around the base is this flat, then blends back into the dunes (shared/terrain.ts). */
const PAD = { x0: -25, x1: 18, z0: -14, z1: 20, blend: 24 };
/** The pad's sand lies just under the floor so they don't z-fight. */
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

/** True where the ground is covered by the building (no digging, no blown sand): footprint + margin. */
export function insideBase(x: number, z: number, margin = 0): boolean {
  const lx = x - BASE.x, lz = z - BASE.z;
  const r = HALL_R + HALL_T + margin;
  if (lx * lx + lz * lz < r * r) return true;
  return lx > GH.x0 - margin && lx < GH.x1 && Math.abs(lz) < GH.z + margin;
}

/**
 * A placed model: node name in its glb, position (local), facing (fx, fz): the model's front (+Z)
 * turns towards it. `y` lifts it (hanging lamps). Furniture that blocks gets a capsule hitbox:
 * half extents (hx, hz) of its footprint (before turning) and height h; low things are walked over.
 */
export type BasePiece = { glb: string; node: string; x: number; z: number; fx: number; fz: number; y?: number; hx?: number; hz?: number; h?: number };

/** Face the hall centre from (x, z). */
function inward(glb: string, node: string, x: number, z: number, hx?: number, hz?: number, h?: number): BasePiece {
  return { glb, node, x, z, fx: -x, fz: -z, hx, hz, h };
}

export const BASE_PIECES: BasePiece[] = [
  // Hall: workshop along the back wall, living space around the rug, bunk and chest by the door.
  { glb: 'hall', node: 'rug', x: 0, z: 0, fx: 0, fz: 1 },
  { glb: 'hall', node: 'table', x: 0, z: 0, fx: 0, fz: 1, hx: 0.75, hz: 0.75, h: 0.8 },
  { glb: 'hall', node: 'chandelier', x: 0, z: 0, fx: 0, fz: 1, y: 7.15 },
  { glb: 'hall', node: 'workbench', x: 0, z: -6.35, fx: 0, fz: 1, hx: 1.1, hz: 0.45, h: 0.95 },
  inward('hall', 'shelf', 4.02, -5.36, 0.8, 0.25, 2.4),
  inward('hall', 'radio', -3.99, -5.32, 0.6, 0.3, 1.4),
  inward('hall', 'stove', 5.35, -1.7, 0.45, 0.45, 1.6),
  inward('hall', 'bunk', 5.12, 3.84, 1.05, 0.5, 1.9),
  inward('hall', 'chest', -5.28, 3.96, 0.5, 0.3, 0.6),

  // Greenhouse: planter rows either side of the central path, work corner by the hall, seeds at the far end.
  { glb: 'greenhouse', node: 'planter_grown', x: -10.6, z: -2.6, fx: 0, fz: 1, hx: 1.2, hz: 0.5, h: 0.7 },
  { glb: 'greenhouse', node: 'planter_sprouts', x: -13.6, z: -2.6, fx: 0, fz: 1, hx: 1.2, hz: 0.5, h: 0.7 },
  { glb: 'greenhouse', node: 'planter_empty', x: -16.6, z: -2.6, fx: 0, fz: 1, hx: 1.2, hz: 0.5, h: 0.7 },
  { glb: 'greenhouse', node: 'planter_sprouts', x: -10.6, z: 2.6, fx: 0, fz: -1, hx: 1.2, hz: 0.5, h: 0.7 },
  { glb: 'greenhouse', node: 'planter_empty', x: -13.6, z: 2.6, fx: 0, fz: -1, hx: 1.2, hz: 0.5, h: 0.7 },
  { glb: 'greenhouse', node: 'planter_grown', x: -16.6, z: 2.6, fx: 0, fz: -1, hx: 1.2, hz: 0.5, h: 0.7 },
  { glb: 'greenhouse', node: 'cistern', x: -8.4, z: -2.9, fx: 0, fz: 1, hx: 0.6, hz: 0.5, h: 1.2 },
  { glb: 'greenhouse', node: 'potting_bench', x: -8.4, z: 3.3, fx: 0, fz: -1, hx: 0.9, hz: 0.35, h: 0.9 },
  { glb: 'greenhouse', node: 'seed_cabinet', x: -20.45, z: 2.7, fx: 1, fz: 0, hx: 0.6, hz: 0.25, h: 1.8 },
  { glb: 'greenhouse', node: 'tree_pot', x: -18.6, z: 2.6, fx: 1, fz: 0, hx: 0.45, hz: 0.45, h: 0.9 },
  { glb: 'greenhouse', node: 'vine_trellis', x: -20.5, z: -2.6, fx: 1, fz: 0, hx: 1.0, hz: 0.2, h: 2.6 },
  { glb: 'greenhouse', node: 'pot_cluster', x: -19.0, z: -2.9, fx: 1, fz: 0, hx: 0.6, hz: 0.6, h: 0.5 },
  ...[-10.6, -13.6, -16.6].flatMap((x): BasePiece[] => [
    { glb: 'greenhouse', node: 'grow_lamp', x, z: -2.2, fx: 0, fz: 1, y: 4.8 },
    { glb: 'greenhouse', node: 'grow_lamp', x, z: 2.2, fx: 0, fz: 1, y: 4.8 },
  ]),

  // Outside: water works on the east side, a wind pump behind, sprouting frames along the greenhouse,
  // a wind-break fence on the back.
  { glb: 'exterior', node: 'condenser', x: 12, z: -3, fx: -1, fz: 0, hx: 1.0, hz: 1.0, h: 7 },
  { glb: 'exterior', node: 'tank', x: 11.5, z: 3.5, fx: -1, fz: 0, hx: 1.2, hz: 1.2, h: 3 },
  { glb: 'exterior', node: 'pipe_run', x: 11.75, z: 0.25, fx: 1, fz: 0, hx: 2, hz: 0.1, h: 0.5 },
  { glb: 'exterior', node: 'windpump', x: 12, z: -11, fx: 0, fz: 1, hx: 1.1, hz: 1.1, h: 8 },
  { glb: 'exterior', node: 'solar_still', x: -11, z: 6, fx: 0, fz: 1, hx: 1, hz: 0.5, h: 0.6 },
  { glb: 'exterior', node: 'solar_still', x: -14, z: 6, fx: 0, fz: 1, hx: 1, hz: 0.5, h: 0.6 },
  { glb: 'exterior', node: 'solar_still', x: -17, z: 6, fx: 0, fz: 1, hx: 1, hz: 0.5, h: 0.6 },
  { glb: 'exterior', node: 'signpost', x: 3.4, z: 11.5, fx: 0, fz: 1, hx: 0.15, hz: 0.15, h: 2.6 },
  ...[-19.5, -16.5, -13.5, -10.5, -4.5, -1.5, 1.5, 4.5].map((x): BasePiece => (
    { glb: 'exterior', node: 'fence', x, z: -11, fx: 0, fz: 1, hx: 1.5, hz: 0.08, h: 1.6 }
  )),
];

/** Vertical capsule in local coordinates: segment centre ± half·(ax, az), radius r, top h above the floor. */
type Capsule = { x: number; z: number; ax: number; az: number; half: number; r: number; h: number };
/** Walls are taller than any jump. */
const WALL_H = 100;

const capsules: Capsule[] = [];
// Greenhouse walls (glass above a knee wall): two sides running into the hall wall, the far end
// with the rear door (2 m).
{
  const zc = GH.z - GH_T / 2, xe = GH.x0 + GH_T / 2, r = GH_T / 2, xs = -6.4;
  const seg = (x0: number, z0: number, x1: number, z1: number) => {
    const dx = x1 - x0, dz = z1 - z0, len = Math.sqrt(dx * dx + dz * dz);
    capsules.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, ax: dx / len, az: dz / len, half: len / 2, r, h: WALL_H });
  };
  seg(xe, -zc, xs, -zc);
  seg(xe, zc, xs, zc);
  seg(xe, -zc, xe, -1.0 - r);
  seg(xe, 1.0 + r, xe, zc);
}
for (const p of BASE_PIECES) {
  if (!p.hx || !p.hz || !p.h) continue;
  const fl = Math.sqrt(p.fx * p.fx + p.fz * p.fz), fx = p.fx / fl, fz = p.fz / fl;
  // Local +X turns to (fz, -fx), +Z to (fx, fz). The capsule runs along the longer side.
  const alongX = p.hx >= p.hz;
  const r = alongX ? p.hz : p.hx, half = (alongX ? p.hx : p.hz) - r;
  capsules.push({ x: p.x, z: p.z, ax: alongX ? fz : fx, az: alongX ? -fx : fz, half, r, h: p.h });
}

/**
 * Hall wall openings: wall arcs end where the lateral coordinate (x for the front door, z for the
 * greenhouse) reaches `edge` on the wall's centre circle, with a round cap of radius HALL_HALF_T.
 * axis = which side of the hall: +Z (front door) or -X (greenhouse).
 */
const OPENINGS = [
  { side: 'z+' as const, edge: 1.2 + HALL_HALF_T },
  { side: 'x-' as const, edge: 1.5 + HALL_HALF_T },
];
/** End points of the wall arcs, on the wall's centre circle (local). */
const JAMBS: [number, number][] = [];
for (const o of OPENINGS) {
  const along = Math.sqrt(HALL_MID * HALL_MID - o.edge * o.edge);
  if (o.side === 'z+') JAMBS.push([-o.edge, along], [o.edge, along]);
  else JAMBS.push([-along, -o.edge], [-along, o.edge]);
}

function inOpening(qx: number, qz: number): boolean {
  for (const o of OPENINGS) {
    if (o.side === 'z+' && qz > 0 && Math.abs(qx) < o.edge) return true;
    if (o.side === 'x-' && qx < 0 && Math.abs(qz) < o.edge) return true;
  }
  return false;
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
 * `y`/`prevY` are the feet heights this and last tick. Returns the height of what the player stands on
 * (floor or furniture top), or -Infinity outside the base.
 */
export function collideBase(p: { x: number; z: number; vx: number; vz: number }, y: number, prevY: number, radius: number, stepUp: number): number {
  const lx0 = p.x - BASE.x, lz0 = p.z - BASE.z;
  // Everything is within ~25 m of the hall centre.
  if (lx0 < -30 || lx0 > 25 || lz0 < -20 || lz0 > 20) return -Infinity;
  const q = local;
  q.x = lx0; q.z = lz0; q.vx = p.vx; q.vz = p.vz;

  // Hall wall: an annulus with two openings.
  const d = Math.sqrt(q.x * q.x + q.z * q.z);
  const R = HALL_HALF_T + radius;
  if (Math.abs(d - HALL_MID) < R && d > 1e-9) {
    const cx = (q.x / d) * HALL_MID, cz = (q.z / d) * HALL_MID;
    if (!inOpening(cx, cz)) {
      const nx = q.x / d, nz = q.z / d;
      const target = d < HALL_MID ? HALL_MID - R : HALL_MID + R;
      q.x = nx * target;
      q.z = nz * target;
      const vn = q.vx * nx + q.vz * nz;
      if (d < HALL_MID ? vn > 0 : vn < 0) { q.vx -= vn * nx; q.vz -= vn * nz; }
    }
  }
  for (const [jx, jz] of JAMBS) pushCircle(q, jx, jz, R);

  // Greenhouse walls and furniture.
  let support = onFloor(q.x, q.z) ? BASE.y : -Infinity;
  const feet = Math.max(y, prevY);
  for (const c of capsules) {
    const reach = c.half + c.r + radius;
    if (Math.abs(q.x - c.x) > reach || Math.abs(q.z - c.z) > reach) continue;
    let t = (q.x - c.x) * c.ax + (q.z - c.z) * c.az;
    t = t < -c.half ? -c.half : t > c.half ? c.half : t;
    const top = BASE.y + c.h;
    const cx = c.x + c.ax * t, cz = c.z + c.az * t;
    if (feet >= top - stepUp) {
      const ex = q.x - cx, ez = q.z - cz;
      if (ex * ex + ez * ez < c.r * c.r && top > support) support = top;
      continue;
    }
    pushCircle(q, cx, cz, c.r + radius);
  }

  p.x = q.x + BASE.x;
  p.z = q.z + BASE.z;
  p.vx = q.vx;
  p.vz = q.vz;
  return support;
}

/** Highest the feet may go at world (x, z) for a player of this height (under the roof), or Infinity. */
export function baseCeiling(x: number, z: number, height: number): number {
  const lx = x - BASE.x, lz = z - BASE.z;
  if (lx * lx + lz * lz < HALL_R * HALL_R) return BASE.y + 6.5 - height;
  if (lx > GH.x0 && lx < GH.x1 && Math.abs(lz) < GH.z) return BASE.y + 4.6 - height;
  return Infinity;
}
