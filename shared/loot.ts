// Loot in the world (server/loot.ts): broken gear lying at crash sites and near the spawn, caches buried in
// the sand (depth > 0: only the metal detector finds them, src/detector.ts; dig down to it and it comes up).
// The client draws what's on the surface (src/world/loot.ts) and F picks it up.
export type Loot = {
  id: number;
  /** Item kind (shared/items.ts). */
  kind: string;
  /** Gear: the parts it comes with (shared/gear.ts), null where one is missing. */
  parts?: (string | null)[];
  x: number;
  z: number;
  /** Metres under the undisturbed sand; 0 once it's on the surface. */
  depth: number;
  src: 'find' | 'cache';
  /** A find that belongs near the spawn point (it comes back there). */
  near?: boolean;
};

/** F picks up loot within this distance of the feet (m, horizontally). */
export const LOOT_REACH = 2.5;

export function lootReach(feet: { x: number; z: number }, l: { x: number; z: number }, slack = 0): boolean {
  return Math.hypot(feet.x - l.x, feet.z - l.z) < LOOT_REACH + slack;
}
