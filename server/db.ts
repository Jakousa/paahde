import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { addItem, HOTBAR, BAG_SLOTS, SCRAP_ITEMS, type Slots } from '../shared/items.ts';

export type PlayerRow = { id: string; color: number; x: number; z: number; heat: number; sips: number };
/** A disassembly-table job (bench_jobs). */
export type BenchRow = { kind: string; seed: number; done: number[]; taken: number[]; given: string[] };

export function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS players (
      id         TEXT PRIMARY KEY,           -- browser ID (random UUID from localStorage)
      color      INTEGER NOT NULL,
      x          REAL NOT NULL,
      y          REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // v2 (3D desert): position is x/z on the ground; y is derived from the terrain.
  const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all('players') as { name: string }[];
  if (!cols.some((c) => c.name === 'z')) db.exec('ALTER TABLE players ADD COLUMN z REAL NOT NULL DEFAULT 0; UPDATE players SET x = 0');
  // v3 (survival, shared/water.ts): thirst bar and canteen sips.
  if (!cols.some((c) => c.name === 'water')) db.exec('ALTER TABLE players ADD COLUMN water REAL NOT NULL DEFAULT 100');
  if (!cols.some((c) => c.name === 'sips')) db.exec('ALTER TABLE players ADD COLUMN sips INTEGER NOT NULL DEFAULT 4');
  // v4: the thirst bar became a heat meter (0 = cool); `water` is unused from here on.
  if (!cols.some((c) => c.name === 'heat')) db.exec('ALTER TABLE players ADD COLUMN heat REAL NOT NULL DEFAULT 0');

  const get = db.prepare('SELECT id, color, x, z, heat, sips FROM players WHERE id = ?');
  const upsert = db.prepare(`
    INSERT INTO players (id, color, x, y, z, heat, sips) VALUES (?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET x = excluded.x, z = excluded.z, heat = excluded.heat, sips = excluded.sips,
      last_seen = datetime('now')
  `);

  // Terrain edit layer (shared/terrain.ts): one row per chunk, data = Int32Array of millimetre offsets
  // (EDIT_CHUNK² values, little-endian).
  db.exec(`
    CREATE TABLE IF NOT EXISTS terrain_chunks (
      cx         INTEGER NOT NULL,
      cz         INTEGER NOT NULL,
      data       BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (cx, cz)
    );
  `);
  const allChunks = db.prepare('SELECT cx, cz, data FROM terrain_chunks');
  const upsertChunk = db.prepare(`
    INSERT INTO terrain_chunks (cx, cz, data) VALUES (?, ?, ?)
    ON CONFLICT (cx, cz) DO UPDATE SET data = excluded.data, updated_at = datetime('now')
  `);

  // Run fn in one transaction (nested calls join the outer one).
  let depth = 0;
  function tx<T>(fn: () => T): T {
    if (depth > 0) return fn();
    db.exec('BEGIN');
    depth++;
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      depth--;
    }
  }

  // Scrap (shared/scrap.ts): picked-up pieces until they respawn.
  db.exec(`
    CREATE TABLE IF NOT EXISTS scrap_taken (
      ix       INTEGER NOT NULL,
      iz       INTEGER NOT NULL,
      i        INTEGER NOT NULL,
      taken_at INTEGER NOT NULL,              -- ms since epoch
      PRIMARY KEY (ix, iz, i)
    );
  `);
  const allTaken = db.prepare('SELECT ix, iz, i, taken_at FROM scrap_taken');
  const insertTaken = db.prepare('INSERT OR REPLACE INTO scrap_taken (ix, iz, i, taken_at) VALUES (?, ?, ?, ?)');
  const deleteTaken = db.prepare('DELETE FROM scrap_taken WHERE ix = ? AND iz = ? AND i = ?');

  // Items (shared/items.ts, server/items.ts): one row per stack, in a slot of a box. Player boxes ('bag',
  // 'bike') belong to the player; shared ones ('chest<i>') to nobody ('').
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id    INTEGER PRIMARY KEY,               -- stable stack id
      kind  TEXT NOT NULL,                     -- ITEMS key
      n     INTEGER NOT NULL,                  -- stack size
      owner TEXT NOT NULL,                     -- browser ID, '' for shared boxes
      box   TEXT NOT NULL,                     -- 'bag', 'bike', 'chest<i>'
      slot  INTEGER NOT NULL,
      UNIQUE (owner, box, slot)
    );
    CREATE TABLE IF NOT EXISTS starter_kits (
      player_id TEXT PRIMARY KEY,              -- got the canteen and spyglass (STARTER_KIT)
      given_at  INTEGER NOT NULL               -- ms since epoch
    );
  `);

  // Small crash sites (shared/crash.ts) whose machine was carried off, until they refill. The machine itself
  // is an item in the player's bag, given in the same transaction (server/crash.ts).
  db.exec(`
    CREATE TABLE IF NOT EXISTS crash_taken (
      id       TEXT PRIMARY KEY,
      taken_at INTEGER NOT NULL               -- ms since epoch
    );
  `);
  // Disassembly-table jobs (server/crash.ts): the carried machine a player is taking apart, one per player, until
  // it is empty. `given` lists the part item kinds already put in their bag, checked against what the seed rolls.
  db.exec(`
    CREATE TABLE IF NOT EXISTS bench_jobs (
      owner TEXT PRIMARY KEY,                -- browser ID
      kind  TEXT NOT NULL,                   -- ComponentKind
      seed  INTEGER NOT NULL,                -- what is inside (shared/parts.ts rollParts)
      done  TEXT NOT NULL,                   -- JSON step indexes
      taken TEXT NOT NULL,                   -- JSON part slot indexes
      given TEXT NOT NULL                    -- JSON item kinds
    );
  `);
  const getBench = db.prepare('SELECT kind, seed, done, taken, given FROM bench_jobs WHERE owner = ?');
  const putBench = db.prepare('INSERT OR REPLACE INTO bench_jobs (owner, kind, seed, done, taken, given) VALUES (?, ?, ?, ?, ?, ?)');
  const deleteBench = db.prepare('DELETE FROM bench_jobs WHERE owner = ?');
  const allCrash = db.prepare('SELECT id, taken_at FROM crash_taken');
  const insertCrash = db.prepare('INSERT OR REPLACE INTO crash_taken (id, taken_at) VALUES (?, ?)');
  const deleteCrash = db.prepare('DELETE FROM crash_taken WHERE id = ?');
  const boxRows = db.prepare('SELECT id, kind, n, slot FROM items WHERE owner = ? AND box = ? ORDER BY slot');
  const clearBox = db.prepare('DELETE FROM items WHERE owner = ? AND box = ?');
  const insertItem = db.prepare('INSERT INTO items (id, kind, n, owner, box, slot) VALUES (?, ?, ?, ?, ?, ?)');
  const maxItemId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM items');
  const getStarter = db.prepare('SELECT 1 FROM starter_kits WHERE player_id = ?');
  const putStarter = db.prepare('INSERT OR IGNORE INTO starter_kits (player_id, given_at) VALUES (?, ?)');
  const saveBox = (owner: string, box: string, slots: Slots) => {
    clearBox.run(owner, box);
    slots.forEach((it, slot) => it && insertItem.run(it.id, it.kind, it.n, owner, box, slot));
  };

  // v5: scrap counts per SCRAP_KINDS index (old `inventory` table) become stacks in the bag, after the hotbar.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inventory'").get()) {
    tx(() => {
      let id = (maxItemId.get() as { id: number }).id;
      const rows = db.prepare('SELECT player_id, kind, count FROM inventory WHERE count > 0 ORDER BY player_id, kind').all() as
        { player_id: string; kind: number; count: number }[];
      const bags = new Map<string, Slots>();
      for (const r of rows) {
        const kind = SCRAP_ITEMS[r.kind];
        if (!kind) continue;
        let bag = bags.get(r.player_id);
        if (!bag) bags.set(r.player_id, (bag = new Array(BAG_SLOTS).fill(null)));
        // Can't fit (more than a bag of scrap): keep what fits, one item per slot.
        for (let n = r.count; n > 0 && addItem(bag, kind, 1, () => ++id, HOTBAR); n--);
      }
      for (const [player, bag] of bags) saveBox(player, 'bag', bag);
      db.exec('DROP TABLE inventory');
      console.log(`items: moved ${bags.size} players' scrap into their bags`);
    });
  }

  // Placed things (shared/placed.ts, server/placed.ts): items put down on the bunker floor. The old
  // `garden` table (greenhouse beds by layout index) is unused since beds are placed things.
  db.exec(`
    CREATE TABLE IF NOT EXISTS placed (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      kind      TEXT NOT NULL,               -- ITEMS key (a PLACEABLES kind)
      x         REAL NOT NULL,               -- world position of the footprint centre
      z         REAL NOT NULL,
      rot       INTEGER NOT NULL,            -- 0: long side along X, 1: along Z
      owner     TEXT NOT NULL,               -- browser ID of whoever put it down
      placed_at INTEGER NOT NULL             -- ms since epoch
    );
    CREATE TABLE IF NOT EXISTS beds (
      id     INTEGER PRIMARY KEY,            -- placed id of a plant_bed
      stage  INTEGER NOT NULL,               -- EMPTY / SPROUTS / GROWN (shared/garden.ts)
      growth REAL NOT NULL                   -- ms grown under a UV lamp so far
    );
  `);
  const allPlaced = db.prepare('SELECT id, kind, x, z, rot FROM placed ORDER BY id');
  const insertPlaced = db.prepare('INSERT INTO placed (kind, x, z, rot, owner, placed_at) VALUES (?, ?, ?, ?, ?, ?)');
  const deletePlaced = db.prepare('DELETE FROM placed WHERE id = ?');
  const allBeds = db.prepare('SELECT id, stage, growth FROM beds');
  const upsertBed = db.prepare('INSERT OR REPLACE INTO beds (id, stage, growth) VALUES (?, ?, ?)');
  const deleteBed = db.prepare('DELETE FROM beds WHERE id = ?');

  // Key/value settings (the debug menu's shared-clock shift survives server restarts).
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value REAL NOT NULL)');
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const putSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  return {
    getSetting: (key: string) => (getSetting.get(key) as { value: number } | undefined)?.value,
    setSetting: (key: string, value: number) => putSetting.run(key, value),
    loadPlaced: () => allPlaced.all() as { id: number; kind: string; x: number; z: number; rot: number }[],
    /** New placed row; returns its id. */
    insertPlaced: (kind: string, x: number, z: number, rot: number, owner: string) =>
      Number(insertPlaced.run(kind, x, z, rot, owner, Date.now()).lastInsertRowid),
    deletePlaced: (id: number) => deletePlaced.run(id),
    loadBeds: () => allBeds.all() as { id: number; stage: number; growth: number }[],
    saveBed: (id: number, stage: number, growth: number) => upsertBed.run(id, stage, growth),
    deleteBed: (id: number) => deleteBed.run(id),
    loadTaken: () => allTaken.all() as { ix: number; iz: number; i: number; taken_at: number }[],
    tx,
    takeScrap: (ix: number, iz: number, i: number, at: number) => insertTaken.run(ix, iz, i, at),
    respawnScrap: (ix: number, iz: number, i: number) => deleteTaken.run(ix, iz, i),
    loadBox: (owner: string, box: string) => boxRows.all(owner, box) as { id: number; kind: string; n: number; slot: number }[],
    /** Rewrite whole boxes in one transaction (an item moving between them keeps its id). */
    saveBoxes: (boxes: { owner: string; box: string; slots: Slots }[]) => tx(() => {
      for (const b of boxes) clearBox.run(b.owner, b.box);
      for (const b of boxes) b.slots.forEach((it, slot) => it && insertItem.run(it.id, it.kind, it.n, b.owner, b.box, slot));
    }),
    maxItemId: () => (maxItemId.get() as { id: number }).id,
    hasStarterKit: (playerId: string) => !!getStarter.get(playerId),
    markStarterKit: (playerId: string) => putStarter.run(playerId, Date.now()),
    loadCrashTaken: () => allCrash.all() as { id: string; taken_at: number }[],
    takeCrash: (id: string, at: number) => insertCrash.run(id, at),
    respawnCrash: (id: string) => deleteCrash.run(id),
    loadBench(owner: string): BenchRow | null {
      const r = getBench.get(owner) as { kind: string; seed: number; done: string; taken: string; given: string } | undefined;
      return r ? { kind: r.kind, seed: r.seed, done: JSON.parse(r.done), taken: JSON.parse(r.taken), given: JSON.parse(r.given) } : null;
    },
    saveBench: (owner: string, j: BenchRow) => putBench.run(owner, j.kind, j.seed, JSON.stringify(j.done), JSON.stringify(j.taken), JSON.stringify(j.given)),
    clearBench: (owner: string) => deleteBench.run(owner),
    getPlayer: (id: string) => get.get(id) as PlayerRow | undefined,
    savePlayer: (p: PlayerRow) => upsert.run(p.id, p.color, p.x, p.z, p.heat, p.sips),
    loadChunks(): { cx: number; cz: number; data: Int32Array }[] {
      return (allChunks.all() as { cx: number; cz: number; data: Uint8Array }[]).map((r) => ({
        cx: r.cx,
        cz: r.cz,
        data: new Int32Array(r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength)),
      }));
    },
    /** Upsert several chunks in one transaction. */
    saveChunks(chunks: { cx: number; cz: number; data: Int32Array }[]) {
      if (chunks.length === 0) return;
      db.exec('BEGIN');
      try {
        for (const c of chunks) upsertChunk.run(c.cx, c.cz, new Uint8Array(c.data.buffer, c.data.byteOffset, c.data.byteLength));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    close: () => db.close(),
  };
}
