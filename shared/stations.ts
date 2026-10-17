// Work stations in the base: the crafting workbench and the disassembly table (pieces in shared/base.ts),
// and which one the player is looking at. Interacting does nothing yet besides a hint (src/main.ts); when
// they do something, the server checks reach with stationReach().
import { BASE, BASE_PIECES } from './base.ts';
import { EYE_HEIGHT, pitchFromQ } from './dig.ts';
import { yawFromQ } from './sim.ts';

/** How far from the eye a station can be used, metres. */
export const STATION_REACH = 3;

export const STATION_KINDS = ['workbench', 'disassembly'] as const;
export type StationKind = (typeof STATION_KINDS)[number];

/** A station: its kind and its look-target box (world, axis-aligned: stations face ±X or ±Z). */
export type Station = { kind: StationKind; x0: number; y0: number; z0: number; x1: number; y1: number; z1: number };

export const STATIONS: Station[] = BASE_PIECES.flatMap((p) => {
  const kind = STATION_KINDS.find((k) => k === p.node);
  if (!kind || !p.hx || !p.hz || !p.h) return [];
  // Facing ±X turns the footprint's long side along Z.
  const sideways = Math.abs(p.fx) > Math.abs(p.fz);
  const hx = sideways ? p.hz : p.hx, hz = sideways ? p.hx : p.hz;
  const x = BASE.x + p.x, z = BASE.z + p.z, y = BASE.y + (p.y ?? 0);
  return [{ kind, x0: x - hx, y0: y, z0: z - hz, x1: x + hx, y1: y + p.h, z1: z + hz }];
});

/** Distance from the eye to station i's box (0 inside it). For server-side reach checks. */
export function stationReach(feet: { x: number; y: number; z: number }, i: number): number {
  const s = STATIONS[i];
  const ey = feet.y + EYE_HEIGHT;
  const dx = Math.max(s.x0 - feet.x, 0, feet.x - s.x1);
  const dy = Math.max(s.y0 - ey, 0, ey - s.y1);
  const dz = Math.max(s.z0 - feet.z, 0, feet.z - s.z1);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** The station the player is looking at (nearest box hit by the look ray within STATION_REACH), or -1. */
export function stationTarget(feet: { x: number; y: number; z: number }, yawQ: number, pitchQ: number): number {
  const yaw = yawFromQ(yawQ), pitch = pitchFromQ(pitchQ);
  const cp = Math.cos(pitch);
  const d = [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
  const e = [feet.x, feet.y + EYE_HEIGHT, feet.z];
  let best = -1, bestT = STATION_REACH;
  STATIONS.forEach((s, i) => {
    // Slab test: the ray's entry is the latest of the three near-plane crossings.
    const lo = [s.x0, s.y0, s.z0], hi = [s.x1, s.y1, s.z1];
    let t0 = 0, t1 = Infinity;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-9) {
        if (e[k] < lo[k] || e[k] > hi[k]) return;
        continue;
      }
      const a = (lo[k] - e[k]) / d[k], c = (hi[k] - e[k]) / d[k];
      t0 = Math.max(t0, Math.min(a, c));
      t1 = Math.min(t1, Math.max(a, c));
    }
    if (t0 <= t1 && t0 < bestT) {
      bestT = t0;
      best = i;
    }
  });
  return best;
}
