// Poison gas: a night-time weather event. A heavy, yellow-green pollution cloud creeps in over the land from one
// side, like a storm front (shared/storm.ts) but low: it lies on the ground, rising behind its leading edge over
// GAS_RISE_S to GAS_DEPTH over the dune corridors' floor (shared/dunes.ts duneFloor), so the crests of big dunes, rock
// and cliffs stand out of it. It sinks into every shelter, so the usual cover is a trap. It
// doesn't touch electronics, push or blind machines: it only chokes people whose head is in it, darkening their view
// until they die (GAS_S; server/world.ts counts it, src/gas.ts mirrors it and draws the view going dark).
//
// The server (server/storm.ts) picks when, only at night, and broadcasts the list with the storms; everything else is
// plain math on that list and the server clock, as for storms.
import { duneFloor, WORLD_SEED } from './dunes.ts';
import { indoors } from './shelters.ts';

export type Gas = {
  id: number;
  /** A point on the leading edge at `start`, and the unit xz direction it creeps (m/s: `speed`). */
  x: number;
  z: number;
  dx: number;
  dz: number;
  speed: number;
  /** How deep (m, along the direction) the cloud is behind its leading edge. */
  r: number;
  /** Server-clock ms: it appears (GAS_LEAD_S from the first player) and has sunk away. */
  start: number;
  end: number;
};

/** Creeping speed (m/s): a bit faster than walking (7.5), so you can't just walk away; you climb out of it. */
export const GAS_SPEED = 9;
/** It appears this long (s) before it reaches the first player. */
export const GAS_LEAD_S = 30;
/** How long (s) it takes to rise to full depth over a spot once its edge has passed. */
export const GAS_RISE_S = 25;
/** How long (s) it lies over a spot that stays put: its depth is GAS_SPEED times this. */
export const GAS_PASS_S = 110;
/** Its back sinks away over this long (s) of its depth. */
export const GAS_TAIL_S = 30;
/** It fades in (appearing) and sinks away at the end over this long (ms). */
export const GAS_RAMP_MS = 10_000;
/** How high (m) it stands over the dune floor at full depth: small dunes (≤ 3.5 m) are under it, big ones (12–30 m),
 *  rocks and cliffs stick out. */
export const GAS_DEPTH = 7;
/** Seconds with your head in it before it kills; it wears off this many times slower. */
export const GAS_S = 10;
export const GAS_RECOVER = 0.5;
/** After respawning (by a bedroll or at the pod, which may be in it) the gas doesn't count for this long (s): time to get out and
 *  up, so one cloud can't kill you over and over and eat the world's lives. */
export const GAS_GRACE_S = 25;
/** Eye height over the feet (m): the gas has to be over it to choke you. */
const EYE = 1.6;
/** The gas's surface is soft: fully over your eyes this far (m) under it, clear this far over it. */
const SURFACE = 0.4;

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** Strength over time, 0..1: it rises in and sinks away at the end. */
export function gasEnvelope(g: Gas, t: number): number {
  return smooth((t - g.start) / GAS_RAMP_MS) * smooth((g.end - t) / GAS_RAMP_MS);
}

/** How far (m) gas `g`'s leading edge has crept past (x, z) at time `t`: < 0 still ahead of it, > g.r out the back. */
export function gasBehind(g: Gas, x: number, z: number, t: number): number {
  const d = (g.speed * (t - g.start)) / 1000;
  return (g.x - x) * g.dx + (g.z - z) * g.dz + d;
}

/** Server time (ms) gas `g` reaches (x, z) standing still. */
export function gasArrival(g: Gas, x: number, z: number): number {
  return g.start - (gasBehind(g, x, z, g.start) / g.speed) * 1000;
}

/** How deep (m) gas `g` lies over the dune floor at (x, z) at time `t`. */
export function gasDepth(g: Gas, x: number, z: number, t: number): number {
  const e = gasEnvelope(g, t);
  if (e <= 0) return 0;
  const u = gasBehind(g, x, z, t);
  if (u <= 0 || u >= g.r) return 0;
  return GAS_DEPTH * e * smooth(u / (g.speed * GAS_RISE_S)) * smooth((g.r - u) / (g.speed * GAS_TAIL_S));
}

/** The deepest gas (m over the dune floor) at (x, z) at time `t`. */
export function gasDepthAt(gas: readonly Gas[], x: number, z: number, t: number): number {
  let k = 0;
  for (const g of gas) k = Math.max(k, gasDepth(g, x, z, t));
  return k;
}

/** The height (m) of the gas's surface at (x, z) at time `t`; -Infinity where there's none. */
export function gasTop(gas: readonly Gas[], x: number, z: number, t: number): number {
  const d = gasDepthAt(gas, x, z, t);
  return d > 0 ? duneFloor(x, z, WORLD_SEED) + d : -Infinity;
}

/** How much someone standing at (x, y, z) (feet) breathes gas at time `t`, 0..1: GAS_S of 1 kills. In a shelter it
 *  has seeped in as soon as it lies over the spot a metre deep; out in the open, by how far it's over your eyes. */
export function gasExposure(gas: readonly Gas[], x: number, y: number, z: number, t: number): number {
  if (!gas.length) return 0;
  const d = gasDepthAt(gas, x, z, t);
  if (d <= 0) return 0;
  if (indoors(x, y + 1, z)) return smooth(d - 0.5);
  const over = duneFloor(x, z, WORLD_SEED) + d - (y + EYE);
  return smooth((over + SURFACE) / (2 * SURFACE));
}

/** Is any gas out (appeared, not yet sunk away) at time `t`? */
export function gasOut(gas: readonly Gas[], t: number): boolean {
  return gas.some((g) => t >= g.start && t < g.end);
}
