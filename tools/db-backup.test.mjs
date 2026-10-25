import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { backupData, verifyBackup } from './db-backup.mjs';
import { openDb } from '../server/db.ts';

test('online snapshots retain registry and WAL writes; restored legacy worlds migrate without losing items', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'paahde-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'live'), out = join(root, 'backup');
  mkdirSync(join(data, 'worlds'), { recursive: true });
  const registry = new DatabaseSync(join(data, 'games.db'));
  registry.exec("PRAGMA journal_mode=WAL; CREATE TABLE games(id TEXT PRIMARY KEY, name TEXT); INSERT INTO games VALUES('fixture','A world');");
  const world = new DatabaseSync(join(data, 'worlds', 'fixture.db'));
  world.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE players(id TEXT PRIMARY KEY, color INTEGER NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')), last_seen TEXT DEFAULT (datetime('now')));
    INSERT INTO players(id,color,x,y) VALUES('owner',123,12,14);
    CREATE TABLE inventory(player_id TEXT, kind INTEGER, count INTEGER);
    INSERT INTO inventory VALUES('owner',0,3);`);
  t.after(() => { registry.close(); world.close(); });
  const m = await backupData(data, out);
  assert.equal(m.files.length, 2);
  assert.equal(verifyBackup(out).complete, true);
  const restored = join(root, 'restored.db');
  copyFileSync(join(out, 'worlds', 'fixture.db'), restored);
  const migrated = openDb(restored);
  migrated.close();
  const check = new DatabaseSync(restored);
  try {
    assert.equal(check.prepare('SELECT color FROM players WHERE id=?').get('owner').color, 123);
    assert.equal(check.prepare('SELECT SUM(n) AS n FROM items WHERE owner=?').get('owner').n, 3);
    assert.ok(check.prepare('PRAGMA table_info(corpses)').all().some((r) => r.name === 'remaining'));
  } finally { check.close(); }
  await assert.rejects(backupData(data, out), /new backup/);
  symlinkSync(data, join(root, 'alias'), 'dir');
  await assert.rejects(backupData(data, join(root, 'alias', 'nested', 'backup')), /outside the live/);
});
