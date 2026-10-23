// Front server: serves the built client (the landing page and the game), makes new worlds and passes each
// player's WebSocket (/ws?w=<id>) through to its world. Keeps the games' settings (name, public or private, most
// players, password: server/registry.ts) and answers the main menu and the lobby about them. Every world is a process of its own (server/world.ts,
// forked here with WORLD_ID), because the world's layout is seeded once when the shared modules load
// (shared/world.ts). A world starts on its first connection and exits on its own when it's been empty a while.
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import sirv from 'sirv';
import { WebSocketServer } from 'ws';
import type { WorldStats } from '../shared/protocol.ts';
import { checkName, GAME_NAME, MAX_PLAYERS } from '../shared/names.ts';
import { BENCH_WORLD, LAB_WORLD, labAllowed, LEGACY_WORLD, LIVES, newWorldId, WORLD_ID_RE } from '../shared/world.ts';
import { leaderboard, minigameApi } from './minigame.ts';
import { registry } from './registry.ts';

// The dev test lab (?w=lab, shared/lab.ts) exists only when the dev server is started with --lab (npm run dev:server).
if (process.argv.includes('--lab')) process.env.DADAJAM_LAB = '1';
const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? 'data/dadajam.db';
const WORLDS_DIR = join(dirname(DB_PATH), 'worlds');
/** New worlds a minute, from everyone: enough for players, not for filling the disk. */
const NEW_PER_MIN = 30;
/** Password tries a minute from one address. */
const TRIES_PER_MIN = 10;
/** Longest password (characters). */
const PASSWORD_MAX = 64;
/** Most games the browser lists. */
const BROWSE_MAX = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const board = leaderboard(join(dirname(DB_PATH), 'minigame.db')); // the minigame's leaderboards (server/minigame.ts), shared by all worlds
const games = registry(join(dirname(DB_PATH), 'registry.db'));

/** The world from before there were worlds keeps its old database; the rest have one each. */
const dbPath = (id: string) => (id === LEGACY_WORLD ? DB_PATH : join(WORLDS_DIR, `${id}.db`));
const exists = (id: string) => ((id === LAB_WORLD || id === BENCH_WORLD) && labAllowed()) || (WORLD_ID_RE.test(id) && existsSync(dbPath(id)));

type World = { child: ChildProcess; port: Promise<number> };
const worlds = new Map<string, World>();

/** The world's process, started if it isn't running; resolves to the local port it takes connections on. */
function world(id: string): Promise<number> {
  let w = worlds.get(id);
  if (!w) {
    mkdirSync(WORLDS_DIR, { recursive: true });
    const child = fork(new URL('./world.ts', import.meta.url), {
      env: { ...process.env, WORLD_ID: id, DB_PATH: dbPath(id), TELEMETRY_PATH: join(dirname(DB_PATH), 'telemetry.jsonl') },
      // Not under the dev server's --watch-path: that restarts this process, and the worlds go with it.
      execArgv: process.execArgv.filter((a) => !a.startsWith('--watch')),
    });
    const port = new Promise<number>((resolve, reject) => {
      child.on('message', (m: { t?: string; port?: number }) => m.t === 'port' && resolve(m.port!));
      child.on('exit', () => reject(new Error(`world ${id} exited`)));
    });
    port.catch(() => {});
    child.on('exit', () => worlds.get(id) === w && worlds.delete(id));
    w = { child, port };
    worlds.set(id, w);
  }
  return w.port;
}

/** Players connected to each world right now (the sockets piped through below). */
const online = new Map<string, number>();
/** Most worlds one stats request asks about (the landing page keeps fewer). */
const STATS_MAX = 12;

/** How a world is doing, read from its database (the world process writes it; WAL lets us read alongside), with
 *  its settings; with `browserId`, also their name there and how long they've played. */
function stats(id: string, browserId?: string): WorldStats | null {
  if (id === LAB_WORLD || id === BENCH_WORLD || !exists(id)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath(id), { readOnly: true });
    const setting = (key: string) => {
      try {
        return (db!.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: number } | undefined)?.value;
      } catch {
        return undefined; // a world that never got as far as making the table
      }
    };
    const players = (db.prepare('SELECT COUNT(*) AS n FROM players').get() as { n: number }).n;
    const g = games.get(id);
    const s: WorldStats = {
      id, name: g.name, public: g.public, locked: g.locked, max: g.max,
      lives: setting('lives') ?? LIVES, beaten: setting('bosses_beaten') ?? 0, players, online: online.get(id) ?? 0,
    };
    if (browserId) {
      try {
        const me = db.prepare('SELECT name, color, played FROM players WHERE id = ?').get(browserId) as { name: string | null; color: number; played: number } | undefined;
        s.you = me?.name ?? '';
        s.played = me?.played ?? 0;
        if (me?.name) s.color = me.color;
      } catch {} // a world from before play time was kept, not opened since
    }
    return s;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

const serveStatic = sirv('dist', {
  etag: true,
  brotli: true,
  gzip: true,
  setHeaders: (res, path) => {
    res.setHeader('Cache-Control', path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  },
});

let made: number[] = [];
/** Password tries in the last minute, by address. */
const tries = new Map<string, number[]>();
let browsed: { at: number; list: WorldStats[] } | null = null;

function json(res: ServerResponse, body: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** A small JSON object posted to us, or null if it's too big or not one. */
function body(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      raw += c;
      if (raw.length > 4096) {
        resolve(null);
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(raw);
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** Behind Caddy (deploy/), which sets X-Forwarded-For to the caller; locally, the socket's own. */
const address = (req: IncomingMessage) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();

/** Make a game: { name, public, max, password } -> { id, key } (the key so its maker goes straight in). */
async function create(req: IncomingMessage, res: ServerResponse) {
  const now = Date.now();
  made = made.filter((t) => now - t < 60_000);
  if (made.length >= NEW_PER_MIN) return json(res, { error: 'busy' }, 429);
  const b = await body(req);
  if (!b) return json(res, { error: 'bad' }, 400);
  const name = checkName(b.name, GAME_NAME);
  if (!name.ok) return json(res, { error: name.why }, 400);
  const max = Number(b.max);
  const password = typeof b.password === 'string' ? b.password : '';
  if (!Number.isInteger(max) || max < MAX_PLAYERS.min || max > MAX_PLAYERS.max || password.length > PASSWORD_MAX) return json(res, { error: 'bad' }, 400);
  made.push(now);
  let id = newWorldId();
  while (exists(id)) id = newWorldId();
  games.create(id, { name: name.name, public: b.public === true, max, password });
  // Started now, so its database exists before anyone joins (unknown worlds are turned away).
  world(id).then(
    () => json(res, { id, key: games.unlock(id, password) ?? '' }),
    () => json(res, { error: 'failed' }, 500),
  );
}

/** The password for a locked game -> { key }, or 403. */
async function unlock(req: IncomingMessage, res: ServerResponse, id: string) {
  const now = Date.now();
  const ip = address(req);
  const mine = (tries.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (mine.length >= TRIES_PER_MIN) return json(res, { error: 'busy' }, 429);
  if (tries.size > 10_000) tries.clear(); // never grows without end
  mine.push(now);
  tries.set(ip, mine);
  const b = await body(req);
  if (!exists(id)) return json(res, { error: 'missing' }, 404);
  const password = typeof b?.password === 'string' ? b.password.slice(0, PASSWORD_MAX) : '';
  const key = games.unlock(id, password);
  return key === null ? json(res, { error: 'wrong' }, 403) : json(res, { key });
}

/** The public games still being played, busiest first (cached a few seconds: each one opens a database). */
function browse(): WorldStats[] {
  if (browsed && Date.now() - browsed.at < 5000) return browsed.list;
  const list = games
    .publicGames()
    .map((g) => stats(g.id))
    .filter((s): s is WorldStats => !!s && s.lives > 0)
    .sort((a, b) => b.online - a.online)
    .slice(0, BROWSE_MAX);
  browsed = { at: Date.now(), list };
  return list;
}

const http = createServer((req, res) => {
  if (req.url === '/healthz') return void res.end('ok');
  if (minigameApi(board, req, res)) return;
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (path === '/api/browse' && req.method === 'GET') return json(res, browse());
  if (path === '/api/worlds' && req.method === 'POST') return void create(req, res);
  // The worlds this browser joined (the main menu's list): { ids, browserId }, posted so the browserId stays out of URLs.
  if (path === '/api/worlds/mine' && req.method === 'POST') {
    body(req).then((b) => {
      const ids = Array.isArray(b?.ids) ? b.ids.filter((i): i is string => typeof i === 'string').slice(0, STATS_MAX) : [];
      const browserId = typeof b?.browserId === 'string' && UUID.test(b.browserId) ? b.browserId : undefined;
      json(res, ids.map((id) => stats(id, browserId)).filter((s) => s));
    });
    return;
  }
  const one = /^\/api\/worlds\/([a-z0-9]+)(\/key)?$/.exec(path);
  if (one?.[2] && req.method === 'POST') return void unlock(req, res, one[1]);
  if (one && !one[2] && req.method === 'GET') {
    const s = stats(one[1]);
    return s ? json(res, s) : json(res, { error: 'missing' }, 404);
  }
  serveStatic(req, res, () => {
    res.statusCode = 404;
    res.end('not found');
  });
});

// Turns away connections to worlds that don't exist (4404), so the client can say so instead of retrying.
const refuse = new WebSocketServer({ noServer: true });

http.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/ws') return socket.destroy();
  const id = url.searchParams.get('w') ?? '';
  if (!exists(id)) return refuse.handleUpgrade(req, socket, head, (ws) => ws.close(4404, 'no such world'));
  // Locked without the key (src/lobby.ts gets it), or full: say which, so the client can.
  if (!games.keyOk(id, url.searchParams.get('k') ?? '')) return refuse.handleUpgrade(req, socket, head, (ws) => ws.close(4403, 'locked'));
  if ((online.get(id) ?? 0) >= games.get(id).max) return refuse.handleUpgrade(req, socket, head, (ws) => ws.close(4429, 'full'));
  socket.on('error', () => {});
  world(id).then(
    (port) => {
      if (socket.destroyed) return;
      const up = connect(port, '127.0.0.1', () => {
        // Replay the upgrade request as it came, then join the two streams.
        let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
        up.write(raw + '\r\n');
        if (head.length) up.write(head);
        // Small frames at 60 Hz (inputs) and 20 Hz (snapshots): don't let Nagle hold them back on either hop.
        socket.setNoDelay(true);
        up.setNoDelay(true);
        socket.pipe(up).pipe(socket);
        online.set(id, (online.get(id) ?? 0) + 1);
        up.once('close', () => {
          const n = (online.get(id) ?? 1) - 1;
          if (n > 0) online.set(id, n);
          else online.delete(id);
        });
      });
      up.on('error', () => socket.destroy());
      up.on('close', () => socket.destroy());
      socket.on('close', () => up.destroy());
    },
    () => socket.destroy(),
  );
});

// Watchtower stops the container with SIGTERM on every deploy: the worlds save their players and tell them
// the server is restarting (server/world.ts shutdown); wait for them, then go.
function shutdown() {
  http.close();
  const left = [...worlds.values()].map((w) => new Promise((r) => (w.child.exitCode !== null ? r(0) : (w.child.once('exit', r), w.child.kill('SIGTERM')))));
  Promise.all(left).then(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

http.listen(PORT, () => console.log(`dadajam server on :${PORT}`));
