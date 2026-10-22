// Temperature: the desert's air temperature over the day, and how hot it feels to a player in the sun,
// in the shade (shared/shade.ts) or in the base. Heat builds up by the felt temperature (shared/water.ts).
// Plain math on the shared clock (shared/sun.ts), so the server and the client agree. Server-authoritative:
// the server sends the felt temperature in its 'water' message; the client only shows it.
//
// Air: a smooth diurnal curve, coolest just before sunrise and hottest mid-afternoon (the ground keeps
// heating the air after noon, so the peak lags the sun by about two hours, as in real deserts). It warms
// along an inverted squared half cosine, so the morning warms fast once the sun is up, and cools along a
// squared half cosine, so the evening drops fast after sunset (dry air radiates heat away) and nights are
// cold. Both halves have zero slope at the ends: no kinks.
//
// Felt: air, plus up to SUN_BONUS in direct sun (scaled by the sun's height, like sunlight per m²). In
// shade, SHADE_DROP under the air while the sun is up (cool sand, no glare), and never above SHADE_MAX, so even at
// midday the shadow of a rock, a dune or a wreck cools you off (slowly; the base is faster): finding shade is how
// you get through the afternoon. Both fade out as the sun nears the horizon. Partly in shade (shared/shade.ts sunOnBody), it is
// the mix of the two by how much of the body the sun reaches. In the base (the hut or the bunker) the thick walls
// and the sand keep it at most BASE_MAX.
//
// Ground: some biomes (shared/biomes.ts, their `groundHeat`) are hotter than the dune sea while the sun is up. Out on
// a mud flat the bare baked clay adds up to its `sun` °C in the sun (`shade` in what little shade there is), by the
// sun's height.
import { blend } from './biomes.ts';
import { NOON_ELEVATION, sunElevation } from './sun.ts';

/** Coolest air (°C), at AIR_MIN_TOD, just before sunrise (~05:35 here). */
export const AIR_MIN = 12;
/** Hottest air (°C), at AIR_MAX_TOD, mid-afternoon. */
export const AIR_MAX = 44;
/** Time of day of the coolest air: 05:30. */
export const AIR_MIN_TOD = 5.5 / 24;
/** Time of day of the hottest air: 14:00 (two hours after noon). */
export const AIR_MAX_TOD = 14 / 24;
/** Extra felt °C standing in direct sun with the sun at its noon height; less when it is lower. */
export const SUN_BONUS = 12;
/** Felt °C under the air in shade while the sun is up... */
export const SHADE_DROP = 10;
/** Shade never feels hotter than this (°C) while the sun is up: under COMFORT_TEMP (shared/water.ts), so it cools. */
export const SHADE_MAX = 26;
/** ...both in full above this sunStrength, fading to none at sunset. */
const SHADE_FULL_STRENGTH = 0.2;
/** The base never feels hotter than this (°C): cool enough that you cool off there. */
export const BASE_MAX = 22;


/** Air temperature (°C) at a time of day in [0, 1). */
export function airTemp(tod: number): number {
  const t = tod - Math.floor(tod);
  const warm = AIR_MAX_TOD - AIR_MIN_TOD;
  let f: number;
  if (t >= AIR_MIN_TOD && t < AIR_MAX_TOD) {
    const c = (1 - Math.cos((Math.PI * (t - AIR_MIN_TOD)) / warm)) / 2;
    f = 1 - (1 - c) * (1 - c);
  } else {
    const u = (t - AIR_MAX_TOD + 1) % 1 / (1 - warm); // 0 at the peak → 1 at the next minimum
    const c = (1 + Math.cos(Math.PI * u)) / 2;
    f = c * c;
  }
  return AIR_MIN + (AIR_MAX - AIR_MIN) * f;
}

/** Direct sun's share at a time of day, 0..1: sin(elevation) relative to noon, 0 below the horizon. */
export function sunStrength(tod: number): number {
  const s = Math.sin(sunElevation(tod));
  return s <= 0 ? 0 : Math.min(1, s / Math.sin(NOON_ELEVATION));
}

/**
 * Felt temperature (°C) at a time of day with `sun` (0..1, shared/shade.ts sunOnBody) of the body in direct sun,
 * inside the base or not.
 */
export function feltTemp(tod: number, sun: number, inside: boolean): number {
  const air = airTemp(tod);
  if (inside) return Math.min(air, BASE_MAX);
  const strength = sunStrength(tod);
  const lit = air + SUN_BONUS * strength;
  const shaded = air + (Math.min(air - SHADE_DROP, SHADE_MAX) - air) * Math.min(1, strength / SHADE_FULL_STRENGTH);
  return shaded + (lit - shaded) * sun;
}

/** Extra felt °C from the ground under a player outdoors at (x, z): the biome's heat (0 in the dune sea), with
 *  `sun` (0..1) of the body in direct sun. */
export function groundHeat(x: number, z: number, tod: number, sun: number): number {
  const heat = blend(x, z, (b) => b.groundHeat && b.groundHeat.shade + (b.groundHeat.sun - b.groundHeat.shade) * sun, 0);
  return heat === 0 ? 0 : heat * sunStrength(tod);
}
