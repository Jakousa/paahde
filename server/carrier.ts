// The hive carrier's brain (shared/carrier.ts, shared/bosses.ts, server/bosses.ts). It drifts from one far point to
// the next across the desert at CRUISE, CARRIER_ALT over the highest sand under it, its downwash scouring a bowl
// every SCOUR_STEP m. Anyone out in the open within SEE_R it can see from its belly (lineOfSight) it turns after
// (CHASE: still slower than a run) and, once they're within BOMB_REACH, bombs every few seconds: each bomb falls from
// the bay aimed at where they'll be when it lands (a little lead: running straight on at a walk still gets out from under it), and bursts there at the time bombFall gives
// (the view draws the same fall from the 'bomb' bossFx). Shooting it makes it come for the shooter from further off.
//
// Each broken fan hub (a weak point) slows it, sinks it SINK_PER_FAN lower and lists it toward the dead fan. All four
// broken: it falls (die), drifting on and tumbling, and the wreck cratering the sand where it lands (wreck).
//
// Gun drones (shared/carrier.ts DRONE_*) drop out of the bay while anyone is about: each picks the person fewest of
// them are on, circles them low, and every few seconds hovers, aims ('daim': the spot where they stand) and after
// DRONE_CHARGE fires there ('dshot'): still standing there, they're dead. Spent (DRONE_SHOTS, DRONE_LIFE) or with
// nobody left, it flies home into the bay. The carrier dying drops them all.
//
// A crowd (server/bossCrowd.ts) makes it harder: bombs come more often, a run bombs several people at once (and lays a
// second bomb where its target stands, for those who stop), and more drones are out, launched sooner.
import type { Boss, BossOut, BossPlayer, Brain } from './bosses.ts';
import { BOSS_SEND_R } from '../shared/bosses.ts';
import { crowd, scaled } from './bossCrowd.ts';
import {
  BAY, bayAt, BOMB_CRATER_MM, BOMB_CRATER_R, BOMB_GAP, BOMB_KILL_R, BOMB_REACH, bombFall, CARRIER_ALT, CHASE, CRASH_FAN_MM, CRASH_FAN_R,
  CRASH_KILL_R, CRASH_MM, CRASH_R, CRUISE, CS_ALL, CS_LEN, CS_LOCK, CS_OX, CS_OY, CS_OZ, CS_FALL, CS_PITCH, CS_ROLL, CS_SPIN, CS_TX, CS_TZ,
  CS_VX, CS_VZ, DRONE_CHARGE, DRONE_HIT_R, DRONE_LIFE, DRONE_SHOTS, DRONE_SLOTS, DS_LEN, DS_ON, DS_X, DS_Y, DS_Z, FALL_G, FANS, fanAt,
  HULL, SCOUR_MM, SCOUR_R, SCOUR_STEP, SEE_R, SINK_PER_FAN, TURN_RATE,
} from '../shared/carrier.ts';
import { lineOfSight } from '../shared/guardians.ts';
import { blastPush } from '../shared/ragdoll.ts';
import { heightAt } from '../shared/terrain.ts';

/** Wander legs end this far (m) from the nearest player (or where it was put): it stays in their sky. */
const WANDER: [number, number] = [250, 650];
/** An angry carrier comes for its shooter from this far off (m). */
const ANGRY_R = 700;
/** Scours only with someone within this distance (m) to see it (each one is sent to everyone). */
const SCOUR_SEEN_R = 1500;
/** Leaving: climbs to this height over the sand and speeds up to LEAVE_SPEED (m/s); gone past BOSS_SEND_R from
 *  everyone, or after LEAVE_MAX ms whatever. */
const LEAVE_ALT = 130;
const LEAVE_SPEED = 9;
const LEAVE_MAX = 6 * 60_000;
/** Bomb aim: the player's velocity times the fall time times this (leads a little, not all the way), plus scatter (m). */
const LEAD = 0.6;
const SCATTER = 2.5;
/** A player track's velocity is smoothed over this (s). */
const TRACK_TAU = 0.6;
/** Crowd: the bomb gap is divided by scaled(1, n, BOMB_GAP_PER); a run bombs 1 + floor((n − 1) / BOMB_MARK_PER)
 *  people; from STICK_N people a second bomb lands where the target stands (no lead). */
const BOMB_GAP_PER = 0.15;
const BOMB_MARK_PER = 2;
const STICK_N = 5;

/** Drones: out at once (scaled by the crowd), a launch every DRONE_GAP s (divided by the crowd's scale), the first
 *  DRONE_FIRST s after someone's about; they go for people within DRONE_SEEK_R m of the carrier. */
const DRONE_CAP = 2;
const DRONE_CAP_PER = 0.5;
const DRONE_GAP: [number, number] = [9, 14];
const DRONE_GAP_PER = 0.3;
const DRONE_FIRST = 6;
const DRONE_SEEK_R = 260;
/** Drone flight: top speeds (m/s) hunting and going home, acceleration (m/s²), circling radius (m) and height over
 *  the sand (m), the reach it aims from (m), and the wait between shots (s). */
const DRONE_SPEED = 15;
const DRONE_HOME_SPEED = 20;
const DRONE_ACC = 16;
const DRONE_ORBIT = 20;
const DRONE_HEIGHT = 9;
const DRONE_REACH = 50;
const DRONE_RELOAD: [number, number] = [3.5, 5.5];
/** An emptied slot stays empty this long (ms), so the view sees one drone go before the next takes its slot. */
const SLOT_REST = 1500;

type Track = { x: number; z: number; vx: number; vz: number };
type Bomb = { at: number; x: number; y: number; z: number };
/** A gun drone: its slot in the snapshot, its motion, who it's after (-1 none), what it's doing (dropping 'out' of
 *  the bay, 'hunt'ing, 'aim'ing, going 'home') and till when, born, shots fired, where it circles, where it aims. */
type Drone = {
  slot: number; x: number; y: number; z: number; vx: number; vy: number; vz: number;
  target: number; phase: 'out' | 'hunt' | 'aim' | 'home'; until: number; born: number; shots: number;
  orbit: number; turn: number; lx: number; ly: number; lz: number;
};
type St = {
  vx: number; vz: number; yawRate: number; roll: number; pitch: number;
  wx: number; wz: number; ax: number; az: number;
  scourX: number; scourZ: number;
  target: number; tx: number; tz: number; nextBomb: number;
  tracks: Map<number, Track>; bombs: Bomb[];
  leaveAt: number;
  /** People up against it this tick (server/bossCrowd.ts). */
  crowd: number;
  /** Gun drones out, the next launch, and per snapshot slot when it's free again (-1: taken). */
  drones: Drone[]; nextLaunch: number; slotFree: number[];
  /** Dead: where it lands, when, and the fall (see CS_*). */
  crashAt: number; crashed: boolean; ox: number; oy: number; oz: number; fall: number; spin: number;
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r1 = (v: number) => Math.round(v * 10) / 10;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** The highest sand under the hull (centre, the fans) at (x, z) turned yaw. */
function groundUnder(x: number, z: number, yaw: number) {
  let g = heightAt(x, z);
  for (let i = 0; i < FANS.length; i++) {
    const f = fanAt(i, x, 0, z, yaw);
    g = Math.max(g, heightAt(f.x, f.z));
  }
  return g;
}

function brokenCount(b: Boss) {
  let n = 0;
  for (let i = 0; i < FANS.length; i++) if (b.broken & (1 << i)) n++;
  return n;
}

function pickWander(b: Boss, st: St, players: BossPlayer[]) {
  let cx = st.ax, cz = st.az, best = Infinity;
  for (const p of players) {
    const d = Math.hypot(p.x - b.x, p.z - b.z);
    if (d < best) (best = d), (cx = p.x), (cz = p.z);
  }
  // A point round them, on the far side from where it is now more often than not: long legs across their sky.
  const away = Math.atan2(cx - b.x, cz - b.z);
  const a = away + rand(-1.2, 1.2), d = rand(WANDER[0], WANDER[1]);
  st.wx = cx + Math.sin(a) * d;
  st.wz = cz + Math.cos(a) * d;
}

/** Bombs landing, and the wreck hitting the sand (also ticked once dead, see server/bosses.ts `wreck`). */
function resolve(b: Boss, now: number, players: BossPlayer[], out: BossOut) {
  const st = b.st as St;
  st.bombs = st.bombs.filter((m) => {
    if (now < m.at) return true;
    out.craters.push({ x: m.x, z: m.z, r: BOMB_CRATER_R, mm: BOMB_CRATER_MM });
    for (const p of players) {
      if (p.safe || Math.hypot(p.x - m.x, p.y - m.y, p.z - m.z) > BOMB_KILL_R) continue;
      out.kills.push({ id: p.id, cause: 'bomb', push: blastPush(m.x, m.y, m.z, p.x, p.y, p.z, BOMB_KILL_R) });
    }
    return false;
  });
  if (st.crashAt < 0 || st.crashed || now < st.crashAt) return;
  st.crashed = true;
  out.craters.push({ x: b.x, z: b.z, r: CRASH_R, mm: CRASH_MM });
  for (let i = 0; i < FANS.length; i++) {
    const f = fanAt(i, b.x, b.y, b.z, b.yaw);
    out.craters.push({ x: f.x, z: f.z, r: CRASH_FAN_R, mm: CRASH_FAN_MM });
  }
  for (const p of players) {
    if (p.safe || Math.hypot(p.x - b.x, p.z - b.z) > CRASH_KILL_R || p.y > b.y + HULL[1] * 3) continue;
    out.kills.push({ id: p.id, cause: 'bomb', push: blastPush(b.x, b.y, b.z, p.x, p.y, p.z, CRASH_KILL_R) });
  }
}

/** A bomb out of the bay at `bay` onto player p, aimed `lead` × their velocity × the fall time ahead of them. */
function dropBomb(b: Boss, st: St, bay: { x: number; y: number; z: number }, p: BossPlayer, lead: number, now: number, out: BossOut) {
  const tr = st.tracks.get(p.id);
  // Fall time to the sand round them, then the aim point that far ahead, then the exact fall to there.
  let t = bombFall(bay.y, heightAt(p.x, p.z));
  const sa = Math.random() * Math.PI * 2, sd = Math.random() * SCATTER;
  const ax = p.x + (tr ? tr.vx : 0) * t * lead + Math.cos(sa) * sd;
  const az = p.z + (tr ? tr.vz : 0) * t * lead + Math.sin(sa) * sd;
  const ay = heightAt(ax, az);
  t = bombFall(bay.y, ay);
  const vx = (ax - bay.x) / t, vz = (az - bay.z) / t;
  st.bombs.push({ at: now + t * 1000, x: ax, y: ay, z: az });
  out.events.push({ msg: { t: 'bossFx', id: b.id, e: 'bomb', time: Math.round(now), x: r3(bay.x), y: r3(bay.y), z: r3(bay.z), a: [r3(vx), r3(vz), r3(t)] }, x: b.x, z: b.z });
}

/** Who drone d should go for: someone about the carrier, the fewest other drones on them first, then the nearest. */
function pickPrey(b: Boss, st: St, d: Drone, players: BossPlayer[]): BossPlayer | null {
  let best: BossPlayer | null = null, score = Infinity;
  for (const p of players) {
    if (p.safe || Math.hypot(p.x - b.x, p.z - b.z) > DRONE_SEEK_R) continue;
    let on = 0;
    for (const o of st.drones) if (o !== d && o.target === p.id) on++;
    const sc = on * 1000 + Math.hypot(p.x - d.x, p.z - d.z);
    if (sc < score) (score = sc), (best = p);
  }
  return best;
}

/** Launch, fly, aim and fire the gun drones; take the spent ones home. */
function tickDrones(b: Boss, st: St, dt: number, now: number, players: BossPlayer[], out: BossOut) {
  const n = st.crowd;
  const bay = bayAt(b.x, b.y, b.z, b.yaw);
  const about = !b.leaving && players.some((p) => !p.safe && Math.hypot(p.x - b.x, p.z - b.z) < DRONE_SEEK_R);
  const cap = Math.min(DRONE_SLOTS, Math.round(scaled(DRONE_CAP, n, DRONE_CAP_PER)));
  if (!about) st.nextLaunch = Math.max(st.nextLaunch, now + DRONE_FIRST * 1000);
  else if (now >= st.nextLaunch && st.drones.length < cap) {
    const slot = st.slotFree.findIndex((t) => t >= 0 && now >= t);
    if (slot >= 0) {
      st.slotFree[slot] = -1;
      st.drones.push({
        slot, x: bay.x, y: bay.y, z: bay.z, vx: st.vx, vy: -4, vz: st.vz, target: -1, phase: 'out', until: now + 1500, born: now, shots: 0,
        orbit: Math.random() * Math.PI * 2, turn: Math.random() < 0.5 ? -1 : 1, lx: 0, ly: 0, lz: 0,
      });
      st.nextLaunch = now + (rand(DRONE_GAP[0], DRONE_GAP[1]) * 1000) / scaled(1, n, DRONE_GAP_PER);
    }
  }

  st.drones = st.drones.filter((d) => {
    let prey = d.target >= 0 ? players.find((p) => p.id === d.target) ?? null : null;
    if (prey && (prey.safe || Math.hypot(prey.x - b.x, prey.z - b.z) > DRONE_SEEK_R * 1.4)) prey = null;
    if (d.phase === 'out' && now >= d.until) d.phase = 'hunt';
    if (d.phase === 'hunt') {
      if (b.leaving || d.shots >= DRONE_SHOTS || now - d.born > DRONE_LIFE * 1000) d.phase = 'home';
      else if (!prey) {
        prey = pickPrey(b, st, d, players);
        d.target = prey ? prey.id : -1;
        if (!prey) d.phase = 'home';
        else d.until = Math.max(d.until, now + rand(1.5, 3) * 1000);
      }
    }
    if (d.phase === 'aim' && now >= d.until) {
      // Fire at the spot it aimed at: anyone still there (and in its sight) is dead.
      if (lineOfSight(d.x, d.y, d.z, d.lx, d.ly, d.lz)) {
        for (const p of players) {
          if (p.safe || Math.hypot(p.x - d.lx, p.y + 1 - d.ly, p.z - d.lz) > DRONE_HIT_R) continue;
          out.kills.push({ id: p.id, cause: 'laser', push: blastPush(d.x, d.y, d.z, p.x, p.y, p.z, Math.hypot(p.x - d.x, p.y - d.y, p.z - d.z) * 2) });
        }
      }
      out.events.push({ msg: { t: 'bossFx', id: b.id, e: 'dshot', time: Math.round(now), x: r3(d.lx), y: r3(d.ly), z: r3(d.lz), a: [d.slot, r3(d.x), r3(d.y), r3(d.z)] }, x: d.x, z: d.z });
      d.shots++;
      d.phase = d.shots >= DRONE_SHOTS ? 'home' : 'hunt';
      d.until = now + rand(DRONE_RELOAD[0], DRONE_RELOAD[1]) * 1000;
    }

    // Where to, how fast.
    let gx = d.x, gy = d.y, gz = d.z, top = DRONE_SPEED;
    if (d.phase === 'out') (gx = bay.x + st.vx), (gy = bay.y - 14), (gz = bay.z + st.vz);
    else if (d.phase === 'home') (gx = bay.x), (gy = bay.y), (gz = bay.z), (top = DRONE_HOME_SPEED);
    else if (d.phase === 'hunt' && prey) {
      d.orbit += d.turn * 0.45 * dt;
      const r = DRONE_ORBIT + 6 * Math.sin(now / 1700 + d.slot);
      gx = prey.x + Math.sin(d.orbit) * r;
      gz = prey.z + Math.cos(d.orbit) * r;
      gy = Math.max(heightAt(gx, gz), prey.y) + DRONE_HEIGHT + 2 * Math.sin(now / 900 + d.slot * 2);
      // Reloaded, close enough and in sight: stop and aim at where they stand.
      if (now >= d.until && Math.hypot(prey.x - d.x, prey.y - d.y, prey.z - d.z) < DRONE_REACH && lineOfSight(d.x, d.y, d.z, prey.x, prey.y + 1, prey.z)) {
        d.phase = 'aim';
        d.until = now + DRONE_CHARGE * 1000;
        d.lx = prey.x;
        d.ly = prey.y + 1;
        d.lz = prey.z;
        out.events.push({ msg: { t: 'bossFx', id: b.id, e: 'daim', time: Math.round(now), x: r3(d.lx), y: r3(d.ly), z: r3(d.lz), a: [d.slot, DRONE_CHARGE] }, x: d.x, z: d.z });
      }
    }
    if (d.phase === 'aim') top = 0;
    const dx = gx - d.x, dy = gy - d.y, dz = gz - d.z, dl = Math.hypot(dx, dy, dz);
    if (d.phase === 'home' && dl < 4) {
      st.slotFree[d.slot] = now + SLOT_REST;
      return false;
    }
    // Steer: the velocity it wants (slowing near the goal; keeping up with the carrier going out and home), reached
    // at most DRONE_ACC.
    const sp = Math.min(top, dl * 0.8) / Math.max(1e-3, dl);
    const with_ = d.phase === 'out' || d.phase === 'home' ? 1 : 0;
    let ax = dx * sp + st.vx * with_ - d.vx, ay = dy * sp - d.vy, az = dz * sp + st.vz * with_ - d.vz;
    const al = Math.hypot(ax, ay, az), amax = DRONE_ACC * dt;
    if (al > amax) (ax *= amax / al), (ay *= amax / al), (az *= amax / al);
    d.vx += ax;
    d.vy += ay;
    d.vz += az;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.z += d.vz * dt;
    // Never into the sand.
    const floor = heightAt(d.x, d.z) + 2.5;
    if (d.y < floor) (d.y = floor), (d.vy = Math.max(0, d.vy));
    return true;
  });
}

export const carrier: Brain = {
  spawn(b, x, z, summoned, now) {
    // Comes in from off to one side, already heading past the player.
    const a = Math.random() * Math.PI * 2, d = summoned ? 260 : 1300;
    b.x = x + Math.sin(a) * d;
    b.z = z + Math.cos(a) * d;
    b.yaw = Math.atan2(x - b.x, z - b.z) + rand(-0.3, 0.3);
    b.y = groundUnder(b.x, b.z, b.yaw) + CARRIER_ALT;
    const st: St = {
      vx: Math.sin(b.yaw) * CRUISE, vz: Math.cos(b.yaw) * CRUISE, yawRate: 0, roll: 0, pitch: 0,
      wx: x + Math.sin(a + Math.PI) * 300, wz: z + Math.cos(a + Math.PI) * 300, ax: x, az: z,
      scourX: b.x, scourZ: b.z, target: -1, tx: 0, tz: 0, nextBomb: now + 4000,
      tracks: new Map(), bombs: [], leaveAt: -1, crowd: 1,
      drones: [], nextLaunch: now + DRONE_FIRST * 1000, slotFree: new Array<number>(DRONE_SLOTS).fill(0),
      crashAt: -1, crashed: false, ox: 0, oy: 0, oz: 0, fall: 0, spin: 1,
    };
    b.st = st;
  },

  tick(b, dt, now, players, out) {
    const st = b.st as St;
    resolve(b, now, players, out);
    const broken = brokenCount(b);
    const n = (st.crowd = crowd(b, players));
    // Who's about: tracks for the lead, the target.
    for (const p of players) {
      const t = st.tracks.get(p.id);
      if (!t) st.tracks.set(p.id, { x: p.x, z: p.z, vx: 0, vz: 0 });
      else {
        const k = 1 - Math.exp(-dt / TRACK_TAU);
        const vx = (p.x - t.x) / dt, vz = (p.z - t.z) / dt;
        // A respawn or a teleport isn't a velocity.
        if (Math.hypot(vx, vz) < 40) (t.vx += (vx - t.vx) * k), (t.vz += (vz - t.vz) * k);
        t.x = p.x;
        t.z = p.z;
      }
    }
    for (const id of st.tracks.keys()) if (!players.some((p) => p.id === id)) st.tracks.delete(id);
    const bay = { x: b.x, y: b.y + BAY[1], z: b.z };
    let target: BossPlayer | null = null;
    if (!b.leaving) {
      let best = Infinity;
      for (const p of players) {
        if (p.safe) continue;
        const d = Math.hypot(p.x - b.x, p.z - b.z);
        const reach = p.id === b.angry && now < b.angryUntil ? ANGRY_R : SEE_R;
        if (d > reach || d >= best) continue;
        if (!lineOfSight(bay.x, bay.y, bay.z, p.x, p.y + 1.6, p.z)) continue;
        best = d;
        target = p;
      }
    }
    st.target = target ? target.id : -1;
    if (target) (st.tx = target.x), (st.tz = target.z);

    // Where to: over the target, else the wander point (a new one once there), else (leaving) away and up.
    if (b.leaving && st.leaveAt < 0) {
      st.leaveAt = now;
      let cx = 0, cz = 0;
      for (const p of players) (cx += p.x / players.length), (cz += p.z / players.length);
      const a = players.length ? Math.atan2(b.x - cx, b.z - cz) : b.yaw;
      st.wx = b.x + Math.sin(a) * 10_000;
      st.wz = b.z + Math.cos(a) * 10_000;
    }
    let gx = st.wx, gz = st.wz;
    if (target) {
      // Comes on over them (a little short: the bay is behind its middle).
      gx = target.x;
      gz = target.z;
    } else if (!b.leaving && Math.hypot(st.wx - b.x, st.wz - b.z) < 40) pickWander(b, st, players);
    const want = Math.atan2(gx - b.x, gz - b.z);
    const lame = 1 - 0.13 * broken;
    const turn = Math.max(-TURN_RATE, Math.min(TURN_RATE, wrap(want - b.yaw) * 0.35)) * lame;
    st.yawRate += (turn - st.yawRate) * (1 - Math.exp(-dt / 2.5));
    b.yaw = wrap(b.yaw + st.yawRate * dt);
    const dist = Math.hypot(gx - b.x, gz - b.z);
    let speed = (b.leaving ? LEAVE_SPEED : target ? CHASE : CRUISE) * lame;
    // Over its target it slows to a hover rather than overshooting (still turns to follow).
    if (target) speed *= Math.min(1, Math.max(0.15, dist / 40));
    // Thrust along its heading; the velocity follows slowly (it's heavy).
    const k = 1 - Math.exp(-dt / 4);
    st.vx += (Math.sin(b.yaw) * speed - st.vx) * k;
    st.vz += (Math.cos(b.yaw) * speed - st.vz) * k;
    b.x += st.vx * dt;
    b.z += st.vz * dt;
    // Height: over the highest sand under it, lower per dead fan, bobbing gently; climbing away when leaving.
    const alt = (b.leaving ? LEAVE_ALT : CARRIER_ALT + Math.sin(now / 9000) * 5) - broken * SINK_PER_FAN;
    const wantY = groundUnder(b.x, b.z, b.yaw) + alt;
    const dy = wantY - b.y;
    b.y += Math.sign(dy) * Math.min(Math.abs(dy), (dy > 0 ? 3 : 1.5) * dt);
    // Lean: nose down with speed, banked into its turn, listing toward the dead fans.
    let roll = -st.yawRate * 2.2, pitch = Math.hypot(st.vx, st.vz) * 0.012;
    for (let i = 0; i < FANS.length; i++) {
      if (!(b.broken & (1 << i))) continue;
      roll -= Math.sign(FANS[i][0]) * 0.07;
      pitch += Math.sign(FANS[i][2]) * 0.05;
    }
    const kl = 1 - Math.exp(-dt / 1.5);
    st.roll += (roll - st.roll) * kl;
    st.pitch += (pitch - st.pitch) * kl;

    // The downwash scours the sand under it.
    if (Math.hypot(b.x - st.scourX, b.z - st.scourZ) >= SCOUR_STEP) {
      st.scourX = b.x;
      st.scourZ = b.z;
      if (players.some((p) => Math.hypot(p.x - b.x, p.z - b.z) < SCOUR_SEEN_R)) out.craters.push({ x: b.x, z: b.z, r: SCOUR_R, mm: SCOUR_MM });
    }

    // Bombs away: on the target, and in a crowd on others it can see under it too.
    if (target && now >= st.nextBomb && Math.hypot(target.x - bay.x, target.z - bay.z) < BOMB_REACH) {
      st.nextBomb = now + (rand(BOMB_GAP[0], BOMB_GAP[1]) * 1000) / scaled(1, n, BOMB_GAP_PER);
      const marks = [target];
      const more = Math.floor((n - 1) / BOMB_MARK_PER);
      if (more > 0) {
        const t0 = target;
        const others = players
          .filter((p) => p !== t0 && !p.safe && Math.hypot(p.x - bay.x, p.z - bay.z) < BOMB_REACH && lineOfSight(bay.x, bay.y, bay.z, p.x, p.y + 1.6, p.z))
          .sort((p, q) => Math.hypot(p.x - bay.x, p.z - bay.z) - Math.hypot(q.x - bay.x, q.z - bay.z));
        marks.push(...others.slice(0, more));
      }
      for (const p of marks) dropBomb(b, st, bay, p, LEAD, now, out);
      // A second where the target stands: stopping doesn't save them either.
      if (n >= STICK_N) dropBomb(b, st, bay, target, 0, now, out);
    }

    tickDrones(b, st, dt, now, players, out);

    if (!b.leaving) return false;
    if (st.bombs.length || st.drones.length) return false;
    const far = players.every((p) => Math.hypot(p.x - b.x, p.z - b.z) > BOSS_SEND_R + 100);
    return far || now - st.leaveAt > LEAVE_MAX;
  },

  near(b, x, y, z) {
    return Math.hypot(x - b.x, z - b.z) < 62 && Math.abs(y - b.y) < 25;
  },

  snap(b) {
    const st = b.st as St;
    const s = new Array<number>(CS_ALL).fill(0);
    s[CS_ROLL] = r3(st.roll);
    s[CS_PITCH] = r3(st.pitch);
    s[CS_VX] = r3(st.vx);
    s[CS_VZ] = r3(st.vz);
    s[CS_TX] = r1(st.tx);
    s[CS_TZ] = r1(st.tz);
    s[CS_LOCK] = st.target >= 0 ? 1 : 0;
    s[CS_OX] = r3(st.ox);
    s[CS_OY] = r3(st.oy);
    s[CS_OZ] = r3(st.oz);
    s[CS_FALL] = r3(st.fall);
    s[CS_SPIN] = st.spin;
    // Drones: an empty slot sits at the bay (a new one comes out of it as the view interpolates).
    const bay = bayAt(b.x, b.y, b.z, b.yaw);
    for (let i = 0; i < DRONE_SLOTS; i++) {
      const o = CS_LEN + i * DS_LEN;
      s[o + DS_X] = r1(bay.x);
      s[o + DS_Y] = r1(bay.y);
      s[o + DS_Z] = r1(bay.z);
    }
    for (const d of st.drones) {
      const o = CS_LEN + d.slot * DS_LEN;
      s[o + DS_ON] = 1;
      s[o + DS_X] = r1(d.x);
      s[o + DS_Y] = r1(d.y);
      s[o + DS_Z] = r1(d.z);
    }
    return s;
  },

  die(b, now) {
    const st = b.st as St;
    // It falls drifting on the way it was going, a little toward its last broken fan's side, and tumbles that way.
    const h = Math.max(5, b.y - heightAt(b.x, b.z));
    const t = Math.sqrt((2 * h) / FALL_G);
    const lx = b.x + st.vx * t * 1.2, lz = b.z + st.vz * t * 1.2;
    const ly = heightAt(lx, lz);
    st.spin = st.roll >= 0 ? 1 : -1;
    st.ox = b.x - lx;
    st.oy = b.y - ly;
    st.oz = b.z - lz;
    st.fall = t;
    st.crashAt = now + t * 1000;
    st.target = -1;
    // Its drones drop with it (the view throws them down where they were).
    st.drones = [];
    // The snapshot's position is where it lands; the view adds the fall offset back on (see CS_OX).
    b.x = lx;
    b.y = ly;
    b.z = lz;
  },

  wreck(b, _dt, now, players, out) {
    resolve(b, now, players, out);
  },
};
