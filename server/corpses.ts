// The packs dead players leave (shared/corpse.ts): made in the same transaction that empties the bag into them,
// kept in SQLite (`corpses`, their items as box 'corpse<id>'), gone when emptied or after CORPSE_MS. Changes go to
// everyone straight away ('corpses'), the items in them as 'items' like a chest's.
import { CORPSE_MS, CORPSES, corpseBox, corpseId, type Corpse } from '../shared/corpse.ts';
import { canDropAt } from '../shared/loot.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import type { openDb } from './db.ts';
import type { ItemServer } from './items.ts';

type Db = ReturnType<typeof openDb>;

export class CorpseServer {
  private db: Db;
  private items: ItemServer;
  private tell: (msg: ServerMsg) => void;
  /** Credentials stay here, never in CORPSES or messages. Recovery time advances only while the owner plays. */
  private clocks = new Map<number, { owner: string; remaining: number; at: number }>();

  constructor(db: Db, items: ItemServer, tell: (msg: ServerMsg) => void) {
    this.db = db;
    this.items = items;
    this.tell = tell;
    const now = Date.now();
    for (const c of db.loadCorpses()) {
      // Legacy packs receive their remaining wall-clock time, with a recovery window after an offline expiry.
      const remaining = c.remaining ?? Math.max(5 * 60_000, Math.min(CORPSE_MS, c.until - now));
      this.clocks.set(c.id, { owner: c.owner, remaining, at: now });
      CORPSES.set(c.id, { id: c.id, x: c.x, z: c.z, color: c.color, until: now + remaining });
      db.saveCorpseTime(c.id, remaining, now + remaining);
    }
  }

  /** Everything, for a joining client (their contents follow as 'items'). */
  joinMessage(): ServerMsg {
    return { t: 'corpses', add: [...CORPSES.values()], remove: [], reset: true };
  }

  /** The box ids of every pack, for a joining client. */
  boxes(): string[] {
    return [...CORPSES.keys()].map(corpseBox);
  }

  /**
   * A player died at (x, z): their bag past the hotbar goes into a new pack there. Returns its box id, or null if
   * nothing was left (an empty bag, or in or over a shelter).
   */
  leave(browserId: string, color: number, x: number, z: number): string | null {
    if (!canDropAt(x, z) || !this.items.hasPack(browserId)) return null;
    let made = -1;
    try {
      return this.db.tx(() => {
        const until = Date.now() + CORPSE_MS;
        const c: Corpse = { id: this.db.insertCorpse(browserId, color, x, z, until), x, z, color, until };
        CORPSES.set((made = c.id), c);
        this.clocks.set(c.id, { owner: browserId, remaining: CORPSE_MS, at: Date.now() });
        this.db.saveCorpseTime(c.id, CORPSE_MS, until);
        this.items.leave(browserId, corpseBox(c.id));
        this.tell({ t: 'corpses', add: [c], remove: [] });
        return corpseBox(c.id);
      });
    } catch (e) {
      // Rolled back: the bag is reloaded from the DB as it was.
      if (made >= 0) {
        CORPSES.delete(made);
        this.clocks.delete(made);
        this.items.dropBox(corpseBox(made));
      }
      this.items.forget(browserId);
      throw e;
    }
  }

  /** After something came out of `box`: an emptied pack is gone. */
  check(box: unknown) {
    if (typeof box !== 'string') return;
    const id = corpseId(box);
    if (id >= 0 && this.items.isEmpty(box)) this.remove(id);
  }

  /** Every few seconds: packs that have lain long enough go, with what's in them. */
  expire(online: ReadonlySet<string>, now = Date.now()) {
    this.db.tx(() => {
      for (const [id, clock] of this.clocks) {
        if (online.has(clock.owner)) clock.remaining = Math.max(0, clock.remaining - Math.max(0, now - clock.at));
        clock.at = now;
        if (!clock.remaining) { this.remove(id); continue; }
        const c = CORPSES.get(id)!;
        c.until = now + clock.remaining;
        this.db.saveCorpseTime(id, clock.remaining, c.until);
      }
    });
  }

  private remove(id: number, tell = true) {
    const box = corpseBox(id);
    this.db.deleteCorpse(id);
    CORPSES.delete(id);
    this.clocks.delete(id);
    this.items.dropBox(box);
    if (tell) this.tell({ t: 'corpses', add: [], remove: [id] });
  }
}
