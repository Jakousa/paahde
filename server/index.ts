// Front server: serves the built client (the landing page and the game), makes new worlds and passes each
// player's WebSocket (/ws?w=<id>) through to its world. Every world is a process of its own (server/world.ts,
// forked here with WORLD_ID), because the world's layout is seeded once when the shared modules load
// (shared/world.ts). A world starts on its first connection and exits on its own when it's been empty a while.
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import sirv from 'sirv';
import { WebSocketServer } from 'ws';
import { LEGACY_WORLD, newWorldId, WORLD_ID_RE } from '../shared/world.ts';

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? 'data/dadajam.db';
const WORLDS_DIR = join(dirname(DB_PATH), 'worlds');
/** New worlds a minute, from everyone: enough for players, not for filling the disk. */
const NEW_PER_MIN = 30;

/** The world from before there were worlds keeps its old database; the rest have one each. */
const dbPath = (id: string) => (id === LEGACY_WORLD ? DB_PATH : join(WORLDS_DIR, `${id}.db`));
const exists = (id: string) => WORLD_ID_RE.test(id) && existsSync(dbPath(id));

type World = { child: ChildProcess; port: Promise<number> };
const worlds = new Map<string, World>();

/** The world's process, started if it isn't running; resolves to the local port it takes connections on. */
function world(id: string): Promise<number> {
  let w = worlds.get(id);
  if (!w) {
    mkdirSync(WORLDS_DIR, { recursive: true });
    const child = fork(new URL('./world.ts', import.meta.url), {
      env: { ...process.env, WORLD_ID: id, DB_PATH: dbPath(id) },
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

const serveStatic = sirv('dist', {
  etag: true,
  brotli: true,
  gzip: true,
  setHeaders: (res, path) => {
    res.setHeader('Cache-Control', path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  },
});

let made: number[] = [];
const http = createServer((req, res) => {
  if (req.url === '/healthz') return void res.end('ok');
  if (req.url === '/api/worlds' && req.method === 'POST') {
    const now = Date.now();
    made = made.filter((t) => now - t < 60_000);
    if (made.length >= NEW_PER_MIN) {
      res.statusCode = 429;
      return void res.end();
    }
    made.push(now);
    let id = newWorldId();
    while (exists(id)) id = newWorldId();
    // Started now, so its database exists before anyone joins (unknown worlds are turned away).
    world(id).then(
      () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id }));
      },
      () => {
        res.statusCode = 500;
        res.end();
      },
    );
    return;
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
