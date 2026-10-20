// Server side of scrap pickups: validates pickup requests, keeps the taken set (shared/scrap.ts) in
// SQLite, respawns pieces after RESPAWN_MS and batches changes for broadcast. The piece goes into the
// player's bag (server/items.ts) in the same transaction.
import type { ServerMsg } from '../shared/protocol.ts';
import { PICKUP_REACH, scrapChanged, scrapPiece, scrapReach, scrapTaken } from '../shared/scrap.ts';
import type { openDb } from './db.ts';
import { spendPickup, type PickupLimit } from './pickupLimit.ts';

type Db = ReturnType<typeof openDb>;

/** Picked-up junk reappears after this long, so the desert never runs dry. */
const RESPAWN_MS = 30 * 60 * 1000;
/** Slack on top of PICKUP_REACH for the server's view of the player lagging the client's. */
const REACH_SLACK = 1.5;

export class ScrapServer {
  private db: Db;
  /** Taken pieces: key → [ix, iz, i, takenAt]. */
  private taken = new Map<string, [number, number, number, number]>();
  private newlyTaken: number[] = [];
  private newlyBack: number[] = [];

  constructor(db: Db) {
    this.db = db;
    for (const r of db.loadTaken()) {
      const pc = scrapPiece(r.ix, r.iz, r.i);
      if (!pc) continue; // the layout changed since: forget it
      this.taken.set(pc.key, [r.ix, r.iz, r.i, r.taken_at]);
      scrapTaken.add(pc.key);
    }
    scrapChanged();
    console.log(`scrap: ${this.taken.size} pieces taken`);
  }

  /**
   * A player asks to pick up piece i of cell (ix, iz). `give(kind)` puts it in their bag (false: no room).
   * Returns the SCRAP_KINDS index taken, or null if refused (unknown piece, already taken, out of reach,
   * too many at once, bag full).
   */
  pickup(feet: { x: number; y: number; z: number }, ix: unknown, iz: unknown, i: unknown, limit: PickupLimit, give: (kind: number) => boolean): number | null {
    const pc = scrapPiece(ix as number, iz as number, i as number);
    const now = Date.now();
    if (!pc || scrapTaken.has(pc.key)) return null;
    if (scrapReach(feet, pc) > PICKUP_REACH + REACH_SLACK || !spendPickup(limit, now)) return null;
    const ok = this.db.tx(() => {
      if (!give(pc.kind)) return false;
      this.db.takeScrap(pc.ix, pc.iz, pc.i, now);
      return true;
    });
    if (!ok) return null;
    this.taken.set(pc.key, [pc.ix, pc.iz, pc.i, now]);
    scrapTaken.add(pc.key);
    scrapChanged();
    this.newlyTaken.push(pc.ix, pc.iz, pc.i);
    return pc.kind;
  }

  /** Respawn pieces taken more than RESPAWN_MS ago. */
  respawn() {
    const cutoff = Date.now() - RESPAWN_MS;
    let any = false;
    for (const [k, [ix, iz, i, at]] of this.taken) {
      if (at > cutoff) continue;
      this.taken.delete(k);
      scrapTaken.delete(k);
      this.db.respawnScrap(ix, iz, i);
      this.newlyBack.push(ix, iz, i);
      any = true;
    }
    if (any) scrapChanged();
  }

  /** Everything taken, for a joining client. */
  joinMessage(): ServerMsg {
    const taken: number[] = [];
    for (const [ix, iz, i] of this.taken.values()) taken.push(ix, iz, i);
    return { t: 'scrap', taken, back: [], reset: true };
  }

  /** Changes since the last flush, or null. */
  flush(): ServerMsg | null {
    if (!this.newlyTaken.length && !this.newlyBack.length) return null;
    const msg: ServerMsg = { t: 'scrap', taken: this.newlyTaken, back: this.newlyBack };
    this.newlyTaken = [];
    this.newlyBack = [];
    return msg;
  }
}
