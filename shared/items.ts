// Items: the catalogue, slot containers ("boxes") and the rules for moving stacks between them. The server
// owns every item (server/items.ts, `items` table, one row per stack with a stable id); the client applies
// the same moves at once and the server's answer then replaces them (src/net.ts).
import { partItems, partItem, partOf } from './parts.ts';
import { SALVAGE, TIERS, type PartId, type Tier } from './salvage.ts';
import { CRASH_KINDS } from './crashKinds.ts';
import { SCRAP_KINDS } from './scrap.ts';

/**
 * Item kind ids as stored in the DB. Never rename one: rows hold them. `stack` is 1 for all: nothing stacks for now.
 * `tier`: the item's quality, which doubles as its rarity (RARITY in shared/salvage.ts); parts have one.
 * Gear (shared/gear.ts: the water bottle, telescope, motorcycle, ...) is found broken and repaired with parts.
 */
export const ITEMS: Record<string, { label: string; stack: number; tier?: Tier }> = {
  canteen: { label: 'Water bottle', stack: 1 },
  spyglass: { label: 'Telescope', stack: 1 },
  motorcycle: { label: 'Motorcycle', stack: 1 },
  backpack: { label: 'Backpack', stack: 1 },
  storm_detector: { label: 'Storm detector', stack: 1 },
  wristpad: { label: 'Wrist computer', stack: 1 },
  metal_detector: { label: 'Metal detector', stack: 1 },
  shovel: { label: 'Shovel', stack: 1 },
  oil_drum: { label: 'Oil drum', stack: 1 },
  rusty_drum: { label: 'Rusty drum', stack: 1 },
  gear: { label: 'Gear', stack: 1 },
  scrap_frame: { label: 'Scrap frame', stack: 1 },
  bent_frame: { label: 'Bent frame', stack: 1 },
  metal_plank: { label: 'Metal plank', stack: 1 },
  metal_sheet: { label: 'Metal sheet', stack: 1 },
  dented_sheet: { label: 'Dented sheet', stack: 1 },
  spring: { label: 'Spring', stack: 1 },
  // Small crash-site machines carried home to the disassembly table (COMPONENTS with carry: true, shared/salvage.ts).
  // The item kind is the component kind.
  robot_arm: { label: 'Robot arm joint', stack: 1 },
  control_cabinet: { label: 'Control cabinet', stack: 1 },
  // Parts taken out of machines (shared/parts.ts): `<part>_<tier>`, e.g. battery_space.
  ...partItems(),
  // Crafted at the workbench (shared/crafting.ts) and put down in the base from the hotbar (shared/placed.ts).
  plant_bed: { label: 'Plant bed', stack: 1 },
  uv_lamp: { label: 'UV lamp', stack: 1 },
  // Salvage wrecks carried home from the desert (shared/wrecks.ts), taken apart on the disassembly table too.
  vehicle_frame: { label: SALVAGE.vehicle_frame.label, stack: 1 },
  water_jet: { label: SALVAGE.water_jet.label, stack: 1 },
  warp_core: { label: SALVAGE.warp_core.label, stack: 1 },
  ai_control: { label: SALVAGE.ai_control.label, stack: 1 },
};
const ORDER = Object.keys(ITEMS);

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
 */
export type Item = { id: number; kind: string; n: number; parts?: (string | null)[] };
export type Slots = (Item | null)[];

/**
 * The player's own bag: HOTBAR slots of hotbar (keys 1–4, src/water.ts), then as many as the equipped
 * backpack holds (shared/gear.ts bagSize), up to BACKPACK_MAX. The slots array is always BAG_SLOTS long.
 */
export const HOTBAR = 4;
export const BACKPACK_MAX = 12;
export const BAG_SLOTS = HOTBAR + BACKPACK_MAX;

export const stackOf = (kind: string) => ITEMS[kind]?.stack ?? 1;

/** Does `slots` hold an item of this kind? */
export const hasItem = (slots: Slots | undefined, kind: string) => !!slots?.some((it) => it?.kind === kind);

/** Can these two stack (same kind, and no gear: every gear item is its own)? */
const stacks = (a: Item, kind: string) => a.kind === kind && !a.parts;

/** Room for n more of `kind` (stacking first) in the first `size` slots? */
export function roomFor(slots: Slots, kind: string, n = 1, size = slots.length): boolean {
  let room = 0;
  for (let i = 0; i < size; i++) {
    const it = slots[i];
    room += !it ? stackOf(kind) : stacks(it, kind) ? stackOf(kind) - it.n : 0;
  }
  return room >= n;
}

/**
 * Put n of `kind` into `slots`: onto stacks of it first, then into empty slots from `from` on (wrapping
 * round, so pickups land in the bag before the hotbar). Mutates; false (and no change) if there's no room.
 */
export function addItem(slots: Slots, kind: string, n: number, newId: () => number, from = 0, size = slots.length): boolean {
  if (!roomFor(slots, kind, n, size)) return false;
  for (let i = 0; i < size; i++) {
    const it = slots[i];
    if (n === 0) break;
    if (!it || !stacks(it, kind)) continue;
    const k = Math.min(n, stackOf(kind) - it.n);
    it.n += k;
    n -= k;
  }
  for (let j = 0; j < size && n > 0; j++) {
    const i = (from + j) % size;
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
export function moveItem(src: Slots, si: number, dst: Slots, di: number, n: number | undefined, newId: () => number, from = 0, size = dst.length): boolean {
  const it = src[si];
  if (!it) return false;
  const k = Math.max(1, Math.min(it.n, n ?? it.n));
  if (di === -1) {
    if (src === dst) return false;
    let left = k;
    for (let j = 0; j < size; j++) {
      const d = dst[j];
      if (left === 0) break;
      if (!d || !stacks(d, it.kind) || it.parts) continue;
      const m = Math.min(left, stackOf(it.kind) - d.n);
      d.n += m;
      left -= m;
    }
    let empty = -1;
    for (let j = 0; j < size && empty < 0; j++) if (!dst[(from + j) % size]) empty = (from + j) % size;
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
  if (stacks(d, it.kind) && !it.parts) {
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
      if (!stacks(m, it.kind) || it.parts || left === 0) continue;
      const k = Math.min(left, stackOf(it.kind) - m.n);
      m.n += k;
      left -= k;
    }
    if (left > 0) merged.push({ ...it, n: left });
  }
  merged.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.n - a.n || a.id - b.id);
  for (let i = from; i < slots.length; i++) slots[i] = merged[i - from] ?? null;
}
