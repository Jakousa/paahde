// Server side of placed things (shared/placed.ts): the `placed` table, putting an item from the bag down on
// the bunker floor and picking it back up, both in one transaction with the bag. Keeps shared/placed.ts's
// list (and so the base collision) in step, and broadcasts the list when it changes.
import { EYE_HEIGHT } from '../shared/dig.ts';
import { isPlaceable, PLACE_FLOOR_Y, PLACE_REACH, PLACED_REACH, placeError, placed, placedReach, setPlaced, type Placed } from '../shared/placed.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import type { openDb } from './db.ts';
import type { ItemServer } from './items.ts';
import { TEXT } from '../shared/text.ts';

type Db = ReturnType<typeof openDb>;

/** Slack (m) on the reach checks for the server's view of the player lagging the client's. */
const REACH_SLACK = 1.5;

export class PlacedServer {
  private db: Db;
  private items: ItemServer;
  private changed = false;

  constructor(db: Db, items: ItemServer) {
    this.db = db;
    this.items = items;
    setPlaced(db.loadPlaced().filter((r) => isPlaceable(r.kind)).map((r) => ({ id: r.id, kind: r.kind, x: r.x, z: r.z, rot: r.rot })));
  }

  /**
   * Put the item in bag slot `slot` down at (x, z). `players`: everyone's feet (nobody gets boxed in).
   * Returns the new placed thing, or why not.
   */
  place(browserId: string, feet: { x: number; y: number; z: number }, slot: unknown, x: unknown, z: unknown, rot: unknown,
    players: { x: number; y: number; z: number }[]): Placed | string {
    const kind = Number.isInteger(slot) ? this.items.slots(browserId, 'bag')[slot as number]?.kind : undefined;
    if (!kind || !isPlaceable(kind)) return TEXT.notice.cantPlace;
    if (typeof x !== 'number' || typeof z !== 'number' || typeof rot !== 'number') return TEXT.notice.badSpot;
    const dy = PLACE_FLOOR_Y - feet.y - EYE_HEIGHT;
    if (Math.hypot(x - feet.x, dy, z - feet.z) > PLACE_REACH + REACH_SLACK) return TEXT.notice.tooFar;
    const why = placeError(kind, x, z, rot, placed, players);
    if (why) return why;
    const p = this.db.tx(() => {
      if (!this.items.takeAt(browserId, slot as number, kind)) return null;
      return { id: this.db.insertPlaced(kind, x, z, rot, browserId), kind, x, z, rot };
    });
    if (!p) return TEXT.notice.cantPlace;
    setPlaced([...placed, p]);
    this.changed = true;
    return p;
  }

  /** Pick placed thing `id` back up into the bag. Returns it, or why not. */
  unplace(browserId: string, feet: { x: number; y: number; z: number }, id: unknown): Placed | string {
    const p = placed.find((q) => q.id === id);
    if (!p) return TEXT.notice.alreadyGone;
    if (placedReach(feet, p) > PLACED_REACH + REACH_SLACK) return TEXT.notice.tooFar;
    if (!this.items.roomFor(browserId, p.kind)) return TEXT.notice.bagFull;
    const ok = this.db.tx(() => {
      if (!this.items.give(browserId, p.kind)) return false;
      this.db.deletePlaced(p.id);
      return true;
    });
    if (!ok) return TEXT.notice.bagFull;
    setPlaced(placed.filter((q) => q !== p));
    this.changed = true;
    return p;
  }

  joinMessage(): ServerMsg {
    return { t: 'placed', list: placed };
  }

  flush(): ServerMsg | null {
    if (!this.changed) return null;
    this.changed = false;
    return this.joinMessage();
  }
}
