// Placed things: items from the bag (the PLACEABLES kinds of shared/items.ts) standing on the bunker floor —
// plant beds and UV lamp stands so far (GitHub #22–#24). The server owns the list (server/placed.ts, `placed`
// table) and sends it whole on join and when it changes; client and server both keep it here with setPlaced(),
// which also hands their floor-standing parts to the base's collision (shared/base.ts setPlacedCapsules), so
// prediction and the server collide with the same things.
//
// Rules (placeError): only on the main room's floor, clear of the walls, the hallway mouth, the pump, the work
// stations and the chest, and not overlapping another placed thing — except that a UV lamp and a plant bed
// share their spot when aligned exactly (same centre and turn): the lamp's legs straddle the bed's short ends.
// placeAim() snaps the aim point to a 0.25 m grid, or onto a bed / lamp waiting for its partner.
//
// Same determinism rules as shared/base.ts for anything collision touches: + - * /, Math.sqrt, Math.abs,
// Math.min/max only.
import { BASE, BASE_PIECES, FLOOR, HALL, ROOM, setPlacedCapsules, W, type Capsule } from './base.ts';
import { EYE_HEIGHT } from './dig.ts';
import { TEXT } from './text.ts';

/** A placed thing: DB id, item kind, world position of its footprint centre on the floor, and its turn
 *  (0: long side along X, 1: along Z). */
export type Placed = { id: number; kind: string; x: number; z: number; rot: number };

/** An axis-aligned box in the thing's own frame (rot 0), metres above the floor. */
type Box = { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };

/** Each placeable kind: footprint half extents (rot 0) and its look/collision boxes. Boxes standing on the
 *  floor (y0 = 0) collide. Sizes match tools/blender/placeables.py. */
export const PLACEABLES: Record<string, { hx: number; hz: number; boxes: Box[] }> = {
  plant_bed: { hx: 0.82, hz: 0.42, boxes: [{ x0: -0.8, x1: 0.8, y0: 0, y1: 0.52, z0: -0.4, z1: 0.4 }] },
  uv_lamp: {
    hx: 0.99, hz: 0.27,
    boxes: [
      { x0: -0.99, x1: -0.89, y0: 0, y1: 2.0, z0: -0.26, z1: 0.26 },
      { x0: 0.89, x1: 0.99, y0: 0, y1: 2.0, z0: -0.26, z1: 0.26 },
      { x0: -0.89, x1: 0.89, y0: 1.8, y1: 2.05, z0: -0.11, z1: 0.11 },
    ],
  },
};

export const isPlaceable = (kind: string | undefined) => !!kind && kind in PLACEABLES;

/** These two kinds may stand in the same spot when aligned. */
const PARTNERS: Record<string, string> = { plant_bed: 'uv_lamp', uv_lamp: 'plant_bed' };

/** How far from the eye you can put something down (to the aim point on the floor). */
export const PLACE_REACH = 5;
/** How far from the eye a placed thing can be picked up. */
export const PLACED_REACH = 4;
/** At most this many things placed in the base. */
export const MAX_PLACED = 40;
/** Aim snaps to this grid (m, from the base origin). */
const GRID = 0.25;
/** World height of the bunker floor. */
export const PLACE_FLOOR_Y = BASE.y + FLOOR;

/** Everything placed right now (from the server). Replace it with setPlaced(). */
export let placed: Placed[] = [];

/** Replace the list, and the collision of what stands on the floor. */
export function setPlaced(list: Placed[]) {
  placed = list;
  const caps: Capsule[] = [];
  for (const p of list) {
    for (const b of worldBoxes(p)) {
      if (b.y0 > PLACE_FLOOR_Y + 1e-6) continue;
      // Capsule along the box's longer side, in base-local coordinates.
      const hx = (b.x1 - b.x0) / 2, hz = (b.z1 - b.z0) / 2, alongX = hx >= hz;
      const r = alongX ? hz : hx;
      caps.push({ x: (b.x0 + b.x1) / 2 - BASE.x, z: (b.z0 + b.z1) / 2 - BASE.z, ax: alongX ? 1 : 0, az: alongX ? 0 : 1,
        half: (alongX ? hx : hz) - r, r, y0: b.y0 - BASE.y, top: b.y1 - BASE.y });
    }
  }
  setPlacedCapsules(caps);
}

/** World rectangle [x0, z0, x1, z1] of a footprint. */
function footprint(kind: string, x: number, z: number, rot: number, m = 0): [number, number, number, number] {
  const k = PLACEABLES[kind];
  const hx = (rot ? k.hz : k.hx) + m, hz = (rot ? k.hx : k.hz) + m;
  return [x - hx, z - hz, x + hx, z + hz];
}

/** A placed thing's boxes in world coordinates. */
export function worldBoxes(p: Placed): Box[] {
  return PLACEABLES[p.kind].boxes.map((b) => p.rot
    ? { x0: p.x + b.z0, x1: p.x + b.z1, y0: PLACE_FLOOR_Y + b.y0, y1: PLACE_FLOOR_Y + b.y1, z0: p.z + b.x0, z1: p.z + b.x1 }
    : { x0: p.x + b.x0, x1: p.x + b.x1, y0: PLACE_FLOOR_Y + b.y0, y1: PLACE_FLOOR_Y + b.y1, z0: p.z + b.z0, z1: p.z + b.z1 });
}

const overlap = (a: number[], b: number[]) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** Same spot and turn (a lamp over a bed). */
const aligned = (a: { x: number; z: number; rot: number }, b: { x: number; z: number; rot: number }) =>
  Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.z - b.z) < 1e-3 && a.rot === b.rot;

/** World rectangles kept clear around the base's own pieces (pump, stations, chest) and the hallway mouth. */
const KEEP_CLEAR: { what: string; r: number[] }[] = [
  ...BASE_PIECES.filter((p) => p.hx && p.hz).map((p) => {
    const sideways = Math.abs(p.fx) > Math.abs(p.fz);
    const m = p.node === 'pump' ? 0.9 : 0.5; // room to reach the pump and to stand at a station
    const hx = (sideways ? p.hz! : p.hx!) + m, hz = (sideways ? p.hx! : p.hz!) + m;
    const x = BASE.x + p.x, z = BASE.z + p.z;
    const spots = TEXT.baseSpots;
    return { what: p.node === 'pump' ? spots.pump : p.node === 'chest' ? spots.chest : p.node === 'workbench' ? spots.workbench : spots.table, r: [x - hx, z - hz, x + hx, z + hz] };
  }),
  { what: TEXT.baseSpots.doorway, r: [BASE.x - W - 0.4, BASE.z + HALL.z - 1.2, BASE.x + W + 0.4, BASE.z + HALL.z + 1] },
];

/**
 * Why `kind` can't go at (x, z) with turn `rot`, or null if it can. `list`: what is placed; `players`: feet of
 * everyone around (nobody gets boxed in by a new hitbox).
 */
export function placeError(kind: string, x: number, z: number, rot: number, list: Placed[], players: { x: number; y: number; z: number }[] = []): string | null {
  if (!isPlaceable(kind)) return TEXT.notice.cantPlace;
  if (!Number.isFinite(x) || !Number.isFinite(z) || (rot !== 0 && rot !== 1)) return TEXT.notice.badSpot;
  const f = footprint(kind, x, z, rot);
  const m = 0.05;
  if (f[0] < BASE.x - ROOM.w + m || f[2] > BASE.x + ROOM.w - m || f[1] < BASE.z + ROOM.z + m || f[3] > BASE.z + HALL.z - m) {
    return TEXT.notice.floorOnly;
  }
  for (const k of KEEP_CLEAR) if (overlap(f, k.r)) return TEXT.notice.tooClose(k.what);
  if (list.length >= MAX_PLACED) return TEXT.notice.baseFull;
  for (const p of list) {
    if (!overlap(f, footprint(p.kind, p.x, p.z, p.rot))) continue;
    if (PARTNERS[kind] === p.kind && aligned(p, { x, z, rot })) continue;
    return p.kind === PARTNERS[kind] ? TEXT.notice.lineUp(p.kind === 'plant_bed' ? 'bed' : 'lamp') : TEXT.notice.inTheWay;
  }
  const fp = footprint(kind, x, z, rot, 0.4);
  for (const s of players) {
    if (s.y < PLACE_FLOOR_Y + 2.5 && s.x > fp[0] && s.x < fp[2] && s.z > fp[1] && s.z < fp[3]) return TEXT.notice.blocked;
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
  if (d[1] > -0.05 || ey < PLACE_FLOOR_Y) return null;
  const t = (PLACE_FLOOR_Y - ey) / d[1];
  if (t > PLACE_REACH) return null;
  const x = feet.x + d[0] * t, z = feet.z + d[2] * t;
  const partner = PARTNERS[kind];
  for (const p of list) {
    if (p.kind !== partner || list.some((o) => o.kind === kind && aligned(o, p))) continue;
    const f = footprint(p.kind, p.x, p.z, p.rot);
    if (x > f[0] && x < f[2] && z > f[1] && z < f[3]) return { x: p.x, z: p.z, rot: p.rot };
  }
  const snap = (v: number, o: number) => o + Math.round((v - o) / GRID) * GRID;
  return { x: snap(x, BASE.x), z: snap(z, BASE.z), rot };
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
