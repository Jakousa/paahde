// Shelters: small empty bunkers scattered over the desert, mostly in the rocky country near its formations. Like
// the home base (shared/base.ts) each is a squat concrete hut on a flat pad with stairs going down inside it, and
// under the sand a room; down there the sun, the storms and the drones can't reach you. Three kinds:
// - small: a short flight down into a little room;
// - deep: a long flight down to a room far under the sand;
// - long: a short flight, then a long low corridor to a narrow gallery.
// Shared by server physics and client prediction (collideShelter() etc. in sim.ts), the terrain (the pad in
// baseHeight, no digging over them, the hut's floor cut out of the sand) and the renderer (src/world/shelters.ts
// builds them from this layout).
//
// Same determinism rules as shared/rocks.ts: integer hashing and + - * /, Math.sqrt, Math.floor, Math.abs,
// Math.min/max only.
//
// Placement: the world is cut into SHELTER_CELL squares; a cell holds at most one shelter, likelier where it is
// rocky (rockiness, shared/rocks.ts). Its spot is kept off the rocks (the pad flattens dunes only) but, in rocky
// country, close beside them. A shelter and its pad stay well inside its cell, so only the cell a point is in can
// hold a shelter that reaches it (margins up to ~20 m).
//
// Local frame: origin = the hut's floor at its doorway centre line; the door faces local +Z and the shelter runs
// down local -Z (like the base). It is turned by a multiple of 90° (exact): local +Z points along world (dx, dz),
// local +X along (dz, -dx).

import { BASE, inBase, terrainHidden, type Capsule } from './base.ts';
import { duneHeight, WORLD_SEED } from './dunes.ts';
import { rockiness, rocksNear } from './rocks.ts';

export type ShelterKind = 'small' | 'deep' | 'long';

/** Wall thickness of the underground parts. */
export const S_WT = 0.3;
/** Half inner width of the hut, the stairs and the corridor. */
export const S_W = 1.0;
/** Hut, inner: back wall, door side, ceiling, door half width; its walls' thickness and outer height. */
export const S_HUT = { z0: -3.4, z1: 1.4, h: 2.2, door: 0.6, t: 0.5, top: 2.6 };
/** Stairs: top edge (the landing ends here), rise and run of a step. */
export const S_STAIRS = { z: 0.2, rise: 0.25, run: 0.3 };
/** Ceiling over the stairs: this far above each step, and never higher than CAP (under the sand). */
const HEAD = 2.4, CAP = -0.6;
/** Corridor ceiling above the floor. */
export const S_HALL_H = 2.4;
/** Underground walls end just under the sand. */
const BURIED_TOP = -0.3;

/** A kind's layout: steps down, where the corridor ends (the room's front wall), the room (half width, far wall,
 *  ceiling height above the floor), and its floor (local y). */
export type ShelterLayout = { steps: number; hall: number; room: { w: number; z: number; h: number }; floor: number };

function layout(steps: number, hall: number, room: { w: number; z: number; h: number }): ShelterLayout {
  return { steps, hall, room, floor: -steps * S_STAIRS.rise };
}

export const SHELTER_KINDS: Record<ShelterKind, ShelterLayout> = {
  small: layout(14, -4.6, { w: 2.4, z: -10, h: 2.6 }),
  deep: layout(40, -13, { w: 2.6, z: -19.5, h: 3.2 }),
  long: layout(14, -24, { w: 1.8, z: -36, h: 2.6 }),
};

export type Shelter = {
  id: number;
  kind: ShelterKind;
  /** World position of the origin (`y` = the hut's floor). */
  x: number; y: number; z: number;
  /** Where the door faces (a world axis). */
  dx: number; dz: number;
  L: ShelterLayout;
};

/** Height (local) of the stairs (a ramp half a step under the nosings) at local z, clamped to the landing/floor. */
export function shelterStairY(L: ShelterLayout, lz: number): number {
  const y = -(S_STAIRS.z - lz) * (S_STAIRS.rise / S_STAIRS.run) - S_STAIRS.rise / 2;
  return lz >= S_STAIRS.z ? 0 : Math.max(L.floor, Math.min(0, y));
}

/** Ceiling (local) over the stairs and the corridor at local z (behind the hut): stepped, one slab per step. */
export function stairCeiling(L: ShelterLayout, lz: number): number {
  const hall = L.floor + S_HALL_H;
  const i = Math.floor((S_STAIRS.z - lz) / S_STAIRS.run);
  if (i >= L.steps) return hall;
  return Math.max(hall, Math.min(CAP, -(Math.max(i, 0) + 1) * S_STAIRS.rise + HEAD));
}

/** Local point inside the shelter's footprint (hut, stairs, corridor, room, walls included) + margin. */
function inFootprint(L: ShelterLayout, lx: number, lz: number, m: number): boolean {
  const ax = Math.abs(lx);
  if (ax < S_W + S_HUT.t + m && lz > L.hall - S_WT - m && lz < S_HUT.z1 + S_HUT.t + m) return true;
  return ax < L.room.w + S_WT + m && lz > L.room.z - S_WT - m && lz < L.hall + S_WT + m;
}

/** Local point inside the hut (walls included) + margin. */
function inHut(lx: number, lz: number, m: number): boolean {
  return Math.abs(lx) < S_W + S_HUT.t + m && lz > S_HUT.z0 - S_HUT.t - m && lz < S_HUT.z1 + S_HUT.t + m;
}

/** The flat pad (local rectangle) and how far it blends back into the dunes (m). */
const PAD_M = 2, PAD_FRONT = 5, PAD_BLEND = 14;
function padRect(L: ShelterLayout) {
  const w = Math.max(L.room.w + S_WT, S_W + S_HUT.t) + PAD_M;
  return { x0: -w, x1: w, z0: L.room.z - S_WT - PAD_M, z1: S_HUT.z1 + S_HUT.t + PAD_FRONT };
}

// --- Placement ---

/** Grid cell size (m): at most one shelter per cell. */
export const SHELTER_CELL = 400;
/** A shelter's origin stays this far inside its cell (m), so it and its pad never reach the next one. */
const CELL_MARGIN = 64;
/** No shelters this close to the base (m). */
const BASE_CLEAR = 350;
/** Most cut or fill the pad may need (m of dune height range under it). */
const MAX_RANGE = 3.5;

/** Deterministic PRNG seeded from a cell (integer hashing only). */
function rng(ix: number, iz: number) {
  let h = Math.imul(ix | 0, 0x4f1bbcdd) ^ Math.imul(iz | 0, 0x1b873593) ^ Math.imul(WORLD_SEED, 0x85ebca6b) ^ 0x5e17;
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FACINGS: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0]];
/** The world playable square (shared/terrain.ts WORLD_HALF; not imported, terrain.ts imports this). */
const WORLD_HALF = 2000;

/** Local → world offset for a shelter facing (dx, dz). */
function toWorld(dx: number, dz: number, lx: number, lz: number): [number, number] {
  return [lx * dz + lz * dx, -lx * dx + lz * dz];
}

function cellShelter(ix: number, iz: number): Shelter | null {
  const r = rng(ix, iz);
  const k = rockiness((ix + 0.5) * SHELTER_CELL, (iz + 0.5) * SHELTER_CELL);
  if (r() > 0.02 + 0.45 * k) return null;
  const span = SHELTER_CELL - 2 * CELL_MARGIN;
  const u = r();
  const kind: ShelterKind = u < 0.4 ? 'small' : u < 0.7 ? 'deep' : 'long';
  for (let tries = 0; tries < 24; tries++) {
    const x = Math.round(ix * SHELTER_CELL + CELL_MARGIN + span * r());
    const z = Math.round(iz * SHELTER_CELL + CELL_MARGIN + span * r());
    const [dx, dz] = FACINGS[Math.floor(r() * 4)];
    if (Math.abs(x) > WORLD_HALF - CELL_MARGIN || Math.abs(z) > WORLD_HALF - CELL_MARGIN) continue;
    const bx = x - BASE.x, bz = z - BASE.z;
    if (bx * bx + bz * bz < BASE_CLEAR * BASE_CLEAR) continue;
    const L = SHELTER_KINDS[kind];
    const p = padRect(L);
    // The pad's middle and a circle round it with its blend: no rock in there; in rocky country, rock close by.
    const [mx, mz] = toWorld(dx, dz, 0, (p.z0 + p.z1) / 2);
    const hx = (p.x1 - p.x0) / 2, hz = (p.z1 - p.z0) / 2;
    const reach = Math.sqrt(hx * hx + hz * hz) + PAD_BLEND;
    if (rocksNear(x + mx, z + mz, reach)) continue;
    if (k > 0.3 && !rocksNear(x + mx, z + mz, reach + 45)) continue;
    // Flat enough: the pad sits at the mean dune height under it.
    let lo = Infinity, hi = -Infinity, sum = 0, n = 0;
    for (let lz = p.z0; lz <= p.z1; lz += 4) {
      for (let lx = p.x0; lx <= p.x1; lx += 2) {
        const [ox, oz] = toWorld(dx, dz, lx, lz);
        const h = duneHeight(x + ox, z + oz, WORLD_SEED);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
        sum += h;
        n++;
      }
    }
    if (hi - lo > MAX_RANGE) continue;
    return { id: (ix + 64) * 128 + (iz + 64), kind, x, y: Math.round((sum / n) * 100) / 100, z, dx, dz, L };
  }
  return null;
}

const cells = new Map<number, Shelter | null>();

/** The shelter in cell (ix, iz), if any. */
function shelterInCell(ix: number, iz: number): Shelter | null {
  const k = (ix + 64) * 128 + (iz + 64);
  let s = cells.get(k);
  if (s === undefined) cells.set(k, (s = cellShelter(ix, iz)));
  return s;
}

/** The shelter that may reach world (x, z) (the one in its cell), or null. */
export function shelterAt(x: number, z: number): Shelter | null {
  return shelterInCell(Math.floor(x / SHELTER_CELL), Math.floor(z / SHELTER_CELL));
}

/** Shelters whose origin lies within `r` of (x, z). */
export function sheltersNear(x: number, z: number, r: number): Shelter[] {
  const out: Shelter[] = [];
  for (let iz = Math.floor((z - r) / SHELTER_CELL); iz <= Math.floor((z + r) / SHELTER_CELL); iz++) {
    for (let ix = Math.floor((x - r) / SHELTER_CELL); ix <= Math.floor((x + r) / SHELTER_CELL); ix++) {
      const s = shelterInCell(ix, iz);
      if (s && (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z) < r * r) out.push(s);
    }
  }
  return out;
}

/** A shelter's pad reaches at most this far from its origin (m). */
const REACH = 55;

/** True if a shelter or its pad may reach within `r` of (x, z): keeps scrap, wrecks and crash sites off them. */
export function shelterWithin(x: number, z: number, r: number): boolean {
  return sheltersNear(x, z, r + REACH).length > 0;
}

/** Local coordinates of world (x, z) in shelter s. */
function localX(s: Shelter, x: number, z: number): number {
  return (x - s.x) * s.dz - (z - s.z) * s.dx;
}
function localZ(s: Shelter, x: number, z: number): number {
  return (x - s.x) * s.dx + (z - s.z) * s.dz;
}

// --- Terrain ---

/** Terrain height with the shelters' pads: `h` flattened towards the hut's floor around a shelter. */
export function withShelterPad(x: number, z: number, h: number): number {
  const s = shelterAt(x, z);
  if (!s) return h;
  const p = padRect(s.L), lx = localX(s, x, z), lz = localZ(s, x, z);
  const ex = Math.max(p.x0 - lx, 0, lx - p.x1), ez = Math.max(p.z0 - lz, 0, lz - p.z1);
  const y = s.y - 0.06; // just under the hut's floor so they don't z-fight
  if (ex === 0 && ez === 0) return y;
  let t = Math.sqrt(ex * ex + ez * ez) / PAD_BLEND;
  if (t >= 1) return h;
  t = t * t * (3 - 2 * t);
  return y + (h - y) * t;
}

/** True over a shelter's footprint + margin (no digging: it would cut into the rooms). */
export function overShelter(x: number, z: number, margin = 0): boolean {
  const s = shelterAt(x, z);
  return !!s && inFootprint(s.L, localX(s, x, z), localZ(s, x, z), margin);
}

/** True where a shelter's hut stands on the surface + margin. */
export function insideShelter(x: number, z: number, margin = 0): boolean {
  const s = shelterAt(x, z);
  return !!s && inHut(localX(s, x, z), localZ(s, x, z), margin);
}

/** True for someone whose feet are at world `y` inside a shelter (+ margin): in its hut, or down in it. */
export function inShelter(x: number, y: number, z: number, margin = 0): boolean {
  const s = shelterAt(x, z);
  if (!s) return false;
  const lx = localX(s, x, z), lz = localZ(s, x, z), ly = y - s.y;
  if (inHut(lx, lz, margin)) return ly < S_HUT.h;
  return ly < BURIED_TOP && inFootprint(s.L, lx, lz, margin);
}

/** The hole cut in the sand over a shelter's hut floor (world x0, z0, x1, z1). */
export function shelterHole(s: Shelter): [number, number, number, number] {
  return worldRect(s, -S_W - S_WT / 2, S_HUT.z0 - S_WT / 2, S_W + S_WT / 2, S_HUT.z1 + S_WT / 2);
}

/** The hut's outer box (world x0, z0, x1, z1); its height is S_HUT.top over s.y. */
export function shelterHutRect(s: Shelter): [number, number, number, number] {
  return worldRect(s, -S_W - S_HUT.t, S_HUT.z0 - S_HUT.t, S_W + S_HUT.t, S_HUT.z1 + S_HUT.t);
}

/** The hut's inner air (world x0, z0, x1, z1), up to S_HUT.h over s.y. */
export function shelterHutInside(s: Shelter): [number, number, number, number] {
  return worldRect(s, -S_W, S_HUT.z0, S_W, S_HUT.z1);
}

function worldRect(s: Shelter, x0: number, z0: number, x1: number, z1: number): [number, number, number, number] {
  const [ax, az] = toWorld(s.dx, s.dz, x0, z0), [bx, bz] = toWorld(s.dx, s.dz, x1, z1);
  return [s.x + Math.min(ax, bx), s.z + Math.min(az, bz), s.x + Math.max(ax, bx), s.z + Math.max(az, bz)];
}

/** True where the sand is not the ground for feet that were at `y` (world) last tick: in a hut, down in a shelter. */
export function shelterHidden(x: number, z: number, y: number): boolean {
  const s = shelterAt(x, z);
  if (!s) return false;
  const lx = localX(s, x, z), lz = localZ(s, x, z);
  if (Math.abs(lx) < S_W + S_WT / 2 && lz > S_HUT.z0 - S_WT / 2 && lz < S_HUT.z1 + S_WT / 2) return true;
  return y - s.y < BURIED_TOP && inFootprint(s.L, lx, lz, 0);
}

// --- Collision ---

/** Walls are taller than any jump. */
const WALL_H = 100;

/** Wall capsules (local) for a kind. */
function kindCapsules(L: ShelterLayout): Capsule[] {
  const out: Capsule[] = [];
  const wall = (x0: number, z0: number, x1: number, z1: number, y0: number, top: number, r = S_WT / 2) => {
    const dx = x1 - x0, dz = z1 - z0, len = Math.sqrt(dx * dx + dz * dz);
    out.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, ax: dx / len, az: dz / len, half: len / 2, r, y0, top });
  };
  // Hut: thick walls (their inner faces the stairwell's too, all the way down), the doorway in front, the back
  // wall stops over the stairwell's ceiling.
  const r = S_HUT.t / 2, xh = S_W + r, fh = S_HUT.z1 + r, bh = S_HUT.z0 - r;
  wall(-xh, bh, -xh, fh, -Infinity, WALL_H, r);
  wall(xh, bh, xh, fh, -Infinity, WALL_H, r);
  wall(-xh, fh, -S_HUT.door - r, fh, -Infinity, WALL_H, r);
  wall(S_HUT.door + r, fh, xh, fh, -Infinity, WALL_H, r);
  wall(-xh, bh, xh, bh, stairCeiling(L, S_HUT.z0 - 0.01), WALL_H, r);
  // Stairwell and corridor under the sand, into the room's front wall.
  const xs = S_W + S_WT / 2, hz = L.hall + S_WT / 2;
  wall(-xs, S_HUT.z0, -xs, hz, -Infinity, BURIED_TOP);
  wall(xs, S_HUT.z0, xs, hz, -Infinity, BURIED_TOP);
  // The room.
  const rx = L.room.w + S_WT / 2, rz = L.room.z - S_WT / 2;
  wall(-rx, hz, -xs, hz, -Infinity, BURIED_TOP);
  wall(xs, hz, rx, hz, -Infinity, BURIED_TOP);
  wall(-rx, rz, rx, rz, -Infinity, BURIED_TOP);
  wall(-rx, rz, -rx, hz, -Infinity, BURIED_TOP);
  wall(rx, rz, rx, hz, -Infinity, BURIED_TOP);
  return out;
}

const CAPSULES: Record<ShelterKind, Capsule[]> = {
  small: kindCapsules(SHELTER_KINDS.small),
  deep: kindCapsules(SHELTER_KINDS.deep),
  long: kindCapsules(SHELTER_KINDS.long),
};

/** Floor height (local) at local (lx, lz) — landing, stairs, corridor, room — or -Infinity. */
function floorAt(L: ShelterLayout, lx: number, lz: number): number {
  const ax = Math.abs(lx);
  if (ax < S_W + S_WT && lz > L.hall - S_WT && lz < S_HUT.z1 + S_WT) return shelterStairY(L, lz);
  if (ax < L.room.w + S_WT && lz > L.room.z - S_WT && lz < L.hall + S_WT) return L.floor;
  return -Infinity;
}

/** Ceiling (local) over local (lx, lz), or Infinity. */
function ceilingAt(L: ShelterLayout, lx: number, lz: number): number {
  const ax = Math.abs(lx);
  if (ax < S_W + S_WT && lz >= S_HUT.z0 && lz < S_HUT.z1 + S_WT) return S_HUT.h;
  if (ax < S_W + S_WT && lz > L.hall && lz < S_HUT.z0) return stairCeiling(L, lz);
  if (ax < L.room.w + S_WT && lz > L.room.z - S_WT && lz <= L.hall) return L.floor + L.room.h;
  return Infinity;
}

const local = { x: 0, z: 0, vx: 0, vz: 0 };

/**
 * Collide a player (world position p, moved in place, velocity absorbed into walls) with a shelter, like
 * collideBase (shared/base.ts). Returns the height (world) of what the player stands on, or -Infinity.
 */
export function collideShelter(p: { x: number; z: number; vx: number; vz: number }, y: number, prevY: number, radius: number, height: number, stepUp: number): number {
  const s = shelterAt(p.x, p.z);
  if (!s) return -Infinity;
  const q = local;
  q.x = localX(s, p.x, p.z);
  q.z = localZ(s, p.x, p.z);
  if (!inFootprint(s.L, q.x, q.z, 1)) return -Infinity;
  q.vx = p.vx * s.dz - p.vz * s.dx;
  q.vz = p.vx * s.dx + p.vz * s.dz;

  const feet = Math.max(y, prevY) - s.y;
  const head = Math.min(y, prevY) - s.y + height;
  let support = floorAt(s.L, q.x, q.z);
  for (const c of CAPSULES[s.kind]) {
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
    // Push out of the circle round (cx, cz).
    let ex = q.x - cx, ez = q.z - cz;
    const R = c.r + radius, d = Math.sqrt(ex * ex + ez * ez);
    if (d >= R) continue;
    if (d > 1e-9) { ex /= d; ez /= d; } else { ex = 1; ez = 0; }
    q.x = cx + ex * R;
    q.z = cz + ez * R;
    const vn = q.vx * ex + q.vz * ez;
    if (vn < 0) { q.vx -= vn * ex; q.vz -= vn * ez; }
  }

  const [wx, wz] = toWorld(s.dx, s.dz, q.x, q.z), [wvx, wvz] = toWorld(s.dx, s.dz, q.vx, q.vz);
  p.x = s.x + wx;
  p.z = s.z + wz;
  p.vx = wvx;
  p.vz = wvz;
  return support === -Infinity ? support : support + s.y;
}

/** Highest the feet may go at world (x, z) for a player of this height whose feet were at `prevY`, or Infinity. */
export function shelterCeiling(x: number, z: number, prevY: number, height: number): number {
  const s = shelterAt(x, z);
  if (!s) return Infinity;
  const c = ceilingAt(s.L, localX(s, x, z), localZ(s, x, z));
  return prevY - s.y + height <= c + 0.05 ? c + s.y - height : Infinity;
}

/** What a shot meets at world (x, y, z) in and around a shelter: true solid, false its air, null elsewhere. */
export function shelterSolid(x: number, y: number, z: number): boolean | null {
  const s = shelterAt(x, z);
  if (!s) return null;
  const L = s.L, lx = localX(s, x, z), lz = localZ(s, x, z), ly = y - s.y, ax = Math.abs(lx);
  if (ly > S_HUT.top || !inFootprint(L, lx, lz, 0)) return null;
  if (ax < S_W && lz > L.hall && lz < S_HUT.z1 && ly > shelterStairY(L, lz) && ly < ceilingAt(L, lx, lz)) return false;
  if (ax < S_HUT.door && lz >= S_HUT.z1 - 0.01 && ly > 0 && ly < S_HUT.h) return false;
  if (ax < L.room.w && lz > L.room.z && lz <= L.hall && ly > L.floor && ly < ceilingAt(L, lx, lz)) return false;
  if (inHut(lx, lz, 0)) return true;
  return ly < BURIED_TOP ? true : null;
}

/** Within `m` of a shelter's footprint (shots step finely there). */
export function nearShelter(x: number, z: number, m: number): boolean {
  return overShelter(x, z, m);
}

// --- The base and the shelters together ---

/** In the home base or a shelter: out of the sun, the storm and the drones' sight. */
export function indoors(x: number, y: number, z: number, margin = 0): boolean {
  return inBase(x, y, z, margin) || inShelter(x, y, z, margin);
}

/** The sand is not the ground here for feet that were at `y`: in the base or a shelter. */
export function sandHidden(x: number, z: number, y: number): boolean {
  return terrainHidden(x, z, y) || shelterHidden(x, z, y);
}
