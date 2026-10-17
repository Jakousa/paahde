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

  return {
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
