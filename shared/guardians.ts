// Guardians and drones: the desert's machines. Server-simulated (server/guardians.ts), sent to clients ~10 times a
// second ('bots', shared/protocol.ts) and drawn by src/world/guardians.ts (the legs are client-side IK) and
// src/world/drones.ts.
//
// Guardians are giant three- or four-legged walkers that patrol around crash sites, now and then wander to the
// next one, and stand guard for a while. Come within SIGHT of one (or get caught in a drone's searchlight near
// one) and it hunts you, slower than you can walk; if it gets over you, you're crushed.
//
// Drones come out at night (sun below NIGHT_SUN): a few hover around every player out in the open, sweeping a
// searchlight over the sand. Step into the beam and it locks on: it follows you, the beam burns (BURN heat per
// second, shared/water.ts) and every guardian within ALERT_R comes for you. Break its line of sight (behind a
// dune crest, into the base) or outrun it for LOSE_MS and it gives up.
import { inBase } from './base.ts';
import { heightAt } from './terrain.ts';

// --- Guardian body and legs (metres; must match tools/blender/guardians.py) ---

/** Hip height above the ground the feet stand on. */
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

/** Walking speeds (m/s) and how fast they turn (rad/s). A player walks 6 m/s. */
export const PATROL_SPEED = 1.8;
export const HUNT_SPEED = 4.4;
export const TURN_RATE = 0.22;
export const HUNT_TURN_RATE = 0.45;
/** A guardian notices a player out in the open this close (m), from any side. */
export const SIGHT = 42;
/** Under the body this close (m, horizontally) while it hunts you: crushed. */
export const CRUSH_R = 5;

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
export const BEAM_HALF = 0.15;
export const BEAM_RANGE = 75;
/** Drone speeds (m/s): patrolling, and following someone it has locked on (you sprint 11). */
export const DRONE_SPEED = 5;
export const CHASE_SPEED = 6.5;
/** Locked on, it hangs this far back from you (m, horizontally). */
export const CHASE_BACK = 14;
/** Out of the beam for this long (ms), it lets you go. */
export const LOSE_MS = 2500;
/** Heat per second while the beam is on you (shared/water.ts HEAT_MAX 100). */
export const BURN = 5;
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
 * cone (checked at the chest), in range, out of the base and nothing in the way.
 */
export function inBeam(x: number, y: number, z: number, dx: number, dy: number, dz: number, px: number, py: number, pz: number): boolean {
  const cy = py + 1.1;
  const vx = px - x, vy = cy - y, vz = pz - z;
  const d = Math.hypot(vx, vy, vz);
  if (d > BEAM_RANGE || d < 1) return false;
  if ((vx * dx + vy * dy + vz * dz) / d < Math.cos(BEAM_HALF)) return false;
  if (inBase(px, py, pz)) return false;
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
