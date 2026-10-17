// Survival: the thirst bar and the canteen. Server-authoritative (server/water.ts) and not part of
// shared/sim.ts, since it never moves the player; the client only draws it (src/water.ts).
//
// The sun drains water while it is up and you are outside the base, scaled by its elevation (0 at the
// horizon, full at noon). Sips from the canteen (inventory slot 1) put it back; the base refills the canteen.
import { NOON_ELEVATION, sunElevation } from './sun.ts';

/** Full thirst bar. */
export const WATER_MAX = 100;
/** Seconds a full bar lasts at noon in full sun, walking. */
export const NOON_FULL_BAR_S = 5 * 60;
/** Drain multiplier while sprinting. */
export const SPRINT_DRAIN = 1.5;
/** Sips in a full canteen, and how much water each one gives back. */
export const CANTEEN_SIPS = 4;
export const SIP_WATER = 25;
/** How long one sip and one refill take on the client (the Drink / Fill animation lengths). */
export const DRINK_MS = 1200;
export const FILL_MS = 1500;
/** Server: minimum time between two sips / two refills (a little under the animations, for lag). */
export const DRINK_COOLDOWN_MS = 1000;
export const FILL_COOLDOWN_MS = 1200;
/** Server: how far outside the base's footprint a refill is still accepted (m), for lag. */
export const FILL_SLACK = 2;
/** Below this the HUD pulses and the screen edges glow with heat. */
export const WATER_LOW = 20;

/** Heat at a time of day, 0..1: sin(elevation) relative to noon, 0 with the sun at or below the horizon. */
export function sunHeat(tod: number): number {
  const s = Math.sin(sunElevation(tod));
  return s <= 0 ? 0 : Math.min(1, s / Math.sin(NOON_ELEVATION));
}

/** Water lost per second at a time of day. 0 inside the base. */
export function drainPerSecond(tod: number, inside: boolean, sprinting: boolean): number {
  if (inside) return 0;
  return (sunHeat(tod) * WATER_MAX * (sprinting ? SPRINT_DRAIN : 1)) / NOON_FULL_BAR_S;
}
