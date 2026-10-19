// Authoritative game server for one world (WORLD_ID, shared/world.ts): forked by server/index.ts, which hands
// it the world's WebSocket connections over a local port. Simulates every player with shared/sim.ts and
// broadcasts snapshots; exits when nobody has been on for a while (server/index.ts starts it again).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { DT, INPUT_MASK, spawnState, step, TICK_RATE, YAW_STEPS, type PlayerState } from '../shared/sim.ts';
import { PITCH_STEPS, quantizePitch } from '../shared/dig.ts';
import { bikeLevel, bottleSips, carriedGear, equipped, gearTiers, GEAR_KINDS, shieldGraceMs, tierOf, gunCooldown, jamMs, quality, repaired, scrapParts, wornGear } from '../shared/gear.ts';
import { scrapKey, scrapTaken } from '../shared/scrap.ts';
import { HOTBAR, partKind, SCRAP, scrapItem } from '../shared/items.ts';
import { pickTier } from '../shared/parts.ts';
import { BOSS_SPOILS, JET_RELIC_ODDS, JET_SCRAP, KILL_SPOILS, RECEIVER_DROPS, RELIC_DROPS } from '../shared/tables.ts';
import { allBeaten, BOSS_KINDS, BOSS_LIVES, BOSS_SEND_R, BOSSES, bossBit, RECEIVERS, receiverBoss, RELICS, type BossKind } from '../shared/bosses.ts';
import { boxSize, CHESTS, isShared, OWN_BOXES } from '../shared/storage.ts';
import { crashTaken } from '../shared/crash.ts';
import { BASE, overBase } from '../shared/base.ts';
import { indoors, overShelter, shelterAt, sheltersNear } from '../shared/shelters.ts';
import { crashSitesNear } from '../shared/crashsites.ts';
import { BLAST_R, CRATER_MM, CRATER_R, GUARDIAN } from '../shared/guardians.ts';
import { BLAST_R as MISSILE_BLAST_R } from '../shared/missiles.ts';
import { GUNS, PISTOL } from '../shared/rifle.ts';
import { inCone, JAM_BLEED, JAM_MS, JAM_SEND_MS, JAMMER } from '../shared/jammer.ts';
import { THROW_MS, THROWABLE } from '../shared/throw.ts';
import { EYE_HEIGHT } from '../shared/dig.ts';
import type { ClientMsg, DeathCause, Hands, NetSummary, PlayerSnap, ServerMsg, StallEvent } from '../shared/protocol.ts';
import { CHAT_MAX, NAME_MAX, OBITUARY_KEEP, type Obituary } from '../shared/protocol.ts';
import { openDb } from './db.ts';
import { trace } from './telemetry.ts';
import { GardenServer } from './garden.ts';
import { PlacedServer } from './placed.ts';
import { ItemServer } from './items.ts';
import { LootServer } from './loot.ts';
import { CorpseServer } from './corpses.ts';
import { canDropAt } from '../shared/loot.ts';
import { ScrapServer } from './scrap.ts';
import { StormServer } from './storm.ts';
import { JetServer } from './jets.ts';
import { JetCrashes } from './jetcrash.ts';
import { BREAK_S, breakup, type Breakup } from '../shared/jetbreak.ts';
import { jetImpact, type Jet } from '../shared/jets.ts';
import { jetCrashList } from '../shared/jetcrash.ts';
import { BossServer, type BossKill, type BossOut } from './bosses.ts';
import { GuardianServer, SEND_R as BOT_SEND_R, TICK_HZ as BOT_HZ, type Kill } from './guardians.ts';
import { CrashServer } from './crash.ts';
import { LAB, LAB_SPAWN } from '../shared/lab.ts';
import { ThrowServer, type TossEvent } from './throws.ts';
import { TerrainServer } from './terrain.ts';
import { bite, drink, fill, newHeat, revive, setBottle, tickHeat, waterMsg, type Heat } from './water.ts';
import { HEAT_MAX } from '../shared/water.ts';
import { TIERS } from '../shared/salvage.ts';
import type { Caster } from '../shared/shade.ts';
import { heightAt } from '../shared/terrain.ts';
import { BUNKER_SPAWN } from '../shared/base.ts';
import { blastPush, DOWN_MS } from '../shared/ragdoll.ts';
import { stormAt, stormDrag } from '../shared/storm.ts';
import { sunElevation, timeOfDayAt } from '../shared/sun.ts';
import { setTrophies } from '../shared/trophies.ts';
import { LIVES, WORLD_ID } from '../shared/world.ts';
import { TEXT } from '../shared/text.ts';

/** Nobody on for this long: the world saves and exits until someone comes back. */
const EMPTY_EXIT_MS = 10 * 60_000;
const SNAPSHOT_RATE = 20; // Hz; clients interpolate remote players between snapshots
const RELAX_RATE = 30; // Hz; sand avalanche passes (shared/dig.ts Relaxer)
const SAVE_INTERVAL_MS = 5000;
const IDLE_MS = 1000; // no input for this long (e.g. hidden tab) → server keeps simulating with no keys
/** Inputs a client may bank: a network stall delivers its delayed inputs in one burst, and any past this
 *  are acked unsimulated (the client snaps back). One second, like IDLE_MS; the long-run rate stays TICK_RATE. */
const MAX_INPUT_BURST = TICK_RATE;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const db = openDb(process.env.DB_PATH ?? `data/worlds/${WORLD_ID}.db`);
/** Deaths left in this world, shared by everyone; at 0 the game is over. */
let lives = db.getSetting('lives') ?? LIVES;
/** Boss kinds killed at least once (shared/bosses.ts bossBit); each first kill gave BOSS_LIVES lives. */
let beaten = db.getSetting('bosses_beaten') ?? 0;
setTrophies(beaten);
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
const jetCrashes = new JetCrashes(db);
const bosses = new BossServer();
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
  slot: number; // selected hotbar slot (-1 none)
  aim: boolean; // gun raised to aim (cosmetic, relayed in snapshots)
  /** Dead and lying where they fell until `until` (Date.now ms), thrown by `push` (shared/ragdoll.ts). */
  down: { until: number; push: [number, number, number] } | null;
  shieldUntil: number; // Date.now() ms: their shield plate just broke, nothing hurts them till then (shielded)
  firedAt: number; // last laser rifle shot or throw (performance.now() ms)
  chatAt: number; // last chat line (performance.now() ms)
  traceAt: number; // last 'telemetry' taken (performance.now() ms)
  backlogAt: number; // last traced their sends piling up (performance.now() ms)
  name: string; // shown in chat ('' none; db.getName null until asked)
  /** Loaded the game and chose a name ('ready', src/name.ts): until then unseen by others, unhurtable and out of the heat. */
  ready: boolean;
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

// Only server/index.ts connects here: it passes the players' WebSocket upgrades through.
const http = createServer((_req, res) => {
  res.statusCode = 404;
  res.end();
});
const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 1024 });

wss.on('connection', (ws) => {
  // Invalid frames (including maxPayload violations) emit an error as ws closes the connection.
  // Keep that connection's protocol error from becoming an uncaught error in the whole world.
  ws.on('error', () => {});
  send(ws, { t: 'version', build: BUILD });
  send(ws, { t: 'lives', n: lives, beaten });
  if (lives <= 0) return ws.close(4410, 'game over');
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
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') {
      return ws.close(1003, 'bad message');
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
    if (msg.t === 'summon' && BOSS_KINDS.includes(msg.what as BossKind) && p) return bosses.summon(msg.what, { id: p.id, x: p.state.x, y: p.state.y, z: p.state.z, safe: false }, performance.now());
    if (msg.t === 'summon' && p) return guardians.summon(msg.what, { id: p.id, x: p.state.x, y: p.state.y, z: p.state.z, safe: false }, performance.now());
    if (msg.t === 'fire' && p) return onFire(p, msg);
    if (msg.t === 'jam' && p) return onJam(p, msg);
    if (msg.t === 'call' && p) return onCall(p);
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
    if (msg.t === 'debugGear' && p) return onDebugGear(p, msg.tier);
    if (msg.t === 'debugHit' && p) return die(p, 'laser', [0, 3, 6]);
    if (msg.t === 'debugWeather' && p) {
      storms.off = msg.off === true;
      return;
    }
    if (msg.t === 'debugHeat' && p) {
      p.heat.off = msg.off === true;
      if (p.heat.off) p.heat.heat = 0;
      send(p.ws, waterMsg(p.heat));
      return;
    }
    if (msg.t === 'chat' && p) return onChat(p, msg.text);
    if (msg.t === 'name' && p) return onName(p, msg.name);
    if (msg.t === 'ready' && p) return onReady(p);
    if (msg.t === 'telemetry' && p) return onTelemetry(p, msg.ev, msg.sum);
    if (msg.t === 'hands' && p) {
      p.hands = msg.hands === 1 || msg.hands === 2 || msg.hands === 3 ? msg.hands : 0;
      p.aim = msg.aim === true;
      const slot = Number.isInteger(msg.slot) && (msg.slot as number) >= 0 && (msg.slot as number) < HOTBAR ? (msg.slot as number) : -1;
      if (slot !== p.slot) {
        p.slot = slot;
        gearChanged(p.browserId); // a motorcycle in hand rides too
      }
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
  // Someone who left in a shelter starts outside its door.
  const left = row && !atBase && overShelter(row.x, row.z, 0.5) ? shelterAt(row.x, row.z) : null;
  if (left) state = spawnState(left.x + left.dx * 4, left.z + left.dz * 4);
  // The dev test lab (shared/lab.ts): new players appear in the open room, not down in the bunker.
  if (LAB && (!row || atBase || overBase(row.x, row.z, 0.5))) state = spawnState(LAB_SPAWN.x, LAB_SPAWN.z);
  if (spawn === 'shelter') {
    // Dev helper: 6 m outside the door of the nearest shelter.
    const s = sheltersNear(state.x, state.z, 6000).sort((a, b) => Math.hypot(a.x - state.x, a.z - state.z) - Math.hypot(b.x - state.x, b.z - state.z))[0];
    if (s) state = spawnState(s.x + s.dx * 6, s.z + s.dz * 6);
  }
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
    id: nextId++, browserId, color, state, yaw: 0, pitch: quantizePitch(0), ack: 0,
    tokens: MAX_INPUT_BURST, lastInputAt: Date.now(), idleAccum: 0, lastPickup: { at: 0 }, lastTend: { at: 0 }, input: 0,
    heat: newHeat(row?.heat, row?.sips, bottleSips(items.slots(browserId, 'bag'))), ws, alive: true, hands: 0, slot: -1, aim: false, down: null, shieldUntil: 0, firedAt: 0, chatAt: 0, traceAt: -Infinity, backlogAt: -Infinity, name: '', ready: false, jam: null,
  };
  players.set(ws, p);
  save(p);
  if (LAB) {
    // No heat in the lab; and a first visit brings the full kit: every gear kind repaired, the grinder.
    p.heat.off = true;
    if (!db.hasGrant(browserId, 'lab_kit')) {
      db.markGrant(browserId, 'lab_kit');
      onDebugGear(p, 0);
    }
  }
  const name = db.getName(browserId);
  p.name = name ?? '';
  // Terrain first, so the client never sees its spawn without the holes.
  for (const m of terrain.joinMessages(state.x, state.z)) send(ws, m);
  send(ws, scrap.joinMessage());
  send(ws, crash.joinMessage());
  send(ws, crash.progressMessage());
  send(ws, crash.benchMessage());
  send(ws, crash.spentMessage());
  send(ws, crash.rollsMessage());
  send(ws, placedThings.joinMessage());
  send(ws, garden.joinMessage());
  send(ws, storms.msg());
  send(ws, jets.msg());
  send(ws, { t: 'jetCrashes', list: jetCrashList(), reset: true });
  send(ws, loot.joinMessage(browserId));
  send(ws, { t: 'welcome', id: p.id, state, color, epoch, name });
  send(ws, { t: 'names', names: [...players.values()].filter((o) => o.ready).map((o) => [o.id, o.name]), reset: true });
  send(ws, { t: 'obituaries', list: db.lastObituaries(OBITUARY_KEEP) });
  recall(p);
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

/** A player's items (or selected hotbar slot) changed: the motorcycle they can ride (equipped, or the one in hand) and
 *  their water bottle follow, on every connection. */
function gearChanged(browserId: string) {
  const bag = items.slots(browserId, 'bag');
  const sips = bottleSips(bag);
  for (const o of players.values()) {
    if (o.browserId !== browserId) continue;
    const bike = bikeLevel(items.slots(browserId, 'equip'), o.slot >= 0 ? bag[o.slot] : null);
    if (o.state.bike !== bike) o.state = { ...o.state, bike };
    if (setBottle(o.heat, sips)) send(o.ws, waterMsg(o.heat));
  }
}

/** What casts shade on players besides the world (shared/shade.ts): everyone standing (shorter crouched) or riding
 *  (the bike as a low capsule along its heading), and motorcycles lying on the sand. Rebuilt every CASTERS_MS. */
let casters: Caster[] = [];
let castersAt = -Infinity;
const CASTERS_MS = 250;
function shadeCasters(now: number): Caster[] {
  if (now - castersAt < CASTERS_MS) return casters;
  castersAt = now;
  casters = [];
  for (const o of players.values()) {
    const s = o.state;
    if (o.down || !o.ready) continue;
    casters.push({ x: s.x, z: s.z, ax: 1, az: 0, half: 0, r: 0.28, y0: s.y, y1: s.y + (s.crouching ? 1.2 : 1.8), id: o.id });
    if (s.riding) casters.push({ x: s.x, z: s.z, ax: -Math.sin(s.heading), az: -Math.cos(s.heading), half: 0.55, r: 0.35, y0: s.y, y1: s.y + 1, id: o.id });
  }
  for (const l of loot.loot.values()) {
    if (l.kind === 'motorcycle') casters.push({ x: l.x, z: l.z, ax: 1, az: 0, half: 0, r: 0.7, y0: -Infinity, y1: heightAt(l.x, l.z) + 0.6 });
  }
  return casters;
}

// Heat builds up in the sun (server/water.ts); when the meter is full the player dies of heatstroke and respawns
// at the base, recovered.
// The next snapshot carries the new position, which the client snaps to (src/net.ts reconcile).
function heat(p: Player, dt: number, tod: number, serverNow: number) {
  const now = Date.now();
  const storm = stormAt(storms.storms, p.state.x, p.state.z, serverNow);
  const r = tickHeat(p.heat, dt, p.state, p.input, tod, storm, now, { casters: shadeCasters(now), self: p.id });
  if (r === 'died') {
    die(p, 'heat');
  } else if (r === 'send') {
    send(p.ws, waterMsg(p.heat));
  }
}

/** Drop where they stand (off the bike, stopped) for DOWN_MS, as a ragdoll thrown by `push`; then respawn().
 *  `bolt`: the guardian's bolt that did it, which the client lets reach them first. */
function die(p: Player, cause: DeathCause, push: [number, number, number] = [0, 0, 0], bolt?: number) {
  if (p.down || !p.ready || lives <= 0) return;
  if (cause !== 'heat' && shielded(p, push)) return;
  p.down = { until: Date.now() + DOWN_MS, push };
  p.state = { ...p.state, vx: 0, vy: 0, vz: 0, riding: false, mounting: 0, sliding: false, crouching: false };
  revive(p.heat, Date.now());
  send(p.ws, { t: 'died', cause, push, ...(bolt !== undefined ? { bolt } : {}) });
  const obit: Obituary = { t: 'obituary', id: p.id, color: p.color, name: p.name, cause, at: Date.now() };
  db.putObituary(obit);
  for (const o of players.values()) send(o.ws, obit);
  // The bag past the hotbar stays where they fell (shared/corpse.ts).
  const pack = corpses.leave(p.browserId, p.color, p.state.x, p.state.z);
  if (pack) {
    sendBox(p, pack);
    sendBox(p, 'bag');
    gearChanged(p.browserId);
  }
  lives--;
  db.setSetting('lives', lives);
  for (const o of players.values()) send(o.ws, { t: 'lives', n: lives, beaten });
  if (lives <= 0) gameOver();
}

/** A killing blow (not heatstroke) on someone wearing a shield plate: it takes the blow and breaks (shared/gear.ts
 *  SHIELD_BREAKS), and for a moment after nothing else can hurt them (shieldGraceMs). True if they live. */
function shielded(p: Player, push: [number, number, number]): boolean {
  const now = Date.now();
  if (now < p.shieldUntil) return true;
  const plate = equipped(items.slots(p.browserId, 'equip'), 'armor');
  if (!plate) return false;
  const ms = Math.round(shieldGraceMs(quality(plate))), tier = tierOf(plate); // before it breaks
  p.shieldUntil = now + ms;
  items.breakShield(p.browserId);
  sendBox(p, 'equip');
  // A crawler's bites fill the heat meter: the blow is taken, so take them back off.
  p.heat.heat = Math.min(p.heat.heat, HEAT_MAX * 0.6);
  send(p.ws, waterMsg(p.heat));
  const s = p.state;
  const msg: ServerMsg = { t: 'shieldBreak', id: p.id, x: round4(s.x), y: round4(s.y), z: round4(s.z), push, tier, ms };
  for (const o of players.values()) if (Math.hypot(o.state.x - s.x, o.state.z - s.z) < BOT_SEND_R) send(o.ws, msg);
  return true;
}

/** The last life is gone: everyone sees how it ended, then the world closes for good (new joins are turned away). */
function gameOver() {
  console.log(`world ${WORLD_ID}: game over`);
  setTimeout(() => {
    for (const p of players.values()) {
      save(p);
      p.ws.close(4410, 'game over');
    }
  }, DOWN_MS);
}

/** The client saw a guardian's foot come down on it (the feet are client IK). */
function onStomped(p: Player, g: number) {
  const s = p.state;
  if (!p.down && p.ready && guardians.stomp(g, { id: p.id, x: s.x, y: s.y, z: s.z, safe: Date.now() - p.heat.diedAt < BOT_GRACE_MS }, performance.now())) die(p, 'guardian');
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
  const list = [...players.values()].map((p) => ({ id: p.id, x: p.state.x, y: p.state.y, z: p.state.z, safe: !p.ready || !!p.down || wall - p.heat.diedAt < BOT_GRACE_MS }));
  guardians.storms = storms.storms;
  const r = guardians.tick(dt, now, tod, list);
  for (const k of guardians.crashes()) dropSpoils(k);
  // The bolts go out before the deaths they cause, so the client has the bolt to hold the death for (src/net.ts).
  for (const p of players.values()) {
    for (const e of r.events) if (Math.hypot(e.x - p.state.x, e.z - p.state.z) < BOT_SEND_R) send(p.ws, e.msg);
    send(p.ws, guardians.msg(now, p.id, p.state.x, p.state.z));
  }
  for (const p of players.values()) {
    if (r.shot.includes(p.id)) {
      const hit = boltPush(p, r.events, 'boom', BLAST_R);
      die(p, 'laser', hit.push, hit.id);
    } else if (r.blasted.includes(p.id)) die(p, 'missile', boltPush(p, r.events, 'blast', MISSILE_BLAST_R).push);
    else if (r.bitten.has(p.id) && bite(p.heat, r.bitten.get(p.id)!)) die(p, 'crawler');
    else if (r.bitten.has(p.id)) send(p.ws, waterMsg(p.heat));
  }
  for (const e of r.events) if ((e.msg.t === 'boom' && e.msg.ground) || e.msg.t === 'blast') terrain.crater(e.msg.x, e.msg.z, CRATER_R, CRATER_MM);
  const b = bosses.tick(dt, now, list);
  for (const p of players.values()) {
    const k = b.kills.find((o) => o.id === p.id);
    if (k) die(p, k.cause, k.push);
    send(p.ws, bosses.msg(now, p.id, p.state.x, p.state.z));
  }
  bossOut(b);
  if (now - whereSentAt > 1000) {
    whereSentAt = now;
    sendAll(bosses.whereMsg());
  }
}

let whereSentAt = 0;

/** A message to everyone. */
function sendAll(msg: ServerMsg) {
  const json = JSON.stringify(msg);
  for (const o of players.values()) if (o.ws.readyState === o.ws.OPEN) o.ws.send(json);
}

/** Settings key of a called boss: the hits it has taken + 1 while it's about, 0 once it's dead (none called). */
const calledKey = (kind: BossKind) => `called_${kind}`;

/** The receiver in hand (shared/bosses.ts RECEIVERS), repaired: spend its cell and call its boss, some way off. */
function onCall(p: Player) {
  const held = p.slot < 0 ? undefined : items.slots(p.browserId, 'bag')[p.slot];
  const kind = receiverBoss(held?.kind);
  if (p.down || !kind || !repaired(held) || bosses.alive(kind)) return;
  const s = p.state;
  if (!bosses.call(kind, { id: p.id, x: s.x, y: s.y, z: s.z, safe: false }, performance.now())) return;
  items.spendPart(p.browserId, p.slot, 0); // the uranium cell (shared/gear.ts: first slot)
  sendBox(p, 'bag');
  db.setSetting(calledKey(kind), 1);
  console.log(`world ${WORLD_ID}: ${kind} called`);
  sendAll(bosses.whereMsg());
}

/** Bosses called before a restart (the world's process ends when the last player leaves) come back near whoever
 *  joins first, with the hits they had taken. */
function recall(p: Player) {
  const s = p.state;
  for (const kind of BOSS_KINDS) {
    const v = db.getSetting(calledKey(kind)) ?? 0;
    if (v > 0 && !bosses.alive(kind)) bosses.call(kind, { id: p.id, x: s.x, y: s.y, z: s.z, safe: false }, performance.now(), v - 1);
  }
  send(p.ws, bosses.whereMsg());
}

/** The sand marks and one-off effects of the bosses (server/bosses.ts). */
function bossOut(b: BossOut) {
  for (const c of b.craters) terrain.crater(c.x, c.z, c.r, c.mm, false);
  for (const e of b.events) {
    const json = JSON.stringify(e.msg);
    for (const p of players.values()) if (Math.hypot(e.x - p.state.x, e.z - p.state.z) < BOSS_SEND_R && p.ws.readyState === p.ws.OPEN) p.ws.send(json);
  }
}

/** The nearest bolt burst ('boom') or missile blast throws a player it killed; `id` is that bolt's or missile's. */
function boltPush(p: Player, events: { msg: ServerMsg }[], t: 'boom' | 'blast', r: number): { push: [number, number, number]; id?: number } {
  let best: Extract<ServerMsg, { t: 'boom' | 'blast' }> | null = null;
  for (const { msg: m } of events) {
    if (m.t === t && (!best || Math.hypot(m.x - p.state.x, m.z - p.state.z) < Math.hypot(best.x - p.state.x, best.z - p.state.z))) best = m;
  }
  return best ? { push: blastPush(best.x, best.y, best.z, p.state.x, p.state.y, p.state.z, r), id: best.id } : { push: [0, 0, 0] };
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
  if (m.b !== undefined) {
    const out: BossOut = { kills: [], craters: [], events: [] };
    const r = bosses.shoot(by, m.x, m.y, m.z, m.ex, m.ey, m.ez, m.b, m.bi, now, out);
    const zap: ServerMsg = { t: 'zap', by: p.id, x: m.x, y: m.y, z: m.z, ex: m.ex, ey: m.ey, ez: m.ez, hit: r.hit, ...(kind === PISTOL ? { pistol: true as const } : {}) };
    for (const o of players.values()) if (o !== p && Math.hypot(o.state.x - s.x, o.state.z - s.z) < BOT_SEND_R) send(o.ws, zap);
    bossOut(out);
    if (r.boss?.called) db.setSetting(calledKey(r.boss.kind), r.kill ? 0 : BOSSES[r.boss.kind].hp - r.boss.hp + 1);
    if (r.kill) dropBossSpoils(r.kill);
    return;
  }
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
  const held = p.slot < 0 ? undefined : items.slots(p.browserId, 'bag')[p.slot];
  const s = p.state, len = Math.hypot(m.dx, m.dy, m.dz);
  if (held?.kind !== JAMMER || !repaired(held) || p.down || len < 0.5 || Math.hypot(m.x - s.x, m.y - (s.y + EYE_HEIGHT), m.z - s.z) > SHOT_FROM) return;
  // A jet moves fast: the client sees it where it was some ping ago, so any of the last half second will do.
  const seen = (at: { x: number; y: number; z: number } | null) => !!at && inCone(m.x, m.y, m.z, m.dx / len, m.dy / len, m.dz / len, at.x, at.y, at.z, 0.1);
  if (m.kind === 'jet' ? ![0, 150, 300, 500].some((ago) => seen(jets.where(m.id, now, ago))) : !seen(guardians.droneAt(m.id))) return;
  const j = p.jam && p.jam.kind === m.kind && p.jam.id === m.id ? p.jam : (p.jam = { kind: m.kind, id: m.id, acc: 0, at: now });
  const gap = now - j.at, step = Math.min(gap, JAM_SEND_MS * 1.5);
  j.acc = Math.max(0, j.acc - (gap - step) * JAM_BLEED) + step;
  j.at = now;
  if (j.acc < jamMs(JAM_MS, quality(held))) return;
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
  if (s.riding || len < 0.5 || now - p.firedAt < THROW_MS * 0.8 || indoors(s.x, s.y, s.z)) return;
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
  const json = JSON.stringify({ t: 'chat', id: p.id, color: p.color, name: p.name, text: clean, at: Date.now() } satisfies ServerMsg);
  for (const o of players.values()) if (o.ws.readyState === o.ws.OPEN) o.ws.send(json);
}

/** Their name in this world, cleaned like a chat line; blank is fine (asked once, src/name.ts). */
function onName(p: Player, name: unknown) {
  if (typeof name !== 'string') return;
  p.name = name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  db.setName(p.browserId, p.name);
  if (p.ready) sendName(p);
}

/** The client has loaded and chosen a name: from now on others see them and they can die. */
function onReady(p: Player) {
  if (p.ready) return;
  p.ready = true;
  sendName(p);
}

/** p's name to everyone else, for the tag over their head. */
function sendName(p: Player) {
  const json = JSON.stringify({ t: 'names', names: [[p.id, p.name]] } satisfies ServerMsg);
  for (const o of players.values()) if (o !== p && o.ws.readyState === o.ws.OPEN) o.ws.send(json);
}

/** A random boss receiver kind (shared/bosses.ts RECEIVERS). */
const randomReceiver = () => { const r = Object.values(RECEIVERS); return r[Math.floor(Math.random() * r.length)]; };

/** What a killed walker or downed drone leaves on the sand (shared/tables.ts KILL_SPOILS). */
function dropSpoils(k: Kill) {
  const kind = k.kind === GUARDIAN ? 'guardian' : k.kind === 'drone' ? 'drone' : 'crawler';
  const sp = KILL_SPOILS[kind];
  if (Math.random() < RELIC_DROPS[kind].odds) loot.dropAt(k.x, k.z, RELIC_DROPS[kind].kind);
  if (Math.random() < RECEIVER_DROPS[kind]) loot.dropBroken(k.x, k.z, randomReceiver());
  const n = Math.random() < sp.odds ? sp.min + Math.floor(Math.random() * (sp.max - sp.min + 1)) : 0;
  for (let i = 0; i < n; i++) {
    const part = sp.parts[Math.floor(Math.random() * sp.parts.length)];
    loot.dropAt(k.x, k.z, partKind(part, pickTier(sp.tierWeights, Math.random)));
  }
}

/** A jet's nose met the sand (shared/jets.ts): it comes apart (shared/jetbreak.ts: every client flies the same pieces from the same impact), the sand is
 *  dug up where they land when they land, and when they have come to rest the crash site is made (jetCame). */
const jetsBreaking: { due: number; jet: number; bk: Breakup; lx: number; lz: number }[] = [];
const jetCraters: { at: number; x: number; z: number; r: number; mm: number }[] = [];
function jetLanded(j: Jet) {
  const d = j.down!;
  const bk = breakup(jetImpact(j), j.id);
  jetCraters.push({ at: d.land, x: d.lx, z: d.lz, r: 7.5, mm: 2800 });
  for (const e of bk.events) jetCraters.push({ at: d.land + e.t * 1000, x: e.x, z: e.z, r: e.r, mm: e.mm });
  jetsBreaking.push({ due: d.land + BREAK_S * 1000, jet: j.id, bk, lx: d.lx, lz: d.lz });
}

/** The pieces of a jet have come to rest: its crash site is made (shared/jetcrash.ts: they stay, the right engine is a machine to take apart),
 *  its transponder maybe, a broken receiver now and then, and some scrap off the airframe, strewn about where its nose went in. */
function jetCame(b: { jet: number; bk: Breakup; lx: number; lz: number }): ServerMsg {
  const { crash: c, gone } = jetCrashes.add(b.jet, b.bk.final, b.bk.fates);
  const at = (kind: string) => {
    const a = Math.random() * Math.PI * 2, d = 3 + Math.random() * 16;
    loot.dropAt(b.lx + Math.cos(a) * d, b.lz + Math.sin(a) * d, kind);
  };
  if (Math.random() < JET_RELIC_ODDS) at(RELIC_DROPS.drone.kind);
  if (Math.random() < RECEIVER_DROPS.jet) loot.dropBroken(b.lx + 4, b.lz, randomReceiver(), 4);
  const scrapN = JET_SCRAP.min + Math.floor(Math.random() * (JET_SCRAP.max - JET_SCRAP.min + 1));
  for (let i = 0; i < scrapN; i++) at(SCRAP);
  return { t: 'jetCrashes', list: gone.length ? jetCrashList() : [c], reset: gone.length > 0 };
}

/** A boss's parts, scattered over its wreck; its kind's first kill counts toward the win and gives the world lives. */
function dropBossSpoils(k: BossKill) {
  if (!(beaten & bossBit(k.kind))) {
    beaten |= bossBit(k.kind);
    lives += BOSS_LIVES;
    db.setSetting('bosses_beaten', beaten);
    setTrophies(beaten);
    db.setSetting('lives', lives);
    for (const o of players.values()) send(o.ws, { t: 'lives', n: lives, beaten });
    console.log(`world ${WORLD_ID}: ${k.kind} beaten${allBeaten(beaten) ? ', world won' : ''}`);
  }
  const relic = RELICS[k.kind];
  if (relic) loot.dropAt(k.x, k.z, relic);
  const sp = BOSS_SPOILS[k.kind];
  const n = sp.min + Math.floor(Math.random() * (sp.max - sp.min + 1));
  for (let i = 0; i < n; i++) {
    const part = sp.parts[Math.floor(Math.random() * sp.parts.length)], a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * k.r;
    loot.dropAt(k.x + Math.cos(a) * d, k.z + Math.sin(a) * d, partKind(part, pickTier(sp.tierWeights, Math.random)));
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
  if (kind === 'full') send(p.ws, { t: 'notice', text: TEXT.notice.bagFull });
  else if (kind === 'had') send(p.ws, { t: 'notice', text: TEXT.notice.alreadyHad });
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
    if (inside) send(p.ws, { t: 'notice', text: TEXT.notice.cantDropHere });
    return send(p.ws, boxMsg(p.browserId, box));
  }
  sendBox(p, box);
  gearChanged(p.browserId);
  corpses.check(box);
}

// Debug menu: one of each piece of gear (the guns too), repaired with Scrap parts, into the bag (what fits) and the
// equipment slots (if free).
function onDebugGear(p: Player, tier: unknown) {
  const t = TIERS[Number.isInteger(tier) ? (tier as number) : 0] ?? 'scrap';
  for (const kind of GEAR_KINDS) {
    const parts = scrapParts(kind, t);
    if (!items.equip(p.browserId, { kind, parts })) items.giveItem(p.browserId, { kind, parts });
  }
  items.give(p.browserId, 'grinder'); // (the grinder is made, not found: shared/tables.ts RECIPE_TABLE)
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
  } else if (msg.t === 'benchScrap') {
    if (crash.scrapBench(p.state, (n) => items.give(p.browserId, SCRAP, n))) sendBox(p, 'bag');
  } else if (msg.t === 'labReset') {
    crash.labReset(msg.id);
  } else if (msg.t === 'siteJoin') {
    const state = crash.join(p.id, p.state, msg.id);
    if (state) send(p.ws, state);
  } else if (msg.t === 'siteLeave') crash.leave(p.id, msg.id);
  else if (msg.t === 'siteHold') crash.hold(p.id, msg.id, msg.i, msg.players, msg.on);
  else if (msg.t === 'siteDone') crash.done(p.id, msg.id, msg.i, (n, x, z) => payScrap(p, n, x, z));
  else if (msg.t === 'siteTake') {
    const answer = crash.takePart(p.id, msg.id, msg.i, (kind) => items.give(p.browserId, kind), (n, x, z) => payScrap(p, n, x, z));
    if (answer) send(p.ws, answer);
    if (answer?.t === 'siteTook' && answer.ok) sendBox(p, 'bag', answer.kind);
  }
}

/** Scrap for taking a machine apart: into the bag as far as it fits (a stack at a time), the rest left on the ground by the machine. */
function payScrap(p: Player, n: number, x: number, z: number) {
  let got = 0;
  for (let k = 0; k < n; k++) {
    if (!items.give(p.browserId, SCRAP, 1)) break;
    got++;
  }
  const dropped = n - got;
  for (let k = 0; k < dropped; k++) loot.dropAt(x, z, SCRAP, 1.4);
  if (got) sendBox(p, 'bag');
  send(p.ws, { t: 'scrapGot', n, dropped });
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
  p.state = step(p.state, input & INPUT_MASK, p.yaw, drag, guardians.posts);
  crash.push(p.state, input & INPUT_MASK, p.yaw); // crouched and leaning on a machine rolls it
}

// Fixed-rate server loop: refill input tokens, simulate idle players, broadcast snapshots.
let last = performance.now();
let snapAccum = 0;
let relaxAccum = 0;
setInterval(() => {
  const now = performance.now();
  const elapsed = (now - last) / 1000;
  last = now;
  // Something blocked the event loop: every player's snapshots and bots are late by this much.
  if (elapsed > LATE_TICK_S) trace('tick', { ms: Math.round(elapsed * 1000), players: players.size });
  const tod = timeOfDayAt(now + epoch);
  for (const p of players.values()) {
    p.tokens = Math.min(MAX_INPUT_BURST, p.tokens + elapsed * TICK_RATE);
    if (p.down) {
      if (Date.now() >= p.down.until) respawn(p);
      continue;
    }
    if (p.ready && !LAB) heat(p, elapsed, tod, now);
    if (Date.now() - p.lastInputAt > IDLE_MS) {
      p.input = 0;
      for (p.idleAccum += elapsed; p.idleAccum >= DT; p.idleAccum -= DT) {
        p.state = step(p.state, 0, p.yaw, 0, guardians.posts);
      }
    } else {
      p.idleAccum = 0;
    }
  }
  if (!LAB) tickBots(elapsed, now, tod); // (no walkers, drones or bosses in the lab)
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
  // (The lab has no storms and no jets.)
  const weather = LAB ? null : storms.tick(time, [...players.values()].map((p) => p.state), sunElevation(timeOfDayAt(time + epoch)) < 0);
  const flights = LAB ? null : jets.tick(time, [...players.values()].map((p) => p.state));
  const crashed: ServerMsg[] = [];
  if (!LAB) {
    for (const j of jets.landed(time)) jetLanded(j);
    for (let i = jetCraters.length - 1; i >= 0; i--) {
      if (jetCraters[i].at > time) continue;
      const k = jetCraters.splice(i, 1)[0];
      terrain.crater(k.x, k.z, k.r, k.mm, false);
    }
    for (let i = jetsBreaking.length - 1; i >= 0; i--) {
      if (jetsBreaking[i].due <= time) crashed.push(jetCame(jetsBreaking.splice(i, 1)[0]));
    }
  }
  for (const msg of [terrain.flush(), scrap.flush(), crash.flush(), crash.flushSpent(), crash.flushRolls(), placedThings.flush(), garden.flush(), weather, flights, ...crashed]) {
    if (!msg) continue;
    const json = JSON.stringify(msg);
    for (const p of players.values()) if (p.ws.readyState === p.ws.OPEN) p.ws.send(json);
  }
  const lootMsg = loot.flush(); // per player: the home bike is hidden from whoever has had theirs
  if (lootMsg) for (const p of players.values()) send(p.ws, loot.seenBy(lootMsg, p.browserId));
  const all = [...players.values()].map((p) => {
    const item = p.slot >= 0 ? items.slots(p.browserId, 'bag')[p.slot]?.kind : undefined;
    const gear = wornGear(items.slots(p.browserId, 'equip')) | carriedGear(items.slots(p.browserId, 'bag'), p.slot);
    const tiers = gearTiers(items.slots(p.browserId, 'equip'), items.slots(p.browserId, 'bag'), p.slot);
    const snap: PlayerSnap = {
      id: p.id, color: p.color, pitch: p.pitch, ...round(p.state), ...(p.hands ? { hands: p.hands } : {}), ...(p.aim ? { aim: 1 as const } : {}),
      ...(item ? { item } : {}), ...(gear ? { gear } : {}), ...(tiers ? { tiers } : {}), ...(p.down ? { down: p.down.push } : {}),
    };
    return { snap, ready: p.ready };
  });
  // Players still loading are seen only by themselves.
  const seen = all.filter((o) => o.ready).map((o) => o.snap);
  for (const p of players.values()) {
    const list = p.ready ? seen : [...seen, all.find((o) => o.snap.id === p.id)!.snap];
    send(p.ws, { t: 'snap', time, ack: p.ack, players: list });
    // Sends piling up past the kernel's buffer: TCP can't get them out to this player (a stalled or slow link).
    if (p.ws.bufferedAmount > BACKLOG_BYTES && time - p.backlogAt > TRACE_GAP_MS) {
      p.backlogAt = time;
      trace('backlog', { p: p.id, name: p.name, bytes: p.ws.bufferedAmount });
    }
  }
}

/** A tick this late (s) is traced (server/telemetry.ts), and a player's queued sends past this many bytes; a backlog
 *  and a client's own reports at most once per TRACE_GAP_MS per player. */
const LATE_TICK_S = 0.1;
const BACKLOG_BYTES = 64 * 1024;
const TRACE_GAP_MS = 2000;
const STALL_KINDS = new Set(['down', 'up', 'server', 'frame', 'reconnect']);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(Math.max(v, 0), 3_600_000)) : undefined);

/** Stalls a client saw and its minute's summary (src/telemetry.ts), each traced at the time it happened. */
function onTelemetry(p: Player, ev: unknown, sum: unknown) {
  const now = performance.now();
  if (now - p.traceAt < TRACE_GAP_MS || !Array.isArray(ev)) return;
  p.traceAt = now;
  const who = { p: p.id, name: p.name };
  for (const e of ev.slice(0, 16) as Partial<StallEvent>[]) {
    const ms = num(e?.ms), ago = num(e?.ago);
    if (!e || !STALL_KINDS.has(e.k as string) || ms === undefined || ago === undefined) continue;
    trace(e.k as string, { ...who, ms, ...(num(e.n) !== undefined ? { n: num(e.n) } : {}), ...(num(e.code) !== undefined ? { code: num(e.code) } : {}) }, Date.now() - ago);
  }
  if (sum && typeof sum === 'object') {
    const s = sum as Partial<NetSummary>;
    trace('summary', { ...who, rtt50: num(s.rtt50), rtt95: num(s.rtt95), rttMax: num(s.rttMax), gapMax: num(s.gapMax), frameMax: num(s.frameMax), fps: num(s.fps), ...(s.hidden === true ? { hidden: true } : {}) });
  }
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
  for (const p of players.values()) send(p.ws, { t: 'terrainHeal' });
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
  terrain.save(true);
  db.close();
  http.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

let emptySince = Date.now();
setInterval(() => {
  if (players.size > 0) emptySince = Date.now();
  else if (Date.now() - emptySince > EMPTY_EXIT_MS) shutdown();
}, 30_000);

// A free local port, told to server/index.ts over IPC.
http.listen(0, '127.0.0.1', () => {
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  console.log(`world ${WORLD_ID} on :${port}`);
  process.send?.({ t: 'port', port });
});
// server/index.ts went away (dev restart, crash): don't linger.
process.on('disconnect', shutdown);
