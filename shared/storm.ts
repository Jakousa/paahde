// Sandstorms: local, short and now and then. The server (server/storm.ts) picks when and where one
// blows up, near a random player, and broadcasts the list; everything else is plain math on that list
// and the server clock (snapshot time, Net.serverTime on the client), so both sides agree on where each
// storm is and how strong.
//
// A storm is a column of dust drifting downwind (the dunes' WIND). It's announced WARN_MS before it
// starts (players in its path hear a warning beep), builds over RAMP_MS, blows for 30–150 s in all, and
// dies down over the last RAMP_MS. Its strength at a point is the envelope times a radial falloff: full
// out to EDGE·r, nothing past r.
//
// Gameplay: inside one it's hotter (STORM_TEMP on the felt temperature, server/water.ts), you walk slower and
// it pushes you downwind (STORM_SLOW, STORM_PUSH, shared/sim.ts), and the locator bar is lost in the dust
// (src/storm.ts). The base keeps it out.
import { inBase } from './base.ts';
import { WIND } from './dunes.ts';

export type Storm = {
  id: number;
  /** Centre (m) at `start`; it drifts downwind at `speed` m/s from there. */
  x: number;
  z: number;
  /** Radius (m). */
  r: number;
  speed: number;
  /** Server-clock ms: the storm starts (warning ends) and ends. Announced at start − WARN_MS. */
  start: number;
  end: number;
};

/** Warning before a storm starts (ms). */
export const WARN_MS = 20_000; // the best storm detector (shared/gear.ts stormWarnS) warns this early
/** Build-up and dying down (ms), inside the storm's length. */
export const RAMP_MS = 6_000;
export const MIN_LEN_MS = 30_000;
export const MAX_LEN_MS = 150_000;
/** Full strength out to this fraction of the radius, fading to nothing at the radius. */
export const EDGE = 0.55;
/** Felt °C added at full strength (outside the base). */
export const STORM_TEMP = 10;
/** Players this far (m) beyond a storm's path get the warning too. */
export const WARN_MARGIN = 40;

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
  return smooth((t - s.start) / RAMP_MS) * smooth((s.end - t) / RAMP_MS);
}

const c = { x: 0, z: 0 };
/** Strength of storm `s` at (x, z) at server time `t`, 0..1. */
export function stormStrength(s: Storm, x: number, z: number, t: number): number {
  const e = stormEnvelope(s, t);
  if (e <= 0) return 0;
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

/** Storm strength slowing a player standing at (x, y, z) (feet): none in the base. Fed to step() by
 *  the server per input and by the client per predicted tick (kept for replays), shared/sim.ts. */
export function stormDrag(storms: readonly Storm[], x: number, y: number, z: number, t: number): number {
  return inBase(x, y + 1, z) ? 0 : stormAt(storms, x, z, t);
}

/** Will storm `s` pass over (x, z) (within WARN_MARGIN), standing still there? */
export function inStormPath(s: Storm, x: number, z: number): boolean {
  // Distance from the point to the segment the centre travels from start to end.
  const len = (s.speed * (s.end - s.start)) / 1000;
  const along = Math.min(len, Math.max(0, (x - s.x) * WIND.x + (z - s.z) * WIND.z));
  return Math.hypot(x - (s.x + WIND.x * along), z - (s.z + WIND.z * along)) < s.r + WARN_MARGIN;
}
