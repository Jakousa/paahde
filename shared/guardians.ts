// Guardians and drones: the desert's machines. Server-simulated (server/guardians.ts), sent to clients ~10 times a
// second ('bots', shared/protocol.ts) and drawn by src/world/guardians.ts (the legs are client-side IK) and
// src/world/drones.ts.
//
// Two kinds of walker (KINDS), built from the same parts at different scales:
// - Guardians: a few rare giants roaming from crash site to crash site, standing guard now and then. Come within
//   sight of one (or get caught in a drone's searchlight near one) and it hunts you, slower than you can walk; if one
//   of its feet comes down on you, you're crushed (FOOT_CRUSH_R; under its body, between the legs, you're safe).
// - Crawlers: player-sized spiders swarming every crash site someone is near. Faster than you run (slide away),
//   the pack spreads out and comes at you from all sides (server/pack.ts); one bite kills (BITE_DAMAGE, shared/health.ts); they give up after a short chase or once
//   you're well away from their site.
//
// While it hunts you and sees you, a guardian's cannon (hung under its body, turning to follow you) charges for
// CHARGE_MS and fires a big slow laser bolt at where you are, every FIRE_MS. A hit, or a blast within BLAST_R of
// you, kills. Bolts fly straight at BOLT_SPEED: from a distance you can sidestep them.
//
// Drones come out at night (sun below NIGHT_SUN): a few hover over every crash site someone is near, sweeping a
// searchlight over the sand. Come within NOTICE_R in the open and it notices you and swings the beam your way; get
// caught in the beam and it locks on: it follows you, every guardian within ALERT_R
// comes for you and the nearest ones shell you with missiles from afar (shared/missiles.ts). The beam turns after
// you no faster than TRACK_RATE and the drone flies slower than you walk: sprint sideways out of the light, break
// its line of sight (behind a dune crest, into a shelter) or outrun it, and after LOSE_MS in the dark it lets you go
// and leaves you be for IGNORE_MS.
import { collideCrash } from './crashsites.ts';
import { collideScrap } from './scrap.ts';
import { heightAt } from './terrain.ts';
import { KILL } from './health.ts';
import { indoors } from './shelters.ts';

// --- Guardian body and legs (metres; must match tools/blender/guardians.py) ---

/** Hip height above the ground the feet stand on (at scale 1: see KINDS). */
export const BODY_H = 13;
/** Upper and lower leg, knee to ankle. */
export const FEMUR = 12;
export const TIBIA = 16;
/** Ankle above the foot's sole. */
export const ANKLE = 1.2;
/** Hip sockets on the body (model frame: +Z forward), by leg count. Legs splay out along the socket direction. */
export const SOCKETS: Record<3 | 4, [number, number][]> = {
  4: [[2.3, 2.3], [-2.3, 2.3], [-2.3, -2.3], [2.3, -2.3]],
  3: [[2.6, 1.5], [-2.6, 1.5], [0, -3.0]],
};
/** A foot at rest stands this far out from the body's centre, along its socket's direction. */
export const REST_R = 14;
/** A planted foot steps once its rest spot is this far away (server/guardians.ts for guardians, src/world/guardians.ts
 *  for crawlers); a stopped body settles feet that are off by SETTLE. Lengths × scale. */
export const STEP_DIST = 9;
export const SETTLE = 1.2;
/** Swing time bounds (s, × √scale: small legs swing quicker). */
export const STEP_MIN = 0.6, STEP_MAX = 1.5;
/** A guardian's foot landing within this (m, horizontally, × scale) of you crushes you. The landing is animated on the client, so
 *  your client tells the server ('stomped'); it checks the guardian is alive and that one of its feet could reach you
 *  (within (REST_R + STEP_DIST) × scale + CRUSH_SLACK of its centre). */
export const FOOT_CRUSH_R = 1.5;
export const CRUSH_SLACK = 8;
/** Half the foot pad's width (m, × scale): it stands on the highest thing under it (footTop). */
export const FOOT_HALF = 1.1;

/**
 * Where a guardian's feet are is the server's call (server/guardians.ts steps them, the client swings its legs to
 * them), so both sides know the planted ones exactly. A planted foot is a post players can't walk through
 * (shared/sim.ts collideLegs): LEG_POST_R (m, × scale) around the foot, from its sole up LEG_POST_H (× scale), the
 * foot pad and the near-vertical shin over it. Feet in the air don't block.
 */
export const LEG_POST_R = 1.2;
export const LEG_POST_H = 12;
/** 'bots' feet (`f`): guardian id, leg, x, y (the sole), z, seconds of swing left (0 planted). */
export const F_STRIDE = 6;

const _top = { x: 0, z: 0, vx: 0, vz: 0 };
/** The top of whatever a walker's foot (of `scale`) put down at (x, z) stands on: sand, rock (part of heightAt), or
 *  the scrap and crash-site wrecks under its pad (their collision capsules, shared/scrap.ts, shared/crashsites.ts). */
export function footTop(x: number, z: number, scale: number): number {
  let top = heightAt(x, z);
  const h = FOOT_HALF * scale;
  for (let i = 0; i < 5; i++) {
    _top.x = x + (i === 1 ? h : i === 2 ? -h : 0);
    _top.z = z + (i === 3 ? h : i === 4 ? -h : 0);
    // From far above, nothing pushes: the result is the highest capsule top under the point.
    top = Math.max(top, collideScrap(_top, 1e6, 1e6, 0, 0), collideCrash(_top, 1e6, 1e6, 0, 0));
  }
  return top;
}

/** A foot's rest spot for leg `i` of a `legs`-legged walker of `scale` at (x, z) facing `yaw`, led `lead` s along
 *  (vx, vz), into `out` (x, z only). */
export function restSpot<T extends { x: number; z: number }>(x: number, z: number, yaw: number, legs: 3 | 4, i: number, scale: number, vx: number, vz: number, lead: number, out: T): T {
  const [sx, sz] = SOCKETS[legs][i], l = Math.hypot(sx, sz);
  const lx = (sx / l) * REST_R * scale, lz = (sz / l) * REST_R * scale;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out.x = x + lx * c + lz * s + vx * lead;
  out.z = z - lx * s + lz * c + vz * lead;
  return out;
}

/**
 * The walker kinds. `scale` multiplies every length above (the model is built at 1). Speeds in m/s (a player runs
 * 7.5, slides 15), turn rates in rad/s; `sight`: notices someone out in the open this close (m), from any side;
 * `reach`: gets this close (m, horizontally) to its prey: a crawler bites, a guardian stands over you; `gun`: has the cannon.
 */
export const KINDS = [
  { name: 'guardian', scale: 1.5, patrol: 2.8, hunt: 5.2, turn: 0.3, huntTurn: 0.6, sight: 65, reach: 7.5, gun: true },
  { name: 'crawler', scale: 0.11, patrol: 2.6, hunt: 9.5, turn: 3, huntTurn: 9, sight: 12, reach: 1.5, gun: false },
] as const;
export const GUARDIAN = 0, CRAWLER = 1;
export type Kind = typeof GUARDIAN | typeof CRAWLER;
/** A crawler's bite: damage (shared/health.ts), at most every BITE_MS. After a bite, or chasing for CRAWLER_CHASE_MS,
 *  it backs off for CRAWLER_CALM_MS. One bite kills. */
export const BITE_DAMAGE = KILL;
export const BITE_MS = 1500;
export const CRAWLER_CHASE_MS = 10_000;
export const CRAWLER_CALM_MS = 2500;

// --- The cannon (tools/blender/guardians.py Guardian_Turret, Guardian_Gun) ---

/** Turret mount on the body (body frame), the gun's pitch pivot below it (turret frame), and the muzzle along the
 *  gun's +Z. */
export const GUN_MOUNT = { y: -2.4, z: 0.6 };
export const GUN_PIVOT = -1.3;
export const MUZZLE = 5;
/** The gun pitches down at most this far (radians below level): someone under the body (closer in than about
 *  11 m) it can't shoot at all. */
export const GUN_DEPRESS = 0.9;
/** Fires at people within this distance (m) it can see, every FIRE_MS, after charging for CHARGE_MS. */
export const FIRE_R = 120;
export const FIRE_MS = 2900;
export const CHARGE_MS = 800;
/** Bolt speed (m/s), how far it flies (m), its radius for hits (m), and the blast where it lands. */
export const BOLT_SPEED = 38;
export const BOLT_RANGE = 180;
export const BOLT_R = 0.9;
export const BLAST_R = 3;
/** A bolt that hits the sand blows a crater this wide (radius, m) and deep (mm) into it (server/terrain.ts), which
 *  the wind fills in again like any hole. */
export const CRATER_R = 3.2;
export const CRATER_MM = 1400;

/** The cannon's pivot, world, for a body of `scale` at (x, bodyY, z) facing `yaw` (level body). */
export function gunPivot<T extends { x: number; y: number; z: number }>(x: number, bodyY: number, z: number, yaw: number, scale: number, out: T): T {
  out.x = x + Math.sin(yaw) * GUN_MOUNT.z * scale;
  out.y = bodyY + (GUN_MOUNT.y + GUN_PIVOT) * scale;
  out.z = z + Math.cos(yaw) * GUN_MOUNT.z * scale;
  return out;
}

// --- Drones ---

/** Night is when the sun is this far below the horizon (radians); drones come out then. */
export const NIGHT_SUN = -0.06;
/** Hover height above the ground (m). */
export const DRONE_ALT = 20;
/** The searchlight looks this far below the horizon (radians) while it sweeps... */
export const BEAM_PITCH = 0.85;
/** ...from side to side by this much (radians) every SWEEP_S seconds. */
export const SWEEP = 0.65;
export const SWEEP_S = 7;
/** The beam's half-angle (radians) and reach (m). */
export const BEAM_HALF = 0.22;
export const BEAM_RANGE = 75;
/** Drone speeds (m/s): patrolling, and following someone it has locked on (you walk 6, sprint 11). */
export const DRONE_SPEED = 5;
export const CHASE_SPEED = 5.5;
/** Locked on, the beam turns after you at most this fast (rad/s): at chase distance a sprint sideways outruns it. */
export const TRACK_RATE = 0.22;
/** Locked on, it hangs this far back from you (m, horizontally). */
export const CHASE_BACK = 14;
/** It notices anyone in the open within this distance (m, horizontally) it has a line of sight to, and searches
 *  them out: flies over and turns its beam onto them at most SEEK_RATE (rad/s). Out of sight or past NOTICE_R *
 *  SEEK_GIVE_UP for LOSE_MS, it goes back to sweeping. */
export const NOTICE_R = 60;
export const SEEK_RATE = 0.35;
export const SEEK_GIVE_UP = 1.4;
/** Out of the beam for this long (ms), it lets you go, and won't lock on to you again for IGNORE_MS. */
export const LOSE_MS = 1200;
export const IGNORE_MS = 15_000;
/** Guardians this close (m) to someone a drone has locked on to come for them. */
export const ALERT_R = 420;

/** The beam's centre line from the drone at (x, y, z) facing `yaw` (three.js: forward = (sin, cos)) swept `sweep`
 *  radians aside, as a unit vector into `out`. */
export function beamDir<T extends { x: number; y: number; z: number }>(yaw: number, sweep: number, out: T): T {
  const a = yaw + sweep, c = Math.cos(BEAM_PITCH);
  out.x = Math.sin(a) * c;
  out.y = -Math.sin(BEAM_PITCH);
  out.z = Math.cos(a) * c;
  return out;
}

/** How far the sweep is turned at server time `t` (ms) for drone `id`. */
export function sweepAt(id: number, t: number): number {
  return SWEEP * Math.sin((t / 1000 / SWEEP_S) * Math.PI * 2 + id * 1.7);
}

/** Is the open line from (ax, ay, az) to (bx, by, bz) clear of the ground? */
export function lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  const len = Math.hypot(bx - ax, by - ay, bz - az);
  const n = Math.ceil(len / 2);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
    if (y < heightAt(x, z)) return false;
  }
  return true;
}

/**
 * Is a player with feet at (px, py, pz) lit by a beam from (x, y, z) along unit vector (dx, dy, dz)? Inside the
 * cone (checked at the chest), in range, out of the shelters and nothing in the way.
 */
export function inBeam(x: number, y: number, z: number, dx: number, dy: number, dz: number, px: number, py: number, pz: number): boolean {
  const cy = py + 1.1;
  const vx = px - x, vy = cy - y, vz = pz - z;
  const d = Math.hypot(vx, vy, vz);
  if (d > BEAM_RANGE || d < 1) return false;
  if ((vx * dx + vy * dy + vz * dz) / d < Math.cos(BEAM_HALF)) return false;
  if (indoors(px, py, pz)) return false;
  return lineOfSight(x, y, z, px, cy, pz);
}

/** Where a beam from (x, y, z) along (dx, dy, dz) meets the ground, within BEAM_RANGE (marching), into `out`. */
export function beamGround<T extends { x: number; y: number; z: number }>(x: number, y: number, z: number, dx: number, dy: number, dz: number, out: T): T {
  let t = 0;
  for (; t < BEAM_RANGE; t += 1.5) if (y + dy * t < heightAt(x + dx * t, z + dz * t)) break;
  t = Math.min(t, BEAM_RANGE);
  out.x = x + dx * t;
  out.y = y + dy * t;
  out.z = z + dz * t;
  return out;
}
