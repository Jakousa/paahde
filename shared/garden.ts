// Plant beds: the plant beds players placed on a shelter's floor (shared/placed.ts, kind 'plant_bed'), their growth
// stages, and which bed the player is looking at. The server owns the stages (server/garden.ts): F on an
// empty bed plants it, sprouts grow only under a UV lamp (a uv_lamp placed over the bed) and are grown
// after GROW_MS of lamp light, F on a grown bed harvests it back to soil. Without a lamp sprouts just wait.
import { placedTarget, type Placed } from './placed.ts';
import { pitchFromQ } from './dig.ts';
import { yawFromQ } from './sim.ts';

export const EMPTY = 0;
export const SPROUTS = 1;
export const GROWN = 2;
/** Object in plant_bed.glb (tools/blender/placeables.py) shown for each stage; the bed itself is always there. */
export const STAGE_NODES = ['', 'plant_bed_sprouts', 'plant_bed_grown'];
/** Sprouts are grown after this long under a UV lamp. */
export const GROW_MS = 6 * 60 * 1000;
/** How far from the eye a bed can be tended, metres. */
export const TEND_REACH = 4;

/** A bed's state as the server sends it: placed id, stage, and growth under the lamp so far (0..1). */
export type BedState = { id: number; stage: number; grow: number };

/** The bed the player is looking at, or null. */
export function bedTarget(feet: { x: number; y: number; z: number }, yawQ: number, pitchQ: number, list: Placed[]): Placed | null {
  return placedTarget(feet, yawFromQ(yawQ), pitchFromQ(pitchQ), list, 'plant_bed');
}
