// Gear: the things you find broken in the desert (server/loot.ts) and repair with parts at the workbench in
// the base. Each piece of gear has part slots (GEAR below); an item's `parts` (shared/items.ts) says what is
// fitted in each. With every slot filled it works, and how well depends on the parts' tiers (quality): a
// better part can be swapped in any time. Some gear is equipped in the Tab menu (the 'equip' box: back,
// wrist, belt, vehicle), the rest is used from the hotbar.
//
// Moves between boxes go through tryMove(), on the client as a prediction and on the server for real, so
// both apply the same rules: gear only into its equipment slot (and only once repaired), nothing put down past the
// bag's open rows (the backpack sets them; taking it off leaves what's there stranded, not lost) and only where it fits in a grid, and parts only into the workbench item's matching slots (fitPart).
import { isCorpseBox } from './corpse.ts';
import type { DigTool } from './dig.ts';
import {
  BAG_COLS, BAG_ROWS, BIKE_COLS, BIKE_ROWS, CHEST_COLS, fitsAt, freeSlots, gridShape, HOTBAR, moveItem, parsePart, sizeOf, strandedAt,
  type Item, type Shape, type Slots,
} from './items.ts';
import { PART_LABELS } from './parts.ts';
import type { PartId } from './salvage.ts';

export const EQUIP_SLOTS = ['back', 'wrist', 'belt', 'vehicle'] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];
export const EQUIP_LABELS: Record<EquipSlot, string> = { back: 'Back', wrist: 'Wrist', belt: 'Belt', vehicle: 'Vehicle' };

/** A part slot: a tiered part from disassembly, or a piece of scrap (no tier: it holds things together). */
export type PartSlot = { part: PartId } | { scrap: string[]; label: string };

export type GearSpec = {
  slots: PartSlot[];
  /** Equipped in the Tab menu; otherwise used from the hotbar. */
  equip?: EquipSlot;
  /** What better parts do, and how to use it, for the tooltip. */
  better: string;
  use: string;
};

const P = (part: PartId): PartSlot => ({ part });

export const GEAR: Record<string, GearSpec> = {
  motorcycle: { slots: [P('motor'), P('battery'), P('bearing')], equip: 'vehicle', better: 'top speed and acceleration',
    use: 'Press 9 to get on and off.' },
  spyglass: { slots: [P('gear'), P('bearing')], better: 'zoom', use: 'Hold the mouse button to look, wheel to zoom.' },
  canteen: { slots: [P('valve'), { scrap: ['oil_drum', 'rusty_drum'], label: 'Drum' }], better: 'how many sips it holds',
    use: 'Hold the mouse button to drink; fill it at the pump in the base.' },
  backpack: { slots: [{ scrap: ['scrap_frame', 'bent_frame'], label: 'Frame' }, P('gear')], equip: 'back', better: 'room (rows)',
    use: 'Bag room past the hotbar.' },
  storm_detector: { slots: [P('coil'), P('relay')], equip: 'belt', better: 'how early it warns',
    use: 'Beeps before a sandstorm reaches you.' },
  wristpad: { slots: [P('compute'), P('battery')], equip: 'wrist', better: 'how far away players show on the locator',
    use: 'Shows the clock, the temperature and the locator bar.' },
  metal_detector: { slots: [P('coil'), P('compute'), P('battery')], better: 'range',
    use: 'Hold it and look at the sand: it ticks faster near something buried. Dig there.' },
  shovel: { slots: [{ scrap: ['metal_sheet', 'dented_sheet'], label: 'Blade' }, P('motor')], better: 'digging speed and width',
    use: 'Hold it and dig (left mouse): faster and wider than bare hands.' },
};
export const GEAR_KINDS = Object.keys(GEAR);

export const isGear = (kind: string) => kind in GEAR;

export function slotLabel(s: PartSlot) {
  return 'part' in s ? PART_LABELS[s.part] : s.label;
}

/** Can `kind` go into part slot `s`? */
export function fitsSlot(s: PartSlot, kind: string): boolean {
  if ('part' in s) return parsePart(kind)?.part === s.part;
  return s.scrap.includes(kind);
}

/** The item's fitted parts, one per slot (a fresh array, null where missing). */
export function partsOf(it: Item): (string | null)[] {
  const n = GEAR[it.kind]?.slots.length ?? 0;
  return Array.from({ length: n }, (_, i) => it.parts?.[i] ?? null);
}

/** Every slot filled. */
export function repaired(it: Item | null | undefined): boolean {
  return !!it && isGear(it.kind) && partsOf(it).every((p) => p !== null);
}

/**
 * How good a repaired item is: the mean tier of its tiered parts, 0 (all Scrap) .. 3 (all Space-grade).
 * -1 when it's broken (or not gear).
 */
export function quality(it: Item | null | undefined): number {
  if (!it || !repaired(it)) return -1;
  let sum = 0, n = 0;
  for (const p of partsOf(it)) {
    const t = parsePart(p!);
    if (t) {
      sum += t.tier;
      n++;
    }
  }
  return n ? sum / n : 0;
}

/** lerp from `lo` (quality 0) to `hi` (quality 3). */
const by = (q: number, lo: number, hi: number) => lo + ((hi - lo) * q) / 3;

// What each piece of gear does at quality q (0..3).
/** Motorcycle top speed (m/s) and engine (m/s² from a standstill). */
export const bikeTopSpeed = (q: number) => by(q, 15, 28);
export const bikeEngine = (q: number) => by(q, 12, 19);
/** Telescope's strongest zoom. */
export const spyglassZoom = (q: number) => by(q, 4, 12);
/** Sips in a full water bottle. */
export const canteenSips = (q: number) => Math.round(by(q, 5, 10));
/** Backpack rows of bag grid (BAG_COLS wide, past the hotbar). */
export const backpackRows = (q: number) => Math.round(by(q, 2, BAG_ROWS));
/** Storm detector: warns this long before a storm reaches you (s). */
export const stormWarnS = (q: number) => by(q, 6, 20);
/** Wrist computer: other players show on the locator this far away (m). The base always does. */
export const locatorRange = (q: number) => by(q, 250, 2000);
/** Metal detector: hears buried things this far away (m, horizontally). */
export const detectorRange = (q: number) => by(q, 8, 22);

/** Bare hands: slow and narrow. */
export const HANDS: DigTool = { mm: 70, radius: 0.8, cooldown: 18 };
export function shovelTool(q: number): DigTool {
  return { mm: Math.round(by(q, 200, 380)), radius: by(q, 1.1, 1.6), cooldown: Math.round(by(q, 12, 8)) };
}
/** The dig tool for an item held in the hand (a repaired shovel), else bare hands. */
export function digTool(held: Item | null | undefined): DigTool {
  return held?.kind === 'shovel' && repaired(held) ? shovelTool(quality(held)) : HANDS;
}

/** The repaired gear equipped in a slot, or null. */
export function equipped(equip: Slots | undefined, slot: EquipSlot): Item | null {
  const it = equip?.[EQUIP_SLOTS.indexOf(slot)];
  return it && repaired(it) ? it : null;
}

/** The repaired gear equipped, as bits (wornBit): what others see worn. */
export function wornGear(equip: Slots | undefined): number {
  let bits = 0;
  for (const s of EQUIP_SLOTS) if (equipped(equip, s)) bits |= wornBit(s);
  return bits;
}

/** An equipment slot's bit in wornGear (by EQUIP_SLOTS index: back 1, wrist 2, belt 4, vehicle 8). */
export const wornBit = (slot: EquipSlot) => 1 << EQUIP_SLOTS.indexOf(slot);

/** The bag's layout: the hotbar, then the grid with as many rows open as the backpack's (none without one). */
export function bagShape(equip: Slots | undefined): Shape {
  const pack = equipped(equip, 'back');
  return { free: HOTBAR, cols: BAG_COLS, rows: pack ? Math.min(BAG_ROWS, backpackRows(quality(pack))) : 0, grid: BAG_ROWS };
}

/** Water bottle sips for a bag holding `canteen` (its best repaired one), 0 without. */
export function bottleSips(bag: Slots | undefined): number {
  let best = -1;
  for (const it of bag ?? []) if (it?.kind === 'canteen') best = Math.max(best, quality(it));
  return best < 0 ? 0 : canteenSips(best);
}

/** Motorcycle level for PlayerState.bike: 0 without a repaired one equipped, else 1 + quality (1..4). */
export function bikeLevel(equip: Slots | undefined): number {
  const b = equipped(equip, 'vehicle');
  return b ? 1 + quality(b) : 0;
}

/** Which box ids hold what: 'equip' is the player's EQUIP_SLOTS, 'bench' the workbench's one slot. */
export type Boxes = Record<string, Slots | undefined>;

/** A box's layout (shared/items.ts Shape): the bag's depends on the backpack, a chest's on how far it has grown. */
export function boxShape(box: string, boxes: Boxes): Shape {
  if (box === 'bag') return bagShape(boxes.equip);
  if (box === 'equip') return freeSlots(EQUIP_SLOTS.length);
  if (box === 'bench') return freeSlots(1);
  if (box === 'bike') return gridShape(BIKE_COLS, BIKE_ROWS);
  return gridShape(CHEST_COLS, Math.floor((boxes[box]?.length ?? 0) / CHEST_COLS));
}

/** Copy boxes deeply enough that a move can be tried and thrown away. */
function cloneBoxes(boxes: Boxes, ids: string[]): Boxes {
  const out: Boxes = { ...boxes };
  for (const id of ids) out[id] = boxes[id]?.map((it) => (it ? { ...it, parts: it.parts && [...it.parts] } : null));
  return out;
}

/** May item `it` sit in `box` slot `i`? */
function allowed(box: string, i: number, it: Item, boxes: Boxes): boolean {
  if (box === 'equip') return GEAR[it.kind]?.equip === EQUIP_SLOTS[i] && repaired(it);
  if (box === 'bench') return isGear(it.kind);
  return true;
}

/**
 * Did the move put something down in bag rows the backpack (as it is after the move) doesn't open? Items already
 * lying there may end up stranded (taking the backpack off leaves its contents in the bag's closed rows, shown
 * red, only to be moved out, open again with a backpack on), but nothing new goes there.
 */
function strandsNew(before: Boxes, after: Boxes): boolean {
  const bag = after.bag, old = before.bag;
  if (!bag || !old) return false;
  const shape = bagShape(after.equip);
  for (let i = 0; i < bag.length; i++) {
    const x = bag[i], o = old[i];
    if (x && !(o && o.id === x.id && o.kind === x.kind && !!o.r === !!x.r) && strandedAt(bag, shape, i)) return true;
  }
  return false;
}

/** The motorcycle can't leave its slot while you ride it. */
export const lockedWhileRiding = (box: string, i: number) => box === 'equip' && EQUIP_SLOTS[i] === 'vehicle';

/**
 * Move n (default all) of `from`[fi] to `to`[ti] (ti -1: anywhere it may go), turned if `r` (default: as it
 * lies), by the rules above. Applies to `boxes` only if the result is allowed; returns whether it did.
 * `from`/`to` must both be in `boxes`.
 */
export function tryMove(boxes: Boxes, from: string, fi: number, to: string, ti: number, n: number | undefined, newId: () => number,
  r?: boolean): boolean {
  const src0 = boxes[from], dst0 = boxes[to];
  const it = src0?.[fi];
  if (!src0 || !dst0 || !it) return false;
  // A dead player's pack (shared/corpse.ts) is only taken from.
  if (to !== from && isCorpseBox(to)) return false;
  // Anywhere in equip: the item's own slot.
  if (to === 'equip' && ti === -1) {
    const slot = GEAR[it.kind]?.equip;
    if (!slot) return false;
    ti = EQUIP_SLOTS.indexOf(slot);
  }
  const ids = [...new Set([from, to])];
  const b = cloneBoxes(boxes, ids);
  const src = b[from]!, dst = b[to]!;
  // Into the bag from the equipment: laid out as the bag will be once it's off (a backpack never lands in its own rows).
  const dstShape = to === 'bag' && from === 'equip' ? bagShape(boxes.equip?.map((x, i) => (i === fi ? null : x))) : boxShape(to, boxes);
  if (!moveItem(src, fi, boxShape(from, boxes), dst, ti, dstShape, n, newId, r)) return false;
  // Every slot that changed must allow what's in it now.
  for (const id of ids) {
    const slots = b[id]!;
    for (let i = 0; i < slots.length; i++) {
      const x = slots[i];
      if (x && x !== boxes[id]![i] && !sameItem(x, boxes[id]![i]) && !allowed(id, i, x, b)) return false;
    }
  }
  if (strandsNew(boxes, b)) return false;
  for (const id of ids) boxes[id]!.splice(0, boxes[id]!.length, ...b[id]!);
  return true;
}

const sameItem = (a: Item, b: Item | null | undefined) => !!b && a.id === b.id && a.kind === b.kind && a.n === b.n && !!a.r === !!b.r;

/**
 * Fit the part at `from`[fi] into slot `slot` of the workbench item. A part already there comes out into
 * `from`[fi] in its place (or anywhere in the bag if one of the stack stays behind): that's how you
 * upgrade. Applies to `boxes` only if allowed; returns whether it did.
 */
export function fitPart(boxes: Boxes, from: string, fi: number, slot: number, newId: () => number): boolean {
  const target = boxes.bench?.[0];
  const src = boxes[from];
  const part = src?.[fi];
  const spec = target && GEAR[target.kind]?.slots[slot];
  if (!target || !src || !part || !spec || !fitsSlot(spec, part.kind)) return false;
  const parts = partsOf(target);
  const old = parts[slot];
  if (old === part.kind) return false;
  const b = cloneBoxes(boxes, [...new Set([from, 'bag', 'bench'])]);
  const s = b[from]!;
  const p = s[fi]!;
  if (p.n > 1) {
    p.n--;
    if (old && !giveBack(b, old, newId)) return false;
  } else {
    // The old part lies down where the new one was (the same part, so the same size), else anywhere in the bag.
    s[fi] = null;
    if (old && fitsAt(s, boxShape(from, b), fi, ...sizeOf(old, p.r))) s[fi] = { id: newId(), kind: old, n: 1, ...(p.r ? { r: true } : {}) };
    else if (old && !giveBack(b, old, newId)) return false;
  }
  parts[slot] = part.kind;
  b.bench![0] = { ...b.bench![0]!, parts };
  for (const id of new Set([from, 'bag', 'bench'])) boxes[id]?.splice(0, boxes[id]!.length, ...b[id]!);
  return true;
}

/** Take the part in slot `slot` of the workbench item out into `to`[ti] (-1: anywhere in it). */
export function unfitPart(boxes: Boxes, slot: number, to: string, ti: number, newId: () => number): boolean {
  const target = boxes.bench?.[0];
  if (!target || !boxes[to] || isCorpseBox(to)) return false;
  const parts = partsOf(target);
  const kind = parts[slot];
  if (!kind) return false;
  const b = cloneBoxes(boxes, [...new Set([to, 'bench'])]);
  const dst = b[to]!;
  const tmp: Slots = [{ id: newId(), kind, n: 1 }];
  if (!moveItem(tmp, 0, ONE, dst, ti, boxShape(to, b), undefined, newId) || tmp[0]) return false;
  parts[slot] = null;
  b.bench![0] = { ...b.bench![0]!, parts };
  for (const id of new Set([to, 'bench'])) boxes[id]!.splice(0, boxes[id]!.length, ...b[id]!);
  return true;
}

/** A lone item, handed between boxes. */
const ONE: Shape = { free: 1, cols: 1, rows: 0, grid: 0 };

function giveBack(b: Boxes, kind: string, newId: () => number): boolean {
  const tmp: Slots = [{ id: newId(), kind, n: 1 }];
  return !!b.bag && moveItem(tmp, 0, ONE, b.bag, -1, bagShape(b.equip), undefined, newId) && !tmp[0];
}
