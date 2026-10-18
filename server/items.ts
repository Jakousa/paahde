// Server side of items (shared/items.ts): every box's slots, cached from the `items` table, the one-time gear
// setup, pickups landing in the bag, and validated moves, sorts and repairs between the boxes a player can
// open (shared/storage.ts; the rules are shared/gear.ts tryMove / fitPart / unfitPart).
import { bagShape, boxShape, EQUIP_SLOTS, fitPart, GEAR, isGear, tryMove, unfitPart, type Boxes } from '../shared/gear.ts';
import {
  addItem, BAG_SLOTS, CHEST_COLS, CHEST_ROWS, findSpot, gridShape, hasItem, HOTBAR, partKind, roomFor, settle, sizeOf, sortItems, stackOf,
  type Item, type Slots,
} from '../shared/items.ts';
import type { PlayerState } from '../shared/sim.ts';
import { boxSize, canOpen, growChest, isShared, OWN_BOXES } from '../shared/storage.ts';
import { craft, RECIPES } from '../shared/crafting.ts';
import { RIFLE } from '../shared/rifle.ts';
import { STATION_REACH, stationReach, STATIONS } from '../shared/stations.ts';
import type { openDb } from './db.ts';

type Db = ReturnType<typeof openDb>;

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
      for (const r of rows) slots[r.slot] = { id: r.id, kind: r.kind, n: r.n, ...(r.parts ? { parts: r.parts } : {}), ...(r.r ? { r: true } : {}) };
      this.boxes.set(key, slots);
      let changed = false;
      for (const it of [...slots]) {
        // Gear from before repairs existed (the old starter canteen and spyglass) works: Scrap parts in every slot.
        if (it && isGear(it.kind) && !it.parts) {
          it.parts = GEAR[it.kind].slots.map((s) => ('part' in s ? partKind(s.part, 'scrap') : s.scrap[s.scrap.length - 1]));
          changed = true;
        }
        // Stacks bigger than their kind allows now: one item per stack, the rest past the end for settle() to place.
        for (; it && it.n > stackOf(it.kind); it.n--) {
          slots.push({ id: this.newId(), kind: it.kind, n: 1 });
          changed = true;
        }
      }
      // The bag's own rows past the backpack are kept (stranded) rather than moved: settle with the backpack's shape.
      if (settle(slots, boxShape(box, this.view(browserId, box)), isShared(box))) changed = true;
      if (isShared(box)) growChest(slots);
      if (changed) this.save(browserId, box);
    }
    return slots;
  }

  private save(browserId: string, ...boxes: string[]) {
    for (const box of boxes) if (isShared(box)) growChest(this.slots(browserId, box));
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
        const pack: Item = { id: this.newId(), kind: 'backpack', n: 1, parts: ['bent_frame', partKind('gear', 'quality')] };
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
   * Once, to the players from before the laser rifle (shared/rifle.ts): one in the 4th hotbar slot. New players craft
   * their own.
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
      bag[slot] = { id: this.newId(), kind, n: 1 };
      if (was) {
        const spot = findSpot(bag, this.bagShape(browserId), was.kind, !!was.r, [slot]);
        if (spot) {
          const moved: Item = { ...was };
          if (spot.r) moved.r = true;
          else delete moved.r;
          bag[spot.i] = moved;
        }
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

  /** One `kind` into the bag (the backpack first, then the hotbar). False if it's full. Call inside the pickup's transaction. */
  give(browserId: string, kind: string): boolean {
    if (!addItem(this.slots(browserId, 'bag'), kind, 1, this.newId, this.bagShape(browserId))) return false;
    this.save(browserId, 'bag');
    return true;
  }

  /** A whole item (gear with its parts) into the first spot it fits in the bag. False if there is none. */
  giveItem(browserId: string, item: { kind: string; parts?: (string | null)[] }): boolean {
    if (!item.parts) return this.give(browserId, item.kind);
    const bag = this.slots(browserId, 'bag');
    const spot = findSpot(bag, this.bagShape(browserId), item.kind);
    if (!spot) return false;
    bag[spot.i] = { id: this.newId(), kind: item.kind, n: 1, parts: [...item.parts], ...(spot.r ? { r: true } : {}) };
    this.save(browserId, 'bag');
    return true;
  }

  /** Repaired gear straight into its equipment slot, if it has one and that's free. */
  equip(browserId: string, item: { kind: string; parts: (string | null)[] }): boolean {
    const slot = GEAR[item.kind]?.equip;
    const equip = this.slots(browserId, 'equip');
    const i = slot ? EQUIP_SLOTS.indexOf(slot) : -1;
    if (i < 0 || equip[i]) return false;
    equip[i] = { id: this.newId(), kind: item.kind, n: 1, parts: [...item.parts] };
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

  /** Use up one `kind` from bag slot `slot`. False if that slot holds something else. */
  takeAt(browserId: string, slot: number, kind: string): boolean {
    const bag = this.slots(browserId, 'bag');
    const it = bag[slot];
    if (it?.kind !== kind) return false;
    if (--it.n <= 0) bag[slot] = null;
    this.save(browserId, 'bag');
    return true;
  }

  /** Craft a recipe (shared/crafting.ts) at the workbench. Returns the item kind made, or why not. */
  craft(browserId: string, s: PlayerState, recipe: unknown): string | { made: string } {
    if (typeof recipe !== 'string' || !RECIPES[recipe]) return 'Unknown recipe';
    const bench = STATIONS.findIndex((st) => st.kind === 'workbench');
    if (bench < 0 || stationReach(s, bench) > STATION_REACH + REACH_SLACK) return 'Too far';
    if (!craft(this.slots(browserId, 'bag'), recipe, this.newId, this.bagShape(browserId))) return 'Missing parts';
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
   * Take one of the item at `box`[slot] out to drop it on the sand (not from the equipment or the workbench:
   * take it off first). Returns what came out, or null if refused. Call inside the drop's transaction.
   */
  drop(browserId: string, s: PlayerState, box: unknown, slot: unknown): { kind: string; parts?: (string | null)[] } | null {
    if (typeof box !== 'string' || !boxSize(box) || box === 'equip' || box === 'bench' || !canOpen(s, box, REACH_SLACK)) return null;
    const slots = this.slots(browserId, box);
    if (!Number.isInteger(slot) || (slot as number) < 0 || (slot as number) >= slots.length) return null;
    const it = slots[slot as number];
    if (!it) return null;
    if (--it.n <= 0) slots[slot as number] = null;
    this.save(browserId, box);
    return { kind: it.kind, ...(it.parts ? { parts: it.parts } : {}) };
  }

  /** Fit the part at `from`[fi] into slot `slot` of the item on the workbench (swapping out what was there). */
  fit(browserId: string, s: PlayerState, from: unknown, fi: unknown, slot: unknown): boolean {
    if (typeof from !== 'string' || !boxSize(from) || !canOpen(s, from, REACH_SLACK) || !canOpen(s, 'bench', REACH_SLACK)) return false;
    if (!Number.isInteger(fi) || !Number.isInteger(slot)) return false;
    if (!fitPart(this.view(browserId, from), from, fi as number, slot as number, this.newId)) return false;
    this.save(browserId, from, 'bag', 'bench');
    return true;
  }

  /** Take the part in slot `slot` of the workbench item out into `to`[ti] (-1: anywhere). */
  unfit(browserId: string, s: PlayerState, slot: unknown, to: unknown, ti: unknown): boolean {
    if (typeof to !== 'string' || !boxSize(to) || !canOpen(s, to, REACH_SLACK) || !canOpen(s, 'bench', REACH_SLACK)) return false;
    if (!Number.isInteger(slot) || !Number.isInteger(ti) || (ti as number) < -1) return false;
    if (!unfitPart(this.view(browserId, to), slot as number, to, ti as number, this.newId)) return false;
    this.save(browserId, to, 'bench');
    return true;
  }

  sort(browserId: string, s: PlayerState, box: unknown): boolean {
    if (typeof box !== 'string' || !boxSize(box) || box === 'equip' || box === 'bench' || !canOpen(s, box, REACH_SLACK)) return false;
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
      const moved: Item = { ...it };
      delete moved.r;
      if (spot?.r) moved.r = true;
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
