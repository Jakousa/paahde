// The shared day/night clock and the sun's position, as plain math (no three), so the client's sky
// (src/world/dayNight.ts) and the server's heat (server/water.ts) agree on where the sun is.
//
// One 24 h day every DAY_SECONDS of real time, on the server's wall clock (epoch + server time). The sun
// runs a real diurnal arc (spherical astronomy, hour angle H at latitude LAT and declination DECL): it rises
// in the east (+Z), peaks in the south (+X) at 90° − LAT + DECL, and sets a little north of west (−Z).

import { LAB } from './world.ts';

/** Real seconds per in-game day (24 h in 30 min). */
export const DAY_SECONDS = 30 * 60;
export const LAT = (42 * Math.PI) / 180;
export const DECL = (9 * Math.PI) / 180;
/** Shifts the cycle against the Unix epoch (fraction of a day). */
export const DAY_OFFSET = 0.3;
/** The sun's elevation at noon (radians): 57°. */
export const NOON_ELEVATION = Math.PI / 2 - LAT + DECL;

/** Time of day in [0, 1) at wall-clock `unixMs`: 0 = midnight, 0.25 ≈ sunrise, 0.5 = noon, 0.75 ≈ sunset. */
export function timeOfDayAt(unixMs: number, dayLen = DAY_SECONDS): number {
  if (LAB) return 0.5; // the dev test lab (shared/lab.ts): always noon
  const t = unixMs / 1000 / dayLen + DAY_OFFSET;
  return t - Math.floor(t);
}

/** Milliseconds to add to the shared clock at `unixMs` so the time of day becomes `tod` (forward, within one day). */
export function shiftToTimeOfDay(unixMs: number, tod: number, dayLen = DAY_SECONDS): number {
  const now = unixMs / 1000 / dayLen + DAY_OFFSET;
  const ahead = (((tod - now) % 1) + 1) % 1;
  return ahead * dayLen * 1000;
}

/** "HH:MM" for a time of day. */
export function clockText(tod: number): string {
  const min = Math.floor(tod * 24 * 60);
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export type Vec3 = { x: number; y: number; z: number };

/** Unit vector to a body at hour angle h (0 = due south, highest) and declination decl, written into `out`. */
export function skyVector<T extends Vec3>(h: number, decl: number, out: T): T {
  const up = Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(h);
  const east = -Math.cos(decl) * Math.sin(h);
  const north = Math.cos(LAT) * Math.sin(decl) - Math.sin(LAT) * Math.cos(decl) * Math.cos(h);
  const len = Math.hypot(north, up, east) || 1;
  out.x = -north / len;
  out.y = up / len;
  out.z = east / len;
  return out;
}

/** Hour angle of the sun at a time of day (0 at noon). */
export function sunHourAngle(tod: number): number {
  return (tod - 0.5) * Math.PI * 2;
}

const tmp: Vec3 = { x: 0, y: 0, z: 0 };
/** Sun elevation above the horizon (radians, negative at night) at a time of day. */
export function sunElevation(tod: number): number {
  return Math.asin(skyVector(sunHourAngle(tod), DECL, tmp).y);
}
