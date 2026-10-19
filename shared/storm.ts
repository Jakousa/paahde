// Sandstorms: local, short and now and then. The server (server/storm.ts) picks when and where one
// blows up, near a random player, and broadcasts the list; everything else is plain math on that list
// and the server clock (snapshot time, Net.serverTime on the client), so both sides agree on where each
// storm is and how strong.
//
// A storm is a column of dust drifting downwind (the dunes' WIND). It's announced WARN_MS before it
// starts (players in its path hear a warning beep), builds over RAMP_MS, blows for 70–180 s in all, and
// dies down over the last RAMP_MS. Its strength at a point is the envelope times a radial falloff: full
// out to EDGE·r, nothing past r.
//
// Gameplay: inside one it's hotter (STORM_TEMP on the felt temperature, server/water.ts), you walk slower and
// it pushes you downwind (STORM_SLOW, STORM_PUSH, shared/sim.ts), and the locator bar is lost in the dust
// (src/storm.ts). The base keeps it out.
//
// Mega-storms (`front`): rare world-wide storm fronts. A straight wall of dust across the whole world rolls
// downwind at FRONT_SPEED, faster than you can run and only outrun on a good bike. It appears FRONT_LEAD_S
// upwind of the first player it will reach, takes FRONT_PASS_S to blow over a spot, and dies down after
// it has passed the last player (server/storm.ts). Out in the open inside it you choke (frontExposure,
// CHOKE_S; server/world.ts kills you); in a bunker or in the lee of a cliff (sheltered) you're fine.
import { WIND } from './dunes.ts';
import { indoors } from './shelters.ts';
import { heightAt } from './terrain.ts';

export type Storm = {
  id: number;
  /** Centre (m) at `start`; it drifts downwind at `speed` m/s from there. A front: a point on its leading edge. */
  x: number;
  z: number;
  /** Radius (m). A front: how deep the dust behind its leading edge is. */
  r: number;
  speed: number;
  /** Server-clock ms: the storm starts (warning ends) and ends. Announced at start − WARN_MS. */
  start: number;
  end: number;
  /** A mega-storm front, not a column. */
  front?: boolean;
};

/** Warning before a storm starts (ms). */
export const WARN_MS = 20_000; // the best storm detector (shared/gear.ts stormWarnS) warns this early
/** Build-up and dying down (ms), inside the storm's length. */
export const RAMP_MS = 25_000;
export const MIN_LEN_MS = 70_000;
export const MAX_LEN_MS = 180_000;
/** Full strength out to this fraction of the radius, fading to nothing at the radius. */
export const EDGE = 0.55;
/** Felt °C added at full strength (outside the base). */
export const STORM_TEMP = 10;
/** Players this far (m) beyond a storm's path get the warning too. */
export const WARN_MARGIN = 40;

/** Mega-storm front speed (m/s): a slide (15–18) can't keep ahead of it, only a bike better than basic
 *  (shared/gear.ts bikeTopSpeed: 20–50). */
export const FRONT_SPEED = 32;
/** A front appears this long (s) before it reaches the first player. */
export const FRONT_LEAD_S = 30;
/** How long (s) a front takes to blow over a spot that stays put: its depth is FRONT_SPEED times this. */
export const FRONT_PASS_S = 60;
/** It fades in (appearing) and dies down over this long (ms). */
export const FRONT_RAMP_MS = 8_000;
/** The leading wall thickens to full over this many metres; the back thins out over FRONT_TAIL. */
export const FRONT_WALL = 40;
export const FRONT_TAIL = 300;
/** Seconds out in the open at full strength before it chokes you; it wears off this many times slower. */
export const CHOKE_S = 12;
export const CHOKE_RECOVER = 0.5;
/** Strength under this (the thin tail, the fade) doesn't choke. */
const CHOKE_FROM = 0.3;

/** The storm's centre at server time `t` (ms), written into `out`. */
export function stormCentre<T extends { x: number; z: number }>(s: Storm, t: number, out: T): T {
  const d = (s.speed * (t - s.start)) / 1000;
  out.x = s.x + WIND.x * d;
  out.z = s.z + WIND.z * d;
  return out;
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** Strength over time, 0..1: 0 before start and after end, ramping in and out. */
export function stormEnvelope(s: Storm, t: number): number {
  const ramp = s.front ? FRONT_RAMP_MS : RAMP_MS;
  return smooth((t - s.start) / ramp) * smooth((s.end - t) / ramp);
}

const c = { x: 0, z: 0 };
/** How far (m) front `s` has rolled past (x, z) at time `t`: < 0 still ahead of it, > s.r out the back. */
export function frontDepth(s: Storm, x: number, z: number, t: number): number {
  stormCentre(s, t, c);
  return (c.x - x) * WIND.x + (c.z - z) * WIND.z;
}

/** Server time (ms) front `s` reaches (x, z) standing still. */
export function frontArrival(s: Storm, x: number, z: number): number {
  return s.start - (frontDepth(s, x, z, s.start) / s.speed) * 1000;
}

/** Strength of storm `s` at (x, z) at server time `t`, 0..1. */
export function stormStrength(s: Storm, x: number, z: number, t: number): number {
  const e = stormEnvelope(s, t);
  if (e <= 0) return 0;
  if (s.front) {
    const u = frontDepth(s, x, z, t);
    return e * smooth(u / FRONT_WALL) * smooth((s.r - u) / FRONT_TAIL);
  }
  stormCentre(s, t, c);
  const d = Math.hypot(x - c.x, z - c.z) / s.r;
  return e * (1 - smooth((d - EDGE) / (1 - EDGE)));
}

/** The strongest storm at (x, z) at time `t`, 0..1. */
export function stormAt(storms: readonly Storm[], x: number, z: number, t: number): number {
  let k = 0;
  for (const s of storms) k = Math.max(k, stormStrength(s, x, z, t));
  return k;
}

/** Drones go dark (no light, no aggro) within this many radii of a storm's centre. */
export const DRONE_DARK_R = 1.5;
/** Is (x, z) within `k` radii (default DRONE_DARK_R) of a blowing storm's centre at server time `t`? */
export function nearStorm(storms: readonly Storm[], x: number, z: number, t: number, k = DRONE_DARK_R): boolean {
  for (const s of storms) {
    if (t < s.start || t > s.end) continue;
    if (s.front) {
      const u = frontDepth(s, x, z, t);
      if (u > -FRONT_WALL * 2 * (k - 1) && u < s.r) return true;
      continue;
    }
    stormCentre(s, t, c);
    if (Math.hypot(x - c.x, z - c.z) < s.r * k) return true;
  }
  return false;
}

/** Storm strength slowing a player standing at (x, y, z) (feet): none in the base. Fed to step() by
 *  the server per input and by the client per predicted tick (kept for replays), shared/sim.ts. */
export function stormDrag(storms: readonly Storm[], x: number, y: number, z: number, t: number): number {
  if (indoors(x, y + 1, z)) return 0;
  let k = 0, f = 0;
  for (const s of storms) {
    if (s.front) f = Math.max(f, stormStrength(s, x, z, t));
    else k = Math.max(k, stormStrength(s, x, z, t));
  }
  // In the lee of a cliff the front blows over your head.
  if (f > 0 && sheltered(x, y, z)) f *= LEE_DRAG;
  return Math.max(k, f);
}

/** Is a mega-storm front out (appeared, not yet died down) at time `t`? */
export function frontOut(storms: readonly Storm[], t: number): boolean {
  return storms.some((s) => s.front && t >= s.start && t < s.end);
}

/** Any storm's static knocks out our electronics once it blows this hard where you stand (out of a bunker): the wrist
 *  computer (clock, thermometer, locator), the storm detector, the jammer, the receivers. src/storm.ts toolsDown on the
 *  client, toolsDown() here for the server's checks. */
export const STATIC_AT = 0.35;
/** Are tools dead for someone standing at (x, y, z) (feet) at time `t`? */
export function toolsDown(storms: readonly Storm[], x: number, y: number, z: number, t: number): boolean {
  return !indoors(x, y + 1, z) && stormAt(storms, x, z, t) > STATIC_AT;
}

/** A storm front's static seizes up machines on the ground (walkers, crawlers, harvesters) once it blows this hard
 *  over them: they stop dead and hold fire until it has passed. */
export const SEIZE_AT = 0.35;
/** Is a machine on the ground at (x, z) seized up by a storm front at time `t`? Each ground enemy's brain asks this
 *  every tick and, while it's true, neither moves nor attacks (server/guardians.ts, server/harvesters.ts). */
export function seized(storms: readonly Storm[], x: number, z: number, t: number): boolean {
  return frontAt(storms, x, z, t) > SEIZE_AT;
}

/** The strongest mega-storm front at (x, z) at time `t`, 0..1 (no columns). */
export function frontAt(storms: readonly Storm[], x: number, z: number, t: number): number {
  let k = 0;
  for (const s of storms) if (s.front) k = Math.max(k, stormStrength(s, x, z, t));
  return k;
}

/** Wind-shadow test: distances (m) upwind to look for rock, how far over the eye it must rise, and how steeply
 *  (rise per metre: steeper than a dune's lee face, ~33°, so only cliffs, boulders and pillars count). */
const LEE_STEPS = [1.5, 3, 5, 8, 12, 17, 24];
const LEE_OVER = 0.6;
const LEE_SLOPE = 0.8;
const EYE = 1.6;
/** What's left of a front's push in the lee. */
const LEE_DRAG = 0.3;

/** Out of a mega-storm's wind at (x, y, z) (feet): in a bunker, or with rock rising steeply just upwind. */
export function sheltered(x: number, y: number, z: number): boolean {
  if (indoors(x, y + 1, z)) return true;
  const eye = y + EYE;
  for (const d of LEE_STEPS) {
    const rise = heightAt(x - WIND.x * d, z - WIND.z * d) - eye;
    if (rise > LEE_OVER && rise > d * LEE_SLOPE) return true;
  }
  return false;
}

/** How fast a mega-storm chokes someone standing at (x, y, z) (feet) at time `t`: CHOKE_S of it kills (1 is full
 *  strength out in the open); 0 under cover or out of it. */
export function frontExposure(storms: readonly Storm[], x: number, y: number, z: number, t: number): number {
  const f = frontAt(storms, x, z, t);
  if (f <= CHOKE_FROM || sheltered(x, y, z)) return 0;
  return (f - CHOKE_FROM) / (1 - CHOKE_FROM);
}

/** Will storm `s` pass over (x, z) (within WARN_MARGIN), standing still there? */
export function inStormPath(s: Storm, x: number, z: number): boolean {
  if (s.front) return frontArrival(s, x, z) < s.end;
  // Distance from the point to the segment the centre travels from start to end.
  const len = (s.speed * (s.end - s.start)) / 1000;
  const along = Math.min(len, Math.max(0, (x - s.x) * WIND.x + (z - s.z) * WIND.z));
  return Math.hypot(x - (s.x + WIND.x * along), z - (s.z + WIND.z * along)) < s.r + WARN_MARGIN;
}
