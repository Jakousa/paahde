// Authoritative game server: serves the built client, accepts WebSocket connections on /ws,
// simulates every player with shared/sim.ts and broadcasts snapshots.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import sirv from 'sirv';
import { WebSocketServer, type WebSocket } from 'ws';
import { DIG, DT, INPUT_MASK, PILE, spawnState, step, TICK_RATE, YAW_STEPS, type PlayerState } from '../shared/sim.ts';
import { PITCH_STEPS, quantizePitch } from '../shared/dig.ts';
import { bikeLevel, bottleSips, digTool, GEAR_KINDS, gunCooldown, quality, repaired, scrapParts, wornGear } from '../shared/gear.ts';
import { scrapKey, scrapTaken } from '../shared/scrap.ts';
import { HOTBAR, partKind, scrapItem } from '../shared/items.ts';
import { pickTier } from '../shared/parts.ts';
import { KILL_SPOILS } from '../shared/tables.ts';
import { boxSize, CHESTS, isShared, OWN_BOXES } from '../shared/storage.ts';
import { crashTaken } from '../shared/crash.ts';
import { inBase, overBase } from '../shared/base.ts';
import { crashSitesNear } from '../shared/crashsites.ts';
import { BLAST_R, CRATER_MM, CRATER_R, GUARDIAN } from '../shared/guardians.ts';
import { BLAST_R as MISSILE_BLAST_R } from '../shared/missiles.ts';
import { GUNS, PISTOL } from '../shared/rifle.ts';
import { inCone, JAM_BLEED, JAM_MS, JAM_SEND_MS, JAMMER } from '../shared/jammer.ts';
import { THROW_MS, THROWABLE } from '../shared/throw.ts';
import { EYE_HEIGHT } from '../shared/dig.ts';
import type { ClientMsg, DeathCause, Hands, PlayerSnap, ServerMsg } from '../shared/protocol.ts';
import { CHAT_MAX } from '../shared/protocol.ts';
import { openDb } from './db.ts';
import { GardenServer } from './garden.ts';
import { PlacedServer } from './placed.ts';
import { ItemServer } from './items.ts';
import { LootServer } from './loot.ts';
import { CorpseServer } from './corpses.ts';
import { canDropAt } from '../shared/loot.ts';
import { ScrapServer } from './scrap.ts';
import { StormServer } from './storm.ts';
import { JetServer } from './jets.ts';
import { GuardianServer, SEND_R as BOT_SEND_R, TICK_HZ as BOT_HZ, type Kill } from './guardians.ts';
import { CrashServer } from './crash.ts';
import { ThrowServer, type TossEvent } from './throws.ts';
import { TerrainServer } from './terrain.ts';
import { bite, drink, fill, newHeat, revive, setBottle, tickHeat, waterMsg, type Heat } from './water.ts';
import { BUNKER_SPAWN } from '../shared/base.ts';
import { blastPush, DOWN_MS } from '../shared/ragdoll.ts';
import { stormAt, stormDrag } from '../shared/storm.ts';
import { sunElevation, timeOfDayAt } from '../shared/sun.ts';

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
const items = new ItemServer(db);
const crash = new CrashServer(db, (ids, msg) => {
  const want = new Set(ids);
  for (const p of players.values()) if (want.has(p.id)) send(p.ws, msg);
}, (msg) => {
  for (const p of players.values()) send(p.ws, msg);
});
const placedThings = new PlacedServer(db, items); // before the garden: it loads the beds
const garden = new GardenServer(db);
const loot = new LootServer(db);
const corpses = new CorpseServer(db, items, (msg) => {
  const json = JSON.stringify(msg);
  for (const p of players.values()) if (p.ws.readyState === p.ws.OPEN) p.ws.send(json);
});

const storms = new StormServer(performance.now());
const jets = new JetServer(performance.now());
const guardians = new GuardianServer();
const throws = new ThrowServer(guardians);
/** Heat per second from drone searchlights by player id, from the last bot tick. */

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
  heat: Heat; // server/water.ts
  lastTend: { at: number };
  ws: WebSocket;
  alive: boolean;
  hands: Hands; // what the client says it holds, relayed in snapshots
  slot: number; // selected hotbar slot (-1 none): digs with what's in it
  aim: boolean; // gun raised to aim (cosmetic, relayed in snapshots)
  /** Dead and lying where they fell until `until` (Date.now ms), thrown by `push` (shared/ragdoll.ts). */
  down: { until: number; push: [number, number, number] } | null;
  firedAt: number; // last laser rifle shot or throw (performance.now() ms)
  chatAt: number; // last chat line (performance.now() ms)
  /** The jammer's lock (shared/jammer.ts): on which target, built up how far (ms), last told when (performance.now). */
  jam: { kind: 'jet' | 'drone'; id: number; acc: number; at: number } | null;
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
    if (msg.t === 'hello' && !p) return join(ws, msg.browserId, msg.spawn);
    if (msg.t === 'input' && p) return onInput(p, msg.seq, msg.input, msg.yaw, msg.pitch);
    if (msg.t === 'pickup' && p) return onPickup(p, msg.ix, msg.iz, msg.i);
    if (msg.t === 'tend' && p) return onTend(p, msg.bed);
    if (msg.t === 'place' && p) return onPlace(p, msg.slot, msg.x, msg.z, msg.rot);
    if (msg.t === 'unplace' && p) return onUnplace(p, msg.id);
    if (msg.t === 'craft' && p) return onCraft(p, msg.recipe);
    if (msg.t === 'setEpoch' && p) return onSetEpoch(ws, msg.epoch);
    if (msg.t === 'storm' && p) return storms.spawn(p.state.x, p.state.z, 0, performance.now());
    if (msg.t === 'summon' && msg.what === 'jet' && p) return jets.spawn(p.state.x, p.state.z, 0, performance.now(), true);
    if (msg.t === 'summon' && p) return guardians.summon(msg.what, { id: p.id, x: p.state.x, y: p.state.y, z: p.state.z, safe: false }, performance.now());
    if (msg.t === 'fire' && p) return onFire(p, msg);
    if (msg.t === 'jam' && p) return onJam(p, msg);
    if (msg.t === 'throw' && p) return onThrow(p, msg);
    if (msg.t === 'stomped' && p) return onStomped(p, msg.g);
    if (msg.t === 'drink' && p) return onDrink(p);
    if (msg.t === 'fill' && p) return onFill(p);
    if (msg.t === 'move' && p) return onMove(p, msg.from, msg.fi, msg.to, msg.ti, msg.n, msg.r);
    if (msg.t === 'sort' && p) return onSort(p, msg.box);
    if (msg.t === 'fit' && p) return onFit(p, msg.from, msg.fi, msg.slot);
    if (msg.t === 'unfit' && p) return onUnfit(p, msg.slot, msg.to, msg.ti);
    if (msg.t === 'lootTake' && p) return onLootTake(p, msg.id);
    if (msg.t === 'drop' && p) return onDrop(p, msg.box, msg.slot);
    if (msg.t === 'debugGear' && p) return onDebugGear(p);
    if (msg.t === 'chat' && p) return onChat(p, msg.text);
    if (msg.t === 'hands' && p) {
      p.hands = msg.hands === 1 || msg.hands === 2 || msg.hands === 3 ? msg.hands : 0;
      p.aim = msg.aim === true;
      p.slot = Number.isInteger(msg.slot) && (msg.slot as number) >= 0 && (msg.slot as number) < HOTBAR ? (msg.slot as number) : -1;
      return;
    }
    if (p) return onCrash(p, msg);
  });
  ws.on('close', () => {
    const p = players.get(ws);
    if (!p) return;
    save(p);
    crash.leaveAll(p.id);
    players.delete(ws);
    if (![...players.values()].some((o) => o.browserId === p.browserId)) {
      items.forget(p.browserId);
    }
  });
  // Drop clients that never say hello.
  setTimeout(() => players.has(ws) || ws.close(1008, 'no hello'), 5000);
});

function join(ws: WebSocket, browserId: unknown, spawn: unknown) {
  if (typeof browserId !== 'string' || !UUID.test(browserId)) return ws.close(1008, 'bad browserId');
  const row = db.getPlayer(browserId);
  const color = row?.color ?? Math.floor(Math.random() * 0xffffff);
  // Heights aren't saved: someone who left over the bunker (or in it) starts down in it.
  const atBase = spawn === 'base';
  let state = row && !atBase && !overBase(row.x, row.z, 0.5) ? spawnState(row.x, row.z) : spawnState();
  if (spawn === 'crash') {
    // Dev helper: 7 m from the large machine of the nearest crash site, on its far side from the wreck.
    const m = crashSitesNear(state.x, state.z, 3000).find((s) => s.level > 0)?.machines[0];
    if (m) state = spawnState(m.x + m.dx * 7, m.z + m.dz * 7);
  }
  if (spawn === 'field') {
    // Dev helper: just outside the nearest scrap field, on the base's side, looking at it.
    const s = crashSitesNear(state.x, state.z, 3000).find((o) => o.level === 0);
    if (s) {
      const d = Math.hypot(state.x - s.x, state.z - s.z) || 1;
      state = spawnState(s.x + ((state.x - s.x) / d) * (s.radius + 6), s.z + ((state.z - s.z) / d) * (s.radius + 6));
    }
  }
  items.setup(browserId);
  state.bike = bikeLevel(items.slots(browserId, 'equip'));
  const p: Player = {
    id: nextId++, browserId, color, state, yaw: 0, pitch: quantizePitch(0), digCooldown: 0, ack: 0,
    tokens: MAX_INPUT_BURST, lastInputAt: Date.now(), idleAccum: 0, lastPickup: { at: 0 }, lastTend: { at: 0 }, input: 0,
    heat: newHeat(row?.heat, row?.sips, bottleSips(items.slots(browserId, 'bag'))), ws, alive: true, hands: 0, slot: -1, aim: false, down: null, firedAt: 0, chatAt: 0, jam: null,
  };
  players.set(ws, p);
  save(p);
  // Terrain first, so the client never sees its spawn without the holes.
  for (const m of terrain.joinMessages(state.x, state.z)) send(ws, m);
  send(ws, scrap.joinMessage());
  send(ws, crash.joinMessage());
  send(ws, crash.progressMessage());
  send(ws, crash.benchMessage());
  send(ws, crash.spentMessage());
  send(ws, placedThings.joinMessage());
  send(ws, garden.joinMessage());
  send(ws, storms.msg());
  send(ws, jets.msg());
  send(ws, loot.joinMessage());
  send(ws, { t: 'welcome', id: p.id, state, color, epoch });
  send(ws, corpses.joinMessage());
  for (const box of [...OWN_BOXES, ...CHESTS.map((_, i) => `chest${i}`), ...corpses.boxes()]) send(ws, boxMsg(browserId, box));
  send(ws, waterMsg(p.heat));

}

// Sips and refills: the client plays the animation, then asks. Refused ones still get the real state.
// No repaired water bottle in the bag (left in a chest, or still broken), no drinking or filling (maxSips 0).
function onDrink(p: Player) {
  drink(p.heat, Date.now());
  send(p.ws, waterMsg(p.heat));
}

function onFill(p: Player) {
  fill(p.heat, p.state, Date.now());
  send(p.ws, waterMsg(p.heat));
}

/** A player's items changed: the motorcycle they can ride and their water bottle follow, on every connection. */
function gearChanged(browserId: string) {
  const bike = bikeLevel(items.slots(browserId, 'equip'));
  const sips = bottleSips(items.slots(browserId, 'bag'));
  for (const o of players.values()) {
    if (o.browserId !== browserId) continue;
    if (o.state.bike !== bike) o.state = { ...o.state, bike };
    if (setBottle(o.heat, sips)) send(o.ws, waterMsg(o.heat));
  }
}

// Heat builds up in the sun (server/water.ts); when it's full the player dies of heatstroke and respawns at
// the base, cooled down.
// The next snapshot carries the new position, which the client snaps to (src/net.ts reconcile).
function heat(p: Player, dt: number, tod: number, serverNow: number) {
  const now = Date.now();
  const storm = stormAt(storms.storms, p.state.x, p.state.z, serverNow);
  const r = tickHeat(p.heat, dt, p.state, p.input, tod, storm, now);
  if (r === 'died') {
    die(p, 'heat');
  } else if (r === 'send') {
    send(p.ws, waterMsg(p.heat));
  }
}

/** Drop where they stand (off the bike, stopped) for DOWN_MS, as a ragdoll thrown by `push`; then respawn(). */
function die(p: Player, cause: DeathCause, push: [number, number, number] = [0, 0, 0]) {
  if (p.down) return;
  p.down = { until: Date.now() + DOWN_MS, push };
  p.state = { ...p.state, vx: 0, vy: 0, vz: 0, riding: false, sliding: false, crouching: false };
  revive(p.heat, Date.now());
  send(p.ws, { t: 'died', cause, push });
  // The bag past the hotbar stays where they fell (shared/corpse.ts).
  const pack = corpses.leave(p.browserId, p.color, p.state.x, p.state.z);
  if (pack) {
    sendBox(p, pack);
    sendBox(p, 'bag');
    gearChanged(p.browserId);
  }
}

/** The client saw a guardian's foot come down on it (the feet are client IK). */
function onStomped(p: Player, g: number) {
  const s = p.state;
  if (!p.down && guardians.stomp(g, { id: p.id, x: s.x, y: s.y, z: s.z, safe: Date.now() - p.heat.diedAt < BOT_GRACE_MS }, performance.now())) die(p, 'guardian');
}

/** Back to the base, cooled down, with a full canteen. */
function respawn(p: Player) {
  p.down = null;
  p.state = { ...spawnState(), bike: p.state.bike };
  revive(p.heat, Date.now());
  save(p);
  send(p.ws, { t: 'respawn' });
  send(p.ws, waterMsg(p.heat));
}

/** Respawned this recently (ms): the guardians and drones leave you alone. */
const BOT_GRACE_MS = 5000;
let botAccum = 0;
function tickBots(elapsed: number, now: number, tod: number) {
  botAccum += elapsed;
  if (botAccum < 1 / BOT_HZ) return;
  const dt = Math.min(botAccum, 0.5);
  botAccum = 0;
  const wall = Date.now();
  const list = [...players.values()].map((p) => ({ id: p.id, x: p.state.x, y: p.state.y, z: p.state.z, safe: !!p.down || wall - p.heat.diedAt < BOT_GRACE_MS }));
  guardians.storms = storms.storms;
  const r = guardians.tick(dt, now, tod, list);
  for (const k of guardians.crashes()) dropSpoils(k);
  for (const p of players.values()) {
    if (r.shot.includes(p.id)) die(p, 'laser', boltPush(p, r.events, 'boom', BLAST_R));
    else if (r.blasted.includes(p.id)) die(p, 'missile', boltPush(p, r.events, 'blast', MISSILE_BLAST_R));
    else if (r.bitten.has(p.id) && bite(p.heat, r.bitten.get(p.id)!)) die(p, 'crawler');
    else if (r.bitten.has(p.id)) send(p.ws, waterMsg(p.heat));
    for (const e of r.events) if (Math.hypot(e.x - p.state.x, e.z - p.state.z) < BOT_SEND_R) send(p.ws, e.msg);
    send(p.ws, guardians.msg(now, p.id, p.state.x, p.state.z));
  }
  for (const e of r.events) if ((e.msg.t === 'boom' && e.msg.ground) || e.msg.t === 'blast') terrain.crater(e.msg.x, e.msg.z, CRATER_R, CRATER_MM);
}

/** The nearest bolt burst ('boom') or missile blast throws a player it killed. */
function boltPush(p: Player, events: { msg: ServerMsg }[], t: 'boom' | 'blast', r: number): [number, number, number] {
  let best: Extract<ServerMsg, { t: 'boom' | 'blast' }> | null = null;
  for (const { msg: m } of events) {
    if (m.t === t && (!best || Math.hypot(m.x - p.state.x, m.z - p.state.z) < Math.hypot(best.x - p.state.x, best.z - p.state.z))) best = m;
  }
  return best ? blastPush(best.x, best.y, best.z, p.state.x, p.state.y, p.state.z, r) : [0, 0, 0];
}

/** A shot may start this far (m) from the eye: the third-person camera backs off up to 4.5 m along the view ray. */
const SHOT_FROM = 6;
/** A rifle or pistol shot (shared/rifle.ts): the gun in hand and charged, within its reach, from the shooter's eye.
 *  Shown to everyone near. */
function onFire(p: Player, m: Extract<ClientMsg, { t: 'fire' }>) {
  const now = performance.now();
  const nums = [m.x, m.y, m.z, m.ex, m.ey, m.ez];
  if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v))) return;
  const held = p.slot < 0 ? undefined : items.slots(p.browserId, 'bag')[p.slot];
  const kind = held?.kind;
  const gun = kind ? GUNS[kind] : undefined;
  if (p.down || !gun || !repaired(held)) return;
  // A little slack for network jitter bunching two clicks together.
  if (now - p.firedAt < gunCooldown(gun.cooldown, quality(held)) * 0.8) return;
  if (Math.hypot(m.ex - m.x, m.ey - m.y, m.ez - m.z) > gun.range + 5) return;
  p.firedAt = now;
  const s = p.state;
  if (Math.hypot(m.x - s.x, m.y - (s.y + EYE_HEIGHT), m.z - s.z) > SHOT_FROM) return;
  const wall = Date.now();
  const by = { id: p.id, x: s.x, y: s.y, z: s.z, safe: wall - p.heat.diedAt < BOT_GRACE_MS };
  const r = m.j !== undefined ? { hit: jets.shoot(m.x, m.y, m.z, m.ex, m.ey, m.ez, m.j, now), kill: null }
    : m.d !== undefined ? { hit: guardians.shootDrone(m.x, m.y, m.z, m.ex, m.ey, m.ez, m.d, now, p.id), kill: null }
    : m.g === undefined ? { hit: false, kill: null } : guardians.shoot(by, m.x, m.y, m.z, m.ex, m.ey, m.ez, m.g, m.i, now);
  const zap: ServerMsg = { t: 'zap', by: p.id, x: m.x, y: m.y, z: m.z, ex: m.ex, ey: m.ey, ez: m.ez, hit: r.hit, ...(kind === PISTOL ? { pistol: true as const } : {}) };
  for (const o of players.values()) if (o !== p && Math.hypot(o.state.x - s.x, o.state.z - s.z) < BOT_SEND_R) send(o.ws, zap);
  if (r.kill) dropSpoils(r.kill);
}

/** The jammer held on a jet or drone (shared/jammer.ts): with the jammer in hand and the target in the cone from the
 *  eye, the lock builds by the time since the last word (at most a little over the client's send interval: it can't
 *  run ahead), bleeding off for any gap beyond; a new target starts over. At JAM_MS the target goes down, gliding. */
function onJam(p: Player, m: Extract<ClientMsg, { t: 'jam' }>) {
  const now = performance.now();
  const nums = [m.x, m.y, m.z, m.dx, m.dy, m.dz];
  if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v)) || !Number.isInteger(m.id) || (m.kind !== 'jet' && m.kind !== 'drone')) return;
  const kind = p.slot < 0 ? undefined : items.slots(p.browserId, 'bag')[p.slot]?.kind;
  const s = p.state, len = Math.hypot(m.dx, m.dy, m.dz);
  if (kind !== JAMMER || p.down || len < 0.5 || Math.hypot(m.x - s.x, m.y - (s.y + EYE_HEIGHT), m.z - s.z) > SHOT_FROM) return;
  const at = m.kind === 'jet' ? jets.where(m.id, now) : guardians.droneAt(m.id);
  if (!at || !inCone(m.x, m.y, m.z, m.dx / len, m.dy / len, m.dz / len, at.x, at.y, at.z, 0.1)) return;
  const j = p.jam && p.jam.kind === m.kind && p.jam.id === m.id ? p.jam : (p.jam = { kind: m.kind, id: m.id, acc: 0, at: now });
  const gap = now - j.at, step = Math.min(gap, JAM_SEND_MS * 1.5);
  j.acc = Math.max(0, j.acc - (gap - step) * JAM_BLEED) + step;
  j.at = now;
  if (j.acc < JAM_MS) return;
  p.jam = null;
  if (m.kind === 'jet') jets.jam(m.id, now);
  else guardians.jamDrone(m.id, now);
}

/** Thrown scrap (shared/throw.ts): a throwable in that hotbar slot, not too soon after the last, from the thrower's
 *  eye and out in the open. It leaves the bag and flies (server/throws.ts), shown to everyone near. */
function onThrow(p: Player, m: Extract<ClientMsg, { t: 'throw' }>) {
  const now = performance.now();
  const nums = [m.x, m.y, m.z, m.dx, m.dy, m.dz];
  if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v)) || !Number.isInteger(m.n)) return;
  if (!Number.isInteger(m.slot) || m.slot < 0 || m.slot >= HOTBAR || p.down) return;
  const s = p.state, len = Math.hypot(m.dx, m.dy, m.dz);
  if (s.riding || len < 0.5 || now - p.firedAt < THROW_MS * 0.8 || inBase(s.x, s.y, s.z)) return;
  if (Math.hypot(m.x - s.x, m.y - (s.y + EYE_HEIGHT), m.z - s.z) > SHOT_FROM) return;
  const kind = items.slots(p.browserId, 'bag')[m.slot]?.kind;
  if (!kind || !THROWABLE.has(kind) || !db.tx(() => items.takeAt(p.browserId, m.slot, kind))) return sendBox(p, 'bag');
  p.firedAt = now;
  sendBox(p, 'bag');
  tossEvents([throws.launch(p.id, p.browserId, m.n, kind, m.x, m.y, m.z, m.dx / len, m.dy / len, m.dz / len, now)]);
}

/** Thrown scrap launched, bouncing or landed: to everyone near it. */
function tossEvents(events: TossEvent[]) {
  for (const e of events) {
    const json = JSON.stringify(e.msg);
    for (const o of players.values()) if (Math.hypot(o.state.x - e.x, o.state.z - e.z) < BOT_SEND_R && o.ws.readyState === o.ws.OPEN) o.ws.send(json);
  }
}

/** Fly the thrown scrap on; what lands lies there (or, over the base, goes back to the thrower). */
function tickThrows(dt: number, now: number) {
  const r = throws.tick(dt, now);
  tossEvents(r.events);
  for (const l of r.landed) {
    if (l.ok) loot.dropAt(l.x, l.z, l.kind, 0.1);
    else if (items.give(l.owner, l.kind)) {
      const p = [...players.values()].find((o) => o.browserId === l.owner);
      if (p) sendBox(p, 'bag');
    }
  }
}

/** Chat lines no closer together than this (ms). */
const CHAT_GAP_MS = 400;
/** A chat line: one line of printable text, at most CHAT_MAX long, to everyone. */
function onChat(p: Player, text: unknown) {
  if (typeof text !== 'string') return;
  const now = performance.now();
  if (now - p.chatAt < CHAT_GAP_MS) return;
  const clean = text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, CHAT_MAX);
  if (!clean) return;
  p.chatAt = now;
  const json = JSON.stringify({ t: 'chat', id: p.id, color: p.color, text: clean } satisfies ServerMsg);
  for (const o of players.values()) if (o.ws.readyState === o.ws.OPEN) o.ws.send(json);
}

/** What a killed walker or downed drone leaves on the sand (shared/tables.ts KILL_SPOILS). */
function dropSpoils(k: Kill) {
  const sp = KILL_SPOILS[k.kind === GUARDIAN ? 'guardian' : k.kind === 'drone' ? 'drone' : 'crawler'];
  const n = Math.random() < sp.odds ? sp.min + Math.floor(Math.random() * (sp.max - sp.min + 1)) : 0;
  for (let i = 0; i < n; i++) {
    const part = sp.parts[Math.floor(Math.random() * sp.parts.length)];
    loot.dropAt(k.x, k.z, partKind(part, pickTier(sp.tierWeights, Math.random)));
  }
}

function onPickup(p: Player, ix: unknown, iz: unknown, i: unknown) {
  const kind = scrap.pickup(p.state, ix, iz, i, p.lastPickup, (k) => items.give(p.browserId, scrapItem(k)));
  if (kind !== null) return sendBox(p, 'bag', scrapItem(kind));
  // Refused: the client already hid the piece. If it is still there, tell this client to show it again.
  if (typeof ix === 'number' && typeof iz === 'number' && typeof i === 'number' && !scrapTaken.has(scrapKey(ix, iz, i))) {
    send(p.ws, { t: 'scrap', taken: [], back: [ix, iz, i] });
  }
}

function boxMsg(browserId: string, box: string, got?: string): ServerMsg {
  return { t: 'items', box, slots: items.slots(browserId, box), ...(got !== undefined ? { got } : {}) };
}

/** A box changed: shared ones go to everyone, a player's own to each of their connections. */
function sendBox(p: Player, box: string, got?: string) {
  const json = JSON.stringify(boxMsg(p.browserId, box, got));
  for (const o of players.values()) {
    if ((isShared(box) || o.browserId === p.browserId) && o.ws.readyState === o.ws.OPEN) o.ws.send(json);
  }
}

// Moves and sorts: the client already applied its guess, so it always gets the boxes back.
function onMove(p: Player, from: unknown, fi: unknown, to: unknown, ti: unknown, n: unknown, r: unknown) {
  const changed = !p.down && items.move(p.browserId, p.state, from, fi, to, ti, n, r);
  for (const box of new Set([from, to])) {
    if (typeof box !== 'string' || !boxSize(box)) continue;
    if (changed) sendBox(p, box);
    else send(p.ws, boxMsg(p.browserId, box));
  }
  if (changed) gearChanged(p.browserId);
  if (changed) corpses.check(from);
}

function onFit(p: Player, from: unknown, fi: unknown, slot: unknown) {
  const changed = !p.down && items.fit(p.browserId, p.state, from, fi, slot);
  for (const box of new Set(['bench', 'bag', from])) {
    if (typeof box !== 'string' || !boxSize(box)) continue;
    if (changed) sendBox(p, box);
    else send(p.ws, boxMsg(p.browserId, box));
  }
  if (changed) gearChanged(p.browserId);
  if (changed) corpses.check(from);
}

function onUnfit(p: Player, slot: unknown, to: unknown, ti: unknown) {
  const changed = !p.down && items.unfit(p.browserId, p.state, slot, to, ti);
  for (const box of new Set(['bench', to])) {
    if (typeof box !== 'string' || !boxSize(box)) continue;
    if (changed) sendBox(p, box);
    else send(p.ws, boxMsg(p.browserId, box));
  }
  if (changed) gearChanged(p.browserId);
}

function onLootTake(p: Player, id: unknown) {
  const kind = loot.take(p.state, p.browserId, id, (l) => items.giveItem(p.browserId, l));
  if (kind === 'full') send(p.ws, { t: 'notice', text: 'Bag full' });
  else if (kind === 'had') send(p.ws, { t: 'notice', text: 'Already had one' });
  else if (kind) {
    sendBox(p, 'bag', kind);
    gearChanged(p.browserId);
  }
}

// Drop an item on the sand (shared/loot.ts canDropAt: not in the base).
function onDrop(p: Player, box: unknown, slot: unknown) {
  if (typeof box !== 'string' || !boxSize(box)) return;
  const s = p.state;
  const inside = !canDropAt(s.x, s.z);
  const item = inside || p.down ? null : db.tx(() => {
    const it = items.drop(p.browserId, s, box, slot);
    if (it) loot.drop(s, it);
    return it;
  });
  if (!item) {
    if (inside) send(p.ws, { t: 'notice', text: "Can't drop here" });
    return send(p.ws, boxMsg(p.browserId, box));
  }
  sendBox(p, box);
  gearChanged(p.browserId);
  corpses.check(box);
}

// Debug menu: one of each piece of gear (the guns too), repaired with Scrap parts, into the bag (what fits) and the
// equipment slots (if free), and a jammer.
function onDebugGear(p: Player) {
  for (const kind of GEAR_KINDS) {
    const parts = scrapParts(kind);
    if (!items.equip(p.browserId, { kind, parts })) items.giveItem(p.browserId, { kind, parts });
  }
  if (!items.slots(p.browserId, 'bag').some((it) => it?.kind === JAMMER)) items.giveItem(p.browserId, { kind: JAMMER });
  for (const box of ['bag', 'equip']) sendBox(p, box);
  gearChanged(p.browserId);
}

function onSort(p: Player, box: unknown) {
  if (!p.down && items.sort(p.browserId, p.state, box)) sendBox(p, box as string);
  else if (typeof box === 'string' && boxSize(box)) send(p.ws, boxMsg(p.browserId, box));
}

// Crash sites (shared/crash.ts): carry a small machine home (it becomes an item in the bag), put it on the
// disassembly table (the item is used up), and the shared sessions of large sites and the table.
function onCrash(p: Player, msg: ClientMsg) {
  if (msg.t === 'crashTake') {
    const kind = crash.carry(p.state, msg.id, p.lastPickup, (k) => items.give(p.browserId, k));
    if (kind) {
      sendBox(p, 'bag', kind);
      gearChanged(p.browserId);
    }
    else if (typeof msg.id === 'string' && !crashTaken.has(msg.id)) send(p.ws, { t: 'crash', taken: [], back: [msg.id] });
  } else if (msg.t === 'crashUse') {
    crash.use(p.state, msg.kind, () => items.take(p.browserId, msg.kind));
    sendBox(p, 'bag');
    send(p.ws, crash.benchMessage()); // refused (the table was taken): what is on it
    gearChanged(p.browserId);
  } else if (msg.t === 'siteJoin') {
    const state = crash.join(p.id, p.state, msg.id);
    if (state) send(p.ws, state);
  } else if (msg.t === 'siteLeave') crash.leave(p.id, msg.id);
  else if (msg.t === 'siteHold') crash.hold(p.id, msg.id, msg.i, msg.players, msg.on);
  else if (msg.t === 'siteDone') crash.done(p.id, msg.id, msg.i);
  else if (msg.t === 'siteTake') {
    const answer = crash.takePart(p.id, msg.id, msg.i, (kind) => items.give(p.browserId, kind));
    if (answer) send(p.ws, answer);
    if (answer?.t === 'siteTook' && answer.ok) sendBox(p, 'bag', answer.kind);
  }
}

function onTend(p: Player, bed: unknown) {
  const what = garden.tend(p.state, bed, p.lastTend);
  if (what) send(p.ws, { t: 'tended', what });
}

// Placing things from the bag on the bunker floor and picking them up (server/placed.ts), crafting at the
// workbench (shared/crafting.ts). Refusals get a notice (and the bag back, in case the client guessed).
function onPlace(p: Player, slot: unknown, x: unknown, z: unknown, rot: unknown) {
  const r = placedThings.place(p.browserId, p.state, slot, x, z, rot, [...players.values()].map((o) => o.state));
  if (typeof r === 'string') send(p.ws, { t: 'notice', text: r });
  sendBox(p, 'bag');
}

function onUnplace(p: Player, id: unknown) {
  const r = placedThings.unplace(p.browserId, p.state, id);
  if (typeof r === 'string') return send(p.ws, { t: 'notice', text: r });
  if (r.kind === 'plant_bed') garden.remove(r.id);
  sendBox(p, 'bag', r.kind);
}

function onCraft(p: Player, recipe: unknown) {
  const r = items.craft(p.browserId, p.state, recipe);
  if (typeof r === 'string') {
    send(p.ws, { t: 'notice', text: r });
    send(p.ws, boxMsg(p.browserId, 'bag'));
  } else sendBox(p, 'bag', r.made);
}

function onInput(p: Player, seq: unknown, input: unknown, yaw: unknown, pitch: unknown) {
  if (typeof seq !== 'number' || typeof input !== 'number' || seq <= p.ack) return;
  if (!Number.isInteger(yaw) || (yaw as number) < 0 || (yaw as number) >= YAW_STEPS) return;
  if (!Number.isInteger(pitch) || (pitch as number) < 0 || (pitch as number) >= PITCH_STEPS) return;
  p.ack = seq;
  p.lastInputAt = Date.now();
  if (p.down) return; // lying dead: acknowledged, not simulated
  // Over the rate limit: acknowledge but don't simulate, so the client gets corrected.
  if (p.tokens < 1) return;
  p.tokens -= 1;
  p.yaw = yaw as number;
  p.pitch = pitch as number;
  p.input = input & INPUT_MASK;
  const drag = stormDrag(storms.storms, p.state.x, p.state.y, p.state.z, performance.now());
  p.state = step(p.state, input & INPUT_MASK, p.yaw, drag);
  dig(p, input);
}

// Dig/pile stroke while the button is held, at most every tool.cooldown simulated ticks: bare hands, or a
// repaired shovel in the selected hotbar slot (shared/gear.ts digTool). The client runs the same countdown and
// stroke as a prediction (src/net.ts). No digging from the bike. A dig can uncover a buried cache (server/loot.ts).
function dig(p: Player, input: number) {
  if (p.digCooldown > 0) p.digCooldown--;
  if (!(input & (DIG | PILE)) || p.digCooldown > 0 || p.state.riding) return;
  const pile = (input & DIG) === 0;
  const tool = digTool(p.slot >= 0 ? items.slots(p.browserId, 'bag')[p.slot] : null);
  const at = terrain.stroke(p.state, p.yaw, p.pitch, pile, tool);
  if (!at) return;
  p.digCooldown = tool.cooldown;
  if (!pile) loot.dug(at.x, at.z, tool.radius);
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
    if (p.down) {
      if (Date.now() >= p.down.until) respawn(p);
      continue;
    }
    heat(p, elapsed, tod, now);
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
  tickBots(elapsed, now, tod);
  tickThrows(elapsed, now);
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
  const weather = storms.tick(time, [...players.values()].map((p) => p.state), sunElevation(timeOfDayAt(time + epoch)) < 0);
  const flights = jets.tick(time, [...players.values()].map((p) => p.state));
  for (const msg of [terrain.flush(), scrap.flush(), crash.flush(), crash.flushSpent(), placedThings.flush(), garden.flush(), loot.flush(), weather, flights]) {
    if (!msg) continue;
    const json = JSON.stringify(msg);
    for (const p of players.values()) if (p.ws.readyState === p.ws.OPEN) p.ws.send(json);
  }
  const list: PlayerSnap[] = [...players.values()].map((p) => {
    const item = p.slot >= 0 ? items.slots(p.browserId, 'bag')[p.slot]?.kind : undefined;
    const gear = wornGear(items.slots(p.browserId, 'equip'));
    return {
      id: p.id, color: p.color, pitch: p.pitch, ...round(p.state), ...(p.hands ? { hands: p.hands } : {}), ...(p.aim ? { aim: 1 as const } : {}),
      ...(item ? { item } : {}), ...(gear ? { gear } : {}), ...(p.down ? { down: p.down.push } : {}),
    };
  });
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
  // Lying dead: they come back at the base.
  const at = p.down ? BUNKER_SPAWN : p.state;
  db.savePlayer({ id: p.browserId, color: p.color, x: at.x, z: at.z, heat: p.heat.heat, sips: p.heat.sips });
}

setInterval(() => {
  players.forEach(save);
  terrain.heal();
  terrain.save();
  scrap.respawn();
  loot.respawn();
  corpses.expire();
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
