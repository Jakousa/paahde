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

  constructor(db: Db, items: ItemServer, tell: (msg: ServerMsg) => void) {
    this.db = db;
    this.items = items;
    this.tell = tell;
    for (const c of db.loadCorpses()) CORPSES.set(c.id, c);
    this.expire(false); // nobody to tell yet
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
   * nothing was left (an empty bag, or in or over the base).
   */
  leave(browserId: string, color: number, x: number, z: number): string | null {
    if (!canDropAt(x, z) || !this.items.hasPack(browserId)) return null;
    let made = -1;
    try {
      return this.db.tx(() => {
        const until = Date.now() + CORPSE_MS;
        const c: Corpse = { id: this.db.insertCorpse(browserId, color, x, z, until), x, z, color, until };
        CORPSES.set((made = c.id), c);
        this.items.leave(browserId, corpseBox(c.id));
        this.tell({ t: 'corpses', add: [c], remove: [] });
        return corpseBox(c.id);
      });
    } catch (e) {
      // Rolled back: the bag is reloaded from the DB as it was.
      if (made >= 0) {
        CORPSES.delete(made);
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
  expire(tell = true) {
    const now = Date.now();
    for (const c of [...CORPSES.values()]) if (c.until <= now) this.remove(c.id, tell);
  }

  private remove(id: number, tell = true) {
    const box = corpseBox(id);
    this.db.deleteCorpse(id);
    CORPSES.delete(id);
    this.items.dropBox(box);
    if (tell) this.tell({ t: 'corpses', add: [], remove: [id] });
  }
}
