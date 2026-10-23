// Server side of items (shared/items.ts): every box's slots, cached from the `items` table, the one-time gear
// setup, pickups landing in the bag, and validated moves, sorts and repairs between the boxes a player can
// open (shared/storage.ts; the rules are shared/gear.ts tryMove / fitPart / unfitPart).
import { bagShape, boxShape, EQUIP_SLOTS, fitPart, fittedBox, GEAR, holdsCargo, SHIELD_BREAKS, isGear, refit, scrapParts, shieldSaves, tierOf, tryMove, unfitPart, type Boxes } from '../shared/gear.ts';
import {
  addItem, addUpTo, BAG_SLOTS, makeItem, ownOf, partAt, CHEST_COLS, CHEST_ROWS, findSpot, gridShape, hasItem, HOTBAR, partKind, RETIRED, roomFor, CLOTH, SCRAP, setData, setPart, settle, sizeOf, sortItems, stackOf, stacks,
  type Item, type ItemData, type Slots,
} from '../shared/items.ts';
import type { PlayerState } from '../shared/sim.ts';
import { boxSize, canOpen, growChest, grows, isShared, OWN_BOXES } from '../shared/storage.ts';
import { buildCost, craft, isBuildable, RECIPES, useUp, type Recipe } from '../shared/crafting.ts';
import { RIFLE } from '../shared/rifle.ts';
import { STATION_REACH, stationReach, STATIONS } from '../shared/stations.ts';
import type { openDb } from './db.ts';
import { TEXT } from '../shared/text.ts';

type Db = ReturnType<typeof openDb>;

/** Pile stacks of one kind onto the first of them, up to its stack size (shared/items.ts stacks). Mutates; whether it did. */
function mergeStacks(slots: Slots): boolean {
  let changed = false;
  for (let i = 0; i < slots.length; i++) {
    const a = slots[i];
    if (!a || a.n >= stackOf(a.kind)) continue;
    for (let j = i + 1; j < slots.length && a.n < stackOf(a.kind); j++) {
      const b = slots[j];
      if (!b || !stacks(a, b)) continue;
      const k = Math.min(b.n, stackOf(a.kind) - a.n);
      a.n += k;
      b.n -= k;
      if (b.n <= 0) slots[j] = null;
      changed = true;
    }
  }
  return changed;
}

/** Slack (m) on the reach checks for the server's view of the player lagging the client's. */
const REACH_SLACK = 1.5;

export class ItemServer {
  private db: Db;
  /** owner + '|' + box → slots. */
  private boxes = new Map<string, Slots>();
  private lastId: number;
  private newId = () => ++this.lastId;

  constructor(db: Db) {
    this.db = db;
    this.lastId = db.maxItemId();
  }

  private ownerOf(browserId: string, box: string) {
    return isShared(box) ? '' : browserId;
  }

  /**
   * A box's slots (loaded on first use). Items that don't fit where they lie (the grid changed, or item sizes did)
   * are laid out again (shared/items.ts settle); what doesn't fit at all is kept past the end.
   */
  slots(browserId: string, box: string): Slots {
    const owner = this.ownerOf(browserId, box);
    const key = `${owner}|${box}`;
    let slots = this.boxes.get(key);
    if (!slots) {
      const rows = this.db.loadBox(owner, box);
      slots = new Array(Math.max(boxSize(box), ...rows.map((r) => r.slot + 1))).fill(null);
      for (const r of rows) if (!RETIRED.has(r.kind)) slots[r.slot] = makeItem(r.id, r);
      this.boxes.set(key, slots);
      let changed = rows.some((r) => RETIRED.has(r.kind));
      // Buildings from when they were crafted and carried (shared/crafting.ts BUILDS): back into what they were made
      // of, their parts and materials, laid out by settle() below. (Not on the workbench, whose one slot can't take
      // them: moved off it, they're turned back next time the box loads.)
      if (!fittedBox(box) && box !== 'bench') {
        for (let i = 0; i < slots.length; i++) {
          const it = slots[i];
          if (!it || !isBuildable(it.kind)) continue;
          slots[i] = null;
          for (const m of buildCost(it.kind)) {
            for (let n = m.n; n > 0; n -= stackOf(m.kind)) slots.push(makeItem(this.newId(), { kind: m.kind, n: Math.min(n, stackOf(m.kind)) }));
          }
          for (let j = 0; j < (it.parts?.length ?? 0); j++) {
            const p = partAt(it, j);
            if (p) slots.push(makeItem(this.newId(), p));
          }
          changed = true;
        }
      }
      for (const it of [...slots]) {
        // Gear from before repairs existed (the old starter canteen and spyglass, guns crafted before they were gear)
        // works: Scrap parts in every slot.
        if (it && isGear(it.kind) && !it.parts) {
          it.parts = scrapParts(it.kind);
          changed = true;
        }
        // Gear whose slots changed since (shared/gear.ts refit).
        if (it && refit(it)) changed = true;
        // Stacks bigger than their kind allows now: one item per stack, the rest past the end for settle() to place.
        for (; it && it.n > stackOf(it.kind); it.n--) {
          slots.push(makeItem(this.newId(), { kind: it.kind }));
          changed = true;
        }
      }
      // Scrap migrated from the old kinds (server/db.ts) comes as many stacks of one: merge them.
      if (mergeStacks(slots)) changed = true;
      // The bag's own rows past the backpack are kept (stranded) rather than moved: settle with the backpack's shape.
      if (settle(slots, boxShape(box, this.view(browserId, box)), isShared(box))) changed = true;
      if (grows(box)) growChest(slots);
      if (changed) this.save(browserId, box);
    }
    return slots;
  }

  private save(browserId: string, ...boxes: string[]) {
    for (const box of boxes) if (grows(box)) growChest(this.slots(browserId, box));
    this.db.saveBoxes([...new Set(boxes)].map((box) => ({ owner: this.ownerOf(browserId, box), box, slots: this.slots(browserId, box) })));
  }

  /** The boxes a rule check needs: the player's own, plus `extra`. */
  private view(browserId: string, ...extra: string[]): Boxes {
    const b: Boxes = {};
    for (const box of new Set([...OWN_BOXES, ...extra])) if (boxSize(box)) b[box] = this.slots(browserId, box);
    return b;
  }

  /**
   * Once per player: there's no starter kit any more (the water bottle and the rest are found broken, see
   * server/loot.ts). Players from before keep what they had, and get a backpack with a Quality gear (9 slots) so
   * their bag keeps its 8; if its slot is taken, it goes past the end of the bag.
   */
  setup(browserId: string) {
    this.rifleGift(browserId);
    if (this.db.hasGearKit(browserId)) return;
    this.db.tx(() => {
      if (this.db.hasStarterKit(browserId)) {
        const equip = this.slots(browserId, 'equip');
        const pack = makeItem(this.newId(), { kind: 'backpack', parts: [CLOTH, SCRAP, partKind('gear', 'quality')] });
        const back = EQUIP_SLOTS.indexOf('back');
        if (!equip[back]) equip[back] = pack;
        else {
          const bag = this.slots(browserId, 'bag');
          bag.push(pack);
        }
        this.save(browserId, 'equip', 'bag');
      } else this.db.markStarterKit(browserId);
      this.db.markGearKit(browserId);
    });
  }

  /**
   * Once, to the players from before the laser rifle (shared/rifle.ts): one in the 4th hotbar slot. New players find
   * and repair their own.
   */
  private rifleGift(browserId: string) {
    this.slotGift(browserId, 'rifle', RIFLE, HOTBAR - 1, this.db.hasGearKit(browserId));
  }

  /**
   * Grant `grant`, once: if `give`, a `kind` into bag slot `slot`. Whatever was there moves to the first free spot in
   * the bag (past its end if there's none).
   */
  private slotGift(browserId: string, grant: string, kind: string, slot: number, give: boolean) {
    if (this.db.hasGrant(browserId, grant)) return;
    this.db.tx(() => {
      this.db.markGrant(browserId, grant);
      if (!give) return;
      const bag = this.slots(browserId, 'bag');
      const was = bag[slot];
      bag[slot] = makeItem(this.newId(), { kind, ...(isGear(kind) ? { parts: scrapParts(kind) } : {}) });
      if (was) {
        const spot = findSpot(bag, this.bagShape(browserId), was.kind, !!was.r, [slot]);
        if (spot) bag[spot.i] = makeItem(was.id, { ...was, r: spot.r });
        else bag.push(was);
      }
      this.save(browserId, 'bag');
    });
  }

  has(browserId: string, kind: string) {
    return hasItem(this.slots(browserId, 'bag'), kind);
  }

  /** The bag's layout right now (the equipped backpack opens its rows). */
  bagShape(browserId: string) {
    return bagShape(this.slots(browserId, 'equip'));
  }

  roomFor(browserId: string, kind: string) {
    return roomFor(this.slots(browserId, 'bag'), kind, this.bagShape(browserId));
  }

  /** `n` (default one) `kind` into the bag (the backpack first, then the hotbar); all or none. False if they don't fit.
   *  Call inside the pickup's transaction. */
  give(browserId: string, kind: string, n = 1): boolean {
    if (!addItem(this.slots(browserId, 'bag'), kind, n, this.newId, this.bagShape(browserId))) return false;
    this.save(browserId, 'bag');
    return true;
  }

  /** Up to `n` `kind` into the bag, as many as fit (the backpack first, then the hotbar). Returns how many went in. */
  giveUpTo(browserId: string, kind: string, n: number): number {
    const got = addUpTo(this.slots(browserId, 'bag'), kind, n, this.newId, this.bagShape(browserId));
    if (got) this.save(browserId, 'bag');
    return got;
  }

  /** Everything in `list` into the bag (one with `data` is one of its own), all or none. False (and no change) if it
   *  doesn't all fit. Call inside a transaction. */
  giveAll(browserId: string, list: { kind: string; n: number; data?: ItemData }[]): boolean {
    const bag = this.slots(browserId, 'bag');
    const s = bag.map((it) => it && { ...it });
    const shape = this.bagShape(browserId);
    if (!list.every((m) => m.n <= 0 || addItem(s, m.kind, m.n, this.newId, shape, m.data))) return false;
    bag.splice(0, bag.length, ...s);
    this.save(browserId, 'bag');
    return true;
  }

  /** A whole item (gear with its parts, anything with its own state) into the first spot it fits in the bag. False if there is none. */
  giveItem(browserId: string, item: { kind: string; parts?: (string | null)[]; data?: ItemData }): boolean {
    if (!item.parts && !item.data) return this.give(browserId, item.kind);
    const bag = this.slots(browserId, 'bag');
    const spot = findSpot(bag, this.bagShape(browserId), item.kind);
    if (!spot) return false;
    bag[spot.i] = makeItem(this.newId(), { ...item, n: 1, r: spot.r });
    this.save(browserId, 'bag');
    return true;
  }

  /** Repaired gear straight into its equipment slot, if it has one and that's free. */
  equip(browserId: string, item: { kind: string; parts: (string | null)[]; data?: ItemData }): boolean {
    const slot = GEAR[item.kind]?.equip;
    const equip = this.slots(browserId, 'equip');
    const i = slot ? EQUIP_SLOTS.indexOf(slot) : -1;
    if (i < 0 || equip[i]) return false;
    equip[i] = makeItem(this.newId(), { ...item, n: 1 });
    this.save(browserId, 'equip');
    return true;
  }

  /** Use up one `kind` from the bag (the last stack that has one). False if there is none. */
  take(browserId: string, kind: string): boolean {
    const bag = this.slots(browserId, 'bag');
    for (let i = bag.length - 1; i >= 0; i--) {
      const it = bag[i];
      if (it?.kind !== kind) continue;
      if (--it.n <= 0) bag[i] = null;
      this.save(browserId, 'bag');
      return true;
    }
    return false;
  }

  /** How many `kind` the bag holds. */
  count(browserId: string, kind: string): number {
    return this.slots(browserId, 'bag').reduce((n, it) => n + (it?.kind === kind ? it.n : 0), 0);
  }

  /** Use up `n` `kind` from the bag (the last stacks first); all or none. Call inside a transaction. */
  spend(browserId: string, kind: string, n: number): boolean {
    if (this.count(browserId, kind) < n) return false;
    const bag = this.slots(browserId, 'bag');
    for (let i = bag.length - 1; i >= 0 && n > 0; i--) {
      const it = bag[i];
      if (it?.kind !== kind) continue;
      const k = Math.min(n, it.n);
      it.n -= k;
      n -= k;
      if (it.n <= 0) bag[i] = null;
    }
    this.save(browserId, 'bag');
    return true;
  }

  /** Use up what `recipe` needs from the bag (shared/crafting.ts useUp); all or none. Call inside a transaction. */
  useUp(browserId: string, recipe: Recipe): boolean {
    if (!useUp(this.slots(browserId, 'bag'), recipe)) return false;
    this.save(browserId, 'bag');
    return true;
  }

  /** Take the whole item (one of a stack) out of bag slot `slot`, if it is a `kind`. Call inside a transaction. */
  takeItemAt(browserId: string, slot: number, kind: string): Item | null {
    const bag = this.slots(browserId, 'bag');
    const it = bag[slot];
    if (it?.kind !== kind) return null;
    const out = makeItem(this.newId(), { ...it, n: 1, r: false });
    if (--it.n <= 0) bag[slot] = null;
    this.save(browserId, 'bag');
    return out;
  }

  /** Change the item at `box`[slot] in place: `fn` changes it and says whether it did; the box is saved if so. */
  edit(browserId: string, box: string, slot: number, fn: (it: Item) => boolean) {
    const it = this.slots(browserId, box)[slot];
    if (it && fn(it)) this.save(browserId, box);
  }

  /** A building's item into its box (shared/gear.ts buildingBox), which must be empty. Call inside a transaction. */
  stow(box: string, it: Item) {
    const slots = this.slots('', box);
    slots.fill(null);
    slots[0] = it;
    this.save('', box);
  }

  /** A new building's item, its part slots empty (shared/gear.ts built), or a vehicle's with `parts`, into its box.
   *  Call inside a transaction. */
  stowNew(box: string, kind: string, parts: (string | null)[] = GEAR[kind].slots.map(() => null), data?: ItemData) {
    this.stow(box, makeItem(this.newId(), { kind, parts, data }));
  }

  /** What a building's box holds, taken out (the box is emptied and forgotten). Call inside a transaction. */
  unstow(box: string): Item | null {
    const it = this.slots('', box)[0] ?? null;
    this.boxes.set(`|${box}`, []);
    this.save('', box);
    this.boxes.delete(`|${box}`);
    return it;
  }

  /** Use up one `kind` from bag slot `slot`. False if that slot holds something else. */
  takeAt(browserId: string, slot: number, kind: string): boolean {
    const bag = this.slots(browserId, 'bag');
    const it = bag[slot];
    if (it?.kind !== kind) return false;
    if (--it.n <= 0) bag[slot] = null;
    this.save(browserId, 'bag');
    return true;
  }

  /** Empty part slot `i` of the gear in bag slot `slot` (its part used up). False if nothing is fitted there. */
  /** The equipped shield plate took a blow. Its last one (shared/gear.ts shieldSaves) breaks it: what breaks of it
   *  (SHIELD_BREAKS) is gone and its wear starts over. True if it broke. */
  wearShield(browserId: string): boolean {
    const it = this.slots(browserId, 'equip')[EQUIP_SLOTS.indexOf('armor')];
    if (it?.kind !== 'shield' || !it.parts) return false;
    const worn = (it.data?.worn ?? 0) + 1, broke = worn >= shieldSaves(tierOf(it));
    if (broke) for (const j of SHIELD_BREAKS) setPart(it, j, null);
    setData(it, 'worn', broke ? undefined : worn);
    this.save(browserId, 'equip');
    return broke;
  }

  spendPart(browserId: string, slot: number, i: number): boolean {
    const it = this.slots(browserId, 'bag')[slot];
    if (!it?.parts?.[i]) return false;
    setPart(it, i, null);
    this.save(browserId, 'bag');
    return true;
  }

  /** Craft a recipe (shared/crafting.ts) at the workbench. Returns the item kind made, or why not. */
  craft(browserId: string, s: PlayerState, recipe: unknown): string | { made: string } {
    if (typeof recipe !== 'string' || !RECIPES[recipe]) return TEXT.notice.unknownRecipe;
    const bench = STATIONS.findIndex((st) => st.kind === 'workbench');
    if (bench < 0 || stationReach(s, bench) > STATION_REACH + REACH_SLACK) return TEXT.notice.tooFar;
    if (!craft(this.slots(browserId, 'bag'), recipe, this.newId, this.bagShape(browserId))) return TEXT.notice.missingParts;
    this.save(browserId, 'bag');
    return { made: RECIPES[recipe].makes };
  }

  /** A move from the client. Returns whether anything changed (either way the client gets both boxes back). */
  move(browserId: string, s: PlayerState, from: unknown, fi: unknown, to: unknown, ti: unknown, n: unknown, r: unknown): boolean {
    if (typeof from !== 'string' || typeof to !== 'string' || !boxSize(from) || !boxSize(to)) return false;
    if (!canOpen(s, from, REACH_SLACK) || !canOpen(s, to, REACH_SLACK)) return false;
    if (!Number.isInteger(fi) || (fi as number) < 0 || (fi as number) >= this.slots(browserId, from).length) return false;
    if (!Number.isInteger(ti) || (ti as number) < -1 || (ti as number) >= this.slots(browserId, to).length) return false;
    if (n !== undefined && (!Number.isInteger(n) || (n as number) < 1)) return false;
    if (r !== undefined && typeof r !== 'boolean') return false;
    if (!tryMove(this.view(browserId, from, to), from, fi as number, to, ti as number, n as number | undefined, this.newId, r)) return false;
    this.save(browserId, from, to);
    return true;
  }

  /**
   * Take one of the item at `box`[slot] out to drop it on the sand (equipment too: a backpack's contents stay in
   * the bag's closed rows; not a carrier with something in it, nor a building's or vehicle's own item). Returns what came out, or null if refused. Call
   * inside the drop's transaction.
   */
  drop(browserId: string, s: PlayerState, box: unknown, slot: unknown): { kind: string; parts?: (string | null)[]; data?: ItemData } | null {
    if (typeof box !== 'string' || !boxSize(box) || fittedBox(box) || !canOpen(s, box, REACH_SLACK)) return null;
    const slots = this.slots(browserId, box);
    if (!Number.isInteger(slot) || (slot as number) < 0 || (slot as number) >= slots.length) return null;
    const it = slots[slot as number];
    if (!it || holdsCargo(this.view(browserId, box), box, slot as number)) return null;
    if (--it.n <= 0) slots[slot as number] = null;
    this.save(browserId, box);
    return { kind: it.kind, ...ownOf(it) };
  }

  /** Fit the part at `from`[fi] into slot `slot` of the item in `at`: the workbench, or a building's or vehicle's box
   *  (swapping out what was there). */
  fit(browserId: string, s: PlayerState, from: unknown, fi: unknown, slot: unknown, at: unknown = 'bench'): boolean {
    if (typeof from !== 'string' || !boxSize(from) || !canOpen(s, from, REACH_SLACK) || !this.fitsAt(s, at)) return false;
    if (!Number.isInteger(fi) || !Number.isInteger(slot)) return false;
    if (!fitPart(this.view(browserId, from, at), from, fi as number, slot as number, this.newId, at)) return false;
    this.save(browserId, from, 'bag', at);
    return true;
  }

  /** Take the part in slot `slot` of the item in `at` (the workbench, or a building's or vehicle's box) out into
   *  `to`[ti] (-1: anywhere). `may`: whether a part may come out of that box (not out of a working vehicle). */
  unfit(browserId: string, s: PlayerState, slot: unknown, to: unknown, ti: unknown, at: unknown = 'bench', may = (_box: string) => true): boolean {
    if (typeof to !== 'string' || !boxSize(to) || !canOpen(s, to, REACH_SLACK) || !this.fitsAt(s, at) || !may(at)) return false;
    if (!Number.isInteger(slot) || !Number.isInteger(ti) || (ti as number) < -1) return false;
    if (!unfitPart(this.view(browserId, to, at), slot as number, to, ti as number, this.newId, at)) return false;
    this.save(browserId, to, at);
    return true;
  }

  /** Parts are fitted at the workbench and into buildings and vehicles, in reach. */
  private fitsAt(s: PlayerState, at: unknown): at is string {
    return (at === 'bench' || (typeof at === 'string' && fittedBox(at) && boxSize(at) > 0)) && canOpen(s, at, REACH_SLACK);
  }

  sort(browserId: string, s: PlayerState, box: unknown): boolean {
    if (typeof box !== 'string' || !boxSize(box) || box === 'equip' || box === 'bench' || fittedBox(box) || !canOpen(s, box, REACH_SLACK)) return false;
    if (!sortItems(this.slots(browserId, box), boxShape(box, this.view(browserId, box)))) return false;
    this.save(browserId, box);
    return true;
  }

  /** Anything in the bag past the hotbar (what dying leaves behind, server/corpses.ts)? */
  hasPack(browserId: string): boolean {
    return this.slots(browserId, 'bag').some((it, i) => i >= HOTBAR && !!it);
  }

  /**
   * Dying: everything in the bag past the hotbar moves (keeping its ids) into the new, empty pack box `box`
   * (shared/corpse.ts), biggest first, packed from the top; the hotbar and the equipment stay. Call inside the
   * transaction that records the pack, once it's in CORPSES.
   */
  leave(browserId: string, box: string) {
    const bag = this.slots(browserId, 'bag');
    const out = bag.slice(HOTBAR).filter((it): it is Item => !!it);
    const area = (it: Item) => sizeOf(it.kind)[0] * sizeOf(it.kind)[1];
    out.sort((a, b) => area(b) - area(a));
    bag.fill(null, HOTBAR);
    bag.length = BAG_SLOTS;
    const pack: Slots = new Array(CHEST_COLS * CHEST_ROWS).fill(null);
    for (const it of out) {
      growChest(pack); // MAX_SIDE free rows below what's in: anything fits
      const spot = findSpot(pack, gridShape(CHEST_COLS, pack.length / CHEST_COLS), it.kind, false, [], false);
      const moved = makeItem(it.id, { ...it, r: spot?.r });
      if (spot) pack[spot.i] = moved;
      else pack.push(moved);
    }
    this.boxes.set(`|${box}`, pack);
    this.save(browserId, 'bag', box);
  }

  isEmpty(box: string): boolean {
    return this.slots('', box).every((it) => !it);
  }

  /** A shared box that's gone (an emptied or expired pack): forget it. */
  dropBox(box: string) {
    this.boxes.delete(`|${box}`);
  }

  /** Forget a player's own boxes once their last connection closes (shared ones stay cached). */
  forget(browserId: string) {
    for (const key of this.boxes.keys()) if (key.startsWith(`${browserId}|`)) this.boxes.delete(key);
  }
}
