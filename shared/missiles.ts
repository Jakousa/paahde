// Guardian missiles: what a hunting guardian fires at its prey (unless they're within MISSILE_MIN_R of it) and what a
// drone's searchlight calls down. While a night drone has someone locked in its beam
// (shared/guardians.ts), the SHOOTERS nearest guardians within MISSILE_R of them each launch a missile at them every
// MISSILE_MS (server/guardians.ts), from far off: a guardian is usually a kilometre or more away. A missile climbs
// out of the guardian's cannon, arcs high over the dunes and comes down on where its target was heading (a little ahead of them, a little scattered) after a flight of FLIGHT_MIN to
// FLIGHT_MAX seconds; anyone within BLAST_R of the impact dies. The aim point is fixed at launch and drawn on the
// sand (src/world/missiles.ts), so a player who keeps moving and turns can get out from under it.
//
// The path is a quadratic Bézier from launch to impact through a control point raised above the middle, the
// same on the server and the client, so everyone sees the missile fall where it bursts.

/** The SHOOTERS nearest guardians within this distance (m) of someone a drone has locked on fire at them. */
export const MISSILE_R = 1500;
export const SHOOTERS = 2;
/** A guardian hunting someone shells them too, beam or not, unless they're within this distance (m) of it. */
export const MISSILE_MIN_R = 40;
/** Each guardian fires one every this long (ms) while the beam holds someone; the first after FIRST_MS. */
export const MISSILE_MS = 6000;
export const FIRST_MS = 1200;
/** Flight time (s): distance / CRUISE, between these. */
export const CRUISE = 160;
export const FLIGHT_MIN = 3.5;
export const FLIGHT_MAX = 8;
/** The arc's control point rises this far (m) above the middle, plus ARC × the distance. */
export const ARC_BASE = 40;
export const ARC = 0.5;
/** Impact kills within this distance (m). */
export const BLAST_R = 6;
/** Aims this fraction of the way to where the target will be by impact, scattered up to SCATTER m. */
export const LEAD = 0.85;
export const SCATTER = 4;

export type MissilePath = { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; flight: number };

/** The arc's control point for a path. */
function control(p: MissilePath) {
  const d = Math.hypot(p.x1 - p.x0, p.z1 - p.z0);
  return { x: (p.x0 + p.x1) / 2, y: Math.max(p.y0, p.y1) + ARC_BASE + ARC * d, z: (p.z0 + p.z1) / 2 };
}

export function flightTime(dist: number): number {
  return Math.min(FLIGHT_MAX, Math.max(FLIGHT_MIN, dist / CRUISE));
}

/** Where a missile on path `p` is `t` seconds after launch (clamped to the flight), into `out`. */
export function missileAt<T extends { x: number; y: number; z: number }>(p: MissilePath, t: number, out: T): T {
  const c = control(p);
  const u = Math.min(1, Math.max(0, t / p.flight)), a = (1 - u) * (1 - u), b = 2 * u * (1 - u), e = u * u;
  out.x = a * p.x0 + b * c.x + e * p.x1;
  out.y = a * p.y0 + b * c.y + e * p.y1;
  out.z = a * p.z0 + b * c.z + e * p.z1;
  return out;
}
