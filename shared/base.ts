// The players' home base: an underground bunker under a flat pad in a dune pan. On the surface there is
// only a small entrance hut; inside its door a staircase goes straight down, then a short hallway leads
// into the main room, lit from above by a skylight, with the disassembly table in the middle. Sandstone pilasters
// stand round its walls, and arched alcoves in them hold the workbench (west), the hand water pump (east) and the
// storage chest (back).
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

import type { BossKind } from './bosses.ts';
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
/** In front of the door (yaw 0 looks down -Z, at it). World layout (scrap, wrecks, crash sites) is seeded
 *  around this, so it stays put; players appear at BUNKER_SPAWN. */
export const BASE_SPAWN = { x: BASE.x, z: BASE.z + 9 };

/** Wall thickness everywhere. */
export const WT = 0.3;
/** Half inner width of the entrance, the stairs and the hallway. */
export const W = 1.1;
/** Entrance hut, inner: from the back wall to the door, ceiling height, door half width; its thick walls
 *  (t) and outer height (top): a squat concrete block like a WW2 bunker. */
export const HUT = { z0: -4.0, z1: 2.0, h: 2.3, door: 0.7, t: 0.6, top: 2.75 };
/** Stairs: top edge (the landing ends here), steps (rise, run), bottom = the bunker floor. */
export const STAIRS = { z: 0.6, n: 36, rise: 0.25, run: 0.3 };
/** Bunker floor height (local). */
export const FLOOR = -STAIRS.n * STAIRS.rise;
/** Hallway ends here, where the room begins; its vault's crown above the floor. */
export const HALL = { z: -14.2, h: 3.3 };
/** Main room, inner: half width, far wall, ceiling height above the floor. */
export const ROOM = { w: 8, z: -33.2, h: 6 };
/** The room's centre: the disassembly table stands here, under the skylight. */
export const ROOM_Z = (HALL.z + ROOM.z) / 2;
/** Arched alcoves through the room's walls: half width, depth past the wall's inner face, springing line of the
 *  vault above the floor. */
export const ALCOVE = { hw: 1.3, d: 1.2, spring: 2.3 };
/** Where they open (local x, z on the wall's inner face) and their outward normal: the workbench's (west), the
 *  pump's (east), the chest's (back). The walls' capsules below are cut for them at these spots. */
export const ALCOVES = [
  { x: -ROOM.w, z: ROOM_Z, nx: -1, nz: 0 },
  { x: ROOM.w, z: ROOM_Z, nx: 1, nz: 0 },
  { x: 0, z: ROOM.z, nx: 0, nz: -1 },
];
/** Sandstone pilasters round the room: width along the wall, how far they stand out; offsets along the side walls
 *  from ROOM_Z and along the front and back walls from the middle. The arches' frames (jambs) beside each opening. */
export const PILLAR = { w: 0.6, d: 0.3, sides: [2.0, 4.7, 7.4], ends: [2.0, 4.7], jambW: 0.32, jambD: 0.12 };
/** Where players appear (new, respawned, or back after leaving in or over the bunker): down in the main
 *  room, just in from the hallway, looking at the table. World coordinates, `y` = the floor. */
export const BUNKER_SPAWN = { x: BASE.x, y: BASE.y + FLOOR, z: BASE.z + HALL.z - 3 };
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
const PAD = { x0: -14, x1: 14, z0: -39, z1: 14, blend: 24 };
/** The pad's sand lies just under the entrance floor so they don't z-fight. */
const PAD_Y = BASE.y - 0.06;
/** The dev test lab's floor (shared/lab.ts): the pad's height everywhere, so the bunker's entrance sits level in it. */
export const LAB_FLOOR_Y = PAD_Y;

/**
 * Flag mast behind and beside the entrance hut, seen from afar: a tapered concrete pole (foot radius r0, top r1,
 * height h) on a round plinth (radius, height), held up by wide, tall buttress fins at its foot (count, reach,
 * height, thickness). A windsock swings on top (src/world/mast.ts).
 */
export const MAST = {
  x: 14, z: -14, h: 22, r0: 0.55, r1: 0.25,
  plinth: { r: 1.2, h: 0.5 },
  fins: { n: 4, reach: 2.6, h: 11, t: 0.45 },
};

/**
 * Where each boss kind's trophy stands once it's beaten (shared/trophies.ts): local (x, z) round the pad, and the
 * radius (m) of sand round it that is never dug (overBase), so it can't be undermined.
 */
export const TROPHY_SPOTS: Record<BossKind, { x: number; z: number; r: number }> = {
  worm: { x: -27, z: 6, r: 9 },
  queen: { x: 27, z: 8, r: 15 },
  colossus: { x: -28, z: -24, r: 21 },
  carrier: { x: 32, z: -32, r: 14 },
};

function nearTrophy(lx: number, lz: number, m: number): boolean {
  for (const k in TROPHY_SPOTS) {
    const t = TROPHY_SPOTS[k as BossKind], dx = lx - t.x, dz = lz - t.z, r = t.r + m;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}

/** Local point within the mast's fins (+ margin). */
function nearMast(lx: number, lz: number, m: number): boolean {
  const dx = lx - MAST.x, dz = lz - MAST.z, r = MAST.fins.reach + 1 + m;
  return dx * dx + dz * dz < r * r;
}

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

/** Local point inside the bunker's footprint (entrance, tunnel, hallway, room and its alcoves, walls included) + margin. */
function inFootprint(lx: number, lz: number, m: number): boolean {
  if (Math.abs(lx) < W + HUT.t + m && lz > HALL.z - WT - m && lz < HUT.z1 + HUT.t + m) return true;
  return Math.abs(lx) < ROOM.w + ALCOVE.d + WT + m && lz > ROOM.z - ALCOVE.d - WT - m && lz < HALL.z + WT + m;
}

/** How far across from its centre line local (lx, lz) is in an alcove (past the room's wall, its walls within
 *  margin m), or -1 outside them. */
function inAlcove(lx: number, lz: number, m: number): number {
  for (const a of ALCOVES) {
    const dx = lx - a.x, dz = lz - a.z, v = dx * a.nx + dz * a.nz, u = Math.abs(dz * a.nx - dx * a.nz);
    if (v > 0 && v < ALCOVE.d + m && u < ALCOVE.hw + m) return u;
  }
  return -1;
}

/** True over the bunker's footprint, around the mast or a trophy's spot + margin (no digging: it would cut into
 *  the rooms or undermine the mast or the trophy). */
export function overBase(x: number, z: number, margin = 0): boolean {
  const lx = x - BASE.x, lz = z - BASE.z;
  return inFootprint(lx, lz, margin) || nearMast(lx, lz, margin) || nearTrophy(lx, lz, margin);
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
 * footprint (before turning) and height h above `y`; `square` makes the hitbox a square, not a rounded stadium.
 */
export type BasePiece = { glb: string; node: string; x: number; z: number; fx: number; fz: number; y?: number; hx?: number; hz?: number; h?: number; square?: boolean };

export const BASE_PIECES: BasePiece[] = [
  // In the east alcove, facing into the room (its drain grate is in tools/blender/base/bunker.py, PUMP_X).
  { glb: 'bunker', node: 'pump', x: ROOM.w + ALCOVE.d - 1.0, z: ROOM_Z, fx: -1, fz: 0, y: FLOOR, hx: 0.35, hz: 0.35, h: 1.2 },
  // The workbench in the west alcove, facing into the room; the disassembly table square in the middle, its tools
  // round its sides (shared/stations.ts makes them interactable).
  { glb: 'bunker', node: 'workbench', x: -ROOM.w - ALCOVE.d + 0.42, z: ROOM_Z, fx: 1, fz: 0, y: FLOOR, hx: 1.0, hz: 0.4, h: 0.95 },
  { glb: 'bunker', node: 'disassembly', x: 0, z: ROOM_Z, fx: 0, fz: 1, y: FLOOR, hx: 0.8, hz: 0.8, h: 0.92, square: true },
  // Storage chest in the back alcove (shared/storage.ts).
  { glb: 'bunker', node: 'chest', x: 0, z: ROOM.z - ALCOVE.d + 0.5, fx: 0, fz: 1, y: FLOOR, hx: 0.62, hz: 0.37, h: 0.62 },
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

/** What stands out of the room's walls (local): centre on the wall's inner face, outward normal, width along the
 *  wall, how far out. The pilasters (`pillar`), and the jambs of the alcoves' and the hallway's arches. */
const ON_WALL: { x: number; z: number; nx: number; nz: number; w: number; d: number; pillar: boolean }[] = [];
{
  const p = (x: number, z: number, nx: number, nz: number) => ON_WALL.push({ x, z, nx, nz, w: PILLAR.w, d: PILLAR.d, pillar: true });
  const j = (x: number, z: number, nx: number, nz: number) => ON_WALL.push({ x, z, nx, nz, w: PILLAR.jambW, d: PILLAR.jambD, pillar: false });
  for (const t of [-1, 1]) {
    for (const o of PILLAR.sides) for (const s of [-1, 1]) p(s * ROOM.w, ROOM_Z + t * o, s, 0);
    for (const o of PILLAR.ends) {
      p(t * o, HALL.z, 0, 1);
      p(t * o, ROOM.z, 0, -1);
    }
    for (const a of ALCOVES) {
      const u = t * (ALCOVE.hw + PILLAR.jambW / 2);
      j(a.x - a.nz * u, a.z + a.nx * u, a.nx, a.nz);
    }
    j(t * (W - 0.01 + PILLAR.jambW / 2), HALL.z, 0, 1);
  }
}

/** Local point inside a pilaster. */
function inPillar(lx: number, lz: number): boolean {
  for (const b of ON_WALL) {
    if (!b.pillar) continue;
    const dx = lx - b.x, dz = lz - b.z, v = dx * b.nx + dz * b.nz;
    if (v <= 0 && v > -b.d && Math.abs(dz * b.nx - dx * b.nz) < b.w / 2) return true;
  }
  return false;
}

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
  // Main room, opening onto the hallway, its corners rounded, broken by the alcoves (in the middle of the side
  // walls and of the back wall).
  const ex = ROOM.w - ROOM_R, ef = HALL.z - ROOM_R, eb = ROOM.z + ROOM_R, rr = ROOM_R + WT / 2;
  const g = ALCOVE.hw + WT / 2, ad = ALCOVE.d + WT / 2;
  wall(-ex, hz, -xs, hz, -Infinity, BURIED_TOP);
  wall(xs, hz, ex, hz, -Infinity, BURIED_TOP);
  wall(-ex, rz, -g, rz, -Infinity, BURIED_TOP);
  wall(g, rz, ex, rz, -Infinity, BURIED_TOP);
  for (const s of [-1, 1]) {
    wall(s * rx, ef, s * rx, ROOM_Z + g, -Infinity, BURIED_TOP);
    wall(s * rx, ROOM_Z - g, s * rx, eb, -Infinity, BURIED_TOP);
    arc(s * ex, ef, rr, s, 1, -Infinity, BURIED_TOP);
    arc(s * ex, eb, rr, s, -1, -Infinity, BURIED_TOP);
  }
  // The alcoves' sides and backs.
  for (const a of ALCOVES) {
    const tx = -a.nz * g, tz = a.nx * g, x0 = a.x + a.nx * WT / 2, z0 = a.z + a.nz * WT / 2;
    const x1 = a.x + a.nx * ad, z1 = a.z + a.nz * ad;
    for (const t of [-1, 1]) wall(x0 + t * tx, z0 + t * tz, x1 + t * tx, z1 + t * tz, -Infinity, BURIED_TOP);
    wall(x1 - tx, z1 - tz, x1 + tx, z1 + tz, -Infinity, BURIED_TOP);
  }
  // Pilasters and the arches' jambs standing out of the walls.
  for (const b of ON_WALL) {
    const r = b.d / 2;
    capsules.push({ x: b.x - b.nx * r, z: b.z - b.nz * r, ax: -b.nz, az: b.nx, half: Math.max(b.w / 2 - r, 0), r, y0: -Infinity, top: BURIED_TOP });
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
{
  // The mast: its plinth can be climbed onto, the fins and the pole can't.
  const { plinth, fins } = MAST;
  capsules.push({ x: MAST.x, z: MAST.z, ax: 1, az: 0, half: 0, r: plinth.r, y0: -Infinity, top: plinth.h });
  capsules.push({ x: MAST.x, z: MAST.z, ax: 1, az: 0, half: 0, r: MAST.r0, y0: plinth.h, top: WALL_H });
  for (const [ax, az] of [[1, 0], [0, 1]]) {
    capsules.push({ x: MAST.x, z: MAST.z, ax, az, half: fins.reach, r: fins.t / 2 + 0.05, y0: -Infinity, top: fins.h });
  }
}
for (const p of BASE_PIECES) {
  if (!p.hx || !p.hz || !p.h) continue;
  const fl = Math.sqrt(p.fx * p.fx + p.fz * p.fz), fx = p.fx / fl, fz = p.fz / fl;
  // Local +X turns to (fz, -fx), +Z to (fx, fz). The capsule runs along the longer side.
  const y0 = p.y ?? 0;
  if (p.square) {
    // Four slim capsules side by side along local X, so the corners are not cut off.
    const r = p.hz / 4;
    for (let k = 0; k < 4; k++) {
      const o = -p.hz + r + k * (p.hz - r) * 2 / 3;
      capsules.push({ x: p.x + fx * o, z: p.z + fz * o, ax: fz, az: -fx, half: p.hx - r, r, y0, top: y0 + p.h });
    }
    continue;
  }
  const alongX = p.hx >= p.hz;
  const r = alongX ? p.hz : p.hx, half = (alongX ? p.hx : p.hz) - r;
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
  else if (ax < ROOM.w + ALCOVE.d + WT && lz > ROOM.z - ALCOVE.d - WT && lz < HALL.z + WT) best = FLOOR; // with the alcoves
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
  if (!inFootprint(lx0, lz0, 1) && !nearMast(lx0, lz0, 0)) return -Infinity;
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
  if (ax < ROOM.w + ALCOVE.d + WT && lz > ROOM.z - ALCOVE.d - WT && lz <= HALL.z) {
    // An alcove's barrel vault; then the room's ceiling, the skylight's glass.
    const u = inAlcove(lx, lz, WT);
    if (u >= 0) return FLOOR + ALCOVE.spring + Math.sqrt(Math.max(0, ALCOVE.hw * ALCOVE.hw - u * u));
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

/**
 * What a shot (src/rifle.ts) meets at world (x, y, z) in and around the base: true solid (the hut, the skylight's
 * collar and glass, the bunker's walls, floors and ceilings), false the air inside it (the sand above is not in the
 * way there), null elsewhere (the terrain decides).
 */
export function baseSolid(x: number, y: number, z: number): boolean | null {
  const lx = x - BASE.x, lz = z - BASE.z, ly = y - BASE.y, ax = Math.abs(lx);
  if (ly > HUT.top || !inFootprint(lx, lz, 0)) return null;
  // Air: the hut, stairwell, tunnel and hallway; the doorway; the room (up to the skylight's glass, round the
  // pilasters) and its alcoves.
  if (ax < W && lz > HALL.z && lz < HUT.z1 && ly > stairY(lz) && ly < ceilingAt(lx, lz)) return false;
  if (ax < HUT.door && lz >= HUT.z1 - 0.01 && ly > 0 && ly < HUT.h) return false;
  if (ax < ROOM.w && lz > ROOM.z && lz <= HALL.z && ly > FLOOR && ly < ceilingAt(lx, lz) && !inPillar(lx, lz)) return false;
  if (inAlcove(lx, lz, 0) >= 0 && ly > FLOOR && ly < ceilingAt(lx, lz)) return false;
  if (ax < W + HUT.t && lz > HUT.z0 - HUT.t) return true; // the hut's walls and roof
  if (ax < SKY.collar && Math.abs(lz - ROOM_Z) < SKY.collar && ly < SKY.h) return true; // collar, glass
  return ly < BURIED_TOP ? true : null; // underground concrete; the sand over it
}

/** Within `m` of the bunker's footprint (shots step finely there: its walls and glass are thin). */
export function nearBunker(x: number, z: number, m: number): boolean {
  return inFootprint(x - BASE.x, z - BASE.z, m);
}
