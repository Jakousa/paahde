// Storage: the item boxes a player can reach besides their bag (shared/items.ts). Chests stand in the
// base (the 'chest' pieces in shared/base.ts) and are shared by everyone, and never fill up (growChest); the sand bike has a cargo grid of
// its own, reachable while riding it. A building standing in the world keeps its item in a box of its own ('bld<id>',
// shared/gear.ts buildingBox), shared too, open within reach of it, to swap its parts. Every player also has their equipment ('equip', shared/gear.ts),
// always open, and a slot on the workbench ('bench') for the item they are repairing, open beside it. The client lists whatever is open next to the bag in the Tab
// inventory (src/inventory.ts); the server checks the same thing, with slack, before every move.
import { BASE, BASE_PIECES } from './base.ts';
import { corpseId, corpsesNear } from './corpse.ts';
import { buildingId, EQUIP_SLOTS, isBuilding } from './gear.ts';
import { BAG_SLOTS, BIKE_COLS, BIKE_ROWS, CHEST_COLS, CHEST_ROWS, coverage, gridShape, ITEMS, MAX_SIDE, type Slots } from './items.ts';
import { placed, PLACED_REACH, placedReach } from './placed.ts';
import type { PlayerState } from './sim.ts';
import { STATION_REACH, STATIONS, stationReach } from './stations.ts';
import { TEXT } from './text.ts';

/** A chest opens when your feet are this close (m, horizontally) to its centre, on its floor. */
export const STORAGE_REACH = 2.5;

/** Chest i is box `chest<i>`. */
export const CHESTS = BASE_PIECES.filter((p) => p.node === 'chest').map((p) => ({
  x: BASE.x + p.x, y: BASE.y + (p.y ?? 0), z: BASE.z + p.z,
}));

/** Box ids: 'bag', 'equip', 'bench' and 'bike' are the player's own, 'chest<i>', the packs left by the dead
 *  ('corpse<id>', shared/corpse.ts) and the buildings' ('bld<id>') are shared. */
export type BoxId = 'bag' | 'equip' | 'bench' | 'bike' | `chest${number}` | `corpse${number}` | `bld${number}`;
/** The player's own boxes. */
export const OWN_BOXES = ['bag', 'equip', 'bench', 'bike'];

const WORKBENCH = STATIONS.findIndex((s) => s.kind === 'workbench');

export function boxSize(box: string): number {
  if (box === 'bag') return BAG_SLOTS;
  if (box === 'equip') return EQUIP_SLOTS.length;
  if (box === 'bench') return 1;
  if (box === 'bike') return BIKE_COLS * BIKE_ROWS;
  if (buildingId(box) >= 0) return building(box) ? 1 : 0;
  return chestIndex(box) >= 0 || corpseId(box) >= 0 ? CHEST_COLS * CHEST_ROWS : 0;
}

/**
 * Chests are endless: resize a chest's grid to MAX_SIDE empty rows past the lowest item (so anything fits, turned
 * if need be), at least CHEST_ROWS, in place. Run after anything changes one, on the server and in the client's
 * prediction alike, so both agree on its size.
 */
export function growChest(slots: Slots) {
  const cov = coverage(slots, gridShape(CHEST_COLS, Math.ceil(slots.length / CHEST_COLS)));
  let used = cov.length;
  while (used > 0 && cov[used - 1] < 0) used--;
  const n = Math.max(CHEST_ROWS, Math.ceil(used / CHEST_COLS) + MAX_SIDE) * CHEST_COLS;
  const old = slots.length;
  slots.length = n;
  if (n > old) slots.fill(null, old);
}

/** Chest index from a box id, or -1. */
export function chestIndex(box: string): number {
  const m = /^chest(\d+)$/.exec(box);
  const i = m ? Number(m[1]) : -1;
  return i < CHESTS.length ? i : -1;
}

/** The building standing in the world whose box this is, or undefined. */
export const building = (box: string) => {
  const id = buildingId(box);
  return id < 0 ? undefined : placed.find((p) => p.id === id && isBuilding(p.kind));
};

/** Chests and packs grow without end (growChest); a building's box is one slot. */
export const grows = (box: string) => chestIndex(box) >= 0 || corpseId(box) >= 0;

/** Shared boxes are owned by nobody (''); the others by the player. */
export const isShared = (box: string) => chestIndex(box) >= 0 || corpseId(box) >= 0 || buildingId(box) >= 0;

export function boxLabel(box: string): string {
  if (box === 'bag') return TEXT.boxes.bag;
  if (box === 'equip') return TEXT.boxes.equip;
  if (box === 'bench') return TEXT.boxes.bench;
  if (box === 'bike') return TEXT.boxes.bike;
  if (corpseId(box) >= 0) return TEXT.boxes.corpse;
  const b = building(box);
  if (b) return ITEMS[b.kind].label;
  return CHESTS.length > 1 ? TEXT.boxes.chestN(chestIndex(box) + 1) : TEXT.boxes.chest;
}

/** Boxes open to a player standing at `s` besides the bag, nearest chest first. */
export function openBoxes(s: PlayerState, slack = 0): BoxId[] {
  const out: BoxId[] = [];
  if (WORKBENCH >= 0 && stationReach(s, WORKBENCH) < STATION_REACH + slack) out.push('bench');
  if (s.riding) out.push('bike');
  const near = CHESTS.map((c, i) => ({ i, d: Math.hypot(s.x - c.x, s.z - c.z), dy: Math.abs(s.y - c.y) }))
    .filter((c) => c.d < STORAGE_REACH + slack && c.dy < 1.5 + slack)
    .sort((a, b) => a.d - b.d);
  for (const c of near) out.push(`chest${c.i}`);
  for (const b of corpsesNear(s, slack)) out.push(b as BoxId);
  // Buildings in reach, nearest first.
  const near2 = placed.filter((p) => isBuilding(p.kind)).map((p) => ({ p, d: placedReach(s, p) }))
    .filter((b) => b.d < PLACED_REACH + slack)
    .sort((a, b) => a.d - b.d);
  for (const b of near2) out.push(`bld${b.p.id}`);
  return out;
}

/** Can a player at `s` use this box? */
export const canOpen = (s: PlayerState, box: string, slack = 0) => box === 'bag' || box === 'equip' || openBoxes(s, slack).includes(box as BoxId);
