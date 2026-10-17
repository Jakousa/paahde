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

  return {
    getPlayer: (id: string) => get.get(id) as PlayerRow | undefined,
    savePlayer: (p: PlayerRow) => upsert.run(p.id, p.color, p.x, p.z),
    close: () => db.close(),
  };
}
