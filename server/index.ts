// Authoritative game server: serves the built client, accepts WebSocket connections on /ws,
// simulates every player with shared/sim.ts and broadcasts snapshots.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import sirv from 'sirv';
import { WebSocketServer, type WebSocket } from 'ws';
import { DIG, DT, INPUT_MASK, PILE, spawnState, step, TICK_RATE, YAW_STEPS, type PlayerState } from '../shared/sim.ts';
import { PITCH_STEPS, quantizePitch } from '../shared/dig.ts';
import { bikeLevel, bottleSips, digTool, GEAR, GEAR_KINDS, wornGear } from '../shared/gear.ts';
import { scrapKey, scrapTaken } from '../shared/scrap.ts';
import { HOTBAR, partKind, SCRAP_ITEMS } from '../shared/items.ts';
import { TIERS } from '../shared/salvage.ts';
import { boxSize, CHESTS, isShared, OWN_BOXES } from '../shared/storage.ts';
import { crashTaken } from '../shared/crash.ts';
import { overBase } from '../shared/base.ts';
import { crashSitesNear } from '../shared/crashsites.ts';
import type { ClientMsg, Hands, PlayerSnap, ServerMsg } from '../shared/protocol.ts';
import { openDb } from './db.ts';
import { GardenServer } from './garden.ts';
import { PlacedServer } from './placed.ts';
import { ItemServer } from './items.ts';
import { LootServer } from './loot.ts';
import { canDropAt } from '../shared/loot.ts';
import { ScrapServer } from './scrap.ts';
import { StormServer } from './storm.ts';
import { CrashServer } from './crash.ts';
import { TerrainServer } from './terrain.ts';
import { drink, fill, newHeat, revive, setBottle, tickHeat, waterMsg, type Heat } from './water.ts';
import { BASE_SPAWN } from '../shared/base.ts';
import { stormAt, stormDrag } from '../shared/storm.ts';
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

const storms = new StormServer(performance.now());

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
    if (msg.t === 'drink' && p) return onDrink(p);
    if (msg.t === 'fill' && p) return onFill(p);
    if (msg.t === 'move' && p) return onMove(p, msg.from, msg.fi, msg.to, msg.ti, msg.n, msg.r);
    if (msg.t === 'sort' && p) return onSort(p, msg.box);
    if (msg.t === 'fit' && p) return onFit(p, msg.from, msg.fi, msg.slot);
    if (msg.t === 'unfit' && p) return onUnfit(p, msg.slot, msg.to, msg.ti);
    if (msg.t === 'lootTake' && p) return onLootTake(p, msg.id);
    if (msg.t === 'drop' && p) return onDrop(p, msg.box, msg.slot);
    if (msg.t === 'debugGear' && p) return onDebugGear(p);
    if (msg.t === 'hands' && p) {
      p.hands = msg.hands === 1 || msg.hands === 2 ? msg.hands : 0;
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
  // Heights aren't saved: someone who left over the bunker (or in it) starts at its door instead.
  const atBase = spawn === 'base';
  let state = row && !atBase && !overBase(row.x, row.z, 0.5) ? spawnState(row.x, row.z) : spawnState();
  if (spawn === 'crash') {
    // Dev helper: 7 m from the large machine of the nearest crash site, on its far side from the wreck.
    const m = crashSitesNear(state.x, state.z, 3000)[0]?.machines[0];
    if (m) state = spawnState(m.x + m.dx * 7, m.z + m.dz * 7);
  }
  items.setup(browserId);
  state.bike = bikeLevel(items.slots(browserId, 'equip'));
  const p: Player = {
    id: nextId++, browserId, color, state, yaw: 0, pitch: quantizePitch(0), digCooldown: 0, ack: 0,
    tokens: MAX_INPUT_BURST, lastInputAt: Date.now(), idleAccum: 0, lastPickup: { at: 0 }, lastTend: { at: 0 }, input: 0,
    heat: newHeat(row?.heat, row?.sips, bottleSips(items.slots(browserId, 'bag'))), ws, alive: true, hands: 0, slot: -1,
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
  send(ws, loot.joinMessage());
  send(ws, { t: 'welcome', id: p.id, state, color, epoch });
  for (const box of [...OWN_BOXES, ...CHESTS.map((_, i) => `chest${i}`)]) send(ws, boxMsg(browserId, box));
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
    p.state = spawnState(BASE_SPAWN.x, BASE_SPAWN.z);
    revive(p.heat, now);
    save(p);
    send(p.ws, { t: 'died', cause: 'heat' });
    send(p.ws, waterMsg(p.heat));
  } else if (r === 'send') {
    send(p.ws, waterMsg(p.heat));
  }
}

function onPickup(p: Player, ix: unknown, iz: unknown, i: unknown) {
  const kind = scrap.pickup(p.state, ix, iz, i, p.lastPickup, (k) => items.give(p.browserId, SCRAP_ITEMS[k]));
  if (kind !== null) return sendBox(p, 'bag', SCRAP_ITEMS[kind]);
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
  const changed = items.move(p.browserId, p.state, from, fi, to, ti, n, r);
  for (const box of new Set([from, to])) {
    if (typeof box !== 'string' || !boxSize(box)) continue;
    if (changed) sendBox(p, box);
    else send(p.ws, boxMsg(p.browserId, box));
  }
  if (changed) gearChanged(p.browserId);
}

function onFit(p: Player, from: unknown, fi: unknown, slot: unknown) {
  const changed = items.fit(p.browserId, p.state, from, fi, slot);
  for (const box of new Set(['bench', 'bag', from])) {
    if (typeof box !== 'string' || !boxSize(box)) continue;
    if (changed) sendBox(p, box);
    else send(p.ws, boxMsg(p.browserId, box));
  }
  if (changed) gearChanged(p.browserId);
}

function onUnfit(p: Player, slot: unknown, to: unknown, ti: unknown) {
  const changed = items.unfit(p.browserId, p.state, slot, to, ti);
  for (const box of new Set(['bench', to])) {
    if (typeof box !== 'string' || !boxSize(box)) continue;
    if (changed) sendBox(p, box);
    else send(p.ws, boxMsg(p.browserId, box));
  }
  if (changed) gearChanged(p.browserId);
}

function onLootTake(p: Player, id: unknown) {
  const kind = loot.take(p.state, id, (l) => items.giveItem(p.browserId, l));
  if (kind === 'full') send(p.ws, { t: 'notice', text: 'Bag full' });
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
  const item = inside ? null : db.tx(() => {
    const it = items.drop(p.browserId, s, box, slot);
    if (it) loot.drop(s, it);
    return it;
  });
  if (!item) {
    if (inside) send(p.ws, { t: 'notice', text: "Can't drop things in the base: use the chest" });
    return send(p.ws, boxMsg(p.browserId, box));
  }
  sendBox(p, box);
  gearChanged(p.browserId);
}

// Debug menu: one of each piece of gear, repaired with Scrap parts, into the bag (what fits) and the
// equipment slots (if free).
function onDebugGear(p: Player) {
  for (const kind of GEAR_KINDS) {
    const parts = GEAR[kind].slots.map((s) => ('part' in s ? partKind(s.part, TIERS[0]) : s.scrap[0]));
    if (!items.equip(p.browserId, { kind, parts })) items.giveItem(p.browserId, { kind, parts });
  }
  for (const box of ['bag', 'equip']) sendBox(p, box);
  gearChanged(p.browserId);
}

function onSort(p: Player, box: unknown) {
  if (items.sort(p.browserId, p.state, box)) sendBox(p, box as string);
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
  const weather = storms.tick(time, [...players.values()].map((p) => p.state));
  for (const msg of [terrain.flush(), scrap.flush(), crash.flush(), crash.flushSpent(), placedThings.flush(), garden.flush(), loot.flush(), weather]) {
    if (!msg) continue;
    const json = JSON.stringify(msg);
    for (const p of players.values()) if (p.ws.readyState === p.ws.OPEN) p.ws.send(json);
  }
  const list: PlayerSnap[] = [...players.values()].map((p) => {
    const item = p.slot >= 0 ? items.slots(p.browserId, 'bag')[p.slot]?.kind : undefined;
    const gear = wornGear(items.slots(p.browserId, 'equip'));
    return {
      id: p.id, color: p.color, pitch: p.pitch, ...round(p.state), ...(p.hands ? { hands: p.hands } : {}),
      ...(item ? { item } : {}), ...(gear ? { gear } : {}),
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
  db.savePlayer({ id: p.browserId, color: p.color, x: p.state.x, z: p.state.z, heat: p.heat.heat, sips: p.heat.sips });
}

setInterval(() => {
  players.forEach(save);
  terrain.heal();
  terrain.save();
  scrap.respawn();
  loot.respawn();
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
