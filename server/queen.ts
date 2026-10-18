// The brood queen's brain (shared/queen.ts, shared/bosses.ts): skitters about crawler and guardian ground (crash
// sites of level 1 and up) near where it turned up, charges whoever it sees out in the open, stabs the sand with
// every step and rears up to slam its front legs down on prey close in front.
//
// - Gait: the feet are stepped here, an alternating tetrapod (shared/queen.ts GROUP): while it moves, one group of
//   four swings while the other stands, each step landing ahead of its rest spot by one and a half swings of travel
//   so the feet stay centred under the body; stopped, feet that are off their spots settle. Each landing stabs a
//   hole into the sand and kills whoever is within STAB_R. The client draws the bosses BOT_DELAY_MS behind the
//   server, so a landing's hole and kill wait that long too, to happen as the drawn foot comes down.
// - Modes (shared/queen.ts): ROAM (wander round its crash site, pausing now and then) → HUNT (charge) → REAR (front
//   legs up, REAR_MS) → slam → RECOVER (stands, RECOVER_MS: the window to run or shoot) → HUNT. It gives up past
//   GIVE_UP or after CHASE_MS, and leaves that player be for a while. LEAVE: walks away from everyone, out of sight.
// - The brood: while it fights, every so often its sac opens (BIRTH_MS) and a clutch of spiderlings drops out from
//   under it. They run at whoever is out in the open (spread over everyone), crouch close by, then spring at where
//   their prey will be: a sidestep while they crouch, or a sprint, gets you out of it. They last until they're shot
//   (one hit: shared/bosses.ts MINION) or it dies. Their bites, like the stabs, are worked out as the drawn spiderling lands (DRAW_DELAY).
// - A crowd (server/bossCrowd.ts: everyone within CROWD_R) makes it harder: a quicker rear, a shorter stand after
//   the slam, a slightly faster charge, and more spiderlings out at once, in bigger clutches, more often. One player
//   is the baseline.
import { crashSitesNear } from '../shared/crashsites.ts';
import {
  BIRTH_MS, BIRTH_Y, BIRTH_Z, BODY_H, BROOD_CAP, CHARGE, CHASE_MS, CROUCH_MS, DEATH_HOLE, DIE_MS, DROP_MS, FRONT, GIVE_UP, GROUP, HUNT,
  HUNT_TURN, LEAP_HIT, LEAP_MAX, LEAP_MS, LEAP_R, LEAVE, LEGS, REAR, REAR_CONE, REAR_MS, REAR_R, RECOVER, RECOVER_MS, REST_MS, restSpot,
  ROAM, SETTLE, SETTLE_S, SIGHT, SLAM_HOLE, SLAM_R, slamPoints, SP_DIE, SP_DROP, SP_LEAP, SP_REST, SP_RUN, SP_CROUCH, SP_SPEED,
  STAB_HOLE, STAB_R, stabY, swingTime, TURN, WALK,
} from '../shared/queen.ts';
import { blastPush } from '../shared/ragdoll.ts';
import { heightAt } from '../shared/terrain.ts';
import { crowd, scaled } from './bossCrowd.ts';
import type { Boss, BossOut, BossPlayer, Brain } from './bosses.ts';

/** The client draws bosses this far (ms) behind the server (src/world/botFrames.ts BOT_DELAY_MS). */
const DRAW_DELAY = 250;
/** Stabs are worked out (holes, deaths) only with someone within MARK_R (m). Every hole's cells go to everyone and
 *  the wind's healing passes resend them until it has filled in (minutes), so holes are rationed: a bucket of
 *  HOLES_MAX, refilled at HOLES_PER_S. A charge leaves rows of holes; ambling about, every few steps leaves one. */
const MARK_R = 400;
const HOLES_PER_S = 1.2, HOLES_MAX = 6;
/** Roaming: wander within ROAM_R (m) of its crash site, pausing PAUSE_MS (random up to) at each spot. */
const ROAM_R = 180;
const PAUSE_MS = 6000;
/** Leaving: gone once everyone is this far (m), or after LEAVE_MS. */
const GONE_R = 2300;
const LEAVE_MS = 5 * 60_000;
/** After giving up on someone, it leaves them be this long (ms). */
const IGNORE_MS = 25_000;
/** Shot: it comes for the shooter from this far (m). */
const ANGRY_R = 400;
/** Acceleration and braking (m/s²). */
const ACCEL = 3, BRAKE = 6, REAR_BRAKE = 14;
/** Against n people (bossCrowd.ts scaled: × (1 + per × (n − 1))): the rear and the stand after the slam shrink by
 *  these, the charge grows by CHARGE_PER (kept under a walk). */
const REAR_PER = 0.1, RECOVER_PER = 0.25, CHARGE_PER = 0.015;
/** The brood against n people: at most BROOD_MAX out (+BROOD_PER each), clutches of CLUTCH (+CLUTCH_PER), one every
 *  CLUTCH_MS (÷ by CLUTCH_FASTER), the first FIRST_CLUTCH_MS into a fight. */
const BROOD_MAX = 4, BROOD_PER = 0.5, CLUTCH = 2, CLUTCH_PER = 0.5, CLUTCH_MS = 15_000, CLUTCH_FASTER = 0.3, FIRST_CLUTCH_MS = 3000;
/** Spiderlings go for people within SP_SIGHT (m) of them; each one already after someone counts as SP_SHARE m more
 *  to them, so a crowd gets spread out; they turn at SP_TURN (rad/s) and keep SP_GAP (m) apart. */
const SP_SIGHT = 160, SP_SHARE = 12, SP_TURN = 7, SP_GAP = 1.6;

type Foot = { x: number; y: number; z: number; left: number; up: boolean };
type Pending = { at: number; slam: boolean; hole: boolean; x: number; y: number; z: number; x2: number; z2: number };
type St = {
  feet: Foot[]; speed: number; lastYaw: number; next: number;
  mode: number; modeAt: number; prey: number; huntAt: number;
  homeX: number; homeZ: number; tx: number; tz: number; waitUntil: number; leaveAt: number;
  ignore: Map<number, number>; pending: Pending[]; holes: number;
  /** The rear in hand (ms); when the sac last began to open (0 never) and whether a clutch is due out of it; when
   *  the next one may come. */
  rearMs: number; birthAt: number; due: boolean; nextBirth: number;
  brood: Ling[]; nextLing: number;
  /** Players' velocities (smoothed), for leading the leaps. */
  vel: Map<number, { x: number; z: number; vx: number; vz: number }>;
};
/** A spiderling: where, which way, state (shared/queen.ts SP_*) since when, its prey (-1 none), born when; crouched
 *  or leaping, where it's springing to (from where); landed, when its bite is worked out (0 done). */
type Ling = {
  id: number; x: number; z: number; yaw: number; st: number; stAt: number; prey: number; born: number;
  ax: number; az: number; fx: number; fz: number; biteAt: number;
};

/** A shot ending this close (m, flat) to a spiderling hits it. */
const LING_HIT = 4;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const r2 = (v: number) => Math.round(v * 100) / 100;
const _p = { x: 0, z: 0 };

function setMode(st: St, mode: number, now: number) {
  st.mode = mode;
  st.modeAt = now;
}

/** A new spot to wander to round its home. */
function wander(st: St) {
  const a = rand(-Math.PI, Math.PI), r = rand(30, ROAM_R);
  st.tx = st.homeX + Math.sin(a) * r;
  st.tz = st.homeZ + Math.cos(a) * r;
}

export const queen: Brain = {
  spawn(b, x, z, summoned, now) {
    // Home: the nearest crawler or guardian site, else where it turned up.
    const site = crashSitesNear(x, z, 1500).find((s) => s.level >= 1);
    const a = rand(-Math.PI, Math.PI), d = summoned ? 75 : rand(350, 500);
    b.x = x + Math.sin(a) * d;
    b.z = z + Math.cos(a) * d;
    b.yaw = summoned ? Math.atan2(x - b.x, z - b.z) : rand(-Math.PI, Math.PI);
    b.y = heightAt(b.x, b.z) + BODY_H;
    const feet: Foot[] = [];
    for (let i = 0; i < LEGS; i++) {
      restSpot(b.x, b.z, b.yaw, i, _p);
      feet.push({ x: _p.x, y: stabY(_p.x, _p.z), z: _p.z, left: 0, up: false });
    }
    const st: St = {
      feet, speed: 0, lastYaw: b.yaw, next: 0, mode: ROAM, modeAt: now, prey: -1, huntAt: 0,
      homeX: site && !summoned ? site.x : b.x, homeZ: site && !summoned ? site.z : b.z, tx: b.x, tz: b.z, waitUntil: now + 1500, leaveAt: 0,
      ignore: new Map(), pending: [], holes: HOLES_MAX,
      rearMs: REAR_MS, birthAt: 0, due: false, nextBirth: 0, brood: [], nextLing: 1, vel: new Map(),
    };
    wander(st);
    b.st = st;
  },

  tick(b, dt, now, players, out) {
    const st = b.st as St;
    land(b, st, now, players, out);
    const n = crowd(b, players);
    track(st, dt, players);
    brood(b, st, dt, now, n, players, out);
    let want = 0, heading = b.yaw, turn = TURN;

    if (b.leaving && st.mode !== LEAVE && st.mode !== REAR) {
      setMode(st, LEAVE, now);
      st.leaveAt = now;
      for (const f of st.feet) f.up = false;
    }
    if (st.mode === LEAVE) {
      // Away from the nearest player, until nobody can see it any more.
      let near: BossPlayer | null = null, nd = Infinity;
      for (const p of players) {
        const d = Math.hypot(p.x - b.x, p.z - b.z);
        if (d < nd) (nd = d), (near = p);
      }
      if (nd > GONE_R || now - st.leaveAt > LEAVE_MS) return true;
      if (near) heading = Math.atan2(b.x - near.x, b.z - near.z);
      want = WALK * 1.5;
    } else {
      for (const [id, until] of st.ignore) if (now > until) st.ignore.delete(id);
      if (st.mode === ROAM) {
        // Someone out in the open close by, or whoever shot it: after them.
        let prey = -1, pd = Infinity;
        for (const p of players) {
          if (p.safe || st.ignore.has(p.id)) continue;
          const d = Math.hypot(p.x - b.x, p.z - b.z);
          const angry = p.id === b.angry && now < b.angryUntil && d < ANGRY_R;
          if ((d < SIGHT || angry) && d < pd) (prey = p.id), (pd = d);
        }
        if (prey >= 0) {
          st.prey = prey;
          st.huntAt = now;
          setMode(st, HUNT, now);
          st.nextBirth = Math.max(st.nextBirth, now + FIRST_CLUTCH_MS);
        }
      }
      const p = st.prey >= 0 ? players.find((o) => o.id === st.prey) : undefined;
      if (st.mode === HUNT) {
        const d = p ? Math.hypot(p.x - b.x, p.z - b.z) : Infinity;
        if (!p || p.safe || d > GIVE_UP || (now - st.huntAt > CHASE_MS && d > REAR_R * 2)) {
          if (p) st.ignore.set(p.id, now + IGNORE_MS);
          st.prey = -1;
          st.homeX = b.x;
          st.homeZ = b.z;
          wander(st);
          setMode(st, ROAM, now);
        } else {
          heading = Math.atan2(p.x - b.x, p.z - b.z);
          const off = Math.abs(wrap(heading - b.yaw));
          turn = HUNT_TURN;
          // Turning hard, it slows to come round tighter.
          want = off > 1 ? WALK : scaled(CHARGE, n, CHARGE_PER);
          if (d < REAR_R && off < REAR_CONE) {
            setMode(st, REAR, now);
            st.rearMs = Math.round(REAR_MS / scaled(1, n, REAR_PER));
            for (const i of FRONT) st.feet[i].up = true, st.feet[i].left = 0;
          }
        }
      }
      if (st.mode === REAR && now - st.modeAt >= st.rearMs) {
        // Slam: the front feet come down ahead; holes and deaths as the drawn ones land.
        const [x0, z0, x1, z1] = slamPoints(b.x, b.z, b.yaw);
        FRONT.forEach((i, k) => {
          const f = st.feet[i];
          f.up = false;
          f.left = 0;
          f.x = k ? x1 : x0;
          f.z = k ? z1 : z0;
          f.y = stabY(f.x, f.z);
        });
        st.pending.push({ at: now + DRAW_DELAY, slam: true, hole: true, x: x0, y: heightAt(x0, z0), z: z0, x2: x1, z2: z1 });
        setMode(st, RECOVER, now);
      }
      if (st.mode === RECOVER && now - st.modeAt >= RECOVER_MS / scaled(1, n, RECOVER_PER)) setMode(st, st.prey >= 0 ? HUNT : ROAM, now);
      if (st.mode === ROAM) {
        if (now < st.waitUntil) want = 0;
        else {
          if (Math.hypot(st.tx - b.x, st.tz - b.z) < 12) {
            st.waitUntil = now + rand(1500, PAUSE_MS);
            wander(st);
          }
          heading = Math.atan2(st.tx - b.x, st.tz - b.z);
          want = Math.abs(wrap(heading - b.yaw)) > 1.2 ? WALK * 0.5 : WALK;
        }
      }
    }

    // Move: turn towards the heading, speed up or brake towards what it wants.
    const still = st.mode === REAR || st.mode === RECOVER;
    if (!still) b.yaw = wrap(b.yaw + Math.max(-turn * dt, Math.min(turn * dt, wrap(heading - b.yaw))));
    if (still) want = 0;
    const acc = want > st.speed ? ACCEL : st.mode === REAR ? REAR_BRAKE : BRAKE;
    st.speed += Math.max(-acc * dt, Math.min(acc * dt, want - st.speed));
    b.x += Math.sin(b.yaw) * st.speed * dt;
    b.z += Math.cos(b.yaw) * st.speed * dt;
    stepFeet(b, st, dt, now, players);
    let gy = 0;
    for (const f of st.feet) gy += f.y;
    b.y = gy / LEGS + 0.3 + BODY_H;
    return false;
  },

  near(b, x, y, z) {
    // Along the body from the head to the end of the abdomen.
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    const along = Math.max(-23, Math.min(10, (x - b.x) * fx + (z - b.z) * fz));
    return Math.hypot(x - (b.x + fx * along), y - b.y, z - (b.z + fz * along)) < 16;
  },

  snap(b) {
    const st = b.st as St;
    const s = [st.mode, Math.round(st.modeAt)];
    for (const f of st.feet) s.push(r2(f.x), r2(f.y), r2(f.z), f.up ? -1 : r2(f.left));
    s.push(st.rearMs, Math.round(st.birthAt));
    for (const l of st.brood) s.push(l.id, r2(l.x), r2(l.z), Math.round(l.yaw * 1000) / 1000, l.st, Math.round(l.stAt));
    return s;
  },

  hitMinion(b, i, x, y, z, now) {
    // The shot ended near it (the view draws it DRAW_DELAY behind, running: some slack).
    const l = (b.st as St).brood.find((o) => o.id === i && o.st !== SP_DIE);
    if (!l || Math.hypot(l.x - x, l.z - z) > LING_HIT || Math.abs(y - heightAt(l.x, l.z)) > 7) return false;
    l.biteAt = 0;
    ling(l, SP_DIE, now);
    return true;
  },

  die(b, now, out) {
    const st = b.st as St;
    st.pending.length = 0;
    st.speed = 0;
    // The brood runs down with her.
    st.due = false;
    for (const l of st.brood) if (l.st !== SP_DIE) ling(l, SP_DIE, now);
    out.craters.push({ x: b.x, z: b.z, r: DEATH_HOLE.r, mm: DEATH_HOLE.mm });
  },

  wreck(b, _dt, now) {
    const st = b.st as St;
    if (st.brood.length) st.brood = st.brood.filter((l) => now - l.stAt < DIE_MS);
  },
};

/** Step the feet (see the top of the file). */
function stepFeet(b: Boss, st: St, dt: number, now: number, players: BossPlayer[]) {
  const turn = wrap(b.yaw - st.lastYaw) / dt;
  st.lastYaw = b.yaw;
  st.holes = Math.min(HOLES_MAX, st.holes + HOLES_PER_S * dt);
  const v = st.speed, vx = Math.sin(b.yaw) * v, vz = Math.cos(b.yaw) * v;
  let swinging = false;
  for (const f of st.feet) {
    if (f.up || f.left <= 0) continue;
    f.left -= dt;
    if (f.left > 1e-6) {
      swinging = true;
      continue;
    }
    f.left = 0;
    if (players.some((p) => Math.hypot(p.x - f.x, p.z - f.z) < MARK_R)) {
      const hole = st.holes >= 1;
      if (hole) st.holes--;
      st.pending.push({ at: now + DRAW_DELAY, slam: false, hole, x: f.x, y: f.y, z: f.z, x2: 0, z2: 0 });
    }
  }
  if (swinging) return;
  const footSpeed = v + Math.abs(turn) * 15;
  const moving = footSpeed > 0.3;
  const err = [0, 0];
  st.feet.forEach((f, i) => {
    if (f.up) return;
    restSpot(b.x, b.z, b.yaw, i, _p);
    err[GROUP[i]] = Math.max(err[GROUP[i]], Math.hypot(_p.x - f.x, _p.z - f.z));
  });
  let g = -1;
  if (moving) g = st.next;
  else if (Math.max(err[0], err[1]) > SETTLE) g = err[0] >= err[1] ? 0 : 1;
  if (g < 0) return;
  const dur = moving ? swingTime(v) : SETTLE_S;
  const lead = moving ? dur * 1.5 : 0;
  st.feet.forEach((f, i) => {
    if (f.up || GROUP[i] !== g) return;
    restSpot(b.x + vx * lead, b.z + vz * lead, b.yaw + turn * dur, i, _p);
    f.x = _p.x;
    f.z = _p.z;
    f.y = stabY(f.x, f.z);
    f.left = dur;
  });
  st.next = 1 - g;
}

/** Feet (and slams) whose drawn landing is now: holes in the sand, and whoever was under them. */
function land(b: Boss, st: St, now: number, players: BossPlayer[], out: BossOut) {
  if (!st.pending.length) return;
  const killed = new Set(out.kills.map((k) => k.id));
  st.pending = st.pending.filter((e) => {
    if (e.at > now) return true;
    if (e.slam) {
      out.craters.push({ x: e.x, z: e.z, r: SLAM_HOLE.r, mm: SLAM_HOLE.mm }, { x: e.x2, z: e.z2, r: SLAM_HOLE.r, mm: SLAM_HOLE.mm });
      const cx = (e.x + e.x2) / 2, cz = (e.z + e.z2) / 2, cy = heightAt(cx, cz);
      for (const p of players) {
        if (p.safe || killed.has(p.id) || Math.hypot(p.x - cx, p.z - cz) > SLAM_R || Math.abs(p.y - cy) > 8) continue;
        killed.add(p.id);
        out.kills.push({ id: p.id, cause: 'queen', push: blastPush(cx, cy, cz, p.x, p.y, p.z, SLAM_R) });
      }
      out.events.push({ msg: { t: 'bossFx', id: b.id, e: 'slam', time: Math.round(now), x: r2(cx), y: r2(cy), z: r2(cz) }, x: cx, z: cz });
      return false;
    }
    if (e.hole) out.craters.push({ x: e.x, z: e.z, r: STAB_HOLE.r, mm: STAB_HOLE.mm });
    for (const p of players) {
      if (p.safe || killed.has(p.id) || Math.hypot(p.x - e.x, p.z - e.z) > STAB_R || Math.abs(p.y - e.y) > 4) continue;
      killed.add(p.id);
      out.kills.push({ id: p.id, cause: 'queen', push: blastPush(e.x, e.y, e.z, p.x, p.y, p.z, STAB_R * 2) });
    }
    return false;
  });
}

function ling(l: Ling, s: number, now: number) {
  l.st = s;
  l.stAt = now;
}

/** Everyone's velocity, smoothed, for leading the spiderlings' leaps. */
function track(st: St, dt: number, players: BossPlayer[]) {
  const k = 1 - Math.exp(-dt * 6);
  const seen = new Set<number>();
  for (const p of players) {
    seen.add(p.id);
    const v = st.vel.get(p.id);
    if (!v) {
      st.vel.set(p.id, { x: p.x, z: p.z, vx: 0, vz: 0 });
      continue;
    }
    let vx = (p.x - v.x) / dt, vz = (p.z - v.z) / dt;
    if (Math.hypot(vx, vz) > 25) vx = vz = 0; // respawned
    v.vx += (vx - v.vx) * k;
    v.vz += (vz - v.vz) * k;
    v.x = p.x;
    v.z = p.z;
  }
  for (const id of st.vel.keys()) if (!seen.has(id)) st.vel.delete(id);
}

/** The brood (see the top of the file): clutches out of the sac, and every spiderling's run, crouch, leap and bite. */
function brood(b: Boss, st: St, dt: number, now: number, n: number, players: BossPlayer[], out: BossOut) {
  let alive = 0;
  for (const l of st.brood) if (l.st !== SP_DIE) alive++;
  const cap = Math.min(BROOD_CAP, Math.round(scaled(BROOD_MAX, n, BROOD_PER)));
  const fighting = !b.leaving && (st.mode === HUNT || st.mode === REAR || st.mode === RECOVER);
  if (fighting && !st.due && now >= st.nextBirth && alive < cap) {
    st.birthAt = now;
    st.due = true;
    st.nextBirth = now + CLUTCH_MS / scaled(1, n, CLUTCH_FASTER);
  }
  if (st.due && now - st.birthAt >= BIRTH_MS) {
    // Out from under the sac, one after another.
    st.due = false;
    const k = Math.min(cap - alive, Math.round(scaled(CLUTCH, n, CLUTCH_PER)));
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    for (let i = 0; i < k; i++) {
      const side = (i - (k - 1) / 2) * 0.9 + rand(-0.3, 0.3), along = BIRTH_Z + rand(-1, 1);
      const x = b.x + fx * along + fz * side, z = b.z + fz * along - fx * side, at = now + i * 140;
      st.brood.push({
        id: st.nextLing++, x, z, yaw: wrap(b.yaw + Math.PI + rand(-1.2, 1.2)), st: SP_DROP, stAt: at, prey: -1, born: at,
        ax: x, az: z, fx: x, fz: z, biteAt: 0,
      });
    }
  }

  const chasing = new Map<number, number>();
  for (const l of st.brood) if (l.prey >= 0 && l.st !== SP_DIE) chasing.set(l.prey, (chasing.get(l.prey) ?? 0) + 1);
  const killed = new Set(out.kills.map((k) => k.id));
  st.brood = st.brood.filter((l) => {
    const since = now - l.stAt;
    if (l.st === SP_DIE) return since < DIE_MS;
    if (l.st === SP_DROP) {
      if (since >= DROP_MS) ling(l, SP_RUN, now);
      return true;
    }
    if (l.st === SP_RUN) {
      let p = l.prey >= 0 ? players.find((o) => o.id === l.prey) : undefined;
      if (!p || p.safe || Math.hypot(p.x - l.x, p.z - l.z) > SP_SIGHT) {
        // Someone else: the nearest, counting those already chased as further.
        if (l.prey >= 0) chasing.set(l.prey, (chasing.get(l.prey) ?? 1) - 1);
        l.prey = -1;
        p = undefined;
        let best = Infinity;
        for (const o of players) {
          const d = Math.hypot(o.x - l.x, o.z - l.z);
          if (o.safe || d > SP_SIGHT) continue;
          const cost = d + SP_SHARE * (chasing.get(o.id) ?? 0);
          if (cost < best) (best = cost), (p = o);
        }
        if (p) {
          l.prey = p.id;
          chasing.set(p.id, (chasing.get(p.id) ?? 0) + 1);
        }
      }
      let want: number, heading: number;
      if (p) {
        const d = Math.hypot(p.x - l.x, p.z - l.z);
        // Where they'll be when it lands (as they see it: drawn DRAW_DELAY late). In reach of that (or right on
        // them): crouch, aimed there. So walking away only puts it off; a sprint, or a sidestep as it crouches, doesn't.
        const v = st.vel.get(p.id), lead = (CROUCH_MS + LEAP_MS + DRAW_DELAY) / 1000;
        const ax = p.x + (v ? v.vx * lead : 0) - l.x, az = p.z + (v ? v.vz * lead : 0) - l.z, len = Math.hypot(ax, az);
        if (len <= LEAP_MAX || d < LEAP_R) {
          const k = Math.min(1, LEAP_MAX / Math.max(len, 1e-3));
          l.fx = l.x;
          l.fz = l.z;
          l.ax = l.x + ax * k;
          l.az = l.z + az * k;
          if (len > 0.1) l.yaw = Math.atan2(ax, az);
          ling(l, SP_CROUCH, now);
          return true;
        }
        // Cutting them off: headed for where they're going, more so further off.
        const cut = Math.min(1.5, (0.6 * d) / SP_SPEED);
        heading = Math.atan2(p.x + (v ? v.vx * cut : 0) - l.x, p.z + (v ? v.vz * cut : 0) - l.z);
        // Zigzagging in, further off.
        if (d > 10) heading += Math.sin(now * 0.006 + l.id * 1.7) * 0.35;
        want = SP_SPEED;
      } else if (Math.hypot(b.x - l.x, b.z - l.z) > 25) {
        // Nobody: back to her, milling about under her.
        heading = Math.atan2(b.x - l.x, b.z - l.z);
        want = 3;
      } else {
        heading = l.yaw + Math.sin(now * 0.002 + l.id) * 1.5;
        want = 1.5;
      }
      l.yaw = wrap(l.yaw + Math.max(-SP_TURN * dt, Math.min(SP_TURN * dt, wrap(heading - l.yaw))));
      l.x += Math.sin(l.yaw) * want * dt;
      l.z += Math.cos(l.yaw) * want * dt;
      return true;
    }
    if (l.st === SP_CROUCH) {
      if (since >= CROUCH_MS) ling(l, SP_LEAP, now);
      return true;
    }
    if (l.st === SP_LEAP) {
      const t = Math.min(1, since / LEAP_MS);
      l.x = l.fx + (l.ax - l.fx) * t;
      l.z = l.fz + (l.az - l.fz) * t;
      if (t >= 1) {
        ling(l, SP_REST, now);
        l.biteAt = now + DRAW_DELAY;
      }
      return true;
    }
    // Landed: the bite as the drawn one comes down, then up and after them again.
    if (l.biteAt && now >= l.biteAt) {
      l.biteAt = 0;
      const y = heightAt(l.x, l.z);
      for (const p of players) {
        if (p.safe || killed.has(p.id) || Math.hypot(p.x - l.x, p.z - l.z) > LEAP_HIT || Math.abs(p.y - y) > 2.5) continue;
        killed.add(p.id);
        out.kills.push({ id: p.id, cause: 'crawler', push: blastPush(l.x, y, l.z, p.x, p.y, p.z, LEAP_HIT * 3) });
      }
    }
    if (since >= REST_MS) ling(l, SP_RUN, now);
    return true;
  });

  // Running ones keep a little apart.
  const run = st.brood.filter((l) => l.st === SP_RUN);
  for (let i = 0; i < run.length; i++) {
    for (let j = i + 1; j < run.length; j++) {
      const a = run[i], c = run[j], dx = c.x - a.x, dz = c.z - a.z, d = Math.hypot(dx, dz);
      if (d >= SP_GAP || d < 1e-4) continue;
      const k = (SP_GAP - d) / d / 2;
      a.x -= dx * k;
      a.z -= dz * k;
      c.x += dx * k;
      c.z += dz * k;
    }
  }
}
