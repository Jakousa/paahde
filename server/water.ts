// Server side of survival (shared/water.ts): builds up (or cools off) each player's heat meter and chill by the
// felt temperature (shared/temperature.ts; how much of the body is in the sun from shared/shade.ts, with other
// players and bikes as shade casters; hotter in a sandstorm, shared/storm.ts; cold at night unless sheltered,
// wrapped in cloth or by a smouldering wreck), validates sips and canteen refills, and says when a player has died
// of heatstroke or cold (server/index.ts respawns them).
import { atPump, inBase } from '../shared/base.ts';
import { crashSpent } from '../shared/crash.ts';
import { crashSitesNear } from '../shared/crashsites.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { sunOnBody, type Caster } from '../shared/shade.ts';
import { type PlayerState } from '../shared/sim.ts';
import { STORM_TEMP } from '../shared/storm.ts';
import { clothWrap, feltTemp } from '../shared/temperature.ts';
import {
  CHILL_MAX, chillPerSecond, DRINK_COOLDOWN_MS, FILL_COOLDOWN_MS, FILL_SLACK, HEAT_MAX, heatPerSecond, SIP_COOL,
} from '../shared/water.ts';

/** While the meter moves, a 'water' update goes out this often (the client eases between them). */
const SEND_MS = 500;
/** Sun or shade is re-checked this often per player (a ray march over the terrain, shared/shade.ts). */
const SHADE_MS = 250;
/** Meter still, a 'water' update still goes out when the felt temperature moved this much (°C). */
const SEND_TEMP_STEP = 0.5;
/** After a death, no heat and no drink/fill for this long (the client shows the death screen). */
const RESPAWN_GRACE_MS = 3000;
/** A crash site still smouldering (its large machine not stripped, shared/crash.ts crashSpent) warms you this
 *  much (°C) within FIRE_NEAR of a smoke point, fading to nothing at FIRE_FAR (m). */
const FIRE_WARMTH = 14, FIRE_NEAR = 3, FIRE_FAR = 9;

/** Warmth (°C) from smouldering wrecks at (x, z). */
export function fireWarmth(x: number, z: number): number {
  let best = 0;
  for (const s of crashSitesNear(x, z, 120)) {
    if (crashSpent.has(s.id)) continue;
    for (const p of s.smokePoints) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < FIRE_FAR) best = Math.max(best, FIRE_WARMTH * Math.min(1, (FIRE_FAR - d) / (FIRE_FAR - FIRE_NEAR)));
    }
  }
  return best;
}

export type Heat = {
  heat: number; // the meter, 0..HEAT_MAX
  sips: number;
  maxSips: number; // what the water bottle in the bag holds (shared/gear.ts bottleSips), 0 without one
  rising: boolean; // heat building up right now
  chill: number; // cold, 0..CHILL_MAX (not saved: a reconnect starts warm)
  temp: number; // felt temperature (°C)
  sun: number; // how much of the body is in direct sun, 0..1 (0 at night and in the base)
  shade: boolean; // mostly out of direct sun (sun < 0.5)
  warmth: number; // °C from a smouldering wreck nearby
  wrap: number; // cloth in the bag (shared/temperature.ts clothWrap)
  shadeAt: number; // when sun, warmth and wrap were last checked
  sentTemp: number; // temp and shade in the last 'water' sent
  sentShade: boolean;
  sentAt: number;
  lastDrink: number;
  lastFill: number;
  diedAt: number;
};

export function newHeat(heat = 0, sips = 0, maxSips = 0): Heat {
  const h = Number.isFinite(heat) ? Math.min(HEAT_MAX, Math.max(0, heat)) : 0;
  const s = Number.isInteger(sips) ? Math.min(maxSips, Math.max(0, sips)) : 0;
  return {
    heat: h, sips: s, maxSips, rising: false, chill: 0, temp: 20, sun: 0, shade: true, warmth: 0, wrap: 0, shadeAt: -Infinity,
    sentTemp: 20, sentShade: true,
    sentAt: 0, lastDrink: 0, lastFill: 0, diedAt: -Infinity,
  };
}

export function waterMsg(t: Heat): ServerMsg {
  t.sentTemp = t.temp;
  t.sentShade = t.shade;
  return {
    t: 'water', heat: Math.round(t.heat * 100) / 100, chill: Math.round(t.chill * 100) / 100, sips: t.sips, maxSips: t.maxSips,
    rising: t.rising, temp: Math.round(t.temp * 10) / 10, shade: t.shade,
  };
}

/** What shades and warms a player, from server/index.ts: `casters` everyone's bodies and bikes (shared/shade.ts),
 *  `self` the player's id (their own don't count), `cloth` how many pieces of cloth are in their bag. */
export type Surroundings = { casters: readonly Caster[]; self: number; cloth: () => number };

/**
 * Advance one player's heat and chill by `dt` seconds at time of day `tod`, `storm` (0..1, shared/storm.ts) the
 * sandstorm where they stand. Returns 'died' (heatstroke) or 'froze' when a meter is full (the caller respawns and
 * calls revive), 'send' when the client should get a 'water' update, else null.
 */
export function tickHeat(t: Heat, dt: number, s: PlayerState, input: number, tod: number, storm: number, now: number,
  around: Surroundings): 'died' | 'froze' | 'send' | null {
  const inside = inBase(s.x, s.y, s.z);
  if (now - t.shadeAt >= SHADE_MS) {
    t.shadeAt = now;
    t.sun = inside ? 0 : sunOnBody(s.x, s.y, s.z, s.crouching, tod, around.casters, around.self);
    t.shade = t.sun < 0.5;
    t.warmth = inside ? 0 : fireWarmth(s.x, s.z);
    t.wrap = clothWrap(around.cloth());
  }
  t.temp = feltTemp(tod, t.sun, inside, t.wrap) + (inside ? 0 : STORM_TEMP * storm + t.warmth);
  if (now - t.diedAt < RESPAWN_GRACE_MS) return null;
  const sprinting = s.sliding; // speed slides are the exertion now (there is no sprint)
  const rate = heatPerSecond(t.temp, sprinting);
  const rising = rate > 0;
  const before = t.heat, chillBefore = t.chill;
  t.heat = Math.min(HEAT_MAX, Math.max(0, t.heat + rate * dt));
  t.chill = Math.min(CHILL_MAX, Math.max(0, t.chill + chillPerSecond(t.temp) * dt));
  if (t.heat >= HEAT_MAX) return 'died';
  if (t.chill >= CHILL_MAX) return 'froze';
  const moving = t.heat !== before || t.chill !== chillBefore;
  const changed = t.shade !== t.sentShade || Math.abs(t.temp - t.sentTemp) >= SEND_TEMP_STEP;
  // Just cooled (or warmed) right down: say so now, not on the next tick.
  const settled = (t.heat !== before && t.heat === 0) || (t.chill !== chillBefore && t.chill === 0);
  if (rising !== t.rising || changed || settled || (moving && now - t.sentAt >= SEND_MS)) {
    t.rising = rising;
    t.sentAt = now;
    return 'send';
  }
  return null;
}

/** The bag's water bottle changed: it holds `max` now (what was in a bigger one spills). True if anything changed. */
export function setBottle(t: Heat, max: number): boolean {
  if (max === t.maxSips) return false;
  t.maxSips = max;
  t.sips = Math.min(t.sips, max);
  return true;
}

/** A crawler's bite (shared/guardians.ts): `heat` more on the meter. True if that was heatstroke. */
export function bite(t: Heat, heat: number): boolean {
  if (Date.now() - t.diedAt < RESPAWN_GRACE_MS) return false;
  t.heat = Math.min(HEAT_MAX, t.heat + heat);
  t.sentAt = Date.now();
  return t.heat >= HEAT_MAX;
}

/** Cooled (and warmed) right down after dying, with a full bottle. */
export function revive(t: Heat, now: number) {
  t.heat = 0;
  t.chill = 0;
  t.sips = t.maxSips;
  t.rising = false;
  t.diedAt = now;
  t.sentAt = now;
}

/** One sip from the canteen. False (and nothing changes) if empty, too soon or mid-respawn. */
export function drink(t: Heat, now: number): boolean {
  if (t.sips <= 0 || t.maxSips <= 0 || now - t.lastDrink < DRINK_COOLDOWN_MS || now - t.diedAt < RESPAWN_GRACE_MS) return false;
  t.lastDrink = now;
  t.sips--;
  t.heat = Math.max(0, t.heat - SIP_COOL);
  t.sentAt = now;
  return true;
}

/** Refill the canteen at the base's pump (its supply is endless). False if not at the pump or too soon. */
export function fill(t: Heat, s: PlayerState, now: number): boolean {
  if (t.maxSips <= 0 || !atPump(s.x, s.y, s.z, FILL_SLACK) || now - t.lastFill < FILL_COOLDOWN_MS) return false;
  t.lastFill = now;
  t.sips = t.maxSips;
  t.sentAt = now;
  return true;
}
