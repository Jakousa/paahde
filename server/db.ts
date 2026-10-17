import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type PlayerRow = { id: string; color: number; x: number; y: number };

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

  const get = db.prepare('SELECT id, color, x, y FROM players WHERE id = ?');
  const upsert = db.prepare(`
    INSERT INTO players (id, color, x, y) VALUES (?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET x = excluded.x, y = excluded.y, last_seen = datetime('now')
  `);

  return {
    getPlayer: (id: string) => get.get(id) as PlayerRow | undefined,
    savePlayer: (p: PlayerRow) => upsert.run(p.id, p.color, p.x, p.y),
    close: () => db.close(),
  };
}
