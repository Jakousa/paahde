// The colossus's brain (shared/colossus.ts, shared/bosses.ts): a 67 m biped that roams the open desert between far
// waypoints, walks at anyone it sees out in the open within NOTICE_R, and stomps.
//
// - Its hips glide on at WALK, turning slowly; its two feet are planted spots that step when they fall too far
//   behind their rest spots (one at a time, both down a moment between steps), like the guardians' (server/guardians.ts
//   stepFeet). The view swings its legs onto them with IK. A foot lands on the sand wherever that is.
// - Every footfall kills within STEP_KILL_R and digs a crater, so it leaves a line of huge footprints. These happen
//   SEEN_LAG_MS after the server's footfall: the clients draw it that much in the past.
// - Close to its prey it raises a foot high over them (aiming while it rises), holds (the tell), and slams it down:
//   a wider kill and a bigger crater. Slow enough to run from sideways.
// - All five weak points broken: its knees buckle and it topples like a tower along its fall direction; where the
//   body lands, a furrow of craters (and anyone under it dies).
import type { Boss, BossOut, BossPlayer, Brain } from './bosses.ts';
import { BASE } from '../shared/base.ts';
import { blastPush } from '../shared/ragdoll.ts';
import { heightAt, WORLD_HALF } from '../shared/terrain.ts';
import {
  BIG_CRATER_MM, BIG_CRATER_R, BIG_KILL_R, BIG_S, DOUBLE_S, FALL_FROM, FALL_S, FALL_TO, FOOT_X, HIP_H,
  HUNT_TURN_RATE, MOOD_HUNT, MOOD_ROAM, MOOD_STOMP, RAISE_S, RECOVER_S, SEEN_LAG_MS, SETTLE, SETTLE_S, STEP_AT,
  STEP_CRATER_MM, STEP_CRATER_R, STEP_KILL_R, STOMP_GAP_S, STOMP_NEAR, STOMP_REACH, STRIDE, SWING_S, TURN_RATE, TURN_SLOW, WALK,
} from '../shared/colossus.ts';

/** Notices players out in the open within this distance (m); a shooter from further off; loses them past LOSE_R
 *  or once they're safe a while. */
const NOTICE_R = 250;
const SHOT_NOTICE_R = 700;
const LOSE_R = 420;
const FORGET_MS = 8000;
/** Keeps this far (m) from the home base: it doesn't walk over it or hunt anyone near it. */
const BASE_KEEP_OUT = 260;
/** Roaming: the next waypoint 700–1500 m off, within the world (less a margin); reached within WAYPOINT_R. */
const ROAM: [number, number] = [700, 1500];
const MARGIN = 150;
const WAYPOINT_R = 60;
/** Speeding up and slowing down (m/s²). */
const ACCEL = 0.6;
/** Summoned this far (m) from the player, walking at them; a rare one comes in from FAR_SPAWN. */
const NEAR_SPAWN = 330;
const FAR_SPAWN = 1500;
/** Leaving: walks away until everyone is this far (m), or for at most LEAVE_MS. */
const GONE_R = 3200;
const LEAVE_MS = 12 * 60_000;
/** Footprints are dug only within this distance (m) of someone: every dug cell goes to everyone (~9k a crater), so
 *  ones nobody will see would cost for nothing. */
const FOOTPRINT_R = 1200;
/** The falling body kills within this distance (m) of the line it lands along. */
const BODY_KILL_R = 12;

/** A foot's spot (where it stands, or where its swing lands), seconds left of the swing, its kind (0 step, 1 the big
 *  stomp) and how far this step goes. */
type Foot = { x: number; y: number; z: number; left: number; kind: number; span: number };
type Pending = { at: number; x: number; y: number; z: number; r: number; mm: number; kill: number; big: boolean };
type St = {
  feet: [Foot, Foot];
  /** Foot to step next; both feet down for (s); standing still for (s); speed (m/s); yaw last tick. */
  next: number; down: number; still: number; speed: number; lastYaw: number;
  /** Waypoint. */
  tx: number; tz: number;
  /** Hunting this player (-1 none), last seen where and when. */
  prey: number; px: number; pz: number; seenAt: number;
  /** The big stomp: with foot `foot` (-1 none), since (ms), aimed at (ax, az); next one not before (ms); standing
   *  until (ms) after one. */
  foot: number; stompAt: number; ax: number; az: number; stompReady: number; recoverUntil: number;
  /** Footfalls still to come (SEEN_LAG_MS late). */
  pending: Pending[];
  /** Leaving: walking to (lx, lz), since. */
  lx: number; lz: number; leftAt: number;
  /** Dead: the fall's yaw, and whether it has landed. */
  fall: number; fell: boolean;
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const r2 = (v: number) => Math.round(v * 100) / 100;
const inWorld = (x: number, z: number) => Math.abs(x) < WORLD_HALF - 20 && Math.abs(z) < WORLD_HALF - 20;
const fromBase = (x: number, z: number) => Math.hypot(x - BASE.x, z - BASE.z);

/** Foot i's rest spot: beside the hips (foot 0 on its +X side), `lead` m ahead. */
function rest(x: number, z: number, yaw: number, i: number, lead: number, out: { x: number; z: number }) {
  const side = i === 0 ? FOOT_X : -FOOT_X;
  out.x = x + Math.cos(yaw) * side + Math.sin(yaw) * lead;
  out.z = z - Math.sin(yaw) * side + Math.cos(yaw) * lead;
  return out;
}

function plant(b: Boss, st: St) {
  const p = { x: 0, z: 0 };
  st.feet.forEach((f, i) => {
    rest(b.x, b.z, b.yaw, i, i === 0 ? 4 : -4, p);
    f.x = p.x;
    f.z = p.z;
    f.y = heightAt(p.x, p.z);
    f.left = 0;
    f.kind = 0;
  });
}

/** A roaming waypoint: far off, in the world, away from the base (roughly towards `dir` if given). */
function waypoint(st: St, x: number, z: number, dir?: number) {
  for (let k = 0; k < 20; k++) {
    const a = dir === undefined ? Math.random() * Math.PI * 2 : dir + rand(-1.1, 1.1), d = rand(ROAM[0], ROAM[1]);
    const tx = x + Math.sin(a) * d, tz = z + Math.cos(a) * d;
    if (Math.abs(tx) > WORLD_HALF - MARGIN || Math.abs(tz) > WORLD_HALF - MARGIN || fromBase(tx, tz) < BASE_KEEP_OUT + 100) continue;
    st.tx = tx;
    st.tz = tz;
    return;
  }
  st.tx = Math.max(-1000, Math.min(1000, -x));
  st.tz = Math.max(-1000, Math.min(1000, -z));
}

export const colossus: Brain = {
  spawn(b, x, z, summoned, now) {
    const a = Math.random() * Math.PI * 2, d = summoned ? NEAR_SPAWN : FAR_SPAWN;
    b.x = x + Math.sin(a) * d;
    b.z = z + Math.cos(a) * d;
    // A rare one walks past the player, a little to one side; a summoned one straight at them.
    const off = summoned ? 0 : rand(150, 400) * (Math.random() < 0.5 ? -1 : 1);
    const tx = x + Math.cos(a) * off, tz = z - Math.sin(a) * off;
    b.yaw = Math.atan2(tx - b.x, tz - b.z);
    const st: St = {
      feet: [{ x: 0, y: 0, z: 0, left: 0, kind: 0, span: 0 }, { x: 0, y: 0, z: 0, left: 0, kind: 0, span: 0 }],
      next: 1, down: 0, still: 0, speed: 0, lastYaw: b.yaw,
      // On past the player and beyond, then roaming.
      tx: tx + (tx - b.x) * 0.8, tz: tz + (tz - b.z) * 0.8,
      prey: -1, px: 0, pz: 0, seenAt: 0,
      foot: -1, stompAt: 0, ax: 0, az: 0, stompReady: now + 5000, recoverUntil: 0,
      pending: [], lx: 0, lz: 0, leftAt: 0, fall: 0, fell: false,
    };
    b.st = st;
    plant(b, st);
    b.y = (st.feet[0].y + st.feet[1].y) / 2 + HIP_H;
  },

  tick(b, dt, now, players, out) {
    const st = b.st as St;
    footfalls(st, now, players, out);
    if (b.leaving && !st.leftAt) {
      // Away from everyone, far past the edge of sight.
      let ax = 0, az = 0;
      for (const p of players) {
        const d = Math.max(1, Math.hypot(b.x - p.x, b.z - p.z));
        ax += (b.x - p.x) / d;
        az += (b.z - p.z) / d;
      }
      const n = Math.hypot(ax, az);
      const a = n > 0.01 ? Math.atan2(ax, az) : b.yaw;
      st.lx = b.x + Math.sin(a) * (GONE_R + 600);
      st.lz = b.z + Math.cos(a) * (GONE_R + 600);
      st.leftAt = now;
      st.prey = -1;
    }
    if (b.leaving) {
      const near = players.reduce((m, p) => Math.min(m, Math.hypot(p.x - b.x, p.z - b.z)), Infinity);
      if ((near > GONE_R && st.foot < 0) || now - st.leftAt > LEAVE_MS) return true;
    } else hunt(b, st, now, players);

    // Where to: its prey, its way out, or the next waypoint (away from the base).
    let gx = st.tx, gz = st.tz;
    if (b.leaving) (gx = st.lx), (gz = st.lz);
    else if (st.prey >= 0) (gx = st.px), (gz = st.pz);
    else if (Math.hypot(st.tx - b.x, st.tz - b.z) < WAYPOINT_R) waypoint(st, b.x, b.z);
    if (!b.leaving && fromBase(b.x, b.z) < BASE_KEEP_OUT) {
      // Too near the base and heading in: off somewhere else, away from it.
      const away = Math.atan2(b.x - BASE.x, b.z - BASE.z);
      if (Math.abs(wrap(Math.atan2(gx - b.x, gz - b.z) - away)) > Math.PI / 2) {
        st.prey = -1;
        waypoint(st, b.x, b.z, away);
        (gx = st.tx), (gz = st.tz);
      }
    }
    const err = wrap(Math.atan2(gx - b.x, gz - b.z) - b.yaw);
    const dist = Math.hypot(gx - b.x, gz - b.z);

    let want = WALK * Math.max(TURN_SLOW, Math.cos(Math.min(Math.PI / 2, Math.abs(err))));
    if (st.prey >= 0 && dist < 12) want = 0; // right over them: stop and stomp
    if (st.foot >= 0) {
      // The big stomp: creep at them while the foot rises, then stand.
      const t = (now - st.stompAt) / 1000;
      want = t < RAISE_S ? 1.2 : 0;
      if (t < RAISE_S) {
        const p = players.find((o) => o.id === st.prey);
        if (p && !p.safe) aimStomp(b, st, p.x, p.z);
      }
    } else if (now < st.recoverUntil) want = 0;
    else if (st.prey >= 0 && dist < STOMP_NEAR && now >= st.stompReady && !b.leaving && st.feet.every((f) => f.left === 0) && st.down > DOUBLE_S) {
      startStomp(b, st, now);
      want = 1.2;
    }
    st.speed += Math.max(-ACCEL * dt, Math.min(ACCEL * dt, want - st.speed));
    const rate = st.prey >= 0 ? HUNT_TURN_RATE : TURN_RATE;
    b.yaw = wrap(b.yaw + Math.max(-rate * dt, Math.min(rate * dt, err)));
    b.x += Math.sin(b.yaw) * st.speed * dt;
    b.z += Math.cos(b.yaw) * st.speed * dt;
    stepFeet(b, st, dt, now);
    b.y = (st.feet[0].y + st.feet[1].y) / 2 + HIP_H;
    return false;
  },

  near(b, x, y, z) {
    // Anywhere about its body, from the knees to the head (generous: its size, lag).
    const dy = y < b.y - 30 ? b.y - 30 - y : y > b.y + 34 ? y - b.y - 34 : 0;
    return Math.hypot(x - b.x, z - b.z, dy) < 38;
  },

  snap(b) {
    const st = b.st as St;
    const s: number[] = [];
    for (const f of st.feet) s.push(r2(f.x), r2(f.y), r2(f.z), r2(f.left), f.kind);
    const mood = st.foot >= 0 ? MOOD_STOMP : st.prey >= 0 ? MOOD_HUNT : MOOD_ROAM;
    s.push(mood, r2(st.prey >= 0 ? st.px : 0), r2(st.prey >= 0 ? st.pz : 0), Math.round(st.fall * 1e3) / 1e3);
    return s;
  },

  die(b) {
    const st = b.st as St;
    // Topples forward, or a little to one side; a foot in the air comes down where it is.
    st.fall = wrap(b.yaw + rand(-0.6, 0.6));
    st.foot = -1;
    for (const f of st.feet) {
      f.left = 0;
      f.kind = 0;
      f.y = heightAt(f.x, f.z);
    }
  },

  wreck(b, _dt, now, players, out) {
    const st = b.st as St;
    footfalls(st, now, players, out);
    if (st.fell || now - b.deadAt < FALL_S * 1000 + SEEN_LAG_MS) return;
    st.fell = true;
    // The body lands along its fall: a furrow of craters, the chest's the biggest, anyone under it crushed.
    const sx = Math.sin(st.fall), sz = Math.cos(st.fall);
    const ox = (st.feet[0].x + st.feet[1].x) / 2, oz = (st.feet[0].z + st.feet[1].z) / 2;
    const marks: [number, number, number][] = [[FALL_FROM + 6, 10, 2200], [30, 12, 3000], [44, 13.5, 3400], [58, 10, 2600]];
    for (const [d, r, mm] of marks) {
      const x = ox + sx * d, z = oz + sz * d;
      if (inWorld(x, z)) out.craters.push({ x, z, r, mm });
    }
    for (const p of players) {
      if (p.safe) continue;
      const along = (p.x - ox) * sx + (p.z - oz) * sz;
      const side = Math.abs((p.x - ox) * sz - (p.z - oz) * sx);
      if (along < FALL_FROM - 4 || along > FALL_TO + 4 || side > BODY_KILL_R) continue;
      if (p.y > heightAt(p.x, p.z) + 20) continue;
      const bx = ox + sx * along, bz = oz + sz * along;
      out.kills.push({ id: p.id, cause: 'stomp', push: blastPush(bx, heightAt(bx, bz), bz, p.x, p.y, p.z, BODY_KILL_R) });
    }
  },
};

/** Who it's after: whoever shot it (from further off), else the nearest out in the open within NOTICE_R, kept
 *  while in sight. Nobody near the base. */
function hunt(b: Boss, st: St, now: number, players: BossPlayer[]) {
  const ok = (p: BossPlayer) => !p.safe && fromBase(p.x, p.z) > BASE_KEEP_OUT;
  let prey = players.find((p) => p.id === st.prey);
  if (prey && ok(prey) && Math.hypot(prey.x - b.x, prey.z - b.z) < LOSE_R) {
    st.px = prey.x;
    st.pz = prey.z;
    st.seenAt = now;
  } else if (st.prey >= 0 && now - st.seenAt > FORGET_MS) st.prey = -1;
  if (b.angry >= 0 && now < b.angryUntil && b.angry !== st.prey) {
    const p = players.find((o) => o.id === b.angry);
    if (p && ok(p) && Math.hypot(p.x - b.x, p.z - b.z) < SHOT_NOTICE_R) prey = p;
    else prey = undefined;
    if (prey) setPrey(st, prey, now);
  }
  if (st.prey >= 0) return;
  let best: BossPlayer | null = null, bd = NOTICE_R;
  for (const p of players) {
    const d = Math.hypot(p.x - b.x, p.z - b.z);
    if (ok(p) && d < bd) (best = p), (bd = d);
  }
  if (best) setPrey(st, best, now);
}

function setPrey(st: St, p: BossPlayer, now: number) {
  st.prey = p.id;
  st.px = p.x;
  st.pz = p.z;
  st.seenAt = now;
}

/** Raise the foot nearer its prey's side. */
function startStomp(b: Boss, st: St, now: number) {
  const side = (st.px - b.x) * Math.cos(b.yaw) - (st.pz - b.z) * Math.sin(b.yaw);
  st.foot = side >= 0 ? 0 : 1;
  st.stompAt = now;
  aimStomp(b, st, st.px, st.pz);
  const f = st.feet[st.foot];
  f.left = BIG_S;
  f.kind = 1;
}

/** The stomp's spot: at (x, z), within reach of its hips and clear of the other foot. */
function aimStomp(b: Boss, st: St, x: number, z: number) {
  const f = st.feet[st.foot], o = st.feet[1 - st.foot];
  let dx = x - b.x, dz = z - b.z;
  const d = Math.hypot(dx, dz);
  if (d > STOMP_REACH) (dx *= STOMP_REACH / d), (dz *= STOMP_REACH / d);
  let ax = b.x + dx, az = b.z + dz;
  const od = Math.hypot(ax - o.x, az - o.z);
  if (od < 9) {
    ax = o.x + ((ax - o.x) / Math.max(0.1, od)) * 9;
    az = o.z + ((az - o.z) / Math.max(0.1, od)) * 9;
  }
  st.ax = ax;
  st.az = az;
  f.x = ax;
  f.z = az;
  f.y = heightAt(ax, az);
}

/**
 * The gait: a planted foot steps once its rest spot is STEP_AT away (SETTLE when standing), the feet taking turns
 * (the other one if it's much further behind), both down at least DOUBLE_S between steps. It steps to where its rest
 * spot will be when it lands, half a swing on (the feet lead the hips).
 */
function stepFeet(b: Boss, st: St, dt: number, now: number) {
  const feet = st.feet;
  const turn = wrap(b.yaw - st.lastYaw) / Math.max(dt, 1e-3);
  st.lastYaw = b.yaw;
  const moving = st.speed + Math.abs(turn) * FOOT_X;
  st.still = moving < 0.3 ? st.still + dt : 0;
  for (const f of feet) {
    if (f.left <= 0) {
      // Planted: on the sand as it is now (it sinks into its own footprint once that's dug).
      f.y = heightAt(f.x, f.z);
      continue;
    }
    f.left = Math.max(0, f.left - dt);
    if (f.left > 0) continue;
    const big = f.kind === 1;
    land(st, f, now, big ? 1 : Math.min(1, 0.35 + f.span / STRIDE), big);
    f.kind = 0;
    st.down = 0;
    if (big) {
      st.foot = -1;
      st.recoverUntil = now + RECOVER_S * 1000;
      st.stompReady = now + STOMP_GAP_S * 1000;
    }
  }
  if (feet.some((f) => f.left > 0)) return;
  st.down += dt;
  if (st.down < DOUBLE_S || st.foot >= 0) return;
  const p = { x: 0, z: 0 };
  const errs = feet.map((f, i) => Math.hypot(rest(b.x, b.z, b.yaw, i, 0, p).x - f.x, p.z - f.z));
  const need = st.still > 1 ? SETTLE : STEP_AT;
  let i = st.next;
  if (errs[i] < need && errs[1 - i] > need * 1.3) i = 1 - i;
  if (errs[i] < need) return;
  const settling = st.still > 1;
  const d = settling ? SETTLE_S : SWING_S * Math.min(1.25, Math.max(1, WALK / Math.max(1, st.speed)) ** 0.3);
  const f = feet[i];
  const vx = Math.sin(b.yaw) * st.speed, vz = Math.cos(b.yaw) * st.speed;
  // Where its rest spot will be as it lands (turning with the body), half a swing on.
  rest(b.x + vx * d * 1.5, b.z + vz * d * 1.5, b.yaw + turn * d, i, 0, p);
  f.span = Math.hypot(p.x - f.x, p.z - f.z);
  f.x = p.x;
  f.z = p.z;
  f.y = heightAt(p.x, p.z);
  f.left = d;
  f.kind = 0;
  st.next = 1 - i;
}

/** A foot comes down (seen SEEN_LAG_MS later): a crater and death around it. */
function land(st: St, f: Foot, now: number, weight: number, big: boolean) {
  st.pending.push({
    at: now + SEEN_LAG_MS, x: f.x, y: f.y, z: f.z, big,
    r: big ? BIG_CRATER_R : STEP_CRATER_R * (0.75 + 0.25 * weight),
    mm: big ? BIG_CRATER_MM : Math.round(STEP_CRATER_MM * weight),
    kill: big ? BIG_KILL_R : STEP_KILL_R,
  });
}

/** Footfalls now due: dig, kill. */
function footfalls(st: St, now: number, players: BossPlayer[], out: BossOut) {
  if (!st.pending.length) return;
  st.pending = st.pending.filter((e) => {
    if (e.at > now) return true;
    if (inWorld(e.x, e.z) && (e.big || players.some((p) => Math.hypot(p.x - e.x, p.z - e.z) < FOOTPRINT_R))) out.craters.push({ x: e.x, z: e.z, r: e.r, mm: e.mm });
    for (const p of players) {
      if (p.safe || out.kills.some((k) => k.id === p.id)) continue;
      const d = Math.hypot(p.x - e.x, p.z - e.z);
      if (d > e.kill || Math.abs(p.y - e.y) > e.kill) continue;
      out.kills.push({ id: p.id, cause: 'stomp', push: blastPush(e.x, e.y, e.z, p.x, p.y, p.z, e.kill) });
    }
    return false;
  });
}

