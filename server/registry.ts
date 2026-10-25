// The games' settings, kept by the front server (server/index.ts) in a database of its own: each game's name, public
// (listed in the main menu's browser) or private (only by its link or code), most players at once, and a password.
// Passwords are kept salted and scrypted. Whoever gives the right one gets a key (an HMAC of the game and its password
// hash under a secret made once here), kept by their browser and sent with the WebSocket, so the password never goes
// in a URL and every reconnect gets in. Worlds from before (no row) are private and open to all.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { derivePassword } from './password.ts';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MAX_PLAYERS } from '../shared/names.ts';

export type Game = { id: string; name: string; public: boolean; max: number; locked: boolean; created: number };
type Row = { id: string; name: string; public: number; max: number; pass: string | null; created: number };

export function registry(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS games (
      id      TEXT PRIMARY KEY,
      name    TEXT NOT NULL,
      public  INTEGER NOT NULL,
      max     INTEGER NOT NULL,
      pass    TEXT,                -- 'salt:hash' (hex, scrypt), NULL: no password
      created INTEGER NOT NULL     -- Date.now()
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  let secret = (db.prepare("SELECT value FROM meta WHERE key = 'secret'").get() as { value: string } | undefined)?.value;
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    db.prepare("INSERT INTO meta (key, value) VALUES ('secret', ?)").run(secret);
  }
  const getRow = db.prepare('SELECT * FROM games WHERE id = ?');
  const insert = db.prepare('INSERT INTO games (id, name, public, max, pass, created) VALUES (?, ?, ?, ?, ?, ?)');
  const publicRows = db.prepare('SELECT * FROM games WHERE public = 1 ORDER BY created DESC LIMIT ? OFFSET ?');

  const row = (id: string) => getRow.get(id) as Row | undefined;
  const game = (r: Row): Game => ({ id: r.id, name: r.name, public: !!r.public, max: r.max, locked: !!r.pass, created: r.created });
  const hmac = (id: string, pass: string) => createHmac('sha256', secret).update(`${id}:${pass}`).digest('base64url').slice(0, 22);

  return {
    /** Held so the database outlives its statements: Node 23 finalizes them once an unreferenced database is collected. */
    db,
    /** A world made before games had settings: a private one named by its id, open, as full as any. */
    get(id: string): Game {
      const r = row(id);
      return r ? game(r) : { id, name: id, public: false, max: MAX_PLAYERS.max, locked: false, created: 0 };
    },
    async create(id: string, o: { name: string; public: boolean; max: number; password: string }): Promise<string> {
      let pass: string | null = null;
      if (o.password) {
        const salt = randomBytes(16);
        pass = `${salt.toString('hex')}:${(await derivePassword(o.password, salt)).toString('hex')}`;
      }
      insert.run(id, o.name, o.public ? 1 : 0, o.max, pass, Date.now());
      return pass ? hmac(id, pass) : '';
    },
    publicGames: (limit = 100, offset = 0) => (publicRows.all(limit, offset) as Row[]).map(game),
    remove: (id: string) => db.prepare('DELETE FROM games WHERE id = ?').run(id),
    /** The key for a game whose password is `password`, or null if it's wrong ('' for an open game). */
    async unlock(id: string, password: string): Promise<string | null> {
      const r = row(id);
      if (!r?.pass) return '';
      const [salt, hash] = r.pass.split(':');
      const got = await derivePassword(password, Buffer.from(salt, 'hex'));
      return timingSafeEqual(got, Buffer.from(hash, 'hex')) ? hmac(id, r.pass) : null;
    },
    /** May someone with key `k` come in? Anyone may into an open game. */
    keyOk(id: string, k: string): boolean {
      const r = row(id);
      if (!r?.pass) return true;
      const want = Buffer.from(hmac(id, r.pass));
      const got = Buffer.from(k);
      return got.length === want.length && timingSafeEqual(got, want);
    },
  };
}
