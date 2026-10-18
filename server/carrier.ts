// The hive carrier's brain (shared/carrier.ts, shared/bosses.ts, server/bosses.ts). It drifts from one far point to
// the next across the desert at CRUISE, CARRIER_ALT over the highest sand under it, its downwash scouring a bowl
// every SCOUR_STEP m. Anyone out in the open within SEE_R it can see from its belly (lineOfSight) it turns after
// (CHASE: still slower than a run) and, once they're within BOMB_REACH, bombs every few seconds: each bomb falls from
// the bay aimed at where they'll be when it lands (a little lead: running straight on at a walk still gets out from under it), and bursts there at the time bombFall gives
// (the view draws the same fall from the 'bomb' bossFx). Shooting it makes it come for the shooter from further off.
//
// Each broken fan hub (a weak point) slows it, sinks it SINK_PER_FAN lower and lists it toward the dead fan. All four
// broken: it falls (die), drifting on and tumbling, and the wreck cratering the sand where it lands (wreck).
import type { Boss, BossOut, BossPlayer, Brain } from './bosses.ts';
import { BOSS_SEND_R } from '../shared/bosses.ts';
import {
  BAY, BOMB_CRATER_MM, BOMB_CRATER_R, BOMB_GAP, BOMB_KILL_R, BOMB_REACH, bombFall, CARRIER_ALT, CHASE, CRASH_FAN_MM, CRASH_FAN_R,
  CRASH_KILL_R, CRASH_MM, CRASH_R, CRUISE, CS_LEN, CS_LOCK, CS_OX, CS_OY, CS_OZ, CS_FALL, CS_PITCH, CS_ROLL, CS_SPIN, CS_TX, CS_TZ, CS_VX,
  CS_VZ, FALL_G, FANS, fanAt, HULL, SCOUR_MM, SCOUR_R, SCOUR_STEP, SEE_R, SINK_PER_FAN, TURN_RATE,
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

type Track = { x: number; z: number; vx: number; vz: number };
type Bomb = { at: number; x: number; y: number; z: number };
type St = {
  vx: number; vz: number; yawRate: number; roll: number; pitch: number;
  wx: number; wz: number; ax: number; az: number;
  scourX: number; scourZ: number;
  target: number; tx: number; tz: number; nextBomb: number;
  tracks: Map<number, Track>; bombs: Bomb[];
  leaveAt: number;
  /** Dead: where it lands, when, and the fall (see CS_*). */
  crashAt: number; crashed: boolean; ox: number; oy: number; oz: number; fall: number; spin: number;
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
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
      tracks: new Map(), bombs: [], leaveAt: -1,
      crashAt: -1, crashed: false, ox: 0, oy: 0, oz: 0, fall: 0, spin: 1,
    };
    b.st = st;
  },

  tick(b, dt, now, players, out) {
    const st = b.st as St;
    resolve(b, now, players, out);
    const broken = brokenCount(b);
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

    // Bombs away.
    if (target && now >= st.nextBomb && Math.hypot(target.x - bay.x, target.z - bay.z) < BOMB_REACH) {
      st.nextBomb = now + rand(BOMB_GAP[0], BOMB_GAP[1]) * 1000;
      const tr = st.tracks.get(target.id);
      // Fall time to the sand round them, then the aim point that far ahead, then the exact fall to there.
      let t = bombFall(bay.y, heightAt(target.x, target.z));
      const sa = Math.random() * Math.PI * 2, sd = Math.random() * SCATTER;
      const ax = target.x + (tr ? tr.vx : 0) * t * LEAD + Math.cos(sa) * sd;
      const az = target.z + (tr ? tr.vz : 0) * t * LEAD + Math.sin(sa) * sd;
      const ay = heightAt(ax, az);
      t = bombFall(bay.y, ay);
      const vx = (ax - bay.x) / t, vz = (az - bay.z) / t;
      st.bombs.push({ at: now + t * 1000, x: ax, y: ay, z: az });
      out.events.push({ msg: { t: 'bossFx', id: b.id, e: 'bomb', time: Math.round(now), x: r3(bay.x), y: r3(bay.y), z: r3(bay.z), a: [r3(vx), r3(vz), r3(t)] }, x: b.x, z: b.z });
    }

    if (!b.leaving) return false;
    if (st.bombs.length) return false;
    const far = players.every((p) => Math.hypot(p.x - b.x, p.z - b.z) > BOSS_SEND_R + 100);
    return far || now - st.leaveAt > LEAVE_MAX;
  },

  near(b, x, y, z) {
    return Math.hypot(x - b.x, z - b.z) < 62 && Math.abs(y - b.y) < 25;
  },

  snap(b) {
    const st = b.st as St;
    const s = new Array<number>(CS_LEN).fill(0);
    s[CS_ROLL] = r3(st.roll);
    s[CS_PITCH] = r3(st.pitch);
    s[CS_VX] = r3(st.vx);
    s[CS_VZ] = r3(st.vz);
    s[CS_TX] = Math.round(st.tx * 10) / 10;
    s[CS_TZ] = Math.round(st.tz * 10) / 10;
    s[CS_LOCK] = st.target >= 0 ? 1 : 0;
    s[CS_OX] = r3(st.ox);
    s[CS_OY] = r3(st.oy);
    s[CS_OZ] = r3(st.oz);
    s[CS_FALL] = r3(st.fall);
    s[CS_SPIN] = st.spin;
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
    // The snapshot's position is where it lands; the view adds the fall offset back on (see CS_OX).
    b.x = lx;
    b.y = ly;
    b.z = lz;
  },

  wreck(b, _dt, now, players, out) {
    resolve(b, now, players, out);
  },
};
