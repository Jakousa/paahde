// Server side of items (shared/items.ts): every box's slots, cached from the `items` table, the starter
// kit, scrap pickups landing in the bag, and validated moves and sorts between the boxes a player can
// open (shared/storage.ts).
import { addItem, hasItem, stackOf, HOTBAR, moveItem, roomFor, sortItems, STARTER_KIT, type Slots } from '../shared/items.ts';
import type { PlayerState } from '../shared/sim.ts';
import { boxSize, canOpen, isShared } from '../shared/storage.ts';
import { craft, RECIPES } from '../shared/crafting.ts';
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

  /** A box's slots (loaded on first use). Rows past its size (a box that shrank) are kept at the end. */
  slots(browserId: string, box: string): Slots {
    const owner = this.ownerOf(browserId, box);
    const key = `${owner}|${box}`;
    let slots = this.boxes.get(key);
    if (!slots) {
      const rows = this.db.loadBox(owner, box);
      slots = new Array(Math.max(boxSize(box), ...rows.map((r) => r.slot + 1))).fill(null);
      for (const r of rows) slots[r.slot] = { id: r.id, kind: r.kind, n: r.n };
      this.boxes.set(key, slots);
      // Stacks bigger than their kind allows now (stacking was turned off): one item per slot, the rest
      // into empty slots and then past the end, so nothing is lost.
      let split = false;
      for (const it of [...slots]) {
        for (; it && it.n > stackOf(it.kind); it.n--) {
          const i = slots.indexOf(null);
          slots[i < 0 ? slots.length : i] = { id: this.newId(), kind: it.kind, n: 1 };
          split = true;
        }
      }
      if (split) this.save(browserId, box);
    }
    return slots;
  }

  private save(browserId: string, ...boxes: string[]) {
    this.db.saveBoxes([...new Set(boxes)].map((box) => ({ owner: this.ownerOf(browserId, box), box, slots: this.slots(browserId, box) })));
  }

  /** New players get the canteen and spyglass, once (dropping them in a chest doesn't bring new ones). */
  giveStarterKit(browserId: string) {
    if (this.db.hasStarterKit(browserId)) return;
    const bag = this.slots(browserId, 'bag');
    this.db.tx(() => {
      for (const kind of STARTER_KIT) addItem(bag, kind, 1, this.newId);
      this.save(browserId, 'bag');
      this.db.markStarterKit(browserId);
    });
  }

  has(browserId: string, kind: string) {
    return hasItem(this.slots(browserId, 'bag'), kind);
  }

  roomFor(browserId: string, kind: string) {
    return roomFor(this.slots(browserId, 'bag'), kind);
  }

  /** One `kind` into the bag (past the hotbar first). False if it's full. Call inside the pickup's transaction. */
  give(browserId: string, kind: string): boolean {
    if (!addItem(this.slots(browserId, 'bag'), kind, 1, this.newId, HOTBAR)) return false;
    this.save(browserId, 'bag');
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
    if (bench < 0 || stationReach(s, bench) > STATION_REACH + REACH_SLACK) return 'Stand at the workbench to craft';
    if (!craft(this.slots(browserId, 'bag'), recipe, this.newId)) return 'Missing parts';
    this.save(browserId, 'bag');
    return { made: RECIPES[recipe].makes };
  }

  /** A move from the client. Returns whether anything changed (either way the client gets both boxes back). */
  move(browserId: string, s: PlayerState, from: unknown, fi: unknown, to: unknown, ti: unknown, n: unknown): boolean {
    if (typeof from !== 'string' || typeof to !== 'string' || !boxSize(from) || !boxSize(to)) return false;
    if (!canOpen(s, from, REACH_SLACK) || !canOpen(s, to, REACH_SLACK)) return false;
    const src = this.slots(browserId, from), dst = this.slots(browserId, to);
    if (!Number.isInteger(fi) || (fi as number) < 0 || (fi as number) >= src.length) return false;
    if (!Number.isInteger(ti) || (ti as number) < -1 || (ti as number) >= dst.length) return false;
    if (n !== undefined && (!Number.isInteger(n) || (n as number) < 1)) return false;
    if (!moveItem(src, fi as number, dst, ti as number, n as number | undefined, this.newId, to === 'bag' ? HOTBAR : 0)) return false;
    this.save(browserId, from, to);
    return true;
  }

  sort(browserId: string, s: PlayerState, box: unknown): boolean {
    if (typeof box !== 'string' || !boxSize(box) || !canOpen(s, box, REACH_SLACK)) return false;
    sortItems(this.slots(browserId, box), box === 'bag' ? HOTBAR : 0);
    this.save(browserId, box);
    return true;
  }

  /** Forget a player's own boxes once their last connection closes (shared ones stay cached). */
  forget(browserId: string) {
    for (const key of this.boxes.keys()) if (key.startsWith(`${browserId}|`)) this.boxes.delete(key);
  }
}
