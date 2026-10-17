// The greenhouse planter beds: which beds there are (the planter pieces in shared/base.ts), their growth
// stages, and which bed the player is looking at. The server owns the stages (server/garden.ts): F on an
// empty bed plants it, sprouts grow on their own after GROW_MS, F on a grown bed harvests it back to soil.
import { BASE, BASE_PIECES } from './base.ts';
import { EYE_HEIGHT, pitchFromQ } from './dig.ts';
import { yawFromQ } from './sim.ts';

export const EMPTY = 0;
export const SPROUTS = 1;
export const GROWN = 2;
/** Model node (greenhouse.glb) for each stage. */
export const STAGE_NODES = ['planter_empty', 'planter_sprouts', 'planter_grown'];
/** Sprouts become a grown bed this long after planting. */
export const GROW_MS = 6 * 60 * 1000;
/** How far from the eye a bed can be tended, metres. */
export const TEND_REACH = 4;

/** A bed: world position of its centre on the floor, and its stage in the layout (a fresh world). */
export type Bed = { x: number; z: number; initial: number };

export const BEDS: Bed[] = BASE_PIECES.filter((p) => STAGE_NODES.includes(p.node)).map((p) => ({
  x: BASE.x + p.x,
  z: BASE.z + p.z,
  initial: STAGE_NODES.indexOf(p.node),
}));

/** Look-target box around a bed (its frame, 2.4 × 1 m and 0.75 m high): half extents and height. Beds face
 *  ±Z, so the box stays axis-aligned. */
const HX = 1.2, HZ = 0.5, H = 0.75;

/** Distance from the eye to bed i's box (0 inside it). For server-side reach checks. */
export function bedReach(feet: { x: number; y: number; z: number }, i: number): number {
  const b = BEDS[i];
  const ey = feet.y + EYE_HEIGHT;
  const dx = Math.max(Math.abs(feet.x - b.x) - HX, 0);
  const dy = Math.max(BASE.y - ey, 0, ey - (BASE.y + H));
  const dz = Math.max(Math.abs(feet.z - b.z) - HZ, 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** The bed the player is looking at (nearest box hit by the look ray within TEND_REACH), or -1. */
export function bedTarget(feet: { x: number; y: number; z: number }, yawQ: number, pitchQ: number): number {
  const yaw = yawFromQ(yawQ), pitch = pitchFromQ(pitchQ);
  const cp = Math.cos(pitch);
  const d = [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
  const e = [feet.x, feet.y + EYE_HEIGHT, feet.z];
  let best = -1, bestT = TEND_REACH;
  BEDS.forEach((b, i) => {
    // Slab test: the ray's entry is the latest of the three near-plane crossings.
    const lo = [b.x - HX, BASE.y, b.z - HZ], hi = [b.x + HX, BASE.y + H, b.z + HZ];
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
