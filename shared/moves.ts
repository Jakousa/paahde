// Moving items between boxes (shared/boxes.ts), and parts in and out of gear. Moves go through tryMove(), on the client
// as a prediction and on the server for real, so both apply the same rules: gear only into its equipment slot (and
// only once repaired), nothing put down past the bag's open rows (the backpack sets them; taking it off leaves what's
// there stranded, not lost) and only where it fits in a grid, and parts only into the matching slots of the item on
// the workbench or in a building's or vehicle's box (fitPart / unfitPart).
import { boxKind, fittedBox, takeOnly, type BoxKind } from './boxes.ts';
import { bagShape, EQUIP_SLOTS, fitsSlot, GEAR, isGear, isVehicle, repaired } from './gear.ts';
import {
  BIKE_COLS, BIKE_ROWS, CHEST_COLS, fitsAt, freeSlots, gridShape, makeItem, moveItem, partAt, setPart, sizeOf, strandedAt, withData,
  type Item, type Part, type Shape, type Slots,
} from './items.ts';

/** Which box ids hold what: 'equip' is the player's EQUIP_SLOTS, 'bench' the workbench's one slot. */
export type Boxes = Record<string, Slots | undefined>;

/** A box's layout (shared/items.ts Shape): the bag's depends on the backpack, a chest's on how far it has grown. */
export function boxShape(box: string, boxes: Boxes): Shape {
  const k = boxKind(box);
  return k ? SHAPES[k.kind](box, boxes) : freeSlots(0);
}
const grown = (box: string, boxes: Boxes) => gridShape(CHEST_COLS, Math.floor((boxes[box]?.length ?? 0) / CHEST_COLS));
const SHAPES: Record<BoxKind, (box: string, boxes: Boxes) => Shape> = {
  bag: (_, boxes) => bagShape(boxes.equip),
  equip: () => freeSlots(EQUIP_SLOTS.length),
  bench: () => freeSlots(1),
  bld: () => freeSlots(1),
  veh: () => freeSlots(1),
  cargo: () => gridShape(BIKE_COLS, BIKE_ROWS),
  chest: grown,
  corpse: grown,
};

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
 * Did the move strand anything in bag rows the backpack (as it is after the move) doesn't open? Items already lying
 * there stay stranded (from before this rule, or a backpack lost on dying; shown red, only to be moved out), but
 * nothing new goes there, and a backpack with things in its rows can't come off (or be swapped for a smaller one).
 */
function strandsNew(before: Boxes, after: Boxes): boolean {
  const bag = after.bag, old = before.bag;
  if (!bag || !old) return false;
  const shape = bagShape(after.equip), oldShape = bagShape(before.equip);
  for (let i = 0; i < bag.length; i++) {
    const x = bag[i], o = old[i];
    if (x && strandedAt(bag, shape, i) && !(o && o.id === x.id && o.kind === x.kind && !!o.r === !!x.r && strandedAt(old, oldShape, i))) return true;
  }
  return false;
}

/** Would going from `before` to `after` shut away what a carrier holds: strand the backpack's rows? */
function losesCargo(before: Boxes, after: Boxes): boolean {
  return strandsNew(before, after);
}

/** Is the item at `box`[i] a carrier with something in it (so it can't leave: empty it first)? */
export function holdsCargo(boxes: Boxes, box: string, i: number): boolean {
  if (!boxes[box]?.[i]) return false;
  const after = cloneBoxes(boxes, [box]);
  after[box]![i] = null;
  return losesCargo(boxes, after);
}

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
  // A dead player's pack (shared/corpse.ts) is only taken from; a building's or vehicle's item stays in it.
  if (to !== from && takeOnly(to)) return false;
  if (fittedBox(from) || fittedBox(to)) return false;
  // Vehicles are never carried (nor put in a cargo).
  if (isVehicle(it.kind)) return false;
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
  if (!changesAllowed(boxes, b, ids) || losesCargo(boxes, b)) return false;
  for (const id of ids) boxes[id]!.splice(0, boxes[id]!.length, ...b[id]!);
  return true;
}

const sameItem = (a: Item, b: Item | null | undefined) => !!b && a.id === b.id && a.kind === b.kind && a.n === b.n && !!a.r === !!b.r;

/** Does every slot of `ids` that changed from `before` to `after` allow what's in it now? */
function changesAllowed(before: Boxes, after: Boxes, ids: string[]): boolean {
  for (const id of ids) {
    const slots = after[id]!;
    for (let i = 0; i < slots.length; i++) {
      const x = slots[i];
      if (x && x !== before[id]![i] && !sameItem(x, before[id]![i]) && !allowed(id, i, x, after)) return false;
    }
  }
  return true;
}

/**
 * Fit the part at `from`[fi] into slot `slot` of the item in box `at` (the workbench, a building's or a vehicle's box). A part
 * already there comes out into `from`[fi] in its place (or anywhere in the bag if one of the stack stays behind):
 * that's how you upgrade. Applies to `boxes` only if allowed; returns whether it did.
 */
export function fitPart(boxes: Boxes, from: string, fi: number, slot: number, newId: () => number, at = 'bench'): boolean {
  const target = boxes[at]?.[0];
  const src = boxes[from];
  const part = src?.[fi];
  const spec = target && GEAR[target.kind]?.slots[slot];
  if (!target || !src || !part || !spec || !fitsSlot(spec, part.kind) || from === at || fittedBox(from)) return false;
  const old = partAt(target, slot);
  // The same part with the same data: nothing would change.
  if (old?.kind === part.kind && JSON.stringify(old.data ?? null) === JSON.stringify(part.data ?? null)) return false;
  const ids = [...new Set([from, 'bag', at])];
  const b = cloneBoxes(boxes, ids);
  const s = b[from]!;
  const p = s[fi]!;
  if (p.n > 1) {
    p.n--;
    if (old && !giveBack(b, old, newId)) return false;
  } else {
    // The old part lies down where the new one was (the same part, so the same size), else anywhere in the bag.
    s[fi] = null;
    if (old && fitsAt(s, boxShape(from, b), fi, ...sizeOf(old.kind, p.r))) s[fi] = makeItem(newId(), { ...old, r: p.r });
    else if (old && !giveBack(b, old, newId)) return false;
  }
  const t = { ...b[at]![0]! };
  setPart(t, slot, { kind: part.kind, ...withData(part.data) });
  b[at]![0] = t;
  for (const id of ids) boxes[id]?.splice(0, boxes[id]!.length, ...b[id]!);
  return true;
}

/** Take the part in slot `slot` of the item in box `at` (the workbench, a building's or a vehicle's box) out into
 *  `to`[ti] (-1: anywhere in it). */
export function unfitPart(boxes: Boxes, slot: number, to: string, ti: number, newId: () => number, at = 'bench'): boolean {
  const target = boxes[at]?.[0];
  if (!target || !boxes[to] || takeOnly(to) || to === at || fittedBox(to)) return false;
  const part = partAt(target, slot);
  if (!part) return false;
  const b = cloneBoxes(boxes, [...new Set([to, at])]);
  const dst = b[to]!;
  const tmp: Slots = [makeItem(newId(), part)];
  if (!moveItem(tmp, 0, ONE, dst, ti, boxShape(to, b), undefined, newId) || tmp[0]) return false;
  // Into the equipment or onto the workbench only by the same rules as a move (a part is never either).
  if (!changesAllowed(boxes, b, [to])) return false;
  const t = { ...b[at]![0]! };
  setPart(t, slot, null);
  b[at]![0] = t;
  for (const id of new Set([to, at])) boxes[id]!.splice(0, boxes[id]!.length, ...b[id]!);
  return true;
}

/** A lone item, handed between boxes. */
const ONE: Shape = { free: 1, cols: 1, rows: 0, grid: 0 };

function giveBack(b: Boxes, part: Part, newId: () => number): boolean {
  const tmp: Slots = [makeItem(newId(), part)];
  return !!b.bag && moveItem(tmp, 0, ONE, b.bag, -1, bagShape(b.equip), undefined, newId) && !tmp[0];
}
