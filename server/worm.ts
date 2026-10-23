// The worm's brain (shared/worm.ts, server/bosses.ts): steers its head through the sand, flies it on gravity out of
// it, lays the body along the head's path, and does the harm: the burst out of the sand and the head swallow whoever
// is near, and the plunge back in; both blow craters, and running shallow its back ploughs a furrow. The more people
// about (server/bossCrowd.ts), the faster it hunts, the shorter the warning and the sooner it comes up again.
//
// Every half minute or so, hunting someone, it breaks out of the sand short of them and flies a huge arc high over the
// desert instead (the sky arc), and while its body is up there it fires missiles out of its back: the guardians'
// missiles (shared/missiles.ts, drawn by src/world/missiles.ts), some at whoever is about, some scattered round them.
// A crowd gets more of them and more often.
//
// Against more than one person it doesn't stay on whoever is kiting it: every time it goes back under (after a leap or
// a charge) it picks someone (most likely someone else), and every SWITCH_S or so it drops its prey for another
// anyway. A new prey it stalks: deep and quiet (no wake, no furrow, no arc), straight at them, to come up under them.
import { BASE } from '../shared/base.ts';
import { crowd, scaled } from './bossCrowd.ts';
import { ball, blast, due } from './blasts.ts';
import { BLAST_R, flightTime, LEAD, SCATTER, type MissilePath } from '../shared/missiles.ts';
import { blastPush } from '../shared/ragdoll.ts';
import { heightAt, rockTop, sandOverRock } from '../shared/terrain.ts';
import {
  ACCEL, GRAVITY, HEAD_R, HUNT_SPEED, MODE_AIR, MODE_DIVE, MODE_HUNT, MODE_LUNGE, MODE_RISE, MODE_ROAM, NOTICE_R, RADIUS, RISE_SPEED, RISE_TURN,
  ROAM_SPEED, SEG_LEN, SEGS, segScale, TELL, TURN,
} from '../shared/worm.ts';
import type { Boss, BossOut, BossPlayer, Brain } from './bosses.ts';

/** Depths (m, the head's centre under the sand): roaming, hunting, diving after a leap, leaving, and running with its
 *  back out of the sand (the body's top a little above it). */
const ROAM_DEPTH = 10, HUNT_DEPTH = 15, DIVE_DEPTH = 18, LEAVE_DEPTH = 24;
const SURFACE_DEPTH = RADIUS * 0.55;
/** Roaming: runs at the surface every SURFACE_EVERY s (random within), for SURFACE_FOR s. */
const SURFACE_EVERY: [number, number] = [18, 40];
const SURFACE_FOR: [number, number] = [10, 18];
/** Waypoints (m from where it is); it keeps BASE_KEEP_OUT from the base, and hunts nobody within PREY_BASE of it. */
const LEG: [number, number] = [180, 420];
const BASE_KEEP_OUT = 380, PREY_BASE = 320;
/** Rock: it can't reach anyone standing on rock or sand thinner than ON_ROCK over it; it looks AHEAD m for rock. */
const ON_ROCK = 4;
const AHEAD = 10;
/** Hunting: rises once within RISE_R (m, horizontally) of its prey, at least RISE_MIN_DEPTH down and with all of its
 *  body back under the sand. It holds under the spot for the tell (TELL, creeping at WIND_SPEED), then shoots up
 *  aiming RISE_UP m over the sand and RISE_LEAD m past it; after a leap it dives and keeps off for COOL_S. */
const RISE_R = 13, RISE_MIN_DEPTH = 8, RISE_UP = 50, RISE_LEAD = 3, COOL_S = 6, WIND_SPEED = 4;
/** Hunting half out of the sand (its back up, ploughing a furrow), SHALLOW_P of the hunts: once within LUNGE_R (m) it
 *  charges straight at where they are, LUNGE_SPEED, and runs on through for LUNGE_S s whatever they do (step aside!),
 *  swallowing whoever its head meets and crushing whoever its back runs into. Then it goes deep. */
const SHALLOW_P = 0.45, LUNGE_R = 24, LUNGE_SPEED = 24, LUNGE_S = 2.2, LUNGE_ON = 40;
/** Too close to rise yet (cooling down, body still out, not deep enough): it runs on past them this far before turning back. */
const PASS_R = 40;
/** A crowd: per person past the first, this much faster hunting, shorter tell (down to TELL_MIN s), shorter cool-down. */
const CROWD_SPEED = 0.06, CROWD_TELL = 0.08, TELL_MIN = 0.8, CROWD_COOL = 0.25;
/** It loses prey it hasn't had a fix on for this long (s), or that has got this far from it (m) unless they shot it. */
const LOSE_S = 4, LOSE_R = NOTICE_R * 1.5;
/** Harm: the burst and the plunge kill within BURST_R (m) of where the head breaks the sand; the head out of the sand
 *  swallows within SWALLOW_R of its centre; a body segment out of the sand crushes within its radius + BODY_PAD. */
const BURST_R = 6.5, SWALLOW_R = HEAD_R + 1, BODY_PAD = 1;
/** Craters (radius m, depth mm): the burst, the plunge; the furrow its back ploughs (one every FURROW_STEP m). */
const BURST_CRATER = { r: 7, mm: 2400 }, PLUNGE_CRATER = { r: 5.5, mm: 1800 };
const FURROW_R = 2.6, FURROW_STEP = 5;
/** The trail is kept as points at least TRAIL_STEP m apart. */
const TRAIL_STEP = 0.8;
/** The sky arc: hunting with its prey within ARC_R m, once it's due (whatever the hunt: running shallow it goes deep
 *  first) it comes up (after the tell, at the spot over its head) aiming ARC_FWD m on towards them (right over them
 *  if they're close) and ARC_UP m over the sand, at ARC_SPEED (a far higher, longer leap than the rise). Not
 *  again for ARC_GAP s (shorter for a crowd by CROWD_ARC a person), the first ARC_FIRST s into a fight. While it's up,
 *  every SHOT_S s a missile leaves a segment of its back that's well out of the sand (SHOT_CLEAR m): ARC_SHOTS of
 *  them (+ARC_SHOTS_PER a person, at most ARC_SHOTS_MAX), at people within SHOT_R of its head; every SPRAY-th one at a
 *  spot SPRAY_R m round one of them instead. */
const ARC_R = 170, ARC_FWD = 45, ARC_UP = 95, ARC_SPEED = 62;
const ARC_GAP: [number, number] = [22, 34], CROWD_ARC = 0.15, ARC_FIRST = 8;
const SHOT_S = 0.5, SHOT_CLEAR = 6, ARC_SHOTS = 8, ARC_SHOTS_PER = 2, ARC_SHOTS_MAX = 16, SHOT_R = 320, SPRAY = 3, SPRAY_R: [number, number] = [12, 40];
/** Changing prey (more than one person about): on going back under, someone else OTHER_P of the time... */
const OTHER_P = 0.75;
/** ...and every SWITCH_S s (random within) hunting, whatever; the new prey stalked from STALK_DEPTH (m: no wake). */
const SWITCH_S: [number, number] = [14, 26];
const STALK_DEPTH = 22;
/** Its missiles' ids, clear of the guardians' (server/guardians.ts counts from 1). */
let nextMissile = 1_000_000;
const BODY_LEN = (SEGS + 1) * SEG_LEN;

type Worm = {
  vx: number; vy: number; vz: number;
  mode: number;
  /** The head's past positions, newest last (x, y, z flattened). */
  trail: number[];
  /** Segment positions, absolute (x, y, z flattened), from the last tick. */
  segs: number[];
  tx: number; tz: number;
  /** Server s clock (summed dt) and when the next surface run starts / the current one ends. */
  clock: number; surfaceAt: number; surfaceUntil: number;
  prey: number; fixAt: number; px: number; pz: number;
  /** This hunt: half out of the sand (else deep); charging till lungeUntil. */
  shallow: boolean; lungeUntil: number;
  /** Rising at (ax, ay, az) once the clock reaches riseAt (till then the tell: it holds under the spot); cooling down
   *  (no rising) until coolUntil. */
  ax: number; ay: number; az: number; riseAt: number; coolUntil: number;
  /** Was the head under the sand last tick; where the last furrow crater went. */
  under: boolean; fx: number; fz: number;
  /** The sky arc: this leap is one; the next not before (clock); missiles fired this arc, the next one at (clock);
   *  missiles in the air; everyone's position and velocity (for the lead). */
  arc: boolean; arcReady: number; shots: number; shotAt: number;
  /** Stalking its prey (deep and quiet, to surprise them); when it next drops its prey for someone else (clock). */
  stalk: boolean; switchAt: number;
  missiles: { id: number; at: number; x: number; y: number; z: number }[];
  vel: Map<number, { x: number; z: number; vx: number; vz: number }>;
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const inRock = (x: number, y: number, z: number) => y < rockTop(x, z) + 1.5;

function newWaypoint(b: Boss, w: Worm, players: BossPlayer[], far = false) {
  for (let i = 0; i < 12; i++) {
    const a = Math.random() * Math.PI * 2, d = far ? 900 : rand(LEG[0], LEG[1]);
    const x = b.x + Math.sin(a) * d, z = b.z + Math.cos(a) * d;
    if (Math.hypot(x - BASE.x, z - BASE.z) < BASE_KEEP_OUT + 100) continue;
    if (sandOverRock(x, z) < 12) continue;
    if (far && players.some((p) => Math.hypot(p.x - x, p.z - z) < 600)) continue;
    w.tx = x;
    w.tz = z;
    return;
  }
  w.tx = b.x + (b.x - BASE.x);
  w.tz = b.z + (b.z - BASE.z);
}

/** Turn the head's velocity towards unit (dx, dy, dz) at most `turn` × dt, and its speed towards `speed`. */
function steer(w: Worm, dx: number, dy: number, dz: number, turn: number, speed: number, accel: number, dt: number) {
  let s = Math.hypot(w.vx, w.vy, w.vz);
  let ux = s > 1e-3 ? w.vx / s : dx, uy = s > 1e-3 ? w.vy / s : dy, uz = s > 1e-3 ? w.vz / s : dz;
  const dot = Math.max(-1, Math.min(1, ux * dx + uy * dy + uz * dz)), ang = Math.acos(dot), max = turn * dt;
  if (ang > 1e-4) {
    // Slerp from u towards d by min(1, max / ang).
    const t = Math.min(1, max / ang), so = Math.sin(ang);
    const a = Math.sin((1 - t) * ang) / so, c = Math.sin(t * ang) / so;
    if (so > 1e-4) (ux = ux * a + dx * c), (uy = uy * a + dy * c), (uz = uz * a + dz * c);
    else (ux = dx), (uy = dy), (uz = dz);
    const n = Math.hypot(ux, uy, uz);
    (ux /= n), (uy /= n), (uz /= n);
  }
  s += Math.max(-accel * dt, Math.min(accel * dt, speed - s));
  w.vx = ux * s;
  w.vy = uy * s;
  w.vz = uz * s;
}

/** Steer for (tx, tz) at `depth` under the sand there, turning away from rock ahead. */
function swim(b: Boss, w: Worm, tx: number, tz: number, depth: number, speed: number, dt: number, accel = ACCEL) {
  let hx = tx - b.x, hz = tz - b.z;
  const hl = Math.hypot(hx, hz) || 1;
  (hx /= hl), (hz /= hl);
  // Rock ahead (at the depth it's heading for): turn to whichever side is clear, or back.
  const s = Math.hypot(w.vx, w.vz) || 1, fx = w.vx / s, fz = w.vz / s;
  const ahead = (ax: number, az: number) => {
    const x = b.x + ax * AHEAD, z = b.z + az * AHEAD;
    return inRock(x, heightAt(x, z) - depth, z) || inRock(x, b.y, z);
  };
  if (ahead(fx, fz)) {
    const left = !ahead(-fz, fx), right = !ahead(fz, -fx);
    [hx, hz] = left ? [-fz, fx] : right ? [fz, -fx] : [-fx, -fz];
  }
  // Aim for the depth under the sand ahead and here, whichever is deeper (over a crest the head stays in).
  const yT = Math.min(heightAt(b.x + hx * 8, b.z + hz * 8), heightAt(b.x, b.z)) - depth;
  const dy = Math.max(-0.8, Math.min(0.8, (yT - b.y) / 14));
  const n = Math.hypot(1, dy);
  steer(w, hx / n, dy / n, hz / n, TURN, speed, accel, dt);
}

/** Can it go after this player: out on the sand, off rock, away from the base? */
function reachable(p: BossPlayer): boolean {
  if (p.safe || Math.hypot(p.x - BASE.x, p.z - BASE.z) < PREY_BASE) return false;
  if (sandOverRock(p.x, p.z) < ON_ROCK) return false;
  return p.y < heightAt(p.x, p.z) + 3;
}

/** The segments along the trail, SEG_LEN apart from the head back; past the trail's end, straight on. */
function layBody(b: Boss, w: Worm) {
  const t = w.trail, out = w.segs;
  out.length = 0;
  let px = b.x, py = b.y, pz = b.z, i = t.length - 3, along = 0, want = SEG_LEN;
  let lx = 0, ly = 0, lz = -1;
  for (let k = 0; k < SEGS; k++, want += SEG_LEN) {
    while (i >= 0) {
      const qx = t[i], qy = t[i + 1], qz = t[i + 2], d = Math.hypot(qx - px, qy - py, qz - pz);
      if (along + d >= want) {
        const f = (want - along) / d;
        out.push(px + (qx - px) * f, py + (qy - py) * f, pz + (qz - pz) * f);
        break;
      }
      if (d > 1e-6) (lx = (qx - px) / d), (ly = (qy - py) / d), (lz = (qz - pz) / d);
      along += d;
      (px = qx), (py = qy), (pz = qz);
      i -= 3;
    }
    if (i < 0) out.push(px + lx * (want - along), py + ly * (want - along), pz + lz * (want - along));
  }
  // Drop trail no segment needs.
  let len = 0;
  for (let j = t.length - 3; j >= 3; j -= 3) {
    len += Math.hypot(t[j] - t[j - 3], t[j + 1] - t[j - 2], t[j + 2] - t[j - 1]);
    if (len > BODY_LEN + 10) {
      t.splice(0, j - 3);
      break;
    }
  }
}

/** Is any of the body out of the sand (still pouring out of a leap, or its back up on a surface run)? */
function bodyOut(w: Worm): boolean {
  for (let i = 0; i < SEGS; i++) {
    const x = w.segs[i * 3], y = w.segs[i * 3 + 1], z = w.segs[i * 3 + 2];
    if (y + RADIUS * segScale(i) > heightAt(x, z)) return true;
  }
  return false;
}

function kill(out: BossOut, p: BossPlayer, x: number, y: number, z: number, r: number) {
  if (out.kills.some((k) => k.id === p.id)) return;
  out.kills.push({ id: p.id, cause: 'worm', push: blastPush(x, y, z, p.x, p.y, p.z, r) });
}

function event(out: BossOut, b: Boss, e: string, x: number, y: number, z: number, now: number, a?: number[]) {
  out.events.push({ msg: { t: 'bossFx', id: b.id, e, time: Math.round(now), x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, z: Math.round(z * 10) / 10, ...(a ? { a } : {}) }, x, z });
}

export const worm: Brain = {
  spawn(b, x, z, summoned) {
    // Under the sand some way off, heading past the player.
    let a = Math.random() * Math.PI * 2, d = summoned ? 170 : 650;
    for (let i = 0; i < 16; i++, a += 0.4) {
      const sx = x + Math.sin(a) * d, sz = z + Math.cos(a) * d;
      if (sandOverRock(sx, sz) > 25 && Math.hypot(sx - BASE.x, sz - BASE.z) > BASE_KEEP_OUT) break;
    }
    b.x = x + Math.sin(a) * d;
    b.z = z + Math.cos(a) * d;
    b.y = heightAt(b.x, b.z) - HUNT_DEPTH;
    b.yaw = Math.atan2(x - b.x, z - b.z);
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    const w: Worm = {
      vx: fx * ROAM_SPEED, vy: 0, vz: fz * ROAM_SPEED, mode: MODE_ROAM, trail: [], segs: [], tx: x + fx * 300, tz: z + fz * 300,
      clock: 0, surfaceAt: rand(4, 10), surfaceUntil: 0, prey: -1, fixAt: 0, px: 0, pz: 0, shallow: false, lungeUntil: 0, ax: 0, ay: 0, az: 0, riseAt: 0, coolUntil: 0,
      under: true, fx: b.x, fz: b.z,
      stalk: false, switchAt: rand(SWITCH_S[0], SWITCH_S[1]), arc: false, arcReady: ARC_FIRST, shots: 0, shotAt: 0, missiles: [], vel: new Map(),
    };
    // A straight trail behind it, so the body is laid out from the start.
    for (let s = BODY_LEN + 4; s > 0; s -= 2) w.trail.push(b.x - fx * s, b.y, b.z - fz * s);
    b.st = w;
    layBody(b, w);
  },

  tick(b, dt, now, players, out) {
    const w = b.st as Worm;
    w.clock += dt;
    const ground = heightAt(b.x, b.z);
    const n = crowd(b, players);
    track(w, dt, players);
    landMissiles(w, now, players, out);

    // Prey: whoever shot it if it can reach them, else the nearest reachable within NOTICE_R.
    if (!b.leaving && w.mode !== MODE_RISE && w.mode !== MODE_AIR) {
      const ok = players.filter(reachable);
      const angry = b.angryUntil > now ? ok.find((p) => p.id === b.angry && Math.hypot(p.x - b.x, p.z - b.z) < NOTICE_R * 2) : undefined;
      const near = angry ?? ok.filter((p) => Math.hypot(p.x - b.x, p.z - b.z) < NOTICE_R).sort((p, q) => Math.hypot(p.x - b.x, p.z - b.z) - Math.hypot(q.x - b.x, q.z - b.z))[0];
      const cur = ok.find((p) => p.id === w.prey && (p === angry || Math.hypot(p.x - b.x, p.z - b.z) < LOSE_R));
      const p = cur ?? near;
      if (p) {
        w.prey = p.id;
        w.fixAt = w.clock;
        w.px = p.x;
        w.pz = p.z;
      } else if (w.prey >= 0 && w.clock - w.fixAt > LOSE_S) w.prey = -1;
      if (w.mode === MODE_ROAM && w.prey >= 0) {
        w.mode = MODE_HUNT;
        w.shallow = Math.random() < SHALLOW_P;
      }
      if ((w.mode === MODE_HUNT || w.mode === MODE_LUNGE) && w.prey < 0) (w.mode = MODE_ROAM), (w.stalk = false);
    }
    if (b.leaving && w.mode !== MODE_RISE && w.mode !== MODE_AIR && w.mode !== MODE_DIVE) {
      if (w.mode !== MODE_ROAM || w.prey >= 0) newWaypoint(b, w, players, true);
      w.mode = MODE_ROAM;
      w.prey = -1;
    }

    const under = b.y < ground;
    if (w.mode === MODE_ROAM) {
      if (Math.hypot(w.tx - b.x, w.tz - b.z) < 40 || Math.hypot(w.tx - BASE.x, w.tz - BASE.z) < BASE_KEEP_OUT) newWaypoint(b, w, players, b.leaving);
      if (!b.leaving && w.clock > w.surfaceAt) {
        w.surfaceUntil = w.clock + rand(SURFACE_FOR[0], SURFACE_FOR[1]);
        w.surfaceAt = w.surfaceUntil + rand(SURFACE_EVERY[0], SURFACE_EVERY[1]);
      }
      const depth = b.leaving ? LEAVE_DEPTH : w.clock < w.surfaceUntil ? SURFACE_DEPTH : ROAM_DEPTH;
      swim(b, w, w.tx, w.tz, depth, ROAM_SPEED, dt);
    } else if (w.mode === MODE_LUNGE) {
      // The charge: straight on for the spot it saw them at and past it.
      swim(b, w, w.ax, w.az, SURFACE_DEPTH, LUNGE_SPEED, dt, ACCEL * 2);
      if (w.clock > w.lungeUntil) {
        w.mode = MODE_DIVE;
        w.shallow = Math.random() < SHALLOW_P;
        w.coolUntil = w.clock + COOL_S / scaled(1, n, CROWD_COOL);
        retarget(b, w, players, OTHER_P);
      }
    } else if (w.mode === MODE_HUNT) {
      if (w.clock > w.switchAt) retarget(b, w, players, 1);
      const d = Math.hypot(w.px - b.x, w.pz - b.z), speed = scaled(HUNT_SPEED, n, CROWD_SPEED);
      const s = Math.hypot(w.vx, w.vz) || 1, fx = w.vx / s, fz = w.vz / s;
      const arcDue = d < ARC_R && w.clock > w.arcReady && w.clock > w.coolUntil;
      if (arcDue && ground - b.y > RISE_MIN_DEPTH && !bodyOut(w)) {
        // The sky arc: up out of the sand here and high over towards them (over them if they are close).
        const ux = d > RISE_R ? (w.px - b.x) / d : fx, uz = d > RISE_R ? (w.pz - b.z) / d : fz;
        w.arc = true;
        w.stalk = false;
        w.shots = 0;
        w.ax = b.x + ux * ARC_FWD;
        w.az = b.z + uz * ARC_FWD;
        w.ay = heightAt(b.x, b.z) + ARC_UP;
        w.riseAt = w.clock + Math.max(TELL_MIN, TELL - CROWD_TELL * (n - 1));
        w.arcReady = w.clock + rand(ARC_GAP[0], ARC_GAP[1]) / scaled(1, n, CROWD_ARC);
        w.mode = MODE_RISE;
        event(out, b, 'tell', b.x, heightAt(b.x, b.z), b.z, now, [Math.round((w.riseAt - w.clock + HUNT_DEPTH / ARC_SPEED) * 100) / 100]);
      } else if (arcDue) {
        // Due to fly but too shallow (or its body still out): straight on and down deep first, so all of it gets
        // under (circling them it never would), then it goes from there.
        swim(b, w, b.x + fx * PASS_R, b.z + fz * PASS_R, HUNT_DEPTH, speed * 0.8, dt);
      } else if (w.shallow && !w.stalk && w.clock > w.coolUntil && d < LUNGE_R && (w.px - b.x) * fx + (w.pz - b.z) * fz > d * 0.7) {
        // Charge: they're ahead of it. Aim through them.
        w.ax = w.px + ((w.px - b.x) / (d || 1)) * LUNGE_ON;
        w.az = w.pz + ((w.pz - b.z) / (d || 1)) * LUNGE_ON;
        w.lungeUntil = w.clock + LUNGE_S;
        w.mode = MODE_LUNGE;
        event(out, b, 'lunge', b.x, ground, b.z, now);
      } else if (w.shallow && !w.stalk) {
        // Half out, closing in; too close and not lined up, it runs on and comes round again.
        if (d < LUNGE_R && w.clock > w.coolUntil) swim(b, w, b.x + fx * PASS_R, b.z + fz * PASS_R, SURFACE_DEPTH, speed, dt);
        else swim(b, w, w.px, w.pz, SURFACE_DEPTH, speed, dt);
      } else if (d < RISE_R && ground - b.y > RISE_MIN_DEPTH && w.clock > w.coolUntil && !bodyOut(w)) {
        // Rise: the spot is where they are now, a little past them; the sand there shivers while it holds under it,
        // then it comes up there whether they're still on it or not.
        const ux = (w.px - b.x) / (d || 1), uz = (w.pz - b.z) / (d || 1);
        w.ax = w.px + ux * RISE_LEAD;
        w.az = w.pz + uz * RISE_LEAD;
        w.ay = heightAt(w.ax, w.az) + RISE_UP;
        w.riseAt = w.clock + Math.max(TELL_MIN, TELL - CROWD_TELL * (n - 1));
        w.mode = MODE_RISE;
        w.arc = false;
        w.stalk = false;
        event(out, b, 'tell', w.ax, heightAt(w.ax, w.az), w.az, now, [Math.round((w.riseAt - w.clock + HUNT_DEPTH / RISE_SPEED) * 100) / 100]);
      } else if (d < PASS_R * 0.6 && !(w.clock > w.coolUntil && !bodyOut(w))) {
        // Not ready to come up yet: run on past them rather than circle tight under them.
        swim(b, w, b.x + fx * PASS_R, b.z + fz * PASS_R, w.stalk ? STALK_DEPTH : HUNT_DEPTH, speed * 0.8, dt);
      } else {
        // Close in deep (stalking: deeper, unseen), easing off near them so it doesn't overshoot; stalking, it comes
        // up from its depth at the last.
        const depth = w.stalk && d > RISE_R * 3 ? STALK_DEPTH : HUNT_DEPTH;
        swim(b, w, w.px, w.pz, depth, d < 60 ? speed * 0.8 : speed, dt);
      }
    } else if (w.mode === MODE_RISE) {
      const speed = w.arc ? ARC_SPEED : RISE_SPEED;
      if (w.clock < w.riseAt) {
        // The tell: creep in under the spot (the arc: hold where it is, the sand over it shivering).
        if (w.arc) steer(w, 0, 1, 0, TURN, 0, ACCEL * 2, dt);
        else swim(b, w, w.ax, w.az, HUNT_DEPTH, WIND_SPEED, dt, ACCEL * 2);
      } else {
        const dx = w.ax - b.x, dy = w.ay - b.y, dz = w.az - b.z, l = Math.hypot(dx, dy, dz) || 1;
        if (w.riseAt >= 0) {
          // Off: it kicks up at once, straight for the spot (the arc at full speed).
          w.riseAt = -1;
          const kick = w.arc ? speed : speed * 0.75;
          w.vx = (dx / l) * kick;
          w.vy = (dy / l) * kick;
          w.vz = (dz / l) * kick;
        }
        steer(w, dx / l, dy / l, dz / l, RISE_TURN, speed, ACCEL * 3, dt);
      }
      if (!under) w.mode = MODE_AIR;
    } else if (w.mode === MODE_AIR) {
      w.vy -= GRAVITY * dt;
      if (w.arc && !b.leaving) salvo(b, w, n, now, players, out);
      if (under) {
        w.mode = MODE_DIVE;
        w.coolUntil = w.clock + COOL_S / scaled(1, n, CROWD_COOL);
        w.shallow = Math.random() < SHALLOW_P;
        w.arc = false;
        retarget(b, w, players, OTHER_P);
      }
    } else {
      // Dive: down to depth, then back to whatever it was doing.
      const s = Math.hypot(w.vx, w.vz) || 1;
      swim(b, w, b.x + (w.vx / s) * 50, b.z + (w.vz / s) * 50, DIVE_DEPTH, HUNT_SPEED, dt);
      if (ground - b.y > DIVE_DEPTH - 4) w.mode = w.prey >= 0 && !b.leaving ? MODE_HUNT : MODE_ROAM;
    }

    // Move; never into rock (it slides along it instead).
    let nx = b.x + w.vx * dt, ny = b.y + w.vy * dt, nz = b.z + w.vz * dt;
    if (ny < heightAt(nx, nz) && inRock(nx, ny, nz)) {
      w.vx = -w.vx * 0.5;
      w.vz = -w.vz * 0.5;
      w.vy = Math.abs(w.vy) * 0.5 + 2;
      if (w.mode === MODE_RISE || w.mode === MODE_LUNGE) w.mode = MODE_DIVE;
      (nx = b.x), (ny = b.y + w.vy * dt), (nz = b.z);
    }
    b.x = nx;
    b.y = ny;
    b.z = nz;
    if (Math.hypot(w.vx, w.vz) > 0.5) b.yaw = Math.atan2(w.vx, w.vz);
    const t = w.trail, last = t.length - 3;
    if (last < 0 || Math.hypot(t[last] - b.x, t[last + 1] - b.y, t[last + 2] - b.z) >= TRAIL_STEP) t.push(b.x, b.y, b.z);
    layBody(b, w);

    // Breaking the sand on a leap: going out, the burst; coming back in, the plunge. Both blow a crater and kill near
    // it. (Swimming, its head may graze the air over a crest: no burst for that.)
    const g2 = heightAt(b.x, b.z), nowUnder = b.y < g2;
    const leap = (w.under && !nowUnder && (w.mode === MODE_RISE || w.mode === MODE_AIR)) || (!w.under && nowUnder && (w.mode === MODE_AIR || w.mode === MODE_DIVE));
    if (leap) {
      const out_ = !nowUnder, c = out_ ? BURST_CRATER : PLUNGE_CRATER;
      out.craters.push({ x: b.x, z: b.z, r: c.r, mm: c.mm });
      event(out, b, out_ ? 'breach' : 'plunge', b.x, g2, b.z, now, [Math.round(w.vx * 10) / 10, Math.round(w.vy * 10) / 10, Math.round(w.vz * 10) / 10]);
      for (const p of players) if (!p.safe && Math.hypot(p.x - b.x, p.z - b.z) < BURST_R && Math.abs(p.y - g2) < 6) kill(out, p, b.x, g2 - 2, b.z, BURST_R);
    }
    w.under = nowUnder;
    // Its back out of the sand while swimming: a furrow.
    if (nowUnder && w.mode !== MODE_RISE && b.y + RADIUS > g2 - 0.3 && Math.hypot(b.x - w.fx, b.z - w.fz) > FURROW_STEP) {
      w.fx = b.x;
      w.fz = b.z;
      out.craters.push({ x: b.x, z: b.z, r: FURROW_R, mm: Math.round(Math.min(1200, Math.max(300, (b.y + RADIUS - g2 + 1) * 400))) });
    }
    // Swallowed by the head out of the sand; crushed by the body passing out of it.
    for (const p of players) {
      if (p.safe) continue;
      const cy = p.y + 0.9;
      if (b.y > g2 - HEAD_R && Math.hypot(p.x - b.x, cy - b.y, p.z - b.z) < SWALLOW_R) kill(out, p, b.x, b.y, b.z, SWALLOW_R);
      for (let i = 0; i < SEGS; i++) {
        const sx = w.segs[i * 3], sy = w.segs[i * 3 + 1], sz = w.segs[i * 3 + 2], r = RADIUS * segScale(i) + BODY_PAD;
        if (Math.abs(sx - p.x) > r || Math.abs(sz - p.z) > r) continue;
        if (sy + r > heightAt(sx, sz) && Math.hypot(p.x - sx, cy - sy, p.z - sz) < r) kill(out, p, sx, sy, sz, r);
      }
    }

    // Leaving: gone once it's far from everyone (or after a while), its missiles down.
    if (b.leaving && w.missiles.length) return false;
    if (b.leaving) return players.every((p) => Math.hypot(p.x - b.x, p.z - b.z) > 800) || now > b.until + 120_000;
    return false;
  },

  near(b, x, y, z) {
    const w = b.st as Worm, r = RADIUS + 8;
    if (Math.hypot(x - b.x, y - b.y, z - b.z) < r + HEAD_R) return true;
    for (let i = 0; i < w.segs.length; i += 3) if (Math.hypot(x - w.segs[i], y - w.segs[i + 1], z - w.segs[i + 2]) < r) return true;
    return false;
  },

  prey(b) {
    return [(b.st as Worm).prey];
  },

  snap(b) {
    const w = b.st as Worm, s = [w.mode];
    for (let i = 0; i < w.segs.length; i += 3) {
      s.push(Math.round((w.segs[i] - b.x) * 10) / 10, Math.round((w.segs[i + 1] - b.y) * 10) / 10, Math.round((w.segs[i + 2] - b.z) * 10) / 10);
    }
    return s;
  },

  die(b) {
    const w = b.st as Worm;
    w.vx = w.vy = w.vz = 0;
    w.arc = false;
  },

  wreck(b, _dt, now, players, out) {
    // The missiles already flying still land.
    landMissiles(b.st as Worm, now, players, out);
  },
};

/** With `p` probability, drop its prey for someone else it can reach about it (at random) and stalk them; either
 *  way, the next switch is SWITCH_S off. */
function retarget(b: Boss, w: Worm, players: BossPlayer[], p: number) {
  w.switchAt = w.clock + rand(SWITCH_S[0], SWITCH_S[1]);
  if (b.leaving || Math.random() >= p) return;
  const others = players.filter((o) => o.id !== w.prey && reachable(o) && Math.hypot(o.x - b.x, o.z - b.z) < LOSE_R);
  if (!others.length) return;
  const o = others[Math.floor(Math.random() * others.length)];
  w.prey = o.id;
  w.fixAt = w.clock;
  w.px = o.x;
  w.pz = o.z;
  w.stalk = true;
}

/** Everyone's ground velocity (smoothed), for leading the missiles. */
function track(w: Worm, dt: number, players: BossPlayer[]) {
  for (const p of players) {
    const v = w.vel.get(p.id);
    if (!v) {
      w.vel.set(p.id, { x: p.x, z: p.z, vx: 0, vz: 0 });
      continue;
    }
    let vx = (p.x - v.x) / Math.max(dt, 1e-3), vz = (p.z - v.z) / Math.max(dt, 1e-3);
    if (Math.hypot(vx, vz) > 40) vx = vz = 0; // a respawn, not a run
    const k = Math.min(1, dt / 0.6);
    v.vx += (vx - v.vx) * k;
    v.vz += (vz - v.vz) * k;
    v.x = p.x;
    v.z = p.z;
  }
  if (w.vel.size > players.length + 8) for (const id of w.vel.keys()) if (!players.some((p) => p.id === id)) w.vel.delete(id);
}

/** Up on the sky arc: a missile every SHOT_S out of a segment of its back that's clear of the sand. */
function salvo(b: Boss, w: Worm, n: number, now: number, players: BossPlayer[], out: BossOut) {
  const count = Math.min(ARC_SHOTS_MAX, Math.round(scaled(ARC_SHOTS, n, ARC_SHOTS_PER / ARC_SHOTS)));
  if (w.shots >= count || w.clock < w.shotAt) return;
  const up: number[] = [];
  for (let i = 2; i < SEGS - 4; i++) if (w.segs[i * 3 + 1] > heightAt(w.segs[i * 3], w.segs[i * 3 + 2]) + SHOT_CLEAR) up.push(i);
  const marks = players.filter((p) => !p.safe && Math.hypot(p.x - b.x, p.z - b.z) < SHOT_R)
    .sort((p, q) => (p.id === w.prey ? -1 : q.id === w.prey ? 1 : 0));
  if (!up.length || !marks.length) return;
  const k = w.shots++;
  w.shotAt = w.clock + SHOT_S;
  const i = up[Math.floor(Math.random() * up.length)], seg = segScale(i) * RADIUS;
  const x0 = w.segs[i * 3], y0 = w.segs[i * 3 + 1] + seg, z0 = w.segs[i * 3 + 2];
  const p = marks[Math.floor(k / SPRAY) % marks.length], v = w.vel.get(p.id);
  let x1: number, z1: number;
  const flight = flightTime(Math.hypot(p.x - x0, p.z - z0));
  if (k % SPRAY === SPRAY - 1) {
    // Here and there: a spot round them.
    const a = Math.random() * Math.PI * 2, r = rand(SPRAY_R[0], SPRAY_R[1]);
    (x1 = p.x + Math.sin(a) * r), (z1 = p.z + Math.cos(a) * r);
  } else {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * SCATTER;
    x1 = p.x + (v ? v.vx : 0) * flight * LEAD + Math.sin(a) * r;
    z1 = p.z + (v ? v.vz : 0) * flight * LEAD + Math.cos(a) * r;
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const path: MissilePath = { x0: r2(x0), y0: r2(y0), z0: r2(z0), x1: r2(x1), y1: r2(heightAt(x1, z1)), z1: r2(z1), flight: Math.round(flight * 1000) / 1000 };
  const id = nextMissile++;
  w.missiles.push({ id, at: now + path.flight * 1000, x: path.x1, y: path.y1, z: path.z1 });
  out.events.push({ x: path.x1, z: path.z1, msg: { t: 'missile', id, g: -1, time: now, ...path } });
}

/** Missiles now landing: a burst, death round it. */
function landMissiles(w: Worm, now: number, players: BossPlayer[], out: BossOut) {
  w.missiles = due(w.missiles, now, (m) => {
    blast(out, players, m.x, m.y, m.z, 'missile', BLAST_R, ball(m.x, m.y, m.z, BLAST_R, 0.9));
    out.events.push({ x: m.x, z: m.z, msg: { t: 'blast', id: m.id, x: m.x, y: m.y, z: m.z } });
  });
}
