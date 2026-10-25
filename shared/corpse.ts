// Dying costs your pack: everything in the bag past the hotbar (the backpack's grid, and anything stranded past it)
// is left at the spot where you fell, in a bundle on the sand with a stick and a rag of your colour planted beside it
// (src/world/corpses.ts). The hotbar and the worn equipment stay with you. Anyone can open it like a chest (Tab, or F
// beside it) and take what's in it, but nothing can be put in; it goes when it's empty or after CORPSE_MS.
// Dying in or over a shelter leaves nothing (nothing can be dropped there, shared/loot.ts canDropAt).
// The server (server/corpses.ts) keeps the list in SQLite and tells clients ('corpses'); both keep CORPSES up to
// date, so shared/storage.ts can say which packs are in reach. Each one's items are box `corpse<id>`, shared.
import { boxNumber } from './boxes.ts';

export type Corpse = {
  id: number;
  x: number;
  z: number;
  /** The dead player's colour, for the rag. */
  color: number;
  /** Estimated expiry while its owner plays; the server pauses recovery time while they are offline. */
  until: number;
};

/** Recovery time (ms of the owner's play time) before a pack is gone with whatever is still in it. */
export const CORPSE_MS = 30 * 60_000;

/** It opens when your feet are this close (m, horizontally). */
export const CORPSE_REACH = 2.5;

/** The packs lying in the world by id. */
export const CORPSES = new Map<number, Corpse>();

export const corpseBox = (id: number) => `corpse${id}`;

/** A pack's id from its box id, or -1 (also for one that isn't there). Nothing may be put in one (shared/boxes.ts takeOnly). */
export function corpseId(box: string): number {
  const id = boxNumber('corpse', box);
  return CORPSES.has(id) ? id : -1;
}

/** Box ids of the packs within reach of `s`, nearest first. */
export function corpsesNear(s: { x: number; z: number }, slack = 0): string[] {
  return [...CORPSES.values()]
    .map((c) => ({ c, d: Math.hypot(s.x - c.x, s.z - c.z) }))
    .filter((o) => o.d < CORPSE_REACH + slack)
    .sort((a, b) => a.d - b.d)
    .map((o) => corpseBox(o.c.id));
}
