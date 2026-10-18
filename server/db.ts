import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { addItem, BAG_COLS, BAG_ROWS, BAG_SLOTS, HOTBAR, OLD_SCRAP, SCRAP, type Item, type Slots } from '../shared/items.ts';

export type PlayerRow = { id: string; color: number; x: number; z: number; heat: number; sips: number };

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
      player_id TEXT PRIMARY KEY,              -- got the canteen and spyglass (the old starter kit)
      given_at  INTEGER NOT NULL               -- ms since epoch
    );
  `);
  // v6: gear (shared/gear.ts) records the part fitted in each slot, as JSON (NULL for anything else).
  if (!(db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).some((c) => c.name === 'parts')) {
    db.exec('ALTER TABLE items ADD COLUMN parts TEXT');
  }
  // v7: items lie in grids (shared/items.ts Shape), turned 90° when r = 1.
  if (!(db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).some((c) => c.name === 'r')) {
    db.exec('ALTER TABLE items ADD COLUMN r INTEGER NOT NULL DEFAULT 0');
  }

  // Small machine sites (shared/crash.ts) whose machine was carried off; they stay empty (taken_at is kept in case
  // they refill some day). The machine itself is an item in the player's bag, given in the same transaction
  // (server/crash.ts). crash_spent: crash sites (shared/crashsites.ts ids) whose large machine has been stripped
  // of every part; they stop smoking for good.
  db.exec(`
    CREATE TABLE IF NOT EXISTS crash_taken (
      id       TEXT PRIMARY KEY,
      taken_at INTEGER NOT NULL               -- ms since epoch
    );
    CREATE TABLE IF NOT EXISTS crash_spent (
      site     INTEGER PRIMARY KEY,
      spent_at INTEGER NOT NULL               -- ms since epoch
    );
  `);
  const allSpent = db.prepare('SELECT site, spent_at FROM crash_spent');
  const insertSpent = db.prepare('INSERT OR IGNORE INTO crash_spent (site, spent_at) VALUES (?, ?)');
  const allCrash = db.prepare('SELECT id, taken_at FROM crash_taken');
  const insertCrash = db.prepare('INSERT OR REPLACE INTO crash_taken (id, taken_at) VALUES (?, ?)');
  const deleteCrash = db.prepare('DELETE FROM crash_taken WHERE id = ?');
  // Machines being taken apart (server/crash.ts): steps done and parts taken (JSON arrays of indexes) per large
  // site id, or 'bench' for the disassembly table, whose machine (kind + seed) is in bench_job while it has one.
  db.exec(`
    CREATE TABLE IF NOT EXISTS machine_progress (
      id    TEXT PRIMARY KEY,
      done  TEXT NOT NULL,                  -- JSON [step index, ...]
      taken TEXT NOT NULL                   -- JSON [part index, ...] (shared/machine.ts machineParts)
    );
    CREATE TABLE IF NOT EXISTS bench_job (
      id   INTEGER PRIMARY KEY CHECK (id = 1),
      kind TEXT NOT NULL,                   -- component kind (shared/salvage.ts)
      seed INTEGER NOT NULL
    );
  `);
  // Which step layout `done` indexes refer to (TEARDOWN_LAYOUT in shared/crash.ts); rows from before had layout 1.
  const progCols = db.prepare('SELECT name FROM pragma_table_info(?)').all('machine_progress') as { name: string }[];
  if (!progCols.some((c) => c.name === 'layout')) db.exec('ALTER TABLE machine_progress ADD COLUMN layout INTEGER NOT NULL DEFAULT 1');
  const allProgress = db.prepare('SELECT id, done, taken, layout FROM machine_progress');
  const putProgress = db.prepare('INSERT OR REPLACE INTO machine_progress (id, done, taken, layout) VALUES (?, ?, ?, ?)');
  const deleteProgress = db.prepare('DELETE FROM machine_progress WHERE id = ?');
  const getBench = db.prepare('SELECT kind, seed FROM bench_job WHERE id = 1');
  const putBench = db.prepare('INSERT OR REPLACE INTO bench_job (id, kind, seed) VALUES (1, ?, ?)');
  const deleteBench = db.prepare('DELETE FROM bench_job');
  const nums = (json: string): number[] => {
    try {
      const a = JSON.parse(json);
      return Array.isArray(a) ? a.filter((n) => typeof n === 'number') : [];
    } catch {
      return [];
    }
  };
  const boxRows = db.prepare('SELECT id, kind, n, slot, parts, r FROM items WHERE owner = ? AND box = ? ORDER BY slot');
  const clearBox = db.prepare('DELETE FROM items WHERE owner = ? AND box = ?');
  const insertRow = db.prepare('INSERT INTO items (id, kind, n, owner, box, slot, parts, r) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertItem = (it: Item, owner: string, box: string, slot: number) =>
    insertRow.run(it.id, it.kind, it.n, owner, box, slot, it.parts ? JSON.stringify(it.parts) : null, it.r ? 1 : 0);
  const maxItemId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM items');
  db.exec('CREATE TABLE IF NOT EXISTS gear_kits (player_id TEXT PRIMARY KEY, given_at INTEGER NOT NULL)');
  const getGearKit = db.prepare('SELECT 1 FROM gear_kits WHERE player_id = ?');
  const putGearKit = db.prepare('INSERT OR IGNORE INTO gear_kits (player_id, given_at) VALUES (?, ?)');
  // One-off gifts to the players there were at the time (e.g. 'rifle': the laser rifle, to everyone who tested before it).
  db.exec('CREATE TABLE IF NOT EXISTS grants (player_id TEXT NOT NULL, what TEXT NOT NULL, given_at INTEGER NOT NULL, PRIMARY KEY (player_id, what))');
  const getGrant = db.prepare('SELECT 1 FROM grants WHERE player_id = ? AND what = ?');
  const putGrant = db.prepare('INSERT OR IGNORE INTO grants (player_id, what, given_at) VALUES (?, ?, ?)');
  const getStarter = db.prepare('SELECT 1 FROM starter_kits WHERE player_id = ?');
  const putStarter = db.prepare('INSERT OR IGNORE INTO starter_kits (player_id, given_at) VALUES (?, ?)');
  const saveBox = (owner: string, box: string, slots: Slots) => {
    clearBox.run(owner, box);
    slots.forEach((it, slot) => it && insertItem(it, owner, box, slot));
  };

  // v5: scrap counts per SCRAP_KINDS index (old `inventory` table) become stacks in the bag, after the hotbar.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inventory'").get()) {
    tx(() => {
      let id = (maxItemId.get() as { id: number }).id;
      const rows = db.prepare('SELECT player_id, kind, count FROM inventory WHERE count > 0 ORDER BY player_id, kind').all() as
        { player_id: string; kind: number; count: number }[];
      const bags = new Map<string, Slots>();
      for (const r of rows) {
        if (!OLD_SCRAP[r.kind]) continue;
        const kind = SCRAP;
        let bag = bags.get(r.player_id);
        if (!bag) bags.set(r.player_id, (bag = new Array(BAG_SLOTS).fill(null)));
        // Can't fit (more than a bag of scrap): keep what fits, one item per slot.
        for (let n = r.count; n > 0 && addItem(bag, kind, 1, () => ++id, { free: HOTBAR, cols: BAG_COLS, rows: BAG_ROWS, grid: BAG_ROWS }); n--);
      }
      for (const [player, bag] of bags) saveBox(player, 'bag', bag);
      db.exec('DROP TABLE inventory');
      console.log(`items: moved ${bags.size} players' scrap into their bags`);
    });
  }

  // v8: the scrap kinds (sheets, planks, drums, frames, ...) became one stackable SCRAP: in boxes, fitted in gear
  // (JSON parts) and dropped on the sand. The scattered stacks of one are merged when a box loads (server/items.ts).
  {
    const old = OLD_SCRAP.map((k) => `'${k}'`).join(', ');
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM items WHERE kind IN (${old})`).get() as { n: number }).n;
    tx(() => {
      db.exec(`UPDATE items SET kind = '${SCRAP}' WHERE kind IN (${old})`);
      for (const k of OLD_SCRAP) {
        db.prepare("UPDATE items SET parts = REPLACE(parts, ?, ?) WHERE parts LIKE ?").run(`"${k}"`, `"${SCRAP}"`, `%"${k}"%`);
      }
    });
    if (n) console.log(`items: ${n} old scrap stacks are scrap now`);
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

  // Items dropped on the sand (shared/loot.ts, src 'drop'): they lie there until someone picks them up, across
  // restarts. id is the loot id (finds and caches are in `world_loot`, below).
  db.exec(`
    CREATE TABLE IF NOT EXISTS dropped (
      id         INTEGER PRIMARY KEY,
      kind       TEXT NOT NULL,              -- ITEMS key
      parts      TEXT,                       -- gear: JSON part kinds per slot (shared/gear.ts), else NULL
      x          REAL NOT NULL,
      z          REAL NOT NULL,
      dropped_at INTEGER NOT NULL            -- ms since epoch
    );
  `);
  // v8 (above): dropped scrap too.
  tx(() => {
    const old = OLD_SCRAP.map((k) => `'${k}'`).join(', ');
    db.exec(`UPDATE dropped SET kind = '${SCRAP}' WHERE kind IN (${old})`);
    for (const k of OLD_SCRAP) db.prepare('UPDATE dropped SET parts = REPLACE(parts, ?, ?) WHERE parts LIKE ?').run(`"${k}"`, `"${SCRAP}"`, `%"${k}"%`);
  });
  const allDropped = db.prepare('SELECT id, kind, parts, x, z FROM dropped ORDER BY id');
  const insertDropped = db.prepare('INSERT INTO dropped (id, kind, parts, x, z, dropped_at) VALUES (?, ?, ?, ?, ?, ?)');
  const deleteDropped = db.prepare('DELETE FROM dropped WHERE id = ?');

  // World loot (server/loot.ts): finds lying at crash sites and caches buried in the sand, so a restart keeps what
  // was taken and dug. id is the loot id (shared with `dropped`). spawn: what it stands in for when taken (a FINDS key,
  // 'rare', 'home_bike'; NULL for a cache). loot_pending: taken ones waiting to come back somewhere else.
  db.exec(`
    CREATE TABLE IF NOT EXISTS world_loot (
      id    INTEGER PRIMARY KEY,
      kind  TEXT NOT NULL,                   -- ITEMS key
      parts TEXT,                            -- gear: JSON part kinds per slot, else NULL
      x     REAL NOT NULL,
      z     REAL NOT NULL,
      depth REAL NOT NULL,                   -- m under the sand, 0 once on the surface
      src   TEXT NOT NULL,                   -- 'find' | 'cache'
      spawn TEXT
    );
    CREATE TABLE IF NOT EXISTS loot_pending (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      at   INTEGER NOT NULL,                 -- ms since epoch: comes back then
      what TEXT NOT NULL,                    -- 'find' | 'cache'
      kind TEXT                              -- the find's spawn key; NULL for a cache
    );
  `);
  const allWorldLoot = db.prepare('SELECT id, kind, parts, x, z, depth, src, spawn FROM world_loot ORDER BY id');
  const insertWorldLoot = db.prepare('INSERT OR REPLACE INTO world_loot (id, kind, parts, x, z, depth, src, spawn) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const deleteWorldLoot = db.prepare('DELETE FROM world_loot WHERE id = ?');
  const surfaceWorldLoot = db.prepare('UPDATE world_loot SET depth = 0 WHERE id = ?');
  const allPending = db.prepare('SELECT id, at, what, kind FROM loot_pending ORDER BY at');
  const insertPending = db.prepare('INSERT INTO loot_pending (at, what, kind) VALUES (?, ?, ?)');
  const deletePending = db.prepare('DELETE FROM loot_pending WHERE id = ?');

  // Packs left where players died (shared/corpse.ts, server/corpses.ts); their items are box 'corpse<id>' (owner '').
  db.exec(`
    CREATE TABLE IF NOT EXISTS corpses (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      owner   TEXT NOT NULL,                 -- browser ID of who died
      color   INTEGER NOT NULL,
      x       REAL NOT NULL,
      z       REAL NOT NULL,
      until   INTEGER NOT NULL               -- ms since epoch: gone then
    );
  `);
  const allCorpses = db.prepare('SELECT id, color, x, z, until FROM corpses ORDER BY id');
  const insertCorpse = db.prepare('INSERT INTO corpses (owner, color, x, z, until) VALUES (?, ?, ?, ?, ?)');
  const deleteCorpse = db.prepare('DELETE FROM corpses WHERE id = ?');

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
    loadDropped: () => (allDropped.all() as { id: number; kind: string; parts: string | null; x: number; z: number }[])
      .map((r) => ({ ...r, parts: r.parts ? (JSON.parse(r.parts) as (string | null)[]) : undefined })),
    insertDropped: (id: number, kind: string, parts: (string | null)[] | undefined, x: number, z: number) =>
      insertDropped.run(id, kind, parts ? JSON.stringify(parts) : null, x, z, Date.now()),
    deleteDropped: (id: number) => deleteDropped.run(id),
    loadWorldLoot: () => (allWorldLoot.all() as { id: number; kind: string; parts: string | null; x: number; z: number; depth: number; src: 'find' | 'cache'; spawn: string | null }[])
      .map((r) => ({ ...r, parts: r.parts ? (JSON.parse(r.parts) as (string | null)[]) : undefined })),
    putWorldLoot: (l: { id: number; kind: string; parts?: (string | null)[]; x: number; z: number; depth: number; src: string }, spawn: string | null) =>
      insertWorldLoot.run(l.id, l.kind, l.parts ? JSON.stringify(l.parts) : null, l.x, l.z, l.depth, l.src, spawn),
    deleteWorldLoot: (id: number) => deleteWorldLoot.run(id),
    surfaceWorldLoot: (id: number) => surfaceWorldLoot.run(id),
    loadLootPending: () => allPending.all() as { id: number; at: number; what: 'find' | 'cache'; kind: string | null }[],
    /** Returns the new row's id. */
    insertLootPending: (at: number, what: string, kind: string | null) => Number(insertPending.run(at, what, kind).lastInsertRowid),
    deleteLootPending: (id: number) => deletePending.run(id),
    loadCorpses: () => allCorpses.all() as { id: number; color: number; x: number; z: number; until: number }[],
    /** New pack row; returns its id. */
    insertCorpse: (owner: string, color: number, x: number, z: number, until: number) =>
      Number(insertCorpse.run(owner, color, x, z, until).lastInsertRowid),
    /** A pack and whatever is still in it. */
    deleteCorpse: (id: number) => tx(() => {
      deleteCorpse.run(id);
      clearBox.run('', `corpse${id}`);
    }),
    loadBeds: () => allBeds.all() as { id: number; stage: number; growth: number }[],
    saveBed: (id: number, stage: number, growth: number) => upsertBed.run(id, stage, growth),
    deleteBed: (id: number) => deleteBed.run(id),
    loadTaken: () => allTaken.all() as { ix: number; iz: number; i: number; taken_at: number }[],
    tx,
    takeScrap: (ix: number, iz: number, i: number, at: number) => insertTaken.run(ix, iz, i, at),
    respawnScrap: (ix: number, iz: number, i: number) => deleteTaken.run(ix, iz, i),
    loadBox: (owner: string, box: string) => (boxRows.all(owner, box) as { id: number; kind: string; n: number; slot: number; parts: string | null; r: number }[])
      .map((r) => ({ ...r, parts: r.parts ? (JSON.parse(r.parts) as (string | null)[]) : undefined, r: r.r === 1 })),
    /** Rewrite whole boxes in one transaction (an item moving between them keeps its id). */
    saveBoxes: (boxes: { owner: string; box: string; slots: Slots }[]) => tx(() => {
      for (const b of boxes) clearBox.run(b.owner, b.box);
      for (const b of boxes) b.slots.forEach((it, slot) => it && insertItem(it, b.owner, b.box, slot));
    }),
    maxItemId: () => (maxItemId.get() as { id: number }).id,
    hasStarterKit: (playerId: string) => !!getStarter.get(playerId),
    markStarterKit: (playerId: string) => putStarter.run(playerId, Date.now()),
    /** Set up for gear (shared/gear.ts): new players get nothing, players from before get a backpack. Once each. */
    hasGearKit: (playerId: string) => !!getGearKit.get(playerId),
    hasGrant: (playerId: string, what: string) => !!getGrant.get(playerId, what),
    markGrant: (playerId: string, what: string) => putGrant.run(playerId, what, Date.now()),
    markGearKit: (playerId: string) => putGearKit.run(playerId, Date.now()),
    loadCrashTaken: () => allCrash.all() as { id: string; taken_at: number }[],
    takeCrash: (id: string, at: number) => insertCrash.run(id, at),
    respawnCrash: (id: string) => deleteCrash.run(id),
    loadProgress: () => (allProgress.all() as { id: string; done: string; taken: string; layout: number }[])
      .map((r) => ({ id: r.id, done: nums(r.done), taken: nums(r.taken), layout: r.layout })),
    saveProgress: (id: string, done: number[], taken: number[], layout: number) => putProgress.run(id, JSON.stringify(done), JSON.stringify(taken), layout),
    clearProgress: (id: string) => deleteProgress.run(id),
    loadBench: () => getBench.get() as { kind: string; seed: number } | undefined,
    saveBench: (kind: string, seed: number) => putBench.run(kind, seed),
    clearBench: () => deleteBench.run(),
    loadCrashSpent: () => allSpent.all() as { site: number; spent_at: number }[],
    spendCrash: (site: number, at: number) => insertSpent.run(site, at),
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
