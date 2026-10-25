import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Obituary } from '../shared/protocol.ts';
import { addItem, BAG_COLS, BAG_ROWS, BAG_SLOTS, HOTBAR, OLD_COILS, OLD_SCRAP, SCRAP, WIRING, type Item, type ItemData, type Slots } from '../shared/items.ts';

export type PlayerRow = { id: string; color: number; x: number; z: number; heat: number; sips: number; name?: string | null };

/** An item's own state (shared/items.ts ItemData) to and from its `data` column: NULL when it has none. */
const jsonData = (data: ItemData | undefined) => (data && Object.keys(data).length ? JSON.stringify(data) : null);
const parseData = (s: string | null) => (s ? (JSON.parse(s) as ItemData) : undefined);

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
  // v5: a name, asked the first time they join this world (NULL: not asked yet).
  if (!cols.some((c) => c.name === 'name')) db.exec('ALTER TABLE players ADD COLUMN name TEXT');
  // v6: time played in this world (ms, while in the game), shown on the main menu's list of your games.
  if (!cols.some((c) => c.name === 'played')) db.exec('ALTER TABLE players ADD COLUMN played INTEGER NOT NULL DEFAULT 0');

  const get = db.prepare('SELECT id, color, x, z, heat, sips, name FROM players WHERE id = ?');
  const putName = db.prepare('UPDATE players SET name = ? WHERE id = ?');
  const upsert = db.prepare(`
    INSERT INTO players (id, color, x, y, z, heat, sips, played) VALUES (?, ?, ?, 0, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET color = excluded.color, x = excluded.x, z = excluded.z, heat = excluded.heat,
      sips = excluded.sips, played = played + excluded.played, last_seen = datetime('now')
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
  // 'equip', 'bench') belong to the player; shared ones ('chest<i>', 'cargo<id>', ...) to nobody ('').
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id    INTEGER PRIMARY KEY,               -- stable stack id
      kind  TEXT NOT NULL,                     -- ITEMS key
      n     INTEGER NOT NULL,                  -- stack size
      owner TEXT NOT NULL,                     -- browser ID, '' for shared boxes
      box   TEXT NOT NULL,                     -- 'bag', 'equip', 'chest<i>', ...
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
  // v10: killing blows a shield plate has taken since it was last broken (shared/gear.ts shieldSaves).
  if (!(db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).some((c) => c.name === 'worn')) {
    db.exec('ALTER TABLE items ADD COLUMN worn INTEGER NOT NULL DEFAULT 0');
  }
  // v12: an item's own state (shared/items.ts ItemData) as one JSON object, NULL when it has none. The shield's wear
  // moved into it (`worn` is no longer read).
  if (!(db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).some((c) => c.name === 'data')) {
    tx(() => {
      db.exec('ALTER TABLE items ADD COLUMN data TEXT');
      db.exec("UPDATE items SET data = json_object('worn', worn) WHERE worn > 0");
    });
  }

  // Small machine sites (shared/crash.ts) whose machine was carried off; they stay empty (taken_at is kept in case
  // they refill some day). The machine itself is an item in the player's bag, given in the same transaction
  // (server/crash.ts). crash_spent: crash sites (shared/crashsites.ts ids) whose large machine has been stripped
  // of every part; they stop smoking for good. crash_visited: crash sites someone has picked something up from (a
  // part, a small machine, debris, a find): they stop smoking for good too, so the world shows the site was visited.
  db.exec(`
    CREATE TABLE IF NOT EXISTS crash_taken (
      id       TEXT PRIMARY KEY,
      taken_at INTEGER NOT NULL               -- ms since epoch
    );
    CREATE TABLE IF NOT EXISTS crash_spent (
      site     INTEGER PRIMARY KEY,
      spent_at INTEGER NOT NULL               -- ms since epoch
    );
    CREATE TABLE IF NOT EXISTS crash_visited (
      site       INTEGER PRIMARY KEY,
      visited_at INTEGER NOT NULL             -- ms since epoch
    );
  `);
  // Downed jets' crash sites (shared/jetcrash.ts): one JSON row each.
  db.exec('CREATE TABLE IF NOT EXISTS jet_crashes (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
  const allJetCrashes = db.prepare('SELECT data FROM jet_crashes ORDER BY id');
  const putJetCrash = db.prepare('INSERT OR REPLACE INTO jet_crashes (id, data) VALUES (?, ?)');
  const deleteJetCrash = db.prepare('DELETE FROM jet_crashes WHERE id = ?');
  const allSpent = db.prepare('SELECT site, spent_at FROM crash_spent');
  const insertSpent = db.prepare('INSERT OR IGNORE INTO crash_spent (site, spent_at) VALUES (?, ?)');
  const allVisited = db.prepare('SELECT site FROM crash_visited');
  const insertVisited = db.prepare('INSERT OR IGNORE INTO crash_visited (site, visited_at) VALUES (?, ?)');
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
  const boxRows = db.prepare('SELECT id, kind, n, slot, parts, r, data FROM items WHERE owner = ? AND box = ? ORDER BY slot');
  const clearBox = db.prepare('DELETE FROM items WHERE owner = ? AND box = ?');
  const insertRow = db.prepare('INSERT INTO items (id, kind, n, owner, box, slot, parts, r, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertItem = (it: Item, owner: string, box: string, slot: number) =>
    insertRow.run(it.id, it.kind, it.n, owner, box, slot, it.parts ? JSON.stringify(it.parts) : null, it.r ? 1 : 0, jsonData(it.data));
  const maxItemId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM items');
  const deleteRow = db.prepare('DELETE FROM items WHERE id = ? AND owner = ? AND box = ?');
  const deleteId = db.prepare('DELETE FROM items WHERE id = ?');
  const rowSig = (kind: string, n: number, slot: number, parts: string | null, r: number, data: string | null) =>
    JSON.stringify([kind, n, slot, parts, r, data]);
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

  // Placed things (shared/placed.ts, server/placed.ts): items put down on the bunker floor, and buildings out on the
  // sand (`y`: what it stands on; NULL for those from before, all on the floor). A building's item is in its own box,
  // `bld<id>` (items). The old `garden` table (greenhouse beds by layout index) is unused since beds are placed things.
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
  if (!(db.prepare('SELECT name FROM pragma_table_info(?)').all('placed') as { name: string }[]).some((c) => c.name === 'y')) {
    db.exec('ALTER TABLE placed ADD COLUMN y REAL');
  }
  const allPlaced = db.prepare('SELECT id, kind, x, y, z, rot FROM placed ORDER BY id');
  const insertPlaced = db.prepare('INSERT INTO placed (kind, x, y, z, rot, owner, placed_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const deletePlaced = db.prepare('DELETE FROM placed WHERE id = ?');
  // Electricity (shared/power.ts, server/power.ts): each battery station's charge, per part slot (kWh, JSON).
  db.exec('CREATE TABLE IF NOT EXISTS power (id INTEGER PRIMARY KEY, charge TEXT NOT NULL)');
  const allPower = db.prepare('SELECT id, charge FROM power');
  const clearPower = db.prepare('DELETE FROM power');
  const putPower = db.prepare('INSERT INTO power (id, charge) VALUES (?, ?)');
  // Power lines (shared/wires.ts, server/wires.ts): wire between placed things a < b; `kind` is what it was made of
  // (a wiring coil before v11, now always wiring: what comes back follows its length).
  db.exec(`CREATE TABLE IF NOT EXISTS wires (
    id INTEGER PRIMARY KEY AUTOINCREMENT, a INTEGER NOT NULL, b INTEGER NOT NULL, kind TEXT NOT NULL,
    owner TEXT NOT NULL, placed_at INTEGER NOT NULL)`);
  const allWires = db.prepare('SELECT id, a, b FROM wires ORDER BY id');
  const insertWire = db.prepare('INSERT INTO wires (a, b, kind, owner, placed_at) VALUES (?, ?, ?, ?, ?)');
  const deleteWire = db.prepare('DELETE FROM wires WHERE id = ?');
  // Vehicles (shared/vehicles.ts, server/vehicles.ts): where each stands and whether it's been repaired (stood up). Its
  // item is in box `veh<id>`, its cargo in `cargo<id>` (items). src: 'home' (the one in front of the base door),
  // 'find' (lying at a crash site), 'old' (a motorcycle item from before vehicles).
  db.exec(`CREATE TABLE IF NOT EXISTS vehicles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
    heading REAL NOT NULL, up INTEGER NOT NULL, src TEXT NOT NULL)`);
  const allVehicles = db.prepare('SELECT id, kind, x, y, z, heading, up, src FROM vehicles ORDER BY id');
  const insertVehicle = db.prepare('INSERT INTO vehicles (kind, x, y, z, heading, up, src) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const moveVehicle = db.prepare('UPDATE vehicles SET x = ?, y = ?, z = ?, heading = ? WHERE id = ?');
  const standVehicle = db.prepare('UPDATE vehicles SET up = 1 WHERE id = ?');
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
  // v10 (above): a dropped shield plate keeps its wear.
  if (!(db.prepare('PRAGMA table_info(dropped)').all() as { name: string }[]).some((c) => c.name === 'worn')) {
    db.exec('ALTER TABLE dropped ADD COLUMN worn INTEGER NOT NULL DEFAULT 0');
  }
  // v12 (above): a dropped item keeps its own state.
  if (!(db.prepare('PRAGMA table_info(dropped)').all() as { name: string }[]).some((c) => c.name === 'data')) {
    tx(() => {
      db.exec('ALTER TABLE dropped ADD COLUMN data TEXT');
      db.exec("UPDATE dropped SET data = json_object('worn', worn) WHERE worn > 0");
    });
  }
  // v8 (above): dropped scrap too.
  tx(() => {
    const old = OLD_SCRAP.map((k) => `'${k}'`).join(', ');
    db.exec(`UPDATE dropped SET kind = '${SCRAP}' WHERE kind IN (${old})`);
    for (const k of OLD_SCRAP) db.prepare('UPDATE dropped SET parts = REPLACE(parts, ?, ?) WHERE parts LIKE ?').run(`"${k}"`, `"${SCRAP}"`, `%"${k}"%`);
  });
  const allDropped = db.prepare('SELECT id, kind, parts, x, z, data FROM dropped ORDER BY id');
  const insertDropped = db.prepare('INSERT INTO dropped (id, kind, parts, x, z, dropped_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const deleteDropped = db.prepare('DELETE FROM dropped WHERE id = ?');

  // World loot (server/loot.ts): finds lying at crash sites and caches out in the desert, so a restart keeps what
  // was taken. id is the loot id (shared with `dropped`). spawn: what it stands in for when taken (a FINDS key,
  // 'rare', 'home_bike'; NULL for a cache). loot_pending: taken ones waiting to come back somewhere else.
  db.exec(`
    CREATE TABLE IF NOT EXISTS world_loot (
      id    INTEGER PRIMARY KEY,
      kind  TEXT NOT NULL,                   -- ITEMS key
      parts TEXT,                            -- gear: JSON part kinds per slot, else NULL
      x     REAL NOT NULL,
      z     REAL NOT NULL,
      depth REAL NOT NULL,                   -- m under the sand, 0 once on the surface (always 0 now: no digging)
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
  // v9: the anti-matter container became the uranium cell (`antimatter_<tier>` → `uranium_<tier>`): in boxes, dropped
  // and lying in the world.
  tx(() => {
    for (const t of ['items', 'dropped', 'world_loot']) {
      db.exec(`UPDATE ${t} SET kind = 'uranium' || SUBSTR(kind, 11) WHERE kind LIKE 'antimatter\\_%' ESCAPE '\\'`);
    }
  });
  // v11: the wiring coils (`coil_<tier>`) became stackable wiring, one each: in boxes, fitted in gear (JSON parts),
  // dropped and lying in the world. The scattered stacks of one are merged when a box loads (server/items.ts).
  {
    const old = OLD_COILS.map((k) => `'${k}'`).join(', ');
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM items WHERE kind IN (${old})`).get() as { n: number }).n;
    tx(() => {
      for (const t of ['items', 'dropped', 'world_loot']) {
        db.exec(`UPDATE ${t} SET kind = '${WIRING}' WHERE kind IN (${old})`);
        for (const k of OLD_COILS) db.prepare(`UPDATE ${t} SET parts = REPLACE(parts, ?, ?) WHERE parts LIKE ?`).run(`"${k}"`, `"${WIRING}"`, `%"${k}"%`);
      }
    });
    if (n) console.log(`items: ${n} wiring coils are wiring now`);
  }
  // v12 (above): finds and caches have their own state too (a found battery's charge).
  if (!(db.prepare('PRAGMA table_info(world_loot)').all() as { name: string }[]).some((c) => c.name === 'data')) {
    db.exec('ALTER TABLE world_loot ADD COLUMN data TEXT');
  }
  const allWorldLoot = db.prepare('SELECT id, kind, parts, x, z, depth, src, spawn, data FROM world_loot ORDER BY id');
  const insertWorldLoot = db.prepare('INSERT OR REPLACE INTO world_loot (id, kind, parts, x, z, depth, src, spawn, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
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

  // Every death in this world, for chat (ServerMsg 'obituary'); kept for good.
  db.exec(`
    CREATE TABLE IF NOT EXISTS obituaries (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      player INTEGER NOT NULL,               -- public id
      color  INTEGER NOT NULL,
      name   TEXT NOT NULL,
      cause  TEXT NOT NULL,                  -- DeathCause (shared/protocol.ts)
      at     INTEGER NOT NULL                -- ms since epoch
    );
  `);
  const lastObituaries = db.prepare('SELECT player AS id, color, name, cause, at FROM obituaries ORDER BY id DESC LIMIT ?');
  const insertObituary = db.prepare('INSERT INTO obituaries (player, color, name, cause, at) VALUES (?, ?, ?, ?, ?)');

  // Key/value settings (the debug menu's shared-clock shift survives server restarts).
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value REAL NOT NULL)');
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const putSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  return {
    /** The newest `n` deaths, oldest first. */
    lastObituaries: (n: number) =>
      (lastObituaries.all(n) as Omit<Obituary, 't'>[]).reverse().map((r) => ({ t: 'obituary' as const, ...r })),
    putObituary: (o: Obituary) => insertObituary.run(o.id, o.color, o.name, o.cause, o.at),
    getSetting: (key: string) => (getSetting.get(key) as { value: number } | undefined)?.value,
    setSetting: (key: string, value: number) => putSetting.run(key, value),
    loadPlaced: () => allPlaced.all() as { id: number; kind: string; x: number; y: number | null; z: number; rot: number }[],
    /** New placed row; returns its id. */
    insertPlaced: (kind: string, x: number, y: number, z: number, rot: number, owner: string) =>
      Number(insertPlaced.run(kind, x, y, z, rot, owner, Date.now()).lastInsertRowid),
    deletePlaced: (id: number) => deletePlaced.run(id),
    loadVehicles: () => (allVehicles.all() as { id: number; kind: string; x: number; y: number; z: number; heading: number; up: number; src: string }[])
      .map((r) => ({ ...r, up: r.up === 1 })),
    /** New vehicle row; returns its id. */
    insertVehicle: (kind: string, x: number, y: number, z: number, heading: number, up: boolean, src: string) =>
      Number(insertVehicle.run(kind, x, y, z, heading, up ? 1 : 0, src).lastInsertRowid),
    moveVehicle: (id: number, x: number, y: number, z: number, heading: number) => moveVehicle.run(x, y, z, heading, id),
    standVehicle: (id: number) => standVehicle.run(id),
    /**
     * v12, once (call inside a transaction): the motorcycle stopped being an item. Takes every motorcycle out of the
     * boxes (the equipment's old Vehicle slot too; the Armor slot after it moves up into its place) and returns them
     * with their owners, and the owners of the old per-player cargo box 'bike'.
     */
    takeOldBikes: () => {
      const bikes = (db.prepare("SELECT owner, box, parts FROM items WHERE kind = 'motorcycle' ORDER BY id").all() as
        { owner: string; box: string; parts: string | null }[]).map((r) => ({ ...r, parts: r.parts ? (JSON.parse(r.parts) as (string | null)[]) : undefined }));
      db.exec("DELETE FROM items WHERE kind = 'motorcycle'");
      db.exec(`UPDATE items SET slot = 3 WHERE box = 'equip' AND slot = 4
        AND NOT EXISTS (SELECT 1 FROM items o WHERE o.owner = items.owner AND o.box = 'equip' AND o.slot = 3)`);
      const cargo = (db.prepare("SELECT DISTINCT owner FROM items WHERE box = 'bike'").all() as { owner: string }[]).map((r) => r.owner);
      return { bikes, cargo };
    },
    /** Every item in one box moves to another (an empty one), keeping its slots. */
    moveBox: (owner: string, box: string, toOwner: string, toBox: string) =>
      db.prepare('UPDATE items SET owner = ?, box = ? WHERE owner = ? AND box = ?').run(toOwner, toBox, owner, box),
    loadDropped: () => (allDropped.all() as { id: number; kind: string; parts: string | null; x: number; z: number; data: string | null }[])
      .map((r) => ({ ...r, parts: r.parts ? (JSON.parse(r.parts) as (string | null)[]) : undefined, data: parseData(r.data) })),
    insertDropped: (id: number, kind: string, parts: (string | null)[] | undefined, x: number, z: number, data?: ItemData) =>
      insertDropped.run(id, kind, parts ? JSON.stringify(parts) : null, x, z, Date.now(), jsonData(data)),
    deleteDropped: (id: number) => deleteDropped.run(id),
    loadWorldLoot: () => (allWorldLoot.all() as { id: number; kind: string; parts: string | null; x: number; z: number; depth: number; src: 'find' | 'cache'; spawn: string | null; data: string | null }[])
      .map((r) => ({ ...r, parts: r.parts ? (JSON.parse(r.parts) as (string | null)[]) : undefined, data: parseData(r.data) })),
    putWorldLoot: (l: { id: number; kind: string; parts?: (string | null)[]; data?: ItemData; x: number; z: number; src: string }, spawn: string | null) =>
      insertWorldLoot.run(l.id, l.kind, l.parts ? JSON.stringify(l.parts) : null, l.x, l.z, 0, l.src, spawn, jsonData(l.data)),
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
    loadWires: () => allWires.all() as { id: number; a: number; b: number }[],
    /** New wire; returns its id. */
    insertWire: (a: number, b: number, kind: string, owner: string) => Number(insertWire.run(a, b, kind, owner, Date.now()).lastInsertRowid),
    deleteWire: (id: number) => deleteWire.run(id),
    /** Battery stations' charge by placed id (kWh per part slot). */
    loadPower: () => new Map((allPower.all() as { id: number; charge: string }[]).map((r) => [r.id, JSON.parse(r.charge) as number[]])),
    savePower: (rows: Map<number, number[]>) => tx(() => {
      clearPower.run();
      for (const [id, charge] of rows) putPower.run(id, JSON.stringify(charge));
    }),
    saveBed: (id: number, stage: number, growth: number) => upsertBed.run(id, stage, growth),
    deleteBed: (id: number) => deleteBed.run(id),
    loadTaken: () => allTaken.all() as { ix: number; iz: number; i: number; taken_at: number }[],
    tx,
    takeScrap: (ix: number, iz: number, i: number, at: number) => insertTaken.run(ix, iz, i, at),
    respawnScrap: (ix: number, iz: number, i: number) => deleteTaken.run(ix, iz, i),
    loadBox: (owner: string, box: string) => (boxRows.all(owner, box) as { id: number; kind: string; n: number; slot: number; parts: string | null; r: number; data: string | null }[])
      .map((r) => ({ ...r, parts: r.parts ? (JSON.parse(r.parts) as (string | null)[]) : undefined, r: r.r === 1, data: parseData(r.data) })),
    /**
     * Save whole boxes in one transaction (an item moving between them keeps its id), writing only the rows that
     * changed: rows gone from a box or changed are deleted first (by id, within their box), then the changed ones
     * inserted, so moves and swaps never trip UNIQUE (owner, box, slot).
     */
    saveBoxes: (boxes: { owner: string; box: string; slots: Slots }[]) => tx(() => {
      const drop: { id: number; owner: string; box: string }[] = [];
      const put: { it: Item; owner: string; box: string; slot: number }[] = [];
      for (const b of boxes) {
        const had = new Map<number, string>();
        for (const r of boxRows.all(b.owner, b.box) as { id: number; kind: string; n: number; slot: number; parts: string | null; r: number; data: string | null }[])
          had.set(r.id, rowSig(r.kind, r.n, r.slot, r.parts, r.r, r.data));
        const keep = new Set<number>();
        b.slots.forEach((it, slot) => {
          if (!it) return;
          const sig = rowSig(it.kind, it.n, slot, it.parts ? JSON.stringify(it.parts) : null, it.r ? 1 : 0, jsonData(it.data));
          if (had.get(it.id) === sig) keep.add(it.id);
          else put.push({ it, owner: b.owner, box: b.box, slot });
        });
        for (const id of had.keys()) if (!keep.has(id)) drop.push({ id, owner: b.owner, box: b.box });
      }
      for (const d of drop) deleteRow.run(d.id, d.owner, d.box);
      // An item put here may still sit in a box this call doesn't save: it moves, as its id is unique.
      for (const p of put) deleteId.run(p.it.id);
      for (const p of put) insertItem(p.it, p.owner, p.box, p.slot);
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
    loadJetCrashes: () => (allJetCrashes.all() as { data: string }[]).map((r) => JSON.parse(r.data)),
    saveJetCrash: (id: number, data: unknown) => putJetCrash.run(id, JSON.stringify(data)),
    deleteJetCrash: (id: number) => deleteJetCrash.run(id),
    loadCrashSpent: () => allSpent.all() as { site: number; spent_at: number }[],
    spendCrash: (site: number, at: number) => insertSpent.run(site, at),
    loadCrashVisited: () => (allVisited.all() as { site: number }[]).map((r) => r.site),
    visitCrash: (site: number, at: number) => insertVisited.run(site, at),
    getPlayer: (id: string) => get.get(id) as PlayerRow | undefined,
    /** `played`: ms played since the last save, added to the total. */
    savePlayer: (p: PlayerRow, played = 0) => upsert.run(p.id, p.color, p.x, p.z, p.heat, p.sips, Math.round(played)),
    setName: (id: string, name: string) => putName.run(name, id),
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
