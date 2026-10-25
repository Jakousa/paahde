// Storage: the item boxes a player can reach besides their bag (shared/items.ts). Chests stand in the
// base (the 'chest' pieces in shared/base.ts) and are shared by everyone, and never fill up (growChest). A vehicle
// standing in the world (shared/vehicles.ts) keeps its item in a box of its own ('veh<id>', to fit its parts) and has a
// cargo grid ('cargo<id>'), both shared and open in reach of it while nobody rides it. A building standing in the world keeps its item in a box of its own ('bld<id>',
// shared/boxes.ts buildingBox), shared too, open within reach of it, to swap its parts. Every player also has their equipment ('equip', shared/gear.ts),
// always open, and a slot on the workbench ('bench') for the item they are repairing, open beside it. The client lists whatever is open next to the bag in the Tab
// inventory (src/inventory.ts); the server checks the same thing, with slack, before every move.
import { BASE, BASE_PIECES } from './base.ts';
import { corpseId, corpsesNear } from './corpse.ts';
import { boxKind, boxNumber, buildingId, cargoId, vehicleId, type BoxKind } from './boxes.ts';
import { EQUIP_SLOTS, isBuilding } from './gear.ts';
import { BAG_SLOTS, BIKE_COLS, BIKE_ROWS, CHEST_COLS, CHEST_ROWS, coverage, gridShape, ITEMS, MAX_SIDE, type Slots } from './items.ts';
import { placed, PLACED_REACH, placedReach } from './placed.ts';
import type { PlayerState } from './sim.ts';
import { vehicleById, vehiclesNear } from './vehicles.ts';
import { STATION_REACH, STATIONS, stationReach } from './stations.ts';
import { TEXT } from './text.ts';

/** A chest opens when your feet are this close (m, horizontally) to its centre, on its floor. */
export const STORAGE_REACH = 2.5;

/** Chest i is box `chest<i>`. */
export const CHESTS = BASE_PIECES.filter((p) => p.node === 'chest').map((p) => ({
  x: BASE.x + p.x, y: BASE.y + (p.y ?? 0), z: BASE.z + p.z,
}));

/** Box ids: 'bag', 'equip' and 'bench' are the player's own, 'chest<i>', the packs left by the dead
 *  ('corpse<id>', shared/corpse.ts), the buildings' ('bld<id>') and the vehicles' ('veh<id>', 'cargo<id>') are shared. */
export type BoxId = 'bag' | 'equip' | 'bench' | `chest${number}` | `corpse${number}` | `bld${number}` | `veh${number}` | `cargo${number}`;
/** The player's own boxes. */
export const OWN_BOXES = ['bag', 'equip', 'bench'];

const WORKBENCH = STATIONS.findIndex((s) => s.kind === 'workbench');

/** How many slots a box has to start with (0: there's no such box, or it isn't there now). */
export function boxSize(box: string): number {
  const k = boxKind(box);
  return k ? SIZES[k.kind](box) : 0;
}
const SIZES: Record<BoxKind, (box: string) => number> = {
  bag: () => BAG_SLOTS,
  equip: () => EQUIP_SLOTS.length,
  bench: () => 1,
  chest: (box) => (chestIndex(box) >= 0 ? CHEST_COLS * CHEST_ROWS : 0),
  corpse: (box) => (corpseId(box) >= 0 ? CHEST_COLS * CHEST_ROWS : 0),
  bld: (box) => (building(box) ? 1 : 0),
  veh: (box) => (vehicleById(vehicleId(box)) ? 1 : 0),
  cargo: (box) => (vehicleById(cargoId(box))?.up ? BIKE_COLS * BIKE_ROWS : 0),
};

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
  const i = boxNumber('chest', box);
  return i < CHESTS.length ? i : -1;
}

/** The building standing in the world whose box this is, or undefined. */
export const building = (box: string) => {
  const id = buildingId(box);
  return id < 0 ? undefined : placed.find((p) => p.id === id && isBuilding(p.kind));
};

export function boxLabel(box: string): string {
  const k = boxKind(box);
  return k ? LABELS[k.kind](box) : '';
}
const LABELS: Record<BoxKind, (box: string) => string> = {
  bag: () => TEXT.boxes.bag,
  equip: () => TEXT.boxes.equip,
  bench: () => TEXT.boxes.bench,
  chest: (box) => (CHESTS.length > 1 ? TEXT.boxes.chestN(chestIndex(box) + 1) : TEXT.boxes.chest),
  corpse: () => TEXT.boxes.corpse,
  bld: (box) => ITEMS[building(box)?.kind ?? '']?.label ?? '',
  veh: (box) => ITEMS[vehicleById(vehicleId(box))?.kind ?? '']?.label ?? '',
  cargo: () => TEXT.boxes.cargo,
};

/** Boxes open to a player standing at `s` besides the bag, nearest chest first. */
export function openBoxes(s: PlayerState, slack = 0): BoxId[] {
  const out: BoxId[] = [];
  if (WORKBENCH >= 0 && stationReach(s, WORKBENCH) < STATION_REACH + slack) out.push('bench');
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
  // Vehicles in reach that nobody rides: their parts, and a working one's cargo.
  if (!s.riding) {
    for (const v of vehiclesNear(s, slack)) {
      out.push(`veh${v.id}`);
      if (v.up) out.push(`cargo${v.id}`);
    }
  }
  return out;
}

/** Can a player at `s` use this box? */
export const canOpen = (s: PlayerState, box: string, slack = 0) => box === 'bag' || box === 'equip' || openBoxes(s, slack).includes(box as BoxId);
