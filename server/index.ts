// Authoritative game server: serves the built client, accepts WebSocket connections on /ws,
// simulates every player with shared/sim.ts and broadcasts snapshots.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import sirv from 'sirv';
import { WebSocketServer, type WebSocket } from 'ws';
import { DIG, DT, INPUT_MASK, PILE, spawnState, step, TICK_RATE, YAW_STEPS, type PlayerState } from '../shared/sim.ts';
import { DIG_COOLDOWN_TICKS, PITCH_STEPS, quantizePitch } from '../shared/dig.ts';
import { scrapKey, scrapTaken } from '../shared/scrap.ts';
import { overBase } from '../shared/base.ts';
import type { ClientMsg, PlayerSnap, ServerMsg } from '../shared/protocol.ts';
import { openDb } from './db.ts';
import { GardenServer } from './garden.ts';
import { ScrapServer } from './scrap.ts';
import { TerrainServer } from './terrain.ts';
import { drink, fill, newThirst, revive, tickThirst, waterMsg, type Thirst } from './water.ts';
import { BASE_SPAWN } from '../shared/base.ts';
import { timeOfDayAt } from '../shared/sun.ts';

const PORT = Number(process.env.PORT ?? 8787);
const SNAPSHOT_RATE = 20; // Hz; clients interpolate remote players between snapshots
const RELAX_RATE = 30; // Hz; sand avalanche passes (shared/dig.ts Relaxer)
const SAVE_INTERVAL_MS = 5000;
const IDLE_MS = 1000; // no input for this long (e.g. hidden tab) → server keeps simulating with no keys
/** Inputs a client may bank: a network stall delivers its delayed inputs in one burst, and any past this
 *  are acked unsimulated (the client snaps back). One second, like IDLE_MS; the long-run rate stays TICK_RATE. */
const MAX_INPUT_BURST = TICK_RATE;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const db = openDb(process.env.DB_PATH ?? 'data/dadajam.db');
const terrain = new TerrainServer(db);
const scrap = new ScrapServer(db);
const garden = new GardenServer(db);

type Player = {
  id: number;
  browserId: string;
  color: number;
  state: PlayerState;
  yaw: number; // last quantized camera yaw, reused while idle
  pitch: number; // last quantized camera pitch (shared/dig.ts)
  digCooldown: number; // simulated ticks until the next dig/pile stroke may land
  ack: number; // last applied input seq
  tokens: number; // input rate limiter: refills at TICK_RATE/s, so inputs can't speed up time
  lastInputAt: number;
  idleAccum: number;
  lastPickup: { at: number };
  input: number; // last input bitmask (0 while idle), for sprint drain
  thirst: Thirst; // server/water.ts
  lastTend: { at: number };
  ws: WebSocket;
  alive: boolean;
};

const players = new Map<WebSocket, Player>();
let nextId = 1;

const BUILD = (() => {
  try {
    return readFileSync('dist/version.txt', 'utf8').trim();
  } catch {
    return 'dev';
  }
})();

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
  send(ws, { t: 'version', build: BUILD });
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
    if (msg.t === 'hello' && !p) return join(ws, msg.browserId, msg.spawn === 'base');
    if (msg.t === 'input' && p) return onInput(p, msg.seq, msg.input, msg.yaw, msg.pitch);
    if (msg.t === 'pickup' && p) return onPickup(p, msg.ix, msg.iz, msg.i);
    if (msg.t === 'tend' && p) return onTend(p, msg.bed);
    if (msg.t === 'setEpoch' && p) return onSetEpoch(ws, msg.epoch);
    if (msg.t === 'drink' && p) return onDrink(p);
    if (msg.t === 'fill' && p) return onFill(p);
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

function join(ws: WebSocket, browserId: unknown, atBase: boolean) {
  if (typeof browserId !== 'string' || !UUID.test(browserId)) return ws.close(1008, 'bad browserId');
  const row = db.getPlayer(browserId);
  const color = row?.color ?? Math.floor(Math.random() * 0xffffff);
  // Heights aren't saved: someone who left over the bunker (or in it) starts at its door instead.
  const state = row && !atBase && !overBase(row.x, row.z, 0.5) ? spawnState(row.x, row.z) : spawnState();
  const p: Player = {
    id: nextId++, browserId, color, state, yaw: 0, pitch: quantizePitch(0), digCooldown: 0, ack: 0,
    tokens: MAX_INPUT_BURST, lastInputAt: Date.now(), idleAccum: 0, lastPickup: { at: 0 }, lastTend: { at: 0 }, input: 0,
    thirst: newThirst(row?.water, row?.sips), ws, alive: true,
  };
  players.set(ws, p);
  save(p);
  // Terrain first, so the client never sees its spawn without the holes.
  for (const m of terrain.joinMessages(state.x, state.z)) send(ws, m);
  send(ws, scrap.joinMessage());
  send(ws, garden.joinMessage());
  send(ws, { t: 'welcome', id: p.id, state, color, epoch });
  send(ws, { t: 'inventory', items: scrap.inventory(browserId) });
  send(ws, waterMsg(p.thirst));
}

// Sips and refills: the client plays the animation, then asks. Refused ones still get the real state.
function onDrink(p: Player) {
  drink(p.thirst, Date.now());
  send(p.ws, waterMsg(p.thirst));
}

function onFill(p: Player) {
  fill(p.thirst, p.state, Date.now());
  send(p.ws, waterMsg(p.thirst));
}

// Thirst drains in the sun (server/water.ts); at zero the player dies and respawns at the base, full again.
// The next snapshot carries the new position, which the client snaps to (src/net.ts reconcile).
function thirst(p: Player, dt: number, tod: number) {
  const now = Date.now();
  const r = tickThirst(p.thirst, dt, p.state, p.input, tod, now);
  if (r === 'died') {
    p.state = spawnState(BASE_SPAWN.x, BASE_SPAWN.z);
    revive(p.thirst, now);
    save(p);
    send(p.ws, { t: 'died', cause: 'thirst' });
    send(p.ws, waterMsg(p.thirst));
  } else if (r === 'send') {
    send(p.ws, waterMsg(p.thirst));
  }
}

function onPickup(p: Player, ix: unknown, iz: unknown, i: unknown) {
  const items = scrap.pickup(p.browserId, p.state, ix, iz, i, p.lastPickup);
  if (items) return send(p.ws, { t: 'inventory', items });
  // Refused: the client already hid the piece. If it is still there, tell this client to show it again.
  if (typeof ix === 'number' && typeof iz === 'number' && typeof i === 'number' && !scrapTaken.has(scrapKey(ix, iz, i))) {
    send(p.ws, { t: 'scrap', taken: [], back: [ix, iz, i] });
  }
}

function onTend(p: Player, bed: unknown) {
  const what = garden.tend(p.state, bed, p.lastTend);
  if (what) send(p.ws, { t: 'tended', what });
}

function onInput(p: Player, seq: unknown, input: unknown, yaw: unknown, pitch: unknown) {
  if (typeof seq !== 'number' || typeof input !== 'number' || seq <= p.ack) return;
  if (!Number.isInteger(yaw) || (yaw as number) < 0 || (yaw as number) >= YAW_STEPS) return;
  if (!Number.isInteger(pitch) || (pitch as number) < 0 || (pitch as number) >= PITCH_STEPS) return;
  p.ack = seq;
  p.lastInputAt = Date.now();
  // Over the rate limit: acknowledge but don't simulate, so the client gets corrected.
  if (p.tokens < 1) return;
  p.tokens -= 1;
  p.yaw = yaw as number;
  p.pitch = pitch as number;
  p.input = input & INPUT_MASK;
  p.state = step(p.state, input & INPUT_MASK, p.yaw);
  dig(p, input);
}

// Dig/pile stroke while the button is held, at most every DIG_COOLDOWN_TICKS simulated ticks.
// The client runs the same countdown and stroke as a prediction (src/net.ts).
function dig(p: Player, input: number) {
  if (p.digCooldown > 0) p.digCooldown--;
  if (!(input & (DIG | PILE)) || p.digCooldown > 0) return;
  const pile = (input & DIG) === 0;
  const at = terrain.stroke(p.state, p.yaw, p.pitch, pile);
  if (!at) return;
  p.digCooldown = DIG_COOLDOWN_TICKS;
  const msg: ServerMsg = { t: 'dug', id: p.id, x: round4(at.x), y: round4(at.y), z: round4(at.z), pile };
  for (const o of players.values()) if (o !== p) send(o.ws, msg);
}

// Fixed-rate server loop: refill input tokens, simulate idle players, broadcast snapshots.
let last = performance.now();
let snapAccum = 0;
let relaxAccum = 0;
setInterval(() => {
  const now = performance.now();
  const elapsed = (now - last) / 1000;
  last = now;
  const tod = timeOfDayAt(now + epoch);
  for (const p of players.values()) {
    p.tokens = Math.min(MAX_INPUT_BURST, p.tokens + elapsed * TICK_RATE);
    thirst(p, elapsed, tod);
    if (Date.now() - p.lastInputAt > IDLE_MS) {
      p.input = 0;
      for (p.idleAccum += elapsed; p.idleAccum >= DT; p.idleAccum -= DT) {
        p.state = step(p.state, 0, p.yaw);
        dig(p, 0);
      }
    } else {
      p.idleAccum = 0;
    }
  }
  relaxAccum += elapsed;
  if (relaxAccum >= 1 / RELAX_RATE) {
    relaxAccum %= 1 / RELAX_RATE;
    terrain.relax();
  }
  snapAccum += elapsed;
  if (snapAccum >= 1 / SNAPSHOT_RATE) {
    snapAccum %= 1 / SNAPSHOT_RATE;
    broadcast(now);
  }
}, 1000 / TICK_RATE);

// The wall-clock ms at server time 0 drives the day/night cycle. The debug menu (F3) can move it for everyone,
// in production too (a game jam: the team wants it). Any client can send it, so lock it down if this goes public.
// The shift from the real clock is stored, since node --watch restarts the server on every code edit.
const realEpoch = performance.timeOrigin;
let epoch = realEpoch + (db.getSetting('clockShift') ?? 0);

function onSetEpoch(ws: WebSocket, wanted: unknown) {
  const ok = wanted === null || (typeof wanted === 'number' && Number.isFinite(wanted));
  if (!ok) return send(ws, { t: 'epoch', epoch });
  epoch = wanted === null ? realEpoch : (wanted as number);
  db.setSetting('clockShift', epoch - realEpoch);
  for (const p of players.values()) send(p.ws, { t: 'epoch', epoch });
}

function broadcast(time: number) {
  // Terrain and scrap changes go out before the snapshot, so a client seeing ack N has every edit up to N.
  for (const msg of [terrain.flush(), scrap.flush(), garden.flush()]) {
    if (!msg) continue;
    const json = JSON.stringify(msg);
    for (const p of players.values()) if (p.ws.readyState === p.ws.OPEN) p.ws.send(json);
  }
  const list: PlayerSnap[] = [...players.values()].map((p) => ({ id: p.id, color: p.color, pitch: p.pitch, ...round(p.state) }));
  for (const p of players.values()) send(p.ws, { t: 'snap', time, ack: p.ack, players: list });
}

// Trim floats on the wire; client reconciliation re-simulates from these values so precision
// must stay well below anything visible.
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
function round(s: PlayerState): PlayerState {
  const r = round4;
  return { ...s, x: r(s.x), y: r(s.y), z: r(s.z), vx: r(s.vx), vy: r(s.vy), vz: r(s.vz), facing: r(s.facing), heading: r(s.heading) };
}

function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function save(p: Player) {
  db.savePlayer({ id: p.browserId, color: p.color, x: p.state.x, z: p.state.z, water: p.thirst.water, sips: p.thirst.sips });
}

setInterval(() => {
  players.forEach(save);
  terrain.save();
  scrap.respawn();
  garden.grow();
}, SAVE_INTERVAL_MS);

// Heartbeat: keeps NATs/proxies from dropping idle sockets and terminates dead ones.
setInterval(() => {
  for (const p of players.values()) {
    if (!p.alive) {
      p.ws.terminate();
      continue;
    }
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
  terrain.save();
  db.close();
  http.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

http.listen(PORT, () => console.log(`dadajam server on :${PORT}`));
