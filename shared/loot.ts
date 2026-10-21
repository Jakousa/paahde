// Loot in the world (server/loot.ts): broken gear lying at crash sites and near the spawn, caches out in the desert.
// Players can also drop items from the Tab inventory: they lie on the sand (src 'drop') until someone takes them.
// Stashes lie on shelter floors (shared/shelters.ts) instead of the sand over them (lootY).
// The client draws it (src/world/loot.ts) and F picks it up.
import { insideBase, overBase } from './base.ts';
import { overShelter, shelterFloorY } from './shelters.ts';
import { heightAt } from './terrain.ts';

export type Loot = {
  id: number;
  /** Item kind (shared/items.ts). */
  kind: string;
  /** Gear: the parts it comes with (shared/gear.ts), null where one is missing. */
  parts?: (string | null)[];
  /** A dropped shield plate's wear (shared/items.ts Item). */
  worn?: number;
  x: number;
  z: number;
  src: 'find' | 'cache' | 'drop';
};

/** F picks up loot within this distance of the feet (m, horizontally). */
export const LOOT_REACH = 2.5;

/** Dropped items land this far (m) in front of the feet, well within LOOT_REACH. */
export const DROP_AHEAD = 1.2;

/** Not in or over the base or a shelter: it would lie on the sand above the bunker (the chests are for that). */
export const canDropAt = (x: number, z: number) => !overBase(x, z, 2) && !insideBase(x, z, 2) && !overShelter(x, z, 2);

/** The height (world) loot at (x, z) lies at: a shelter's floor, or the sand. */
export function lootY(l: { x: number; z: number }): number {
  return shelterFloorY(l.x, l.z) ?? heightAt(l.x, l.z);
}

/** Feet within reach: LOOT_REACH across, and about level with it (not on the sand over a shelter's stash). */
export function lootReach(feet: { x: number; y: number; z: number }, l: { x: number; z: number }, slack = 0): boolean {
  return Math.hypot(feet.x - l.x, feet.z - l.z) < LOOT_REACH + slack && Math.abs(feet.y - lootY(l)) < 2.5 + slack;
}
