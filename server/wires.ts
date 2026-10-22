// Server side of the power lines (shared/wires.ts): the `wires` table, stringing one with wiring from a player's bag
// (used up by its length) and taking one down (the wiring back), taking a thing's wires down when it is. Keeps
// shared/wires.ts's list in step and broadcasts it when it changes.
import { EYE_HEIGHT } from '../shared/dig.ts';
import { placed } from '../shared/placed.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { WIRING } from '../shared/items.ts';
import { CONNECT_REACH, hasConnector, isWiring, setWires, socketAt, wireBetween, wireCost, wireError, wires, type Wire } from '../shared/wires.ts';
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
   * String a wire from `a` to `b` with the wiring in bag slot `slot` in hand (what it takes is used up from the bag), or,
   * if they are wired already, take that wire down (its wiring into the bag). `feet`: the player, who must be in reach
   * of `b`'s connector (the second click). Returns whether a wire went up or came down, or why not.
   */
  connect(browserId: string, feet: { x: number; y: number; z: number }, slot: unknown, a: unknown, b: unknown): 'up' | 'down' | string {
    const pa = placed.find((p) => p.id === a), pb = placed.find((p) => p.id === b);
    if (!pa || !pb) return TEXT.notice.alreadyGone;
    const s = socketAt(pb);
    if (Math.hypot(s.x - feet.x, s.y - feet.y - EYE_HEIGHT, s.z - feet.z) > CONNECT_REACH + REACH_SLACK) return TEXT.notice.tooFar;
    const had = wireBetween(pa.id, pb.id);
    if (had) {
      const ok = this.db.tx(() => {
        if (!this.items.give(browserId, WIRING, wireCost(pa, pb))) return false;
        this.db.deleteWire(had.id);
        return true;
      });
      if (!ok) return TEXT.notice.bagFull;
      setWires(wires.filter((w) => w !== had));
      this.changed = true;
      return 'down';
    }
    const kind = Number.isInteger(slot) ? this.items.slots(browserId, 'bag')[slot as number]?.kind : undefined;
    if (!isWiring(kind)) return TEXT.notice.cantConnect;
    const why = wireError(pa, pb, this.items.count(browserId, WIRING));
    if (why) return why;
    const w = this.db.tx((): Wire | null => {
      if (!this.items.spend(browserId, WIRING, wireCost(pa, pb))) return null;
      const lo = Math.min(pa.id, pb.id), hi = Math.max(pa.id, pb.id);
      return { id: this.db.insertWire(lo, hi, WIRING, browserId), a: lo, b: hi };
    });
    if (!w) return TEXT.notice.cantConnect;
    setWires([...wires, w]);
    this.changed = true;
    return 'up';
  }

  /** The wiring in placed thing `id`'s wires: what comes back when it is taken down (server/placed.ts unplace). */
  refund(id: number): { kind: string; n: number }[] {
    let n = 0;
    for (const w of wires) {
      if (w.a !== id && w.b !== id) continue;
      const pa = placed.find((p) => p.id === w.a), pb = placed.find((p) => p.id === w.b);
      if (pa && pb) n += wireCost(pa, pb);
    }
    return n ? [{ kind: WIRING, n }] : [];
  }

  /** Placed thing `id` was taken down (its wiring given back with it, refund): its wires are gone. */
  takeDown(id: number) {
    const gone = wires.filter((w) => w.a === id || w.b === id);
    if (!gone.length) return;
    for (const w of gone) this.db.deleteWire(w.id);
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
