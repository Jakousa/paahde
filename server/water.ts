// Server side of survival (shared/water.ts): builds up (or cools off) each player's heat meter by the felt
// temperature (shared/temperature.ts; how much of the body is in the sun from shared/shade.ts, with other players
// and bikes as shade casters; it stops rising in a sandstorm, shared/storm.ts; hotter on a mud flat, shared/biomes.ts), validates sips and canteen refills, and says
// when a player has died of heatstroke, STROKE_S at a full meter (server/world.ts respawns them).
import { indoors } from '../shared/shelters.ts';
import { waterAt } from '../shared/wells.ts';
import type { Placed } from '../shared/placed.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { sunOnBody, type Caster } from '../shared/shade.ts';
import { type PlayerState } from '../shared/sim.ts';
import { STORM_SHADE } from '../shared/storm.ts';
import { feltTemp, groundHeat } from '../shared/temperature.ts';
import {
  DRINK_COOLDOWN_MS, FILL_COOLDOWN_MS, FILL_MS, FILL_SLACK, HEAT_MAX, heatPerSecond, SIP_COOL, STROKE_RECOVER, STROKE_S,
} from '../shared/water.ts';

/** While the meter moves, a 'water' update goes out this often (the client eases between them). */
const SEND_MS = 500;
/** Sun or shade is re-checked this often per player (a ray march over the terrain, shared/shade.ts). */
const SHADE_MS = 250;
/** Meter still, a 'water' update still goes out when the felt temperature moved this much (°C). */
const SEND_TEMP_STEP = 0.5;
/** After a death, no heat and no drink/fill for this long (the client shows the death screen). */
const RESPAWN_GRACE_MS = 3000;
export type Heat = {
  heat: number; // the meter, 0..HEAT_MAX
  stroke: number; // seconds of heatstroke (meter full); STROKE_S kills
  sips: number;
  maxSips: number; // what the water bottle in the bag holds (shared/gear.ts bottleSips), 0 without one
  rising: boolean; // heat building up right now
  temp: number; // felt temperature (°C)
  sun: number; // how much of the body is in direct sun, 0..1 (0 at night and in a shelter)
  shade: boolean; // mostly out of direct sun (sun < 0.5)
  shadeAt: number; // when sun was last checked
  sentTemp: number; // temp and shade in the last 'water' sent
  sentShade: boolean;
  sentAt: number;
  lastDrink: number;
  lastFill: number;
  diedAt: number;
  off: boolean; // debug menu: no heat at all
};

export function newHeat(heat = 0, sips = 0, maxSips = 0): Heat {
  const h = Number.isFinite(heat) ? Math.min(HEAT_MAX, Math.max(0, heat)) : 0;
  const s = Number.isInteger(sips) ? Math.min(maxSips, Math.max(0, sips)) : 0;
  return {
    heat: h, stroke: 0, sips: s, maxSips, rising: false, temp: 20, sun: 0, shade: true, shadeAt: -Infinity,
    sentTemp: 20, sentShade: true,
    sentAt: 0, lastDrink: 0, lastFill: 0, diedAt: -Infinity, off: false,
  };
}

export function waterMsg(t: Heat): ServerMsg {
  t.sentTemp = t.temp;
  t.sentShade = t.shade;
  return {
    t: 'water', heat: Math.round(t.heat * 100) / 100, sips: t.sips, maxSips: t.maxSips,
    rising: t.rising, temp: Math.round(t.temp * 10) / 10, shade: t.shade,
  };
}

/** What shades a player, from server/world.ts: `casters` everyone's bodies and bikes (shared/shade.ts), `self` the
 *  player's id (their own don't count). */
export type Surroundings = { casters: readonly Caster[]; self: number };

/**
 * Advance one player's heat by `dt` seconds at time of day `tod`, `storm` (0..1, shared/storm.ts) the sandstorm
 * where they stand. Returns 'died' on heatstroke (STROKE_S at a full meter) (the caller respawns and calls revive), 'send' when the client
 * should get a 'water' update, else null.
 */
export function tickHeat(t: Heat, dt: number, s: PlayerState, input: number, tod: number, storm: number, now: number,
  around: Surroundings): 'died' | 'send' | null {
  const inside = indoors(s.x, s.y, s.z);
  if (now - t.shadeAt >= SHADE_MS) {
    t.shadeAt = now;
    t.sun = inside ? 0 : sunOnBody(s.x, s.y, s.z, s.crouching, tod, around.casters, around.self);
    t.shade = t.sun < 0.5;
  }
  t.temp = feltTemp(tod, t.sun, inside) + (inside ? 0 : groundHeat(s.x, s.z, tod, t.sun));
  if (now - t.diedAt < RESPAWN_GRACE_MS) return null;
  const sprinting = s.sliding; // speed slides are the exertion now (there is no sprint)
  // In a sandstorm the dust hides the sun: the heat stops rising (it still cools).
  const capped = t.off || (!inside && storm > STORM_SHADE);
  const rate = capped ? Math.min(0, heatPerSecond(t.temp, sprinting)) : heatPerSecond(t.temp, sprinting);
  const rising = rate > 0;
  const before = t.heat;
  t.heat = Math.min(HEAT_MAX, Math.max(0, t.heat + rate * dt));
  const full = t.heat >= HEAT_MAX;
  t.stroke = Math.max(0, t.stroke + (full ? 1 : -STROKE_RECOVER) * dt);
  if (t.stroke >= STROKE_S) return 'died';
  const moving = t.heat !== before;
  const changed = t.shade !== t.sentShade || Math.abs(t.temp - t.sentTemp) >= SEND_TEMP_STEP;
  // Just cooled right down, or just full (the client times the heatstroke from it): say so now, not on the next tick.
  const settled = t.heat !== before && (t.heat === 0 || full);
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

/** Cooled right down after dying, with a full bottle. */
export function revive(t: Heat, now: number) {
  t.heat = 0;
  t.stroke = 0;
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

/** Refill the canteen at a shelter's pump or a running electric well (shared/wells.ts waterAt; their
 *  supply is endless; a slow well's fill takes longer, and so does its cooldown). False if not at water or too soon;
 *  else where it was filled: the well (its pump draws power for it, server/power.ts pump), or null at a pump. */
export function fill(t: Heat, s: PlayerState, now: number): false | { well: Placed | null } {
  const at = t.maxSips > 0 ? waterAt(s.x, s.y, s.z, FILL_SLACK) : null;
  if (!at || now - t.lastFill < (FILL_COOLDOWN_MS * at.ms) / FILL_MS) return false;
  t.lastFill = now;
  t.sips = t.maxSips;
  t.sentAt = now;
  return { well: at.well };
}
