// Storage: the item boxes a player can reach besides their bag (shared/items.ts). Chests stand in the
// base (the 'chest' pieces in shared/base.ts) and are shared by everyone; the sand bike has a few slots of
// its own, reachable while riding it. The client lists whatever is open next to the bag in the Tab
// inventory (src/inventory.ts); the server checks the same thing, with slack, before every move.
import { BASE, BASE_PIECES } from './base.ts';
import { BAG_SLOTS } from './items.ts';
import type { PlayerState } from './sim.ts';

export const CHEST_SLOTS = 16;
export const BIKE_SLOTS = 8;
/** A chest opens when your feet are this close (m, horizontally) to its centre, on its floor. */
export const STORAGE_REACH = 2.5;

/** Chest i is box `chest<i>`. */
export const CHESTS = BASE_PIECES.filter((p) => p.node === 'chest').map((p) => ({
  x: BASE.x + p.x, y: BASE.y + (p.y ?? 0), z: BASE.z + p.z,
}));

/** Box ids: 'bag' and 'bike' are the player's own, 'chest<i>' are shared. */
export type BoxId = 'bag' | 'bike' | `chest${number}`;

export function boxSize(box: string): number {
  if (box === 'bag') return BAG_SLOTS;
  if (box === 'bike') return BIKE_SLOTS;
  return chestIndex(box) >= 0 ? CHEST_SLOTS : 0;
}

/** Chest index from a box id, or -1. */
export function chestIndex(box: string): number {
  const m = /^chest(\d+)$/.exec(box);
  const i = m ? Number(m[1]) : -1;
  return i < CHESTS.length ? i : -1;
}

/** Shared boxes are owned by nobody (''); the others by the player. */
export const isShared = (box: string) => chestIndex(box) >= 0;

export function boxLabel(box: string): string {
  if (box === 'bag') return 'Backpack';
  if (box === 'bike') return 'Sand bike';
  return CHESTS.length > 1 ? `Chest ${chestIndex(box) + 1}` : 'Chest';
}

/** Boxes open to a player standing at `s` besides the bag, nearest chest first. */
export function openBoxes(s: PlayerState, slack = 0): BoxId[] {
  const out: BoxId[] = [];
  if (s.riding) out.push('bike');
  const near = CHESTS.map((c, i) => ({ i, d: Math.hypot(s.x - c.x, s.z - c.z), dy: Math.abs(s.y - c.y) }))
    .filter((c) => c.d < STORAGE_REACH + slack && c.dy < 1.5 + slack)
    .sort((a, b) => a.d - b.d);
  for (const c of near) out.push(`chest${c.i}`);
  return out;
}

/** Can a player at `s` use this box? */
export const canOpen = (s: PlayerState, box: string, slack = 0) => box === 'bag' || openBoxes(s, slack).includes(box as BoxId);
