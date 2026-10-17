// Items: the catalogue, slot containers ("boxes") and the rules for moving stacks between them. The server
// owns every item (server/items.ts, `items` table, one row per stack with a stable id); the client applies
// the same moves at once and the server's answer then replaces them (src/net.ts).
import { SCRAP_KINDS } from './scrap.ts';

/** Item kind ids as stored in the DB. Never rename one: rows hold them. `stack` is 1 for all: nothing stacks for now. */
export const ITEMS: Record<string, { label: string; stack: number }> = {
  canteen: { label: 'Canteen', stack: 1 },
  spyglass: { label: 'Spyglass', stack: 1 },
  oil_drum: { label: 'Oil drum', stack: 1 },
  rusty_drum: { label: 'Rusty drum', stack: 1 },
  gear: { label: 'Gear', stack: 1 },
  scrap_frame: { label: 'Scrap frame', stack: 1 },
  bent_frame: { label: 'Bent frame', stack: 1 },
  metal_plank: { label: 'Metal plank', stack: 1 },
  metal_sheet: { label: 'Metal sheet', stack: 1 },
  dented_sheet: { label: 'Dented sheet', stack: 1 },
  spring: { label: 'Spring', stack: 1 },
};
const ORDER = Object.keys(ITEMS);

/** Item kind of each scrap prop, by SCRAP_KINDS index. */
export const SCRAP_ITEMS = ['oil_drum', 'rusty_drum', 'gear', 'scrap_frame', 'bent_frame', 'metal_plank', 'metal_sheet', 'dented_sheet', 'spring'];
if (SCRAP_ITEMS.length !== SCRAP_KINDS.length) throw new Error('shared/items.ts: SCRAP_ITEMS out of step with SCRAP_KINDS');

/** One stack. `id` is its DB row id (negative: a client-side guess until the server answers). */
export type Item = { id: number; kind: string; n: number };
export type Slots = (Item | null)[];

/** The player's own bag: HOTBAR slots of hotbar (keys 1–4, src/water.ts), then 8 of backpack. */
export const HOTBAR = 4;
export const BAG_SLOTS = HOTBAR + 8;
/** What every new player starts with, in hotbar order. */
export const STARTER_KIT = ['canteen', 'spyglass'];

export const stackOf = (kind: string) => ITEMS[kind]?.stack ?? 1;

/** Does `slots` hold an item of this kind? */
export const hasItem = (slots: Slots | undefined, kind: string) => !!slots?.some((it) => it?.kind === kind);

/** Room for n more of `kind` (stacking first)? */
export function roomFor(slots: Slots, kind: string, n = 1): boolean {
  let room = 0;
  for (const it of slots) room += !it ? stackOf(kind) : it.kind === kind ? stackOf(kind) - it.n : 0;
  return room >= n;
}

/**
 * Put n of `kind` into `slots`: onto stacks of it first, then into empty slots from `from` on (wrapping
 * round, so pickups land in the bag before the hotbar). Mutates; false (and no change) if there's no room.
 */
export function addItem(slots: Slots, kind: string, n: number, newId: () => number, from = 0): boolean {
  if (!roomFor(slots, kind, n)) return false;
  for (const it of slots) {
    if (n === 0) break;
    if (it?.kind !== kind) continue;
    const k = Math.min(n, stackOf(kind) - it.n);
    it.n += k;
    n -= k;
  }
  for (let j = 0; j < slots.length && n > 0; j++) {
    const i = (from + j) % slots.length;
    if (slots[i]) continue;
    const k = Math.min(n, stackOf(kind));
    slots[i] = { id: newId(), kind, n: k };
    n -= k;
  }
  return true;
}

/**
 * Drag n (default all) of the stack at src[si] onto dst[di]: into an empty slot, onto a stack of the same
 * kind (what doesn't fit stays behind), or swapped with a different item (whole stacks only).
 * di = -1 means "anywhere in dst" (shift-click): onto its stacks, then the first empty slot from `from` on.
 * src and dst may be the same array. Mutates; returns whether anything changed.
 */
export function moveItem(src: Slots, si: number, dst: Slots, di: number, n: number | undefined, newId: () => number, from = 0): boolean {
  const it = src[si];
  if (!it) return false;
  const k = Math.max(1, Math.min(it.n, n ?? it.n));
  if (di === -1) {
    if (src === dst) return false;
    let left = k;
    for (const d of dst) {
      if (left === 0) break;
      if (d?.kind !== it.kind) continue;
      const m = Math.min(left, stackOf(it.kind) - d.n);
      d.n += m;
      left -= m;
    }
    let empty = -1;
    for (let j = 0; j < dst.length && empty < 0; j++) if (!dst[(from + j) % dst.length]) empty = (from + j) % dst.length;
    if (left > 0 && empty >= 0) {
      // The rest goes into an empty slot: as the stack itself (keeping its id) when all of it moves.
      if (k === it.n) {
        it.n = left;
        dst[empty] = it;
        src[si] = null;
        return true;
      }
      dst[empty] = { id: newId(), kind: it.kind, n: left };
      left = 0;
    }
    it.n -= k - left;
    if (it.n === 0) src[si] = null;
    return left < k;
  }
  if (src === dst && si === di) return false;
  const d = dst[di];
  if (!d) {
    if (k === it.n) {
      dst[di] = it;
      src[si] = null;
    } else {
      dst[di] = { id: newId(), kind: it.kind, n: k };
      it.n -= k;
    }
    return true;
  }
  if (d.kind === it.kind) {
    const m = Math.min(k, stackOf(it.kind) - d.n);
    if (m === 0) return false;
    d.n += m;
    it.n -= m;
    if (it.n === 0) src[si] = null;
    return true;
  }
  if (k !== it.n) return false;
  src[si] = d;
  dst[di] = it;
  return true;
}

/**
 * Tidy slots[from..]: merge part stacks of the same kind and order by catalogue (then fullest first).
 * The bag passes from = HOTBAR so the hotbar stays as the player set it. Mutates; merged-away stacks drop out.
 */
export function sortItems(slots: Slots, from = 0) {
  const items = slots.slice(from).filter((it): it is Item => !!it);
  const merged: Item[] = [];
  for (const it of items) {
    let left = it.n;
    for (const m of merged) {
      if (m.kind !== it.kind || left === 0) continue;
      const k = Math.min(left, stackOf(it.kind) - m.n);
      m.n += k;
      left -= k;
    }
    if (left > 0) merged.push({ ...it, n: left });
  }
  merged.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.n - a.n || a.id - b.id);
  for (let i = from; i < slots.length; i++) slots[i] = merged[i - from] ?? null;
}
