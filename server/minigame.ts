// Leaderboards of the teardown minigame (src/minigameMenu.ts): one list per game mode, shared by everyone on the
// server and not tied to any world. Speedruns (take 10 / 20 / 30 machines apart) rank by time, lowest first; endless
// ranks by machines taken apart in one session, highest first. One entry per name and mode: the best one.
// GET /api/minigame?mode=10 -> { top }, POST /api/minigame { mode, name, score, machines } -> { top, rank }.
// The client says how it did and nothing here can check it, so it only turns away what can't be real.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NAME_MAX } from '../shared/protocol.ts';

const MODES = ['10', '20', '30', 'endless'];
const TOP = 10;
/** A speedrun machine can't be taken apart faster than this (ms each), and a run takes under an hour. */
const MIN_MS_PER_MACHINE = 600;
const MAX_MS = 3_600_000;
const MAX_ENDLESS = 2000;
/** One submission this often per address (ms). */
const GAP_MS = 3000;

export function leaderboard(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS scores (
      mode     TEXT NOT NULL,
      name     TEXT NOT NULL,
      score    INTEGER NOT NULL,  -- speedruns: milliseconds; endless: machines
      machines INTEGER NOT NULL,
      at       INTEGER NOT NULL,
      PRIMARY KEY (mode, name)
    );
  `);
  const better = (mode: string, a: number, b: number) => (mode === 'endless' ? a > b : a < b);
  const order = (mode: string) => (mode === 'endless' ? 'score DESC, at ASC' : 'score ASC, at ASC');
  const top = (mode: string) =>
    db.prepare(`SELECT name, score, machines FROM scores WHERE mode = ? ORDER BY ${order(mode)} LIMIT ${TOP}`).all(mode) as { name: string; score: number; machines: number }[];
  const rankOf = (mode: string, name: string) => {
    const mine = db.prepare('SELECT score FROM scores WHERE mode = ? AND name = ?').get(mode, name) as { score: number } | undefined;
    if (!mine) return 0;
    const cmp = mode === 'endless' ? '>' : '<';
    return (db.prepare(`SELECT COUNT(*) AS n FROM scores WHERE mode = ? AND score ${cmp} ?`).get(mode, mine.score) as { n: number }).n + 1;
  };
  return {
    top,
    submit(mode: string, name: string, score: number, machines: number) {
      const old = db.prepare('SELECT score FROM scores WHERE mode = ? AND name = ?').get(mode, name) as { score: number } | undefined;
      if (!old || better(mode, score, old.score)) {
        db.prepare('INSERT OR REPLACE INTO scores (mode, name, score, machines, at) VALUES (?, ?, ?, ?, ?)').run(mode, name, score, machines, Date.now());
      }
      return rankOf(mode, name);
    },
  };
}

const last = new Map<string, number>();

/** Answers /api/minigame; false for any other request. */
export function minigameApi(board: ReturnType<typeof leaderboard>, req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/api/minigame') return false;
  const send = (code: number, body?: unknown) => {
    res.statusCode = code;
    if (body !== undefined) res.setHeader('Content-Type', 'application/json');
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  if (req.method === 'GET') {
    const mode = url.searchParams.get('mode') ?? '';
    if (!MODES.includes(mode)) return send(400), true;
    return send(200, { top: board.top(mode) }), true;
  }
  if (req.method !== 'POST') return send(405), true;
  const who = req.socket.remoteAddress ?? '';
  const now = Date.now();
  if (now - (last.get(who) ?? 0) < GAP_MS) return send(429), true;
  last.set(who, now);
  if (last.size > 1000) for (const [k, t] of last) if (now - t > 60_000) last.delete(k);
  let raw = '';
  req.on('data', (c) => {
    raw += c;
    if (raw.length > 512) req.destroy();
  });
  req.on('end', () => {
    let m: { mode?: unknown; name?: unknown; score?: unknown; machines?: unknown };
    try {
      m = JSON.parse(raw);
    } catch {
      return send(400);
    }
    const mode = String(m.mode);
    const { score, machines } = m as { score: number; machines: number };
    if (!MODES.includes(mode) || !Number.isInteger(score) || !Number.isInteger(machines)) return send(400);
    if (mode === 'endless') {
      if (machines < 1 || machines > MAX_ENDLESS || score !== machines) return send(400);
    } else if (machines !== Number(mode) || score < machines * MIN_MS_PER_MACHINE || score > MAX_MS) return send(400);
    const name = (typeof m.name === 'string' ? m.name : '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) || 'anon';
    const rank = board.submit(mode, name, score, machines);
    send(200, { top: board.top(mode), rank, name });
  });
  return true;
}
