// Placed things: items from the bag (the PLACEABLES kinds of shared/items.ts) standing on a floor: plant beds and UV
// lamp stands (GitHub #22–#24; not crafted for now); and the buildings put up with the wrench from base materials
// (shared/crafting.ts BUILDS), anywhere out on the sand (the `sand` kinds): the windmill, the battery station, the power
// pole, the electric well (shared/wells.ts), the beacon (a lamp on a mast shining a column of light into the sky, src/world/beacons.ts; its light's colour is
// its item's data, BEACON_COLORS), the tarp (shade you build, shared/tarp.ts), and the work stations and the chest (WORKBENCH, TABLE, CHEST), which also go up on a
// shelter's room floor (`floor`), and the bedroll (a player's own place to wake up after dying, server/world.ts:
// one each, a new one moves the old, only its owner picks it up, server/placed.ts). The windmill, battery station, well and beacon keep their item with its parts
// in a box of their own while they stand (shared/gear.ts isBuilding, server/placed.ts), the chest its things in another
// (shared/storage.ts). The server owns the list (server/placed.ts, `placed` table) and sends it whole on join and when it
// changes; client and server both keep it here with setPlaced(), which also hands their standing parts to the collision
// (shared/capsules.ts setPlacedCapsules: in a grid of cells, anywhere), so prediction and the server collide with the
// same things.
//
// Where it goes depends on where you stand (placeFloor): down in a shelter, on its room's floor; else out on the sand
// (floor-only kinds go only on a shelter's floor). Rules (placeError): on a shelter's floor, inside its room, clear of the
// pump and the corridor's mouth (shelterRoomClear); on the sand, STRUCTURE_GAP clear of the shelters' huts, SHIP_GAP off
// the crashed ship by its real shape (shared/shipSpot.ts rectNearShip) and off the trophies' ground (shared/trophies.ts
// overTrophy), on ground no steeper than MAX_TILT across the
// footprint (it stands on the lowest corner: the rest sinks into the sand), and that sand is never dug again
// (overPlaced). Sand kinds keep their `gap` (the larger of the two) from each other, edge to edge. Nothing overlaps
// another placed thing — except that a UV lamp and a plant bed share their spot when aligned exactly (same centre and
// turn): the lamp's legs straddle the bed's short ends. placeAim() snaps the aim point to a 0.25 m grid, or onto a bed /
// lamp waiting for its partner.
//
// Same determinism rules as shared/capsules.ts for anything collision touches: + - * /, Math.sqrt, Math.abs,
// Math.min/max, Math.floor only.
import { setPlacedCapsules, type Capsule } from './capsules.ts';
import { EYE_HEIGHT } from './dig.ts';
import { ITEMS } from './items.ts';
import { insideShelter, inShelter, shelterAt, shelterRoomClear, shelterUnder } from './shelters.ts';
import { rectNearShip } from './shipSpot.ts';
import { heightAt } from './terrain.ts';
import { TARP_HALF } from './tarp.ts';
import { overTrophy } from './trophies.ts';
import { TEXT } from './text.ts';

/** A placed thing: DB id, item kind, world position of its footprint centre on the floor or the sand (y: what it
 *  stands on), its turn (0: long side along X, 1: along Z; a tarp's in quarter turns, 0..3, PLACEABLES `turns`), and for a building the parts fitted in it (its tier and
 *  look, src/world/placed.ts). */
export type Placed = { id: number; kind: string; x: number; y: number; z: number; rot: number; parts?: (string | null)[];
  /** A beacon's light (BEACON_COLORS index; its item's ItemData `color`). */
  color?: number };

/** A beacon's light colours, cycled with R in view of one (src/placing.ts): saturated and cold enough to stand out
 *  against the amber day sky and the dark night one (docs/look.md: the world is orange, so none of them is), round the
 *  colour wheel from cyan (the first, a new one's): cyan, blue, violet, magenta, red, yellow, green, white. */
export const BEACON_COLORS = [0x2ee6ff, 0x4a6dff, 0xa64dff, 0xff45cc, 0xff2d3c, 0xffe94a, 0x3dff6e, 0xf2f6ff];

/** An axis-aligned box in the thing's own frame (rot 0), metres above the floor. */
type Box = { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };

/** Each placeable kind: footprint half extents (rot 0) and its look/collision boxes. Boxes standing on the
 *  floor (y0 = 0) collide; the others are only looked at. `sand`: stands outside, anywhere on the sand, at least `gap`
 *  (m, edge to edge) from the other things out there; with `floor` it may stand on a shelter room's floor too. Neither:
 *  on a floor only. Sizes match tools/blender/placeables.py. */
export const PLACEABLES: Record<string, { hx: number; hz: number; boxes: Box[]; sand?: true; floor?: true; gap?: number;
  /** Turns it can be put up at (quarter turns, R cycles them); 2 (along X or Z) if not given. */
  turns?: number;
  /** Most the sand may rise across its footprint (m); MAX_TILT if not given. */
  tilt?: number }> = {
  plant_bed: { hx: 0.82, hz: 0.42, boxes: [{ x0: -0.8, x1: 0.8, y0: 0, y1: 0.52, z0: -0.4, z1: 0.4 }] },
  uv_lamp: {
    hx: 0.99, hz: 0.27,
    boxes: [
      { x0: -0.99, x1: -0.89, y0: 0, y1: 2.0, z0: -0.26, z1: 0.26 },
      { x0: 0.89, x1: 0.99, y0: 0, y1: 2.0, z0: -0.26, z1: 0.26 },
      { x0: -0.89, x1: 0.89, y0: 1.8, y1: 2.05, z0: -0.11, z1: 0.11 },
    ],
  },
  // A lattice tower on four splayed legs (their feet collide; you can step in between), the head and rotor up top.
  windmill: {
    // Room for the head and its tail (2.4 m back from the tower) to swing round.
    hx: 1.1, hz: 1.1, sand: true, gap: 4,
    boxes: [
      ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => ({ x0: sx * 0.95 - 0.12, x1: sx * 0.95 + 0.12, y0: 0, y1: 2.2, z0: sz * 0.95 - 0.12, z1: sz * 0.95 + 0.12 })),
      { x0: -0.7, x1: 0.7, y0: 0.4, y1: 7.6, z0: -0.7, z1: 0.7 },
    ],
  },
  // A welded rack of cells on a skid, the charger box on top.
  battery_station: { hx: 0.78, hz: 0.42, sand: true, gap: 2, boxes: [{ x0: -0.75, x1: 0.75, y0: 0, y1: 1.35, z0: -0.4, z1: 0.4 }] },
  // A pole: its foot collides, the crossarm and insulator up top are only looked at.
  power_pole: {
    hx: 0.3, hz: 0.3, sand: true, gap: 1,
    boxes: [{ x0: -0.12, x1: 0.12, y0: 0, y1: 4.4, z0: -0.12, z1: 0.12 }, { x0: -0.6, x1: 0.6, y0: 4.2, y1: 4.6, z0: -0.1, z1: 0.1 }],
  },
  // A beacon: a mast on a welded foot (both collide), the lamp head up top (only looked at). Sizes match
  // src/world/beacons.ts.
  beacon_light: {
    hx: 0.32, hz: 0.32, sand: true, gap: 1,
    boxes: [
      { x0: -0.3, x1: 0.3, y0: 0, y1: 0.3, z0: -0.3, z1: 0.3 },
      { x0: -0.08, x1: 0.08, y0: 0, y1: 3.35, z0: -0.08, z1: 0.08 },
      { x0: -0.2, x1: 0.2, y0: 3.3, y1: 3.75, z0: -0.2, z1: 0.2 },
    ],
  },
  // A tarp (shared/tarp.ts): canvas on four poles at its corners. The poles collide (each stands on its own sand, up to
  // `tilt` over the lowest, so they reach that much higher); the canvas is only looked at (you walk under it). Its
  // shade: shared/shade.ts. Four turns: which corner is the high one.
  tarp: {
    hx: TARP_HALF + 0.1, hz: TARP_HALF + 0.1, sand: true, gap: 1, turns: 4, tilt: 1.2,
    boxes: [
      ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => ({ x0: sx * TARP_HALF - 0.06, x1: sx * TARP_HALF + 0.06, y0: 0, y1: 4.6, z0: sz * TARP_HALF - 0.06, z1: sz * TARP_HALF + 0.06 })),
      { x0: -TARP_HALF, x1: TARP_HALF, y0: 2.2, y1: 3.6, z0: -TARP_HALF, z1: TARP_HALF },
    ],
  },
  // The workbench (shared/stations.ts): the bench, its front +Z; the pegboard behind it is only looked at.
  workbench: {
    hx: 1.05, hz: 0.42, sand: true, floor: true,
    boxes: [{ x0: -1, x1: 1, y0: 0, y1: 0.95, z0: -0.4, z1: 0.4 }, { x0: -1.04, x1: 1.04, y0: 0.92, y1: 2.05, z0: -0.4, z1: -0.35 }],
  },
  // The dismantling bench (shared/crash.ts tables): a 2 m square table (TABLE_TOP high), the scrap bin on the floor by
  // its +X side; the vise, the tray and the grinder round its edge are only looked at.
  dismantle_bench: {
    hx: 1.3, hz: 1.08, sand: true, floor: true,
    boxes: [
      { x0: -1, x1: 1, y0: 0, y1: 0.82, z0: -1, z1: 1 },
      { x0: 1, x1: 1.33, y0: 0, y1: 0.56, z0: 0.12, z1: 0.58 },
      { x0: -1.3, x1: -1, y0: 0.6, y1: 0.92, z0: -0.5, z1: 0.37 },
    ],
  },
  // A chest (shared/storage.ts storeBox): lid hinged at the back, front +Z.
  storage_chest: { hx: 0.68, hz: 0.4, sand: true, floor: true, boxes: [{ x0: -0.6, x1: 0.6, y0: 0, y1: 0.62, z0: -0.35, z1: 0.35 }] },
  // The electric well (shared/wells.ts): the tank's stand, the bore casing and the control box's post collide; the pad
  // (just off the ground: walked on) and the box are only looked at. Sizes match tools/blender/well.py.
  well: {
    hx: 0.9, hz: 0.6, sand: true, gap: 2,
    boxes: [
      { x0: 0.2, x1: 0.82, y0: 0, y1: 1.8, z0: -0.46, z1: 0.1 },
      { x0: -0.33, x1: -0.07, y0: 0, y1: 1.9, z0: -0.28, z1: -0.02 },
      { x0: -0.74, x1: -0.62, y0: 0, y1: 3.2, z0: 0.22, z1: 0.34 },
      { x0: -0.86, x1: -0.5, y0: 1.02, y1: 1.5, z0: 0.24, z1: 0.45 },
      { x0: -0.9, x1: 0.9, y0: 0.02, y1: 0.12, z0: -0.6, z1: 0.6 },
    ],
  },
  // A bedroll: low enough to walk over, flat enough to want flat sand. Sizes match tools/blender/placeables.py (ROLL_X,
  // ROLL_Y).
  bedroll: { hx: 1.0, hz: 0.4, sand: true, floor: true, gap: 0.3, tilt: 0.2, boxes: [{ x0: -1.0, x1: 1.0, y0: 0, y1: 0.16, z0: -0.39, z1: 0.39 }] },
};
export const TARP = 'tarp';
/** How many turns `kind` can be put up at. */
export const turnsOf = (kind: string) => PLACEABLES[kind]?.turns ?? 2;

/** The placed work stations and the chest (shared/stations.ts, shared/storage.ts). */
export const WORKBENCH = 'workbench';
export const TABLE = 'dismantle_bench';
export const CHEST = 'storage_chest';
/** The dismantling bench's top above what it stands on (tools/blender/stationkit.py TABLE_TOP) and its half size. */
export const TABLE_TOP = 0.8;
export const TABLE_HW = 1;

export const isPlaceable = (kind: string | undefined) => !!kind && kind in PLACEABLES;
/** Goes up out on the sand (if it may stand on a floor too, that's `floor`). */
export const onSand = (kind: string) => !!PLACEABLES[kind]?.sand;
/** May stand on a room's floor. */
const onFloors = (kind: string) => !!PLACEABLES[kind] && (!PLACEABLES[kind].sand || !!PLACEABLES[kind].floor);
/** A placed thing stands on a shelter's floor, not on the sand: down inside one. */
export const standsIndoors = (p: { x: number; y: number; z: number }) => inShelter(p.x, p.y + 0.1, p.z);

/** These two kinds may stand in the same spot when aligned. */
const PARTNERS: Record<string, string> = { plant_bed: 'uv_lamp', uv_lamp: 'plant_bed' };

/** How far from the eye you can put something down (to the aim point on the floor); out on the sand a little further. */
export const PLACE_REACH = 5;
export const SAND_REACH = 8;
/** Most the sand may rise across a sand kind's footprint (m, lowest to highest of its corners and centre). */
const MAX_TILT = 0.7;
/** Sand kinds keep this far (m) from the shelters' huts and their doors. */
const STRUCTURE_GAP = 4;
/** ...and this far from the crashed ship's hull and the debris behind it (by their capsules), so the ramp's foot is free. */
const SHIP_GAP = 0.5;
/** How far from the eye a placed thing can be picked up. */
export const PLACED_REACH = 4;
/** At most this many things placed in the world (beacons aside). */
export const MAX_PLACED = 300;
/** At most this many beacons in the world. */
export const MAX_BEACONS = 30;
export const BEACON = 'beacon_light';
export const BEDROLL = 'bedroll';
/** Counts towards MAX_PLACED (beacons have their own limit; bedrolls are one per player). */
const counted = (kind: string) => kind !== BEACON && kind !== BEDROLL;
/** Aim snaps to this grid (m, world). */
const GRID = 0.25;

/** Everything placed right now (from the server). Replace it with setPlaced(). */
export let placed: Placed[] = [];

/** Replace the list, and the collision of what stands on the floors and the sand. */
export function setPlaced(list: Placed[]) {
  placed = list;
  const out: Capsule[] = [], spots: number[][] = [];
  for (const p of list) {
    if (!isPlaceable(p.kind)) continue;
    if (!standsIndoors(p)) spots.push(footprint(p.kind, p.x, p.z, p.rot));
    for (const b of worldBoxes(p)) {
      if (b.y0 > p.y + 1e-6) continue;
      // Capsule along the box's longer side.
      const hx = (b.x1 - b.x0) / 2, hz = (b.z1 - b.z0) / 2, alongX = hx >= hz;
      const r = alongX ? hz : hx;
      out.push({ x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2, ax: alongX ? 1 : 0, az: alongX ? 0 : 1, half: (alongX ? hx : hz) - r, r, y0: b.y0, top: b.y1 });
    }
  }
  setPlacedCapsules(out, spots);
}

/**
 * The floor (world height) `kind` goes on for a player whose feet are at `feet`: down in a shelter, its room's; null: out
 * on the sand (where a floor-only kind can't go: placeError says so).
 */
export function placeFloor(kind: string, feet: { x: number; y: number; z: number }): number | null {
  if (!onFloors(kind)) return null;
  const s = shelterUnder(feet.x, feet.y, feet.z);
  return s ? s.y + s.L.floor : null;
}

/** What `kind` at (x, z) would stand on: `floor` (placeFloor), or the lowest sand under its footprint's corners and
 *  centre (a little into it, so no corner floats). */
export function placedY(kind: string, x: number, z: number, rot: number, floor: number | null): number {
  if (floor !== null) return floor;
  const f = footprint(kind, x, z, rot);
  return Math.min(heightAt(x, z), heightAt(f[0], f[1]), heightAt(f[2], f[1]), heightAt(f[0], f[3]), heightAt(f[2], f[3])) - 0.05;
}

/** World rectangle [x0, z0, x1, z1] of a footprint. */
function footprint(kind: string, x: number, z: number, rot: number, m = 0): [number, number, number, number] {
  const k = PLACEABLES[kind];
  const hx = (rot ? k.hz : k.hx) + m, hz = (rot ? k.hx : k.hz) + m;
  return [x - hx, z - hz, x + hx, z + hz];
}

/** A placed thing's boxes in world coordinates. Turned a quarter (rot 1), local +X goes to world -Z and local +Z to +X
 *  (three.js rotation.y = π/2, as src/world/placed.ts draws it). */
export function worldBoxes(p: Placed): Box[] {
  return PLACEABLES[p.kind].boxes.map((b) => p.rot
    ? { x0: p.x + b.z0, x1: p.x + b.z1, y0: p.y + b.y0, y1: p.y + b.y1, z0: p.z - b.x1, z1: p.z - b.x0 }
    : { x0: p.x + b.x0, x1: p.x + b.x1, y0: p.y + b.y0, y1: p.y + b.y1, z0: p.z + b.z0, z1: p.z + b.z1 });
}

const overlap = (a: number[], b: number[]) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** Same spot and turn (a lamp over a bed). */
const aligned = (a: { x: number; z: number; rot: number }, b: { x: number; z: number; rot: number }) =>
  Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.z - b.z) < 1e-3 && a.rot === b.rot;

/**
 * Why `kind` can't go at (x, z) with turn `rot` on `floor` (placeFloor; null: the sand), or null if it can. `list`: what
 * is placed; `players`: feet of everyone around (nobody gets boxed in by a new hitbox).
 */
export function placeError(kind: string, x: number, z: number, rot: number, floor: number | null, list: Placed[],
  players: { x: number; y: number; z: number }[] = []): string | null {
  if (!isPlaceable(kind)) return TEXT.notice.cantPlace;
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isInteger(rot) || rot < 0 || rot >= turnsOf(kind)) return TEXT.notice.badSpot;
  if (floor === null ? !onSand(kind) : !onFloors(kind)) return floor === null ? TEXT.notice.floorOnly : TEXT.notice.outsideOnly;
  const f = footprint(kind, x, z, rot);
  const sand = floor === null;
  const shelter = sand ? null : shelterAt(x, z);
  if (sand) {
    // Corners and edge midpoints: the footprint's outline, against margins round the structures.
    const corners = [[x, z], [f[0], f[1]], [f[2], f[1]], [f[0], f[3]], [f[2], f[3]]];
    const outline = [...corners, [x, f[1]], [x, f[3]], [f[0], z], [f[2], z]];
    if (outline.some(([cx, cz]) => insideShelter(cx, cz, STRUCTURE_GAP))) return TEXT.notice.tooClose(TEXT.spots.shelter);
    if (rectNearShip(f, SHIP_GAP)) return TEXT.notice.tooClose(TEXT.spots.ship);
    if (outline.some(([cx, cz]) => overTrophy(cx, cz, 0.5))) return TEXT.notice.tooClose(TEXT.spots.trophy);
    const hs = corners.map(([cx, cz]) => heightAt(cx, cz));
    if (Math.max(...hs) - Math.min(...hs) > (PLACEABLES[kind].tilt ?? MAX_TILT)) return TEXT.notice.tooSteep;
  } else if (shelter && Math.abs(shelter.y + shelter.L.floor - floor) < 1e-3) {
    const why = shelterRoomClear(shelter, f);
    if (why === 'floor') return TEXT.notice.floorOnly;
    if (why) return TEXT.notice.tooClose(TEXT.spots[why === 'pump' ? 'pump' : 'doorway']);
  } else return TEXT.notice.floorOnly;
  if (kind === BEACON) {
    if (list.filter((p) => p.kind === BEACON).length >= MAX_BEACONS) return TEXT.notice.tooManyBeacons;
  } else if (counted(kind) && list.filter((p) => counted(p.kind)).length >= MAX_PLACED) return TEXT.notice.tooManyPlaced;
  if (sand) {
    for (const p of list) {
      if (!onSand(p.kind) || standsIndoors(p)) continue;
      const g = footprint(p.kind, p.x, p.z, p.rot);
      const dx = Math.max(g[0] - f[2], f[0] - g[2], 0), dz = Math.max(g[1] - f[3], f[1] - g[3], 0);
      if (Math.hypot(dx, dz) < Math.max(PLACEABLES[kind].gap ?? 0, PLACEABLES[p.kind].gap ?? 0)) return TEXT.notice.tooCloseTo(ITEMS[p.kind]?.label ?? p.kind);
    }
  }
  const y0 = placedY(kind, x, z, rot, floor);
  for (const p of list) {
    if (Math.abs(p.y - y0) > 2 || !overlap(f, footprint(p.kind, p.x, p.z, p.rot))) continue;
    if (PARTNERS[kind] === p.kind && aligned(p, { x, z, rot })) continue;
    return p.kind === PARTNERS[kind] ? TEXT.notice.lineUp(p.kind === 'plant_bed' ? 'bed' : 'lamp') : TEXT.notice.inTheWay;
  }
  // (Nothing low enough to step on boxes anyone in: a bedroll goes down at your feet.)
  if (PLACEABLES[kind].boxes.every((b) => b.y1 < 0.3)) return null;
  const fp = footprint(kind, x, z, rot, 0.4);
  const y = placedY(kind, x, z, rot, floor);
  for (const s of players) {
    if (s.y < y + 2.5 && s.y > y - 2 && s.x > fp[0] && s.x < fp[2] && s.z > fp[1] && s.z < fp[3]) return TEXT.notice.blocked;
  }
  return null;
}

/**
 * Where `kind` would go for a player looking along (yaw, pitch) radians from `feet`: the floor point under
 * the crosshair snapped to the grid, or the spot of a partner (a bed for a lamp, a lone lamp for a bed) under
 * it, or null when the floor is out of reach.
 */
export function placeAim(feet: { x: number; y: number; z: number }, yaw: number, pitch: number, kind: string, rot: number, list: Placed[]): { x: number; z: number; rot: number } | null {
  const cp = Math.cos(pitch);
  const d = [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
  const ey = feet.y + EYE_HEIGHT;
  const snap = (v: number) => Math.round(v / GRID) * GRID;
  const floor = placeFloor(kind, feet);
  if (floor === null) {
    // Down under the sand (in a shelter's corridor, say): where you stand, which placeError turns down.
    if (ey < heightAt(feet.x, feet.z)) return { x: snap(feet.x), z: snap(feet.z), rot };
    // March along the ray to where it goes into the sand, then halve the step a few times.
    let t0 = 0, t1 = -1;
    for (let t = 0.25; t <= SAND_REACH; t += 0.25) {
      if (ey + d[1] * t <= heightAt(feet.x + d[0] * t, feet.z + d[2] * t)) {
        t1 = t;
        break;
      }
      t0 = t;
    }
    if (t1 < 0) return null;
    for (let k = 0; k < 6; k++) {
      const t = (t0 + t1) / 2;
      if (ey + d[1] * t <= heightAt(feet.x + d[0] * t, feet.z + d[2] * t)) t1 = t;
      else t0 = t;
    }
    return { x: snap(feet.x + d[0] * t1), z: snap(feet.z + d[2] * t1), rot };
  }
  if (d[1] > -0.05 || ey < floor) return null;
  const t = (floor - ey) / d[1];
  if (t > PLACE_REACH) return null;
  const x = feet.x + d[0] * t, z = feet.z + d[2] * t;
  const partner = PARTNERS[kind];
  for (const p of list) {
    if (p.kind !== partner || list.some((o) => o.kind === kind && aligned(o, p))) continue;
    const f = footprint(p.kind, p.x, p.z, p.rot);
    if (x > f[0] && x < f[2] && z > f[1] && z < f[3]) return { x: p.x, z: p.z, rot: p.rot };
  }
  return { x: snap(x), z: snap(z), rot };
}

/** Distance from a player's eye to a placed thing's nearest box (0 inside). For server-side reach checks. */
export function placedReach(feet: { x: number; y: number; z: number }, p: Placed): number {
  const ey = feet.y + EYE_HEIGHT;
  let best = Infinity;
  for (const b of worldBoxes(p)) {
    const dx = Math.max(b.x0 - feet.x, 0, feet.x - b.x1);
    const dy = Math.max(b.y0 - ey, 0, ey - b.y1);
    const dz = Math.max(b.z0 - feet.z, 0, feet.z - b.z1);
    best = Math.min(best, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  return best;
}

/** The placed thing under the crosshair (nearest box hit within PLACED_REACH), optionally only of `kind`, or null. */
export function placedTarget(feet: { x: number; y: number; z: number }, yaw: number, pitch: number, list: Placed[], kind?: string): Placed | null {
  const cp = Math.cos(pitch);
  const d = [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
  const e = [feet.x, feet.y + EYE_HEIGHT, feet.z];
  let best: Placed | null = null, bestT = PLACED_REACH;
  for (const p of list) {
    if (kind && p.kind !== kind) continue;
    for (const b of worldBoxes(p)) {
      // Slab test: the ray's entry is the latest of the three near-plane crossings.
      const lo = [b.x0, b.y0, b.z0], hi = [b.x1, b.y1, b.z1];
      let t0 = 0, t1 = Infinity, miss = false;
      for (let k = 0; k < 3 && !miss; k++) {
        if (Math.abs(d[k]) < 1e-9) {
          miss = e[k] < lo[k] || e[k] > hi[k];
          continue;
        }
        const a = (lo[k] - e[k]) / d[k], c = (hi[k] - e[k]) / d[k];
        t0 = Math.max(t0, Math.min(a, c));
        t1 = Math.min(t1, Math.max(a, c));
      }
      if (!miss && t0 <= t1 && t0 < bestT) {
        bestT = t0;
        best = p;
      }
    }
  }
  return best;
}

/** Is there a UV lamp standing over this bed? */
export const bedLit = (bed: Placed, list: Placed[] = placed) => list.some((p) => p.kind === 'uv_lamp' && aligned(p, bed));
