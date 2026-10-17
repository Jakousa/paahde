import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type PlayerRow = { id: string; color: number; x: number; z: number };

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

  const get = db.prepare('SELECT id, color, x, z FROM players WHERE id = ?');
  const upsert = db.prepare(`
    INSERT INTO players (id, color, x, y, z) VALUES (?, ?, ?, 0, ?)
    ON CONFLICT (id) DO UPDATE SET x = excluded.x, z = excluded.z, last_seen = datetime('now')
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

  // Scrap (shared/scrap.ts): picked-up pieces until they respawn, and each player's inventory.
  db.exec(`
    CREATE TABLE IF NOT EXISTS scrap_taken (
      ix       INTEGER NOT NULL,
      iz       INTEGER NOT NULL,
      i        INTEGER NOT NULL,
      taken_at INTEGER NOT NULL,              -- ms since epoch
      PRIMARY KEY (ix, iz, i)
    );
    CREATE TABLE IF NOT EXISTS inventory (
      player_id TEXT NOT NULL,                -- browser ID
      kind      INTEGER NOT NULL,             -- SCRAP_KINDS index
      count     INTEGER NOT NULL,
      PRIMARY KEY (player_id, kind)
    );
  `);
  const allTaken = db.prepare('SELECT ix, iz, i, taken_at FROM scrap_taken');
  const insertTaken = db.prepare('INSERT OR REPLACE INTO scrap_taken (ix, iz, i, taken_at) VALUES (?, ?, ?, ?)');
  const deleteTaken = db.prepare('DELETE FROM scrap_taken WHERE ix = ? AND iz = ? AND i = ?');
  const getInventory = db.prepare('SELECT kind, count FROM inventory WHERE player_id = ?');
  const addInventory = db.prepare(`
    INSERT INTO inventory (player_id, kind, count) VALUES (?, ?, 1)
    ON CONFLICT (player_id, kind) DO UPDATE SET count = count + 1
  `);

  // Greenhouse beds (shared/garden.ts): a row per bed once it has been tended; untouched beds keep their
  // layout stage.
  db.exec(`
    CREATE TABLE IF NOT EXISTS garden (
      bed        INTEGER PRIMARY KEY,        -- BEDS index
      stage      INTEGER NOT NULL,           -- EMPTY / SPROUTS / GROWN
      planted_at INTEGER NOT NULL            -- ms since epoch, 0 if empty
    );
  `);
  const allBeds = db.prepare('SELECT bed, stage, planted_at FROM garden');
  const upsertBed = db.prepare('INSERT OR REPLACE INTO garden (bed, stage, planted_at) VALUES (?, ?, ?)');

  return {
    loadBeds: () => allBeds.all() as { bed: number; stage: number; planted_at: number }[],
    saveBed: (bed: number, stage: number, plantedAt: number) => upsertBed.run(bed, stage, plantedAt),
    loadTaken: () => allTaken.all() as { ix: number; iz: number; i: number; taken_at: number }[],
    /** Mark a piece taken and give it to a player, atomically. */
    takeScrap(playerId: string, ix: number, iz: number, i: number, kind: number, at: number) {
      db.exec('BEGIN');
      try {
        insertTaken.run(ix, iz, i, at);
        addInventory.run(playerId, kind);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    respawnScrap: (ix: number, iz: number, i: number) => deleteTaken.run(ix, iz, i),
    getInventory: (playerId: string) => getInventory.all(playerId) as { kind: number; count: number }[],
    getPlayer: (id: string) => get.get(id) as PlayerRow | undefined,
    savePlayer: (p: PlayerRow) => upsert.run(p.id, p.color, p.x, p.z),
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
