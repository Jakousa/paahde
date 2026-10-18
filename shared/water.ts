// Survival: the heat meter, the chill (cold, below) and the canteen. Server-authoritative (server/water.ts) and not part of
// shared/sim.ts, since it never moves the player; the client only draws it (src/water.ts).
//
// Heat builds up: the hotter it feels (shared/temperature.ts: air temperature by time of day, plus the
// sun's bonus, or the shade's chill, capped in the base), the faster, from nothing at COMFORT_TEMP up a
// quadratic curve. Below COMFORT_TEMP (the base, nights) you cool off by yourself. Sips from the water bottle
// (found broken and repaired, shared/gear.ts) bring it down; the pump in the base refills it. A full meter is heatstroke.

/** Full heat meter: heatstroke. */
export const HEAT_MAX = 100;
/** Heat neither builds nor fades at this felt temperature (°C). */
export const COMFORT_TEMP = 30;
/** At this felt temperature (°C; full sun, early afternoon)... */
export const HOT_TEMP = 54;
/** ...an empty meter fills in this long walking (s). */
export const HOT_FULL_BAR_S = 60;
/** Build-up grows with (felt − COMFORT_TEMP) to this power: shade (~20 °C cooler than sun) barely builds any. */
export const HEAT_POWER = 2;
/** Build-up multiplier while sprinting. */
export const SPRINT_HEAT = 1.5;
/** Cooling off: this many °C under COMFORT_TEMP (or more)... */
export const COOL_RANGE = 8;
/** ...empties a full meter in this long (s); less cool, slower. The base (22 °C) is full speed. */
export const COOL_FULL_BAR_S = 40;
/** How much heat one sip takes off. How many sips the bottle holds depends on its parts (shared/gear.ts canteenSips). */
export const SIP_COOL = 25;
/** How long one sip and one refill take on the client (the Drink / Fill animation lengths). */
export const DRINK_MS = 1200;
export const FILL_MS = 1500;
/** Server: minimum time between two sips / two refills (a little under the animations, for lag). */
export const DRINK_COOLDOWN_MS = 1000;
export const FILL_COOLDOWN_MS = 1200;
/** Server: how far beyond the pump's reach (shared/base.ts PUMP_REACH) a refill is still accepted (m), for lag. */
export const FILL_SLACK = 1;
/** Above this the HUD pulses and the screen edges glow with heat. */
export const HEAT_HIGH = 80;

/** Heat gained per second at felt temperature `temp` (°C); negative when cooling off. */
export function heatPerSecond(temp: number, sprinting: boolean): number {
  if (temp < COMFORT_TEMP) return (-Math.min(1, (COMFORT_TEMP - temp) / COOL_RANGE) * HEAT_MAX) / COOL_FULL_BAR_S;
  const k = Math.pow((temp - COMFORT_TEMP) / (HOT_TEMP - COMFORT_TEMP), HEAT_POWER);
  return (k * HEAT_MAX * (sprinting ? SPRINT_HEAT : 1)) / HOT_FULL_BAR_S;
}

// Cold: a second, hidden meter (`chill`, 0..CHILL_MAX), shown only through the body: frost creeping in from the
// screen edges and shaking hands (src/water.ts, src/post.ts, src/viewmodel.ts). It builds while the felt
// temperature is under COLD_TEMP (outside on a desert night, shared/temperature.ts NIGHT_CHILL; a cold dawn in
// shade), faster the colder, and a full meter is death by cold. At or over COLD_TEMP it fades: the base
// (BASE_MIN), a smouldering wreck (server/water.ts), cloth wrapped around you, or a sandstorm's hot wind.

/** Full chill: dead of cold. */
export const CHILL_MAX = 100;
/** Chill builds under this felt temperature (°C)... */
export const COLD_TEMP = 10;
/** ...and at this one (or colder) an empty meter fills in COLD_FULL_BAR_S (s); in between, proportionally slower. */
export const FREEZE_TEMP = 0;
export const COLD_FULL_BAR_S = 140;
/** Warming up: this many °C over COLD_TEMP (or more) empties a full meter in WARM_FULL_BAR_S (s); less, slower. */
export const WARM_RANGE = 6;
export const WARM_FULL_BAR_S = 40;
/** Above this the frost reaches well into the view and the hands shake hard. */
export const CHILL_HIGH = 70;

/** Chill gained per second at felt temperature `temp` (°C); negative while warming up. */
export function chillPerSecond(temp: number): number {
  if (temp >= COLD_TEMP) return (-Math.min(1, (temp - COLD_TEMP) / WARM_RANGE) * CHILL_MAX) / WARM_FULL_BAR_S;
  return (Math.min(1, (COLD_TEMP - temp) / (COLD_TEMP - FREEZE_TEMP)) * CHILL_MAX) / COLD_FULL_BAR_S;
}
