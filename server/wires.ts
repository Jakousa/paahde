// Server side of the power lines (shared/wires.ts): the `wires` table, stringing one from the coil in a player's hand
// (used up) and taking one down (the coil back), taking a thing's wires down when it is picked up. Keeps
// shared/wires.ts's list in step and broadcasts it when it changes.
import { EYE_HEIGHT } from '../shared/dig.ts';
import { placed } from '../shared/placed.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { CONNECT_REACH, hasConnector, setWires, socketAt, wireBetween, wireError, wires, type Wire } from '../shared/wires.ts';
import { TEXT } from '../shared/text.ts';
import type { openDb } from './db.ts';
import type { ItemServer } from './items.ts';

type Db = ReturnType<typeof openDb>;

/** Slack (m) on the reach check for the server's view of the player lagging the client's. */
const REACH_SLACK = 1.5;

export class WireServer {
  private db: Db;
  private items: ItemServer;
  private changed = false;

  /** Call after the placed list is loaded (server/placed.ts). Wires to things that are gone are dropped. */
  constructor(db: Db, items: ItemServer) {
    this.db = db;
    this.items = items;
    const ids = new Set(placed.filter((p) => hasConnector(p.kind)).map((p) => p.id));
    const list = db.loadWires();
    for (const w of list) if (!ids.has(w.a) || !ids.has(w.b)) db.deleteWire(w.id);
    setWires(list.filter((w) => ids.has(w.a) && ids.has(w.b)));
  }

  /**
   * String a wire from `a` to `b` with the coil in bag slot `slot` (it is used up), or, if they are wired already, take
   * that wire down (its coil into the bag). `feet`: the player, who must be in reach of `b`'s connector (the second
   * click). Returns whether a wire went up or came down, or why not.
   */
  connect(browserId: string, feet: { x: number; y: number; z: number }, slot: unknown, a: unknown, b: unknown): 'up' | 'down' | string {
    const pa = placed.find((p) => p.id === a), pb = placed.find((p) => p.id === b);
    if (!pa || !pb) return TEXT.notice.alreadyGone;
    const s = socketAt(pb);
    if (Math.hypot(s.x - feet.x, s.y - feet.y - EYE_HEIGHT, s.z - feet.z) > CONNECT_REACH + REACH_SLACK) return TEXT.notice.tooFar;
    const had = wireBetween(pa.id, pb.id);
    if (had) {
      if (!this.items.roomFor(browserId, had.kind)) return TEXT.notice.bagFull;
      const ok = this.db.tx(() => {
        if (!this.items.give(browserId, had.kind)) return false;
        this.db.deleteWire(had.id);
        return true;
      });
      if (!ok) return TEXT.notice.bagFull;
      setWires(wires.filter((w) => w !== had));
      this.changed = true;
      return 'down';
    }
    const kind = Number.isInteger(slot) ? this.items.slots(browserId, 'bag')[slot as number]?.kind : undefined;
    const why = wireError(pa, pb, kind);
    if (why) return why;
    const w = this.db.tx((): Wire | null => {
      if (!this.items.takeAt(browserId, slot as number, kind!)) return null;
      const lo = Math.min(pa.id, pb.id), hi = Math.max(pa.id, pb.id);
      return { id: this.db.insertWire(lo, hi, kind!, browserId), a: lo, b: hi, kind: kind! };
    });
    if (!w) return TEXT.notice.cantConnect;
    setWires([...wires, w]);
    this.changed = true;
    return 'up';
  }

  /**
   * Placed thing `id` is being picked up: its wires come down. Their coils go to `give` (the bag); what it can't take
   * is handed to `drop`. Call inside the pick-up's transaction.
   */
  takeDown(id: number, give: (kind: string) => boolean, drop: (kind: string) => void) {
    const gone = wires.filter((w) => w.a === id || w.b === id);
    if (!gone.length) return;
    for (const w of gone) {
      this.db.deleteWire(w.id);
      if (!give(w.kind)) drop(w.kind);
    }
    setWires(wires.filter((w) => !gone.includes(w)));
    this.changed = true;
  }

  joinMessage(): ServerMsg {
    return { t: 'wires', list: wires };
  }

  flush(): ServerMsg | null {
    if (!this.changed) return null;
    this.changed = false;
    return this.joinMessage();
  }
}
