// Sand vortices: colossal whirlwinds roaming the desert. Every world has ROAMERS of them, out from the moment it starts
// and never dying down (server/storm.ts makes them and sends them with the storms); everything else is plain math on
// them and the server clock, so the server and every client agree on where each is.
//
// A roamer circles the world's origin (shared/origin.ts; the crashed ship where players arrive lies by it) out among the
// crash sites, ORBIT_MIN..ORBIT_MAX m from it, about one lap per LAP_S; it sweeps along fastest where it's heading
// downwind (the dunes' WIND) and labours where it's heading into it, and its distance out swells and shrinks on slow
// waves seeded per vortex. It never comes near the origin or the ship.
//
// The debug menu can also summon a short-lived one near you: that one drifts downwind at DRIFT m/s, swinging MEANDER m
// to each side, kept KEEP_OUT from the origin and the ship (sliding round the edge, dying down if it heads deep in).
//
// Gameplay: within PULL_R it drags you in and round (vortexPull, shared/sim.ts), too hard to walk out of past the
// middle of that; a bike gets you out. Inside CORE_R you're dead, thrown high into the air (server/world.ts). Drones
// are dragged in and torn apart (server/drones.ts). Bunkers and shelters keep it out.
import { ORIGIN } from './origin.ts';
import { WIND } from './dunes.ts';
import { indoors } from './shelters.ts';
import { SHIP_AT } from './shipSpot.ts';

export type Vortex = {
  id: number;
  /** Where its path starts (m), at `start`. */
  x: number;
  z: number;
  /** Server-clock ms: it spins up from `start` (over RAMP_MS) and dies down by `end`. */
  start: number;
  end: number;
  /** Phase of its meander, 0..2π. */
  seed: number;
  /** A roamer: circles (x, z) (the origin) forever instead (`end` is never). */
  roam?: boolean;
};

/** Roamers per world; their distance (m) from the origin; a lap (s) at its average distance; how much faster (and slower)
 *  it goes heading downwind (and into the wind), as a fraction. */
export const ROAMERS = 2;
const ORBIT_MIN = 850;
const ORBIT_MAX = 2550;
const LAP_S = 1800;
const WIND_SWAY = 0.5;
/** The never of a roamer's `end` (ms). */
export const NEVER = Number.MAX_SAFE_INTEGER;
const WIND_ANGLE = Math.atan2(WIND.z, WIND.x);

/** Downwind drift (m/s), and how far (m) it swings to each side of that line. */
export const DRIFT = 5;
export const MEANDER = 260;
/** Spinning up and dying down (ms), inside its life. */
export const RAMP_MS = 15_000;
/** Pulled in from this far (m); dead inside CORE_R (m). PULL_MAX: the pull (m/s) at the core's edge. */
export const PULL_R = 450;
export const CORE_R = 55;
export const PULL_MAX = 20;
/** How much of the pull goes round it rather than in. */
const SWIRL = 0.75;
/** Its centre keeps this far (m) from the origin and the crashed ship. */
export const KEEP_OUT = PULL_R + 150;
const AVOID = SHIP_AT ? [ORIGIN, SHIP_AT] : [ORIGIN];

const PX = -WIND.z, PZ = WIND.x; // across the wind

/** Where its wandering would take it at server time `t` (ms), before it's kept off the origin and the ship. */
function wander<T extends { x: number; z: number }>(v: Vortex, t: number, out: T): T {
  const s = (t - v.start) / 1000;
  if (v.roam) {
    // Round the origin: the angle runs faster where the way round it points downwind (heading (cos a, -sin a) at angle a).
    const w = (Math.PI * 2) / LAP_S, p = w * s + v.seed;
    const a = p + WIND_SWAY * Math.sin(p + WIND_ANGLE);
    const mid = (ORBIT_MIN + ORBIT_MAX) / 2, half = (ORBIT_MAX - ORBIT_MIN) / 2;
    const r = mid + half * (0.8 * Math.sin(s * 0.0021 + v.seed * 1.9) + 0.2 * Math.sin(s * 0.013 + v.seed * 3.1));
    out.x = v.x + Math.sin(a) * r;
    out.z = v.z + Math.cos(a) * r;
    return out;
  }
  const along = DRIFT * s + 60 * Math.sin(s * 0.033 + v.seed * 1.7);
  const side = MEANDER * (0.7 * Math.sin(s * 0.021 + v.seed) + 0.3 * Math.sin(s * 0.047 + v.seed * 2.3));
  out.x = v.x + WIND.x * along + PX * side;
  out.z = v.z + WIND.z * along + PZ * side;
  return out;
}

/** The vortex's centre at server time `t` (ms), written into `out`: its wandering, pushed out to KEEP_OUT from the origin
 *  and the ship when it strays nearer (sliding round the edge; one heading deep in has died down, vortexEnvelope). */
export function vortexCentre<T extends { x: number; z: number }>(v: Vortex, t: number, out: T): T {
  wander(v, t, out);
  let x = out.x, z = out.z;
  for (const a of AVOID) {
    const dx = x - a.x, dz = z - a.z, d = Math.hypot(dx, dz);
    if (d >= KEEP_OUT) continue;
    // Pushed out to the edge of the keep-out (straight upwind of it when dead on top).
    const k = d > 1e-3 ? KEEP_OUT / d : 0;
    x = d > 1e-3 ? a.x + dx * k : a.x - WIND.x * KEEP_OUT;
    z = d > 1e-3 ? a.z + dz * k : a.z - WIND.z * KEEP_OUT;
  }
  out.x = x;
  out.z = z;
  return out;
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

const c = { x: 0, z: 0 };

/** Its strength at server time `t`, 0..1: spinning up, dying down, and breaking up where its wandering would take it
 *  deep into the keep-out round the origin or the ship (so it never sweeps round the edge fast; it re-forms past it). */
export function vortexEnvelope(v: Vortex, t: number): number {
  let e = smooth((t - v.start) / RAMP_MS) * smooth((v.end - t) / RAMP_MS);
  if (e <= 0) return 0;
  wander(v, t, c);
  for (const a of AVOID) e *= smooth((Math.hypot(c.x - a.x, c.z - a.z) - KEEP_OUT * 0.35) / (KEEP_OUT * 0.4));
  return e;
}

/** The drag (m/s, xz) on someone standing at (x, y, z) (feet) at server time `t`, into `out`: towards each vortex
 *  near, and round it, stronger the closer. None indoors. Fed to step() alongside the storm (shared/sim.ts). */
export function vortexPull<T extends { x: number; z: number }>(vs: readonly Vortex[], x: number, y: number, z: number, t: number, out: T): T {
  out.x = 0;
  out.z = 0;
  if (!vs.length || indoors(x, y + 1, z)) return out;
  for (const v of vs) {
    const e = vortexEnvelope(v, t);
    if (e <= 0) continue;
    vortexCentre(v, t, c);
    const dx = c.x - x, dz = c.z - z, d = Math.hypot(dx, dz);
    if (d >= PULL_R || d < 1e-3) continue;
    const k = e * PULL_MAX * Math.pow(1 - d / PULL_R, 1.3);
    // Round it the way its dust turns (src/post.ts).
    out.x += (dx / d) * k - (dz / d) * k * SWIRL;
    out.z += (dz / d) * k + (dx / d) * k * SWIRL;
  }
  out.x = Math.round(out.x * 1000) / 1000; // (sent along with each input's replay: keep it exact)
  out.z = Math.round(out.z * 1000) / 1000;
  return out;
}

/** How close (0..1, 1 at its core's edge) the nearest vortex is to (x, z): its roar and grit (src/vortex.ts). */
export function vortexNear(vs: readonly Vortex[], x: number, z: number, t: number): number {
  let k = 0;
  for (const v of vs) {
    const e = vortexEnvelope(v, t);
    if (e <= 0) continue;
    vortexCentre(v, t, c);
    k = Math.max(k, e * smooth(1 - (Math.hypot(c.x - x, c.z - z) - CORE_R) / (PULL_R * 1.5)));
  }
  return k;
}

/** The vortex whose core (x, y, z) (feet) is in at time `t`, or null. Not indoors. */
export function inVortexCore(vs: readonly Vortex[], x: number, y: number, z: number, t: number): Vortex | null {
  if (!vs.length || indoors(x, y + 1, z)) return null;
  for (const v of vs) {
    if (vortexEnvelope(v, t) < 0.5) continue;
    vortexCentre(v, t, c);
    if (Math.hypot(c.x - x, c.z - z) < CORE_R) return v;
  }
  return null;
}
