// Electricity at the base: the windmills make it, the battery stations store it (shared/gear.ts buildings, standing
// on the sand: shared/placed.ts). Everything put up round the base is on one grid: what the windmills make goes into
// the stations' batteries, as fast as each will take it; what nobody can take is lost. The server runs it
// (server/power.ts), the clients draw it (src/world/placed.ts: the rotor, the cells' lamps; the numbers in the
// building's panel, src/inventory.ts).
//
// Somewhat realistic, in game time: a game day is DAY_SECONDS of real time (shared/sun.ts), so energy adds up
// GAME_SPEED times faster than the real clock, and watts and kilowatt-hours mean what they would over a game day.
//
//   Wind (windSpeed): hub height, desert: calm before dawn (~2 m/s), strongest in the afternoon (~7), with gusts and a
//     slow weather swing over the days; a sandstorm blows up to ~26 m/s more. One wind for the whole base, the same on
//     server and clients (the shared wall clock, the world's seed).
//   Windmill: a 3.5 m multi-blade rotor: P = ½ ρ A v³ · Cp · η. The bearings set how much of the wind the rotor turns
//     into shaft power (Cp, friction, the wind it needs to start), the coils the generator (its efficiency and the
//     most it can give). In a gale the tail folds it out of the wind (furling) and it nearly stops.
//   Battery station: each battery holds its own charge. A Scrap battery is a car battery (12 V × 50 Ah ≈ 0.6 kWh,
//     lead-acid: takes charge slowly, loses a fifth of it), better tiers better chemistries. The coils are the charger,
//     which caps how fast the station takes power in.
import { DAY_SECONDS, timeOfDayAt } from './sun.ts';
import { vnoise } from './noise.ts';
import { WORLD_SEED } from './world.ts';
import { parsePart } from './items.ts';
import type { PartId } from './salvage.ts';

/** Game seconds per real second. */
export const GAME_SPEED = (24 * 3600) / DAY_SECONDS;

// ---- Wind ----------------------------------------------------------------------------------------------------------

/** Sandstorm (0..1, shared/storm.ts stormAt) adds up to this much wind (m/s). */
const STORM_WIND = 26;

/** Wind speed (m/s) at the hub at shared wall-clock `worldMs`, with a sandstorm of strength `storm` (0..1) blowing. */
export function windSpeed(worldMs: number, storm = 0): number {
  const hour = timeOfDayAt(worldMs) * 24;
  // The day's swing: least before dawn, most mid-afternoon (the ground heats, the air churns).
  const daily = 4.6 + 2.6 * Math.cos((2 * Math.PI * (hour - 15.5)) / 24);
  // Weather over the game days (a system lasts a day or two), and gusts over seconds (real time: you see them).
  const days = worldMs / 1000 / DAY_SECONDS;
  const weather = 0.55 + 0.9 * vnoise(days / 1.5, 0.5, WORLD_SEED ^ 0x5eed);
  const s = worldMs / 1000;
  const gust = 1 + 0.28 * (2 * vnoise(s / 7, 3.5, WORLD_SEED ^ 0x9057) - 1) + 0.12 * (2 * vnoise(s / 41, 7.5, WORLD_SEED ^ 0x41) - 1);
  return Math.max(0, daily * weather * gust + STORM_WIND * storm);
}

// ---- Parts ---------------------------------------------------------------------------------------------------------

/** How many of `part` are fitted, and their mean tier (0 Scrap .. 3 Space-grade). */
function fitted(parts: readonly (string | null)[] | undefined, part: PartId): { n: number; q: number } {
  let n = 0, sum = 0;
  for (const p of parts ?? []) {
    const t = p ? parsePart(p) : null;
    if (t?.part !== part) continue;
    n++;
    sum += t.tier;
  }
  return { n, q: n ? sum / n : 0 };
}

const by = (q: number, lo: number, hi: number) => lo + ((hi - lo) * q) / 3;

// ---- Windmill ------------------------------------------------------------------------------------------------------

export const ROTOR_R = 1.75;
const AREA = Math.PI * ROTOR_R * ROTOR_R;
/** Hot desert air (kg/m³). */
const AIR = 1.15;
/** Above this the tail starts to fold the rotor out of the wind; past FURL_FULL it's edge-on. */
const FURL_START = 15;
const FURL_FULL = 22;
/** Bearings and coils a windmill has (shared/gear.ts GEAR.windmill). */
const WINDMILL_BEARINGS = 6;
const WINDMILL_COILS = 2;

/** A windmill's machinery from its parts: rotor power coefficient, the wind it needs to start, its tip speed ratio
 *  (rotor rim speed over wind speed), the generator's efficiency and the most it gives (W). Null when it can't run (a
 *  bearing missing: the shaft binds). */
export function windmillSpec(parts: readonly (string | null)[] | undefined) {
  const b = fitted(parts, 'bearing'), c = fitted(parts, 'coil');
  if (b.n < WINDMILL_BEARINGS) return null;
  return {
    cp: by(b.q, 0.14, 0.3),
    cutIn: by(b.q, 3.2, 2.0),
    tsr: by(b.q, 0.9, 1.3),
    // Coils missing: the rotor turns, nothing is made.
    eff: c.n < WINDMILL_COILS ? 0 : by(c.q, 0.55, 0.92),
    rated: by(c.q, 400, 1500),
  };
}

/** How far the rotor is folded out of the wind at speed `v`: 0 facing it .. 1 edge-on. */
export const furl = (v: number) => Math.min(1, Math.max(0, (v - FURL_START) / (FURL_FULL - FURL_START)));

/** Electric power (W) of a windmill with `parts` in wind `v` (m/s). */
export function windmillWatts(parts: readonly (string | null)[] | undefined, v: number): number {
  const w = windmillSpec(parts);
  if (!w || v < w.cutIn) return 0;
  // Folded out of the wind, the rotor sees only the part of it across its face.
  const face = Math.cos((furl(v) * 75 * Math.PI) / 180);
  const ve = v * face;
  return Math.min(w.rated, 0.5 * AIR * AREA * ve * ve * ve * w.cp * w.eff);
}

/** The rotor's speed (rad/s, real time: what you see) in wind `v`. */
export function rotorSpeed(parts: readonly (string | null)[] | undefined, v: number): number {
  const w = windmillSpec(parts);
  if (!w || v < w.cutIn * 0.6) return 0;
  const face = Math.cos((furl(v) * 75 * Math.PI) / 180);
  // From a crawl at the start to its working speed once it has the wind.
  const start = Math.min(1, (v - w.cutIn * 0.6) / (w.cutIn * 0.6));
  return (w.tsr * v * face * start) / ROTOR_R;
}

// ---- Battery station -----------------------------------------------------------------------------------------------

/** Each battery by tier (Scrap .. Space-grade): what it holds (kWh), how fast it takes charge (C: of its capacity per
 *  hour) and how much of what goes in it keeps. Scrap is a car battery (lead-acid), Basic a deep-cycle one, Quality a
 *  lithium-ion module, Space-grade something better still. */
export const CELLS = [
  { kwh: 0.6, c: 0.2, eff: 0.8 },
  { kwh: 1.2, c: 0.25, eff: 0.85 },
  { kwh: 2.5, c: 0.7, eff: 0.95 },
  { kwh: 5, c: 1, eff: 0.98 },
];
/** The charger: the most each of its coils passes (W), by tier. */
const CHARGER_W = [300, 600, 1200, 2500];

/** The battery in each slot of a station (by its parts; null for a coil slot or an empty one). */
export function cells(parts: readonly (string | null)[] | undefined) {
  return (parts ?? []).map((p) => {
    const t = p ? parsePart(p) : null;
    return t?.part === 'battery' ? CELLS[t.tier] : null;
  });
}

/** What a station's batteries hold all together (kWh). */
export const capacity = (parts: readonly (string | null)[] | undefined) => cells(parts).reduce((s, c) => s + (c?.kwh ?? 0), 0);

/** The most a station's charger passes (W): its coils' sum. */
export function chargerWatts(parts: readonly (string | null)[] | undefined): number {
  let w = 0;
  for (const p of parts ?? []) {
    const t = p ? parsePart(p) : null;
    if (t?.part === 'coil') w += CHARGER_W[t.tier];
  }
  return w;
}

/** A station: its parts and each slot's charge (kWh, one per part slot). */
export type Store = { parts: readonly (string | null)[]; charge: number[] };

/**
 * Feed `watts` for `gameS` game seconds into the stations, in place: each takes what its charger and its batteries
 * (not full ones) will, the rest is shared out among those with room left. Returns what each took (W, from the grid).
 */
export function charge(stores: Store[], watts: number, gameS: number): number[] {
  // What each will take now: the charger's limit, and each battery's charge rate while it has room.
  const accept = stores.map((s) => {
    const cs = cells(s.parts);
    const each = cs.map((c, i) => (c && s.charge[i] < c.kwh - 1e-9 ? c.kwh * 1000 * c.c : 0));
    return { cs, each, max: Math.min(chargerWatts(s.parts), each.reduce((a, b) => a + b, 0)) };
  });
  const took = stores.map(() => 0);
  // Water-filling: an equal share to each, the one that can't use all of it hands the rest on.
  let left = watts;
  let open = accept.map((a, i) => (a.max > 0 ? i : -1)).filter((i) => i >= 0).sort((a, b) => accept[a].max - accept[b].max);
  while (left > 1e-6 && open.length) {
    const share = left / open.length;
    const i = open[0];
    const w = Math.min(share, accept[i].max - took[i]);
    took[i] += w;
    left -= w;
    open = open.slice(1);
  }
  stores.forEach((s, i) => {
    const a = accept[i];
    const sum = a.each.reduce((x, y) => x + y, 0);
    if (!took[i] || !sum) return;
    // Into the batteries by how fast each takes charge, less what it loses doing it.
    a.cs.forEach((c, j) => {
      if (!c || !a.each[j]) return;
      const kwh = ((took[i] * a.each[j]) / sum) * c.eff * gameS / 3600 / 1000;
      s.charge[j] = Math.min(c.kwh, s.charge[j] + kwh);
    });
  });
  return took;
}

/** A station's charge for parts `parts`, from its old charge under `was`: a battery still in its slot keeps what it
 *  held (as far as it fits), anything new starts empty. */
export function recharge(was: readonly (string | null)[], charge: readonly number[], parts: readonly (string | null)[]): number[] {
  const cs = cells(parts);
  return parts.map((p, i) => (p && p === was[i] && cs[i] ? Math.min(cs[i]!.kwh, charge[i] ?? 0) : 0));
}

/** What the server sends: each windmill's output (W) and each station's charge per slot (kWh) and intake (W). */
export type PowerState = { gen: Record<number, number>; store: Record<number, { charge: number[]; w: number }> };
