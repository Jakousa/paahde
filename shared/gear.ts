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
import {
  ITEMS, BAG_COLS, BAG_ROWS, BIKE_COLS, BIKE_ROWS, CHEST_COLS, fitsAt, freeSlots, gridShape, HOTBAR, moveItem, parsePart, partKind, sizeOf, strandedAt,
  type Item, type Shape, type Slots,
} from './items.ts';
import { PART_LABELS } from './parts.ts';
import type { PartId } from './salvage.ts';

export const EQUIP_SLOTS = ['back', 'wrist', 'belt', 'vehicle'] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];
export const EQUIP_LABELS: Record<EquipSlot, string> = { back: 'Back', wrist: 'Wrist', belt: 'Belt', vehicle: 'Vehicle' };

/** A part slot: a tiered part from disassembly, or a basic material (shared/items.ts SCRAP or CLOTH; no tier: it holds
 *  things together), or one of the kinds `scrap` lists (an enemy's or boss's own part: no tier either). `rare`: never
 *  already fitted in gear found broken (server/loot.ts). */
export type PartSlot = ({ part: PartId } | { scrap: string[]; label: string }) & { rare?: true };

export type GearSpec = {
  slots: PartSlot[];
  /** Equipped in the Tab menu; otherwise used from the hotbar. */
  equip?: EquipSlot;
  /** What better parts do, and how to use it, for the tooltip. */
  better: string;
  use: string;
};

const P = (part: PartId): PartSlot => ({ part });
/** The basic materials (shared/items.ts): a piece of scrap metal, a piece of cloth. */
const SCRAP: PartSlot = { scrap: ['scrap'], label: 'Scrap' };
const CLOTH: PartSlot = { scrap: ['cloth'], label: 'Cloth' };
/** The receivers' slots: the uranium cell that drives the call, and an enemy's or boss's own part. */
const CELL: PartSlot = { part: 'uranium', rare: true };
const own = (kind: string): PartSlot => ({ scrap: [kind], label: ITEMS[kind].label, rare: true });
const RECEIVER = { better: 'how steady its needle', use: 'Left mouse sends the signal. The needle points to what answers.' };

export const GEAR: Record<string, GearSpec> = {
  motorcycle: { slots: [P('motor'), P('battery'), P('bearing')], equip: 'vehicle', better: 'top speed and acceleration',
    use: 'Press 9 to get on and off.' },
  spyglass: { slots: [P('gear'), P('bearing')], better: 'zoom', use: 'Hold the mouse button to look, wheel to zoom.' },
  canteen: { slots: [P('valve'), CLOTH], better: 'how many sips it holds',
    use: 'Hold the mouse button to drink; fill it at the pump in the base.' },
  backpack: { slots: [CLOTH, SCRAP, P('gear')], equip: 'back', better: 'room (rows)',
    use: 'Bag room past the hotbar.' },
  storm_detector: { slots: [P('coil'), P('relay')], equip: 'belt', better: 'how early it warns',
    use: 'Beeps before a sandstorm reaches you.' },
  wristpad: { slots: [P('compute'), P('battery')], equip: 'wrist', better: 'how far away players show on the locator',
    use: 'Shows the clock, the temperature and the locator bar.' },
  // The guns (shared/rifle.ts): a coil focuses the beam; the rifle also needs a cell and a heatsink.
  laser_pistol: { slots: [P('coil'), SCRAP], better: 'how fast it recharges', use: 'Left mouse to fire, right mouse to aim.' },
  laser_rifle: { slots: [P('coil'), P('battery'), P('heatsink'), SCRAP], better: 'how fast it recharges',
    use: 'Left mouse to fire, right mouse to look through the scope.' },
  // The jammer (shared/jammer.ts): a compute unit to find the drones' link, a coil for the antenna, a cell to drive it.
  jammer: { slots: [P('compute'), P('coil'), P('battery')], better: 'how fast it locks on',
    use: 'Hold the mouse button on a drone or jet until it drops.' },
  // The receivers (shared/bosses.ts RECEIVERS): each calls its boss, spending the cell. Tuned by a part from the boss's
  // kin (shared/tables.ts RELIC_DROPS); the worm's by a part from each of the other bosses.
  receiver_carrier: { slots: [CELL, own('drone_transponder'), P('compute')], ...RECEIVER },
  receiver_queen: { slots: [CELL, own('brood_gland'), P('coil')], ...RECEIVER },
  receiver_colossus: { slots: [CELL, own('servo_heart'), P('relay')], ...RECEIVER },
  receiver_worm: { slots: [CELL, own('hive_core'), own('queen_eye'), own('furnace_heart')], ...RECEIVER },
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

/** Gear `kind` in working order with the worst parts (Scrap tier) in every slot. */
export function scrapParts(kind: string): string[] {
  return GEAR[kind].slots.map((s) => ('part' in s ? partKind(s.part, 'scrap') : s.scrap[0]));
}

/**
 * Parts fitted under an older slot list (GEAR changed since: e.g. the backpack got a cloth slot), laid onto `kind`'s
 * slots as they are now: each slot takes the first old part that fits it, and what fits nowhere is gone. Gear that
 * worked keeps working: a slot nothing fits gets its Scrap-tier part or material. Null if nothing needs to change.
 */
export function refit(kind: string, parts: (string | null)[]): (string | null)[] | null {
  const slots = GEAR[kind]?.slots;
  if (!slots) return null;
  if (parts.length === slots.length && parts.every((p, i) => p === null || fitsSlot(slots[i], p))) return null;
  const worked = parts.every((p) => p !== null);
  const left = [...parts];
  const fallback = scrapParts(kind);
  return slots.map((s, i) => {
    const j = left.findIndex((p) => p !== null && fitsSlot(s, p));
    if (j < 0) return worked ? fallback[i] : null;
    const p = left[j];
    left[j] = null;
    return p;
  });
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
/** Receiver: how far its needle wanders off the true bearing (rad). */
export const receiverWobble = (q: number) => by(q, 0.35, 0.05);
/** Motorcycle top speed (m/s) and engine (m/s² from a standstill). */
export const bikeTopSpeed = (q: number) => by(q, 22, 30);
export const bikeEngine = (q: number) => by(q, 16, 20);
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

/** A gun's recharge (ms) at quality q: a fifth slower than its base at Scrap parts, a quarter faster at Space-grade. */
export const gunCooldown = (base: number, q: number) => base * by(q, 1.2, 0.75);

/** The jammer's lock time (ms) at quality q: from its base (shared/jammer.ts JAM_MS) at Scrap parts down to 60% at Space-grade. */
export const jamMs = (base: number, q: number) => base * by(q, 1, 0.6);

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

/** Things drawn on the body while in the bag (not in hand): the scrap plate on the backpack, the canteen
 *  and sidearm on the belt. Their bits follow the worn ones (carriedBit). */
export const CARRIED = ['scrap', 'canteen', 'laser_pistol'] as const;
export const carriedBit = (kind: (typeof CARRIED)[number]) => 1 << (EQUIP_SLOTS.length + CARRIED.indexOf(kind));

/** The CARRIED kinds in the bag outside the hand (`held`: the selected hotbar slot, -1 for none), as bits. */
export function carriedGear(bag: Slots | undefined, held: number): number {
  let bits = 0;
  bag?.forEach((it, i) => {
    const k = CARRIED.indexOf(it?.kind as (typeof CARRIED)[number]);
    if (k >= 0 && i !== held) bits |= 1 << (EQUIP_SLOTS.length + k);
  });
  return bits;
}

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

/** Motorcycle level for PlayerState.bike: 0 without a repaired one equipped or in hand (`held`: the selected hotbar
 *  item), else 1 + quality (1..4). */
export function bikeLevel(equip: Slots | undefined, held?: Item | null): number {
  const b = equipped(equip, 'vehicle') ?? (held?.kind === 'motorcycle' && repaired(held) ? held : undefined);
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
