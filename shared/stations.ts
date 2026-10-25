// Work stations: the crafting workbench and the dismantling table (disassembly), every one put up with the wrench
// (shared/placed.ts WORKBENCH, TABLE), and which one the player is looking at. At a workbench, the 'bench' box (the repair slot) and the recipes are open (shared/storage.ts openBoxes,
// server/items.ts craft); a carried machine is taken apart on a table (shared/crash.ts tables, server/crash.ts). The
// server checks reach with stationReach().
import { EYE_HEIGHT, pitchFromQ } from './dig.ts';
import { placed, PLACEABLES, TABLE, WORKBENCH, type Placed } from './placed.ts';
import { yawFromQ } from './sim.ts';

/** How far from the eye a station can be used, metres. */
export const STATION_REACH = 3;

export const STATION_KINDS = ['workbench', 'disassembly'] as const;
export type StationKind = (typeof STATION_KINDS)[number];

/** A station: its kind, the placed thing it is, and its look-target box (world, axis-aligned: stations face ±X or ±Z). */
export type Station = { kind: StationKind; placed: number; x0: number; y0: number; z0: number; x1: number; y1: number; z1: number };

/** A placed station's kind and the height of its working top. (Looked up when called: shared/placed.ts may not be
 *  loaded yet while this module is, the two import each other's neighbours.) */
const topOf = (kind: string): { kind: StationKind; h: number } | null =>
  kind === WORKBENCH ? { kind: 'workbench', h: 0.95 } : kind === TABLE ? { kind: 'disassembly', h: 0.82 } : null;

function placedStation(p: Placed): Station[] {
  const t = topOf(p.kind);
  if (!t) return [];
  const k = PLACEABLES[p.kind];
  // The table's tools stick out past its top: the box is the top itself (2 × 2 m).
  const hx0 = p.kind === TABLE ? 1 : k.hx, hz0 = p.kind === TABLE ? 1 : k.hz;
  const hx = p.rot & 1 ? hz0 : hx0, hz = p.rot & 1 ? hx0 : hz0;
  return [{ kind: t.kind, placed: p.id, x0: p.x - hx, y0: p.y, z0: p.z - hz, x1: p.x + hx, y1: p.y + t.h, z1: p.z + hz }];
}

let cache: { list: Placed[] | null; out: Station[] } = { list: null, out: [] };
/** Every station in the world now: the placed ones (shared/placed.ts `placed`). */
export function stations(): Station[] {
  if (cache.list !== placed) cache = { list: placed, out: placed.flatMap(placedStation) };
  return cache.out;
}

/** Distance from the eye to a station's box (0 inside it). For server-side reach checks. */
export function stationReach(feet: { x: number; y: number; z: number }, s: Station): number {
  const ey = feet.y + EYE_HEIGHT;
  const dx = Math.max(s.x0 - feet.x, 0, feet.x - s.x1);
  const dy = Math.max(s.y0 - ey, 0, ey - s.y1);
  const dz = Math.max(s.z0 - feet.z, 0, feet.z - s.z1);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Is a station of `kind` within reach (+ slack) of a player at `feet`? */
export const nearStation = (feet: { x: number; y: number; z: number }, kind: StationKind, slack = 0) =>
  stations().some((s) => s.kind === kind && stationReach(feet, s) < STATION_REACH + slack);

/** The station the player is looking at (nearest box hit by the look ray within STATION_REACH), or null. */
export function stationTarget(feet: { x: number; y: number; z: number }, yawQ: number, pitchQ: number): Station | null {
  const yaw = yawFromQ(yawQ), pitch = pitchFromQ(pitchQ);
  const cp = Math.cos(pitch);
  const d = [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
  const e = [feet.x, feet.y + EYE_HEIGHT, feet.z];
  let best: Station | null = null, bestT = STATION_REACH;
  for (const s of stations()) {
    if (stationReach(feet, s) > STATION_REACH) continue;
    // Slab test: the ray's entry is the latest of the three near-plane crossings.
    const lo = [s.x0, s.y0, s.z0], hi = [s.x1, s.y1, s.z1];
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
      best = s;
    }
  }
  return best;
}
