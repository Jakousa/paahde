// Server side of scrap pickups: validates pickup requests, keeps the taken set (shared/scrap.ts) and
// inventories in SQLite, respawns pieces after RESPAWN_MS and batches changes for broadcast.
import type { ServerMsg } from '../shared/protocol.ts';
import { PICKUP_REACH, SCRAP_KINDS, scrapChanged, scrapPiece, scrapReach, scrapTaken } from '../shared/scrap.ts';
import type { openDb } from './db.ts';

type Db = ReturnType<typeof openDb>;

/** Picked-up junk reappears after this long, so the desert never runs dry. */
const RESPAWN_MS = 30 * 60 * 1000;
/** Slack on top of PICKUP_REACH for the server's view of the player lagging the client's. */
const REACH_SLACK = 1.5;
/** Minimum time between one player's pickups. */
const PICKUP_COOLDOWN_MS = 200;

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
   * A player asks to pick up piece i of cell (ix, iz). Returns the player's new inventory, or null if
   * refused (unknown piece, already taken, out of reach, too soon).
   */
  pickup(playerId: string, feet: { x: number; y: number; z: number }, ix: unknown, iz: unknown, i: unknown, last: { at: number }): number[] | null {
    const pc = scrapPiece(ix as number, iz as number, i as number);
    const now = Date.now();
    if (!pc || scrapTaken.has(pc.key) || now - last.at < PICKUP_COOLDOWN_MS) return null;
    if (scrapReach(feet, pc) > PICKUP_REACH + REACH_SLACK) return null;
    last.at = now;
    this.db.takeScrap(playerId, pc.ix, pc.iz, pc.i, pc.kind, now);
    this.taken.set(pc.key, [pc.ix, pc.iz, pc.i, now]);
    scrapTaken.add(pc.key);
    scrapChanged();
    this.newlyTaken.push(pc.ix, pc.iz, pc.i);
    return this.inventory(playerId);
  }

  /** Count per SCRAP_KINDS index. */
  inventory(playerId: string): number[] {
    const items = SCRAP_KINDS.map(() => 0);
    for (const r of this.db.getInventory(playerId)) if (r.kind >= 0 && r.kind < items.length) items[r.kind] = r.count;
    return items;
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
