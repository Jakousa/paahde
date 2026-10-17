// Items: the catalogue, slot containers ("boxes") and the rules for moving stacks between them. The server
// owns every item (server/items.ts, `items` table, one row per stack with a stable id); the client applies
// the same moves at once and the server's answer then replaces them (src/net.ts).
//
// Boxes are laid out like Tarkov's: a few free slots that hold one item of any size (the hotbar, the equipment,
// the workbench), then a grid where every item takes w × h cells by its size (ITEMS), turned 90° if the player
// turned it. An item sits in the slot of its top-left cell; the other cells it covers stay null in the array.
import { partItems, partItem, partOf } from './parts.ts';
import { SALVAGE, TIERS, type PartId, type Tier } from './salvage.ts';
import { CRASH_KINDS } from './crashKinds.ts';
import { SCRAP_KINDS } from './scrap.ts';

type Size = [number, number];

/** Grid cells [w, h] per part; the rest are 1 × 1. */
const PART_SIZES: Partial<Record<PartId, Size>> = { battery: [1, 2], motor: [2, 2], heatsink: [2, 1], antimatter: [2, 2], impeller: [2, 2] };

/**
 * Item kind ids as stored in the DB. Never rename one: rows hold them. `stack` is 1 for all: nothing stacks for now.
 * `tier`: the item's quality, which doubles as its rarity (RARITY in shared/salvage.ts); parts have one.
 * `size`: [w, h] grid cells it takes, 1 × 1 if not given. Keep the smaller side at most MAX_SIDE.
 * Gear (shared/gear.ts: the water bottle, telescope, motorcycle, ...) is found broken and repaired with parts.
 */
export const ITEMS: Record<string, { label: string; stack: number; tier?: Tier; size?: Size }> = {
  canteen: { label: 'Water bottle', stack: 1, size: [1, 2] },
  spyglass: { label: 'Telescope', stack: 1, size: [2, 1] },
  motorcycle: { label: 'Motorcycle', stack: 1, size: [4, 3] },
  backpack: { label: 'Backpack', stack: 1, size: [2, 2] },
  storm_detector: { label: 'Storm detector', stack: 1, size: [1, 2] },
  wristpad: { label: 'Wrist computer', stack: 1 },
  metal_detector: { label: 'Metal detector', stack: 1, size: [1, 3] },
  shovel: { label: 'Shovel', stack: 1, size: [1, 3] },
  oil_drum: { label: 'Oil drum', stack: 1, size: [2, 2] },
  rusty_drum: { label: 'Rusty drum', stack: 1, size: [2, 2] },
  gear: { label: 'Gear', stack: 1 },
  scrap_frame: { label: 'Scrap frame', stack: 1, size: [2, 2] },
  bent_frame: { label: 'Bent frame', stack: 1, size: [2, 2] },
  metal_plank: { label: 'Metal plank', stack: 1, size: [1, 3] },
  metal_sheet: { label: 'Metal sheet', stack: 1, size: [2, 2] },
  dented_sheet: { label: 'Dented sheet', stack: 1, size: [2, 2] },
  spring: { label: 'Spring', stack: 1 },
  // Small crash-site machines carried home to the disassembly table (COMPONENTS with carry: true, shared/salvage.ts).
  // The item kind is the component kind.
  robot_arm: { label: 'Robot arm joint', stack: 1, size: [2, 2] },
  control_cabinet: { label: 'Control cabinet', stack: 1, size: [2, 3] },
  // Parts taken out of machines (shared/parts.ts): `<part>_<tier>`, e.g. battery_space.
  ...Object.fromEntries(Object.entries(partItems()).map(([k, v]) => [k, { ...v, size: PART_SIZES[partOf(k)!.part] }])),
  // Crafted at the workbench (shared/crafting.ts) and put down in the base from the hotbar (shared/placed.ts).
  plant_bed: { label: 'Plant bed', stack: 1, size: [3, 2] },
  uv_lamp: { label: 'UV lamp', stack: 1, size: [1, 2] },
  // Salvage wrecks carried home from the desert (shared/wrecks.ts), taken apart on the disassembly table too.
  vehicle_frame: { label: SALVAGE.vehicle_frame.label, stack: 1, size: [4, 3] },
  water_jet: { label: SALVAGE.water_jet.label, stack: 1, size: [3, 2] },
  warp_core: { label: SALVAGE.warp_core.label, stack: 1, size: [3, 3] },
  ai_control: { label: SALVAGE.ai_control.label, stack: 1, size: [2, 2] },
};
const ORDER = Object.keys(ITEMS);

/** Every item fits a grid this many rows tall once turned (its smaller side): chests keep this many rows empty. */
export const MAX_SIDE = 3;
for (const [k, v] of Object.entries(ITEMS)) if (Math.min(...(v.size ?? [1, 1])) > MAX_SIDE) throw new Error(`shared/items.ts: ${k} is too big`);

/** Item kind of a part (shared/parts.ts partItem). */
export const partKind = (part: PartId, tier: Tier) => partItem(part, tier);
/** A part kind's part and tier index (0 scrap .. 3 space), or null for anything else. */
export function parsePart(kind: string): { part: PartId; tier: number } | null {
  const p = partOf(kind);
  return p ? { part: p.part, tier: TIERS.indexOf(p.tier) } : null;
}

/** Item kind of each scrap prop, by SCRAP_KINDS index. */
export const SCRAP_ITEMS = ['oil_drum', 'rusty_drum', 'gear', 'scrap_frame', 'bent_frame', 'metal_plank', 'metal_sheet', 'dented_sheet', 'spring'];
if (SCRAP_ITEMS.length !== SCRAP_KINDS.length) throw new Error('shared/items.ts: SCRAP_ITEMS out of step with SCRAP_KINDS');

/** The scrap item a crash-site debris piece (shared/crashsites.ts) gives when picked up, by CRASH_KINDS node name. */
export const DEBRIS_ITEMS: Record<string, string> = {
  Crash_Debris_1: 'metal_sheet', // hull plate
  Crash_Debris_2: 'dented_sheet', // bent fin
  Crash_Debris_3: 'metal_plank', // pipe bundle
  Crash_Debris_4: 'scrap_frame', // burnt seat
  Crash_Debris_5: 'bent_frame', // porthole ring
  Crash_Debris_6: 'rusty_drum', // boiler tank
  Crash_Debris_7: 'gear', // gear housing
};
for (const k of CRASH_KINDS) {
  if (!k.main && !k.dressing && !(DEBRIS_ITEMS[k.node] in ITEMS)) throw new Error(`shared/items.ts: no DEBRIS_ITEMS entry for ${k.node}`);
}

/**
 * One stack. `id` is its DB row id (negative: a client-side guess until the server answers). Gear also has
 * `parts`: the item kind fitted in each of its part slots (shared/gear.ts), null where one is missing.
 * `r`: turned 90° in a grid (its size's w and h swapped).
 */
export type Item = { id: number; kind: string; n: number; parts?: (string | null)[]; r?: boolean };
export type Slots = (Item | null)[];

/**
 * The player's own bag: HOTBAR free slots of hotbar (keys 1–4, src/water.ts), then a BAG_COLS wide grid of which
 * the equipped backpack opens some rows (shared/gear.ts bagShape), up to BAG_ROWS. The slots array is always
 * at least BAG_SLOTS long; items past it (or in rows the backpack doesn't open) are stranded: only moved out.
 */
export const HOTBAR = 4;
export const BAG_COLS = 6;
export const BAG_ROWS = 5;
export const BAG_SLOTS = HOTBAR + BAG_COLS * BAG_ROWS;
/** The motorcycle's cargo grid. */
export const BIKE_COLS = 6;
export const BIKE_ROWS = 4;
/** Chests are this wide and grow downwards (shared/storage.ts growChest), at least CHEST_ROWS. */
export const CHEST_COLS = 8;
export const CHEST_ROWS = 6;

/**
 * A box's layout: `free` slots (one item of any size each), then a grid `cols` wide and `grid` rows long of
 * which the first `rows` are usable (a small backpack opens fewer). Slot free + y·cols + x is cell (x, y).
 */
export type Shape = { free: number; cols: number; rows: number; grid: number };
export const freeSlots = (n: number): Shape => ({ free: n, cols: 1, rows: 0, grid: 0 });
export const gridShape = (cols: number, rows: number): Shape => ({ free: 0, cols, rows, grid: rows });

export const stackOf = (kind: string) => ITEMS[kind]?.stack ?? 1;

/** An item's footprint [w, h] in grid cells, turned when `r`. */
export function sizeOf(kind: string, r?: boolean): Size {
  const [w, h] = ITEMS[kind]?.size ?? [1, 1];
  return r ? [h, w] : [w, h];
}

/** Cells a w × h item at slot i would cover, or null if it doesn't fit there (out of the first `rows` rows or off the side). */
export function cellsAt(shape: Shape, i: number, w: number, h: number, rows = shape.rows): number[] | null {
  if (i < shape.free) return i >= 0 ? [i] : null;
  const x = (i - shape.free) % shape.cols, y = Math.floor((i - shape.free) / shape.cols);
  if (x + w > shape.cols || y + h > rows) return null;
  const out: number[] = [];
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) out.push(shape.free + (y + dy) * shape.cols + x + dx);
  return out;
}

/** Which item covers each slot: the slot index of its top-left cell, -1 where empty. Items in `skip` don't count. */
export function coverage(slots: Slots, shape: Shape, skip: number[] = []): Int32Array {
  const out = new Int32Array(Math.max(slots.length, shape.free + shape.cols * shape.grid)).fill(-1);
  for (let i = 0; i < slots.length; i++) {
    const it = slots[i];
    if (!it || skip.includes(i)) continue;
    // Anywhere in the grid, usable or not (an item stranded in rows a smaller backpack lacks still takes room).
    const cells = cellsAt(shape, i, ...sizeOf(it.kind, it.r), shape.grid) ?? [];
    for (const c of cells) out[c] = i;
  }
  return out;
}

/** Could a w × h item go at slot i: inside the usable grid (or a free slot), on cells only `skip` items cover? */
export function fitsAt(slots: Slots, shape: Shape, i: number, w: number, h: number, skip: number[] = [], cov = coverage(slots, shape, skip)): boolean {
  const cells = cellsAt(shape, i, w, h);
  return !!cells && cells.every((c) => cov[c] < 0);
}

/** Is the item at slot i outside the usable grid (rows the backpack doesn't open, or past the end)? */
export function strandedAt(slots: Slots, shape: Shape, i: number): boolean {
  const it = slots[i];
  return !!it && i >= shape.free && !cellsAt(shape, i, ...sizeOf(it.kind, it.r));
}

/**
 * The first place an item of `kind` fits: in the grid, row by row, as it lies and then turned; then (if `free`)
 * the first empty free slot. Null if there's none.
 */
export function findSpot(slots: Slots, shape: Shape, kind: string, r = false, skip: number[] = [], free = true): { i: number; r: boolean } | null {
  const cov = coverage(slots, shape, skip);
  const end = shape.free + shape.cols * shape.rows;
  for (const turned of [r, !r]) {
    const [w, h] = sizeOf(kind, turned);
    for (let i = shape.free; i < end; i++) if (fitsAt(slots, shape, i, w, h, skip, cov)) return { i, r: turned };
    if (w === h) break;
  }
  if (free) for (let i = 0; i < shape.free; i++) if (cov[i] < 0) return { i, r };
  return null;
}

/** Set an item's turn (only stored when turned). */
function turn(it: Item, r: boolean) {
  if (r) it.r = true;
  else delete it.r;
}
const fresh = (id: number, kind: string, n: number, r: boolean): Item => ({ id, kind, n, ...(r ? { r: true } : {}) });

/** Does `slots` hold an item of this kind? */
export const hasItem = (slots: Slots | undefined, kind: string) => !!slots?.some((it) => it?.kind === kind);

/** Can these two stack (same kind, and no gear: every gear item is its own)? */
const stacks = (a: Item, kind: string) => a.kind === kind && !a.parts;

/** Room for one more of `kind` (on a stack of it, or a free spot)? */
export function roomFor(slots: Slots, kind: string, shape: Shape): boolean {
  return slots.some((it, i) => it && stacks(it, kind) && it.n < stackOf(kind) && !strandedAt(slots, shape, i)) || !!findSpot(slots, shape, kind);
}

/**
 * Put n of `kind` into `slots`: onto stacks of it first, then wherever it fits (findSpot: the grid before the
 * free slots, so pickups land in the backpack before the hotbar). Mutates; false (and no change) if there's no room.
 */
export function addItem(slots: Slots, kind: string, n: number, newId: () => number, shape: Shape): boolean {
  const s = [...slots];
  for (let i = 0; i < s.length && n > 0; i++) {
    const it = s[i];
    if (!it || !stacks(it, kind) || strandedAt(s, shape, i)) continue;
    const k = Math.min(n, stackOf(kind) - it.n);
    if (k > 0) s[i] = { ...it, n: it.n + k };
    n -= k;
  }
  while (n > 0) {
    const spot = findSpot(s, shape, kind);
    if (!spot) return false;
    const k = Math.min(n, stackOf(kind));
    s[spot.i] = fresh(newId(), kind, k, spot.r);
    n -= k;
  }
  for (let i = 0; i < s.length; i++) slots[i] = s[i];
  return true;
}

/**
 * Drag n (default all) of the stack at src[si] to dst slot di, turned if `r` (default: as it lies): onto free
 * cells, onto a stack of the same kind (what doesn't fit stays behind), or swapped with the item lying there
 * (whole stacks only: it takes that item's corner, or the dropped-on cell, and that item goes where it was).
 * di = -1 means "anywhere in dst" (shift-click): onto its stacks, then the first spot it fits (findSpot).
 * src and dst may be the same array. Mutates; returns whether anything changed (no change when refused).
 */
export function moveItem(src: Slots, si: number, srcShape: Shape, dst: Slots, di: number, dstShape: Shape, n: number | undefined,
  newId: () => number, r?: boolean): boolean {
  const it = src[si];
  if (!it) return false;
  const k = Math.max(1, Math.min(it.n, n ?? it.n));
  if (di === -1) {
    if (src === dst) return false;
    let left = k;
    for (let j = 0; j < dst.length && left > 0 && !it.parts; j++) {
      const d = dst[j];
      if (!d || !stacks(d, it.kind) || strandedAt(dst, dstShape, j)) continue;
      const m = Math.min(left, stackOf(it.kind) - d.n);
      d.n += m;
      left -= m;
    }
    const spot = left > 0 ? findSpot(dst, dstShape, it.kind, !!it.r) : null;
    if (spot) {
      // The rest goes into a free spot: as the stack itself (keeping its id) when all of it moves.
      if (k === it.n) {
        it.n = left;
        turn(it, spot.r);
        src[si] = null;
        dst[spot.i] = it;
        return true;
      }
      dst[spot.i] = fresh(newId(), it.kind, left, spot.r);
      left = 0;
    }
    it.n -= k - left;
    if (it.n === 0) src[si] = null;
    return left < k;
  }
  const rr = r ?? !!it.r;
  if (src === dst && si === di && rr === !!it.r) return false;
  const [w, h] = sizeOf(it.kind, rr);
  const skip = src === dst ? [si] : [];
  const cov = coverage(dst, dstShape, skip);
  const dj = di >= 0 && di < cov.length ? cov[di] : -1;
  if (dj < 0) {
    if (!fitsAt(dst, dstShape, di, w, h, skip, cov)) return false;
    if (k === it.n) {
      src[si] = null;
      turn(it, rr);
      dst[di] = it;
    } else {
      dst[di] = fresh(newId(), it.kind, k, rr);
      it.n -= k;
    }
    return true;
  }
  const d = dst[dj]!;
  if (stacks(d, it.kind) && !it.parts) {
    const m = Math.min(k, stackOf(it.kind) - d.n);
    if (m === 0) return false;
    d.n += m;
    it.n -= m;
    if (it.n === 0) src[si] = null;
    return true;
  }
  if (k !== it.n) return false;
  // Swap: lift both out, put `it` down, then `d` where `it` was (as it lies, else turned); undo if either won't fit.
  const ir = !!it.r, dr = !!d.r;
  src[si] = null;
  dst[dj] = null;
  turn(it, rr);
  for (const t of new Set([dj, di])) {
    if (!fitsAt(dst, dstShape, t, w, h)) continue;
    dst[t] = it;
    for (const turned of [dr, !dr]) {
      if (!fitsAt(src, srcShape, si, ...sizeOf(d.kind, turned))) continue;
      turn(d, turned);
      src[si] = d;
      return true;
    }
    dst[t] = null;
  }
  turn(it, ir);
  dst[dj] = d;
  src[si] = it;
  return false;
}

/**
 * Tidy a box's grid: merge stacks of the same kind and pack them again, biggest first (then by catalogue),
 * row by row. Free slots (the hotbar) stay as the player set them, and so do stranded items. Mutates; false
 * (and no change) if the packing came out worse than what was there and something wouldn't fit.
 */
export function sortItems(slots: Slots, shape: Shape): boolean {
  const s = [...slots];
  const items: Item[] = [];
  for (let i = shape.free; i < s.length; i++) {
    const it = s[i];
    if (!it || strandedAt(s, shape, i)) continue;
    items.push(it);
    s[i] = null;
  }
  const merged: Item[] = [];
  for (const it of items) {
    let left = it.n;
    for (const m of merged) {
      if (!stacks(m, it.kind) || it.parts || left === 0) continue;
      const k = Math.min(left, stackOf(it.kind) - m.n);
      m.n += k;
      left -= k;
    }
    if (left > 0) merged.push({ ...it, n: left });
  }
  const area = (it: Item) => sizeOf(it.kind)[0] * sizeOf(it.kind)[1];
  merged.sort((a, b) => area(b) - area(a) || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.n - a.n || a.id - b.id);
  for (const it of merged) {
    // Lying wide first: rows fill more evenly.
    const [w, h] = sizeOf(it.kind);
    const spot = findSpot(s, shape, it.kind, h > w, [], false);
    if (!spot) return false;
    turn(it, spot.r);
    s[spot.i] = it;
  }
  for (let i = 0; i < s.length; i++) slots[i] = s[i];
  return true;
}

/**
 * Make a box's layout valid (after loading it, or after item sizes changed): an item that overlaps an earlier
 * one or sticks out of the grid moves to the first spot it fits, the usable rows first, then the rest of the
 * grid, then (with `grow`, a chest) a new row, else past the end (stranded). Mutates; returns whether anything moved.
 */
export function settle(slots: Slots, shape: Shape, grow = false): boolean {
  let all = { ...shape, rows: shape.grid };
  const s: Slots = new Array(Math.max(slots.length, shape.free + shape.cols * shape.grid)).fill(null);
  const homeless: Item[] = [];
  for (let i = 0; i < slots.length; i++) {
    const it = slots[i];
    if (!it) continue;
    if (i < shape.free || fitsAt(s, all, i, ...sizeOf(it.kind, it.r))) s[i] = it;
    else homeless.push(it);
  }
  for (const it of homeless) {
    let spot = findSpot(s, shape, it.kind, !!it.r, [], false) ?? findSpot(s, all, it.kind, !!it.r, [], false);
    while (!spot && grow) {
      all = { ...all, rows: all.rows + 1, grid: all.grid + 1 };
      s.push(...new Array(shape.cols).fill(null));
      spot = findSpot(s, all, it.kind, !!it.r, [], false);
    }
    if (spot) {
      turn(it, spot.r);
      s[spot.i] = it;
    } else s.push(it);
  }
  slots.length = s.length;
  for (let i = 0; i < s.length; i++) slots[i] = s[i];
  return homeless.length > 0;
}
