// The worm's brain (shared/worm.ts, server/bosses.ts): steers its head through the sand, flies it on gravity out of
// it, lays the body along the head's path, and does the harm: the burst out of the sand and the head swallow whoever
// is near, and the plunge back in; both blow craters, and running shallow its back ploughs a furrow.
import { BASE } from '../shared/base.ts';
import { rockHeight } from '../shared/rocks.ts';
import { blastPush } from '../shared/ragdoll.ts';
import { heightAt, sandOverRock } from '../shared/terrain.ts';
import {
  ACCEL, GRAVITY, HEAD_R, HUNT_SPEED, MODE_AIR, MODE_DIVE, MODE_HUNT, MODE_RISE, MODE_ROAM, NOTICE_R, RADIUS, RISE_SPEED, RISE_TURN,
  ROAM_SPEED, SEG_LEN, SEGS, segScale, TURN,
} from '../shared/worm.ts';
import type { Boss, BossOut, BossPlayer, Brain } from './bosses.ts';

/** Depths (m, the head's centre under the sand): roaming, hunting, diving after a leap, leaving, and running with its
 *  back out of the sand (the body's top a little above it). */
const ROAM_DEPTH = 10, HUNT_DEPTH = 15, DIVE_DEPTH = 18, LEAVE_DEPTH = 24;
const SURFACE_DEPTH = RADIUS * 0.55;
/** Roaming: runs at the surface every SURFACE_EVERY s (random within), for SURFACE_FOR s. */
const SURFACE_EVERY: [number, number] = [18, 40];
const SURFACE_FOR: [number, number] = [7, 12];
/** Waypoints (m from where it is); it keeps BASE_KEEP_OUT from the base, and hunts nobody within PREY_BASE of it. */
const LEG: [number, number] = [180, 420];
const BASE_KEEP_OUT = 380, PREY_BASE = 320;
/** Rock: it can't reach anyone standing on rock or sand thinner than ON_ROCK over it; it looks AHEAD m for rock. */
const ON_ROCK = 4;
const AHEAD = 10;
/** Hunting: rises once within RISE_R (m, horizontally) of its prey and at least RISE_MIN_DEPTH down, aiming
 *  RISE_UP m over the sand and RISE_LEAD m past them; after a leap it dives and keeps off for COOL_S. */
const RISE_R = 13, RISE_MIN_DEPTH = 8, RISE_UP = 45, RISE_LEAD = 3, COOL_S = 5;
/** It loses prey it hasn't had a fix on for this long (s). */
const LOSE_S = 4;
/** Harm: the burst and the plunge kill within BURST_R (m) of where the head breaks the sand; the head out of the sand
 *  swallows within SWALLOW_R of its centre; a body segment out of the sand crushes within its radius + BODY_PAD. */
const BURST_R = 6.5, SWALLOW_R = HEAD_R + 1, BODY_PAD = 1;
/** Craters (radius m, depth mm): the burst, the plunge; the furrow its back ploughs (one every FURROW_STEP m). */
const BURST_CRATER = { r: 7, mm: 2400 }, PLUNGE_CRATER = { r: 5.5, mm: 1800 };
const FURROW_R = 2.6, FURROW_STEP = 5;
/** The trail is kept as points at least TRAIL_STEP m apart. */
const TRAIL_STEP = 0.8;
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
  /** Rising at (ax, ay, az); cooling down (no rising) until then. */
  ax: number; ay: number; az: number; coolUntil: number;
  /** Was the head under the sand last tick; where the last furrow crater went. */
  under: boolean; fx: number; fz: number;
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const inRock = (x: number, y: number, z: number) => y < rockHeight(x, z) + 1.5;

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
function swim(b: Boss, w: Worm, tx: number, tz: number, depth: number, speed: number, dt: number) {
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
  steer(w, hx / n, dy / n, hz / n, TURN, speed, ACCEL, dt);
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
      clock: 0, surfaceAt: rand(4, 10), surfaceUntil: 0, prey: -1, fixAt: 0, px: 0, pz: 0, ax: 0, ay: 0, az: 0, coolUntil: 0,
      under: true, fx: b.x, fz: b.z,
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

    // Prey: whoever shot it if it can reach them, else the nearest reachable within NOTICE_R.
    if (!b.leaving && w.mode !== MODE_RISE && w.mode !== MODE_AIR) {
      const ok = players.filter(reachable);
      const angry = b.angryUntil > now ? ok.find((p) => p.id === b.angry && Math.hypot(p.x - b.x, p.z - b.z) < NOTICE_R * 2) : undefined;
      const near = angry ?? ok.filter((p) => Math.hypot(p.x - b.x, p.z - b.z) < NOTICE_R).sort((p, q) => Math.hypot(p.x - b.x, p.z - b.z) - Math.hypot(q.x - b.x, q.z - b.z))[0];
      const cur = ok.find((p) => p.id === w.prey);
      const p = cur ?? near;
      if (p) {
        w.prey = p.id;
        w.fixAt = w.clock;
        w.px = p.x;
        w.pz = p.z;
      } else if (w.prey >= 0 && w.clock - w.fixAt > LOSE_S) w.prey = -1;
      if (w.mode === MODE_ROAM && w.prey >= 0) w.mode = MODE_HUNT;
      if (w.mode === MODE_HUNT && w.prey < 0) w.mode = MODE_ROAM;
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
    } else if (w.mode === MODE_HUNT) {
      const d = Math.hypot(w.px - b.x, w.pz - b.z);
      if (d < RISE_R && ground - b.y > RISE_MIN_DEPTH && w.clock > w.coolUntil) {
        // Rise: aim over and a little past them, and warn: the sand over its head shivers.
        const ux = (w.px - b.x) / (d || 1), uz = (w.pz - b.z) / (d || 1);
        w.ax = w.px + ux * RISE_LEAD;
        w.az = w.pz + uz * RISE_LEAD;
        w.ay = heightAt(w.px, w.pz) + RISE_UP;
        w.mode = MODE_RISE;
        event(out, b, 'tell', w.px, heightAt(w.px, w.pz), w.pz, now);
      } else {
        // Close in deep: aim behind them so it's under them by the time it turns up.
        swim(b, w, w.px, w.pz, HUNT_DEPTH, d < 60 ? HUNT_SPEED * 0.8 : HUNT_SPEED, dt);
      }
    } else if (w.mode === MODE_RISE) {
      const dx = w.ax - b.x, dy = w.ay - b.y, dz = w.az - b.z, n = Math.hypot(dx, dy, dz) || 1;
      steer(w, dx / n, dy / n, dz / n, RISE_TURN, RISE_SPEED, ACCEL * 3, dt);
      if (!under) w.mode = MODE_AIR;
    } else if (w.mode === MODE_AIR) {
      w.vy -= GRAVITY * dt;
      if (under) {
        w.mode = MODE_DIVE;
        w.coolUntil = w.clock + COOL_S;
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
      if (w.mode === MODE_RISE) w.mode = MODE_DIVE;
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

    // Leaving: gone once it's far from everyone (or after a while).
    if (b.leaving) return players.every((p) => Math.hypot(p.x - b.x, p.z - b.z) > 800) || now > b.until + 120_000;
    return false;
  },

  near(b, x, y, z) {
    const w = b.st as Worm, r = RADIUS + 8;
    if (Math.hypot(x - b.x, y - b.y, z - b.z) < r + HEAD_R) return true;
    for (let i = 0; i < w.segs.length; i += 3) if (Math.hypot(x - w.segs[i], y - w.segs[i + 1], z - w.segs[i + 2]) < r) return true;
    return false;
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
  },
};
