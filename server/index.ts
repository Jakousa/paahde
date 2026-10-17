// Authoritative game server: serves the built client, accepts WebSocket connections on /ws,
// simulates every player with shared/sim.ts and broadcasts snapshots.
import { createServer } from 'node:http';
import sirv from 'sirv';
import { WebSocketServer, type WebSocket } from 'ws';
import { DT, INPUT_MASK, spawnState, step, TICK_RATE, YAW_STEPS, type PlayerState } from '../shared/sim.ts';
import type { ClientMsg, PlayerSnap, ServerMsg } from '../shared/protocol.ts';
import { openDb } from './db.ts';

const PORT = Number(process.env.PORT ?? 8787);
const SNAPSHOT_RATE = 20; // Hz; clients interpolate remote players between snapshots
const SAVE_INTERVAL_MS = 5000;
const IDLE_MS = 1000; // no input for this long (e.g. hidden tab) → server keeps simulating with no keys
const MAX_INPUT_BURST = 15;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const db = openDb(process.env.DB_PATH ?? 'data/dadajam.db');

type Player = {
  id: number;
  browserId: string;
  color: number;
  state: PlayerState;
  yaw: number; // last quantized camera yaw, reused while idle
  ack: number; // last applied input seq
  tokens: number; // input rate limiter: refills at TICK_RATE/s, so inputs can't speed up time
  lastInputAt: number;
  idleAccum: number;
  ws: WebSocket;
  alive: boolean;
};

const players = new Map<WebSocket, Player>();
let nextId = 1;

const serveStatic = sirv('dist', {
  etag: true,
  setHeaders: (res, path) => {
    res.setHeader('Cache-Control', path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  },
});
const http = createServer((req, res) => {
  if (req.url === '/healthz') return void res.end('ok');
  serveStatic(req, res, () => {
    res.statusCode = 404;
    res.end('not found');
  });
});

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 1024 });

wss.on('connection', (ws) => {
  ws.on('pong', () => {
    const p = players.get(ws);
    if (p) p.alive = true;
  });
  ws.on('message', (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return ws.close(1003, 'bad json');
    }
    const p = players.get(ws);
    if (msg.t === 'hello' && !p) return join(ws, msg.browserId);
    if (msg.t === 'input' && p) return onInput(p, msg.seq, msg.input, msg.yaw);
  });
  ws.on('close', () => {
    const p = players.get(ws);
    if (!p) return;
    save(p);
    players.delete(ws);
  });
  // Drop clients that never say hello.
  setTimeout(() => players.has(ws) || ws.close(1008, 'no hello'), 5000);
});

function join(ws: WebSocket, browserId: unknown) {
  if (typeof browserId !== 'string' || !UUID.test(browserId)) return ws.close(1008, 'bad browserId');
  const row = db.getPlayer(browserId);
  const color = row?.color ?? Math.floor(Math.random() * 0xffffff);
  const state = row ? spawnState(row.x, row.z) : spawnState();
  const p: Player = {
    id: nextId++, browserId, color, state, yaw: 0, ack: 0,
    tokens: MAX_INPUT_BURST, lastInputAt: Date.now(), idleAccum: 0, ws, alive: true,
  };
  players.set(ws, p);
  save(p);
  send(ws, { t: 'welcome', id: p.id, state, color });
}

function onInput(p: Player, seq: unknown, input: unknown, yaw: unknown) {
  if (typeof seq !== 'number' || typeof input !== 'number' || seq <= p.ack) return;
  if (!Number.isInteger(yaw) || (yaw as number) < 0 || (yaw as number) >= YAW_STEPS) return;
  p.ack = seq;
  p.lastInputAt = Date.now();
  // Over the rate limit: acknowledge but don't simulate, so the client gets corrected.
  if (p.tokens < 1) return;
  p.tokens -= 1;
  p.yaw = yaw as number;
  p.state = step(p.state, input & INPUT_MASK, p.yaw);
}

// Fixed-rate server loop: refill input tokens, simulate idle players, broadcast snapshots.
let last = performance.now();
let snapAccum = 0;
setInterval(() => {
  const now = performance.now();
  const elapsed = (now - last) / 1000;
  last = now;
  for (const p of players.values()) {
    p.tokens = Math.min(MAX_INPUT_BURST, p.tokens + elapsed * TICK_RATE);
    if (Date.now() - p.lastInputAt > IDLE_MS) {
      for (p.idleAccum += elapsed; p.idleAccum >= DT; p.idleAccum -= DT) p.state = step(p.state, 0, p.yaw);
    } else {
      p.idleAccum = 0;
    }
  }
  snapAccum += elapsed;
  if (snapAccum >= 1 / SNAPSHOT_RATE) {
    snapAccum %= 1 / SNAPSHOT_RATE;
    broadcast(now);
  }
}, 1000 / TICK_RATE);

function broadcast(time: number) {
  const list: PlayerSnap[] = [...players.values()].map((p) => ({ id: p.id, color: p.color, ...round(p.state) }));
  for (const p of players.values()) send(p.ws, { t: 'snap', time, ack: p.ack, players: list });
}

// Trim floats on the wire; client reconciliation re-simulates from these values so precision
// must stay well below anything visible.
function round(s: PlayerState): PlayerState {
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  return { ...s, x: r(s.x), y: r(s.y), z: r(s.z), vx: r(s.vx), vy: r(s.vy), vz: r(s.vz), facing: r(s.facing) };
}

function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function save(p: Player) {
  db.savePlayer({ id: p.browserId, color: p.color, x: p.state.x, z: p.state.z });
}

setInterval(() => players.forEach(save), SAVE_INTERVAL_MS);

// Heartbeat: keeps NATs/proxies from dropping idle sockets and terminates dead ones.
setInterval(() => {
  for (const p of players.values()) {
    if (!p.alive) p.ws.terminate();
    p.alive = false;
    p.ws.ping();
  }
}, 25_000);

// Watchtower stops the container with SIGTERM on every deploy: persist everyone, then tell
// clients the server is restarting (1012) so they reconnect.
function shutdown() {
  for (const p of players.values()) {
    save(p);
    p.ws.close(1012, 'server restarting');
  }
  db.close();
  http.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

http.listen(PORT, () => console.log(`dadajam server on :${PORT}`));
