// Survival: the thirst bar and the canteen. Server-authoritative (server/water.ts) and not part of
// shared/sim.ts, since it never moves the player; the client only draws it (src/water.ts).
//
// Heat drains water: the hotter it feels (shared/temperature.ts: air temperature by time of day, plus the
// sun's bonus unless you're in shade, capped in the base), the faster, from nothing at COMFORT_TEMP up a
// cubic curve. Sips from the canteen (inventory slot 1) put it back; the base refills the canteen.

/** Full thirst bar. */
export const WATER_MAX = 100;
/** No drain at or below this felt temperature (°C). */
export const COMFORT_TEMP = 24;
/** At this felt temperature (°C; full sun, early afternoon)... */
export const HOT_TEMP = 54;
/** ...a full bar lasts this long walking (s). */
export const HOT_FULL_BAR_S = 255;
/** Drain grows with (felt − COMFORT_TEMP) to this power: shade (~10 °C cooler) drains ~3.5× slower. */
export const DRAIN_POWER = 3;
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

/** Water lost per second at felt temperature `temp` (°C). */
export function drainPerSecond(temp: number, sprinting: boolean): number {
  if (temp <= COMFORT_TEMP) return 0;
  const k = Math.pow((temp - COMFORT_TEMP) / (HOT_TEMP - COMFORT_TEMP), DRAIN_POWER);
  return (k * WATER_MAX * (sprinting ? SPRINT_DRAIN : 1)) / HOT_FULL_BAR_S;
}
