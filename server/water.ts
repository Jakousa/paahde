// Server side of survival (shared/water.ts): drains each player's thirst bar by the felt temperature
// (shared/temperature.ts; sun or shade from shared/shade.ts at the player's head), validates sips and
// canteen refills, and says when a player has died of thirst (server/index.ts respawns them).
import { inBase } from '../shared/base.ts';
import { EYE_HEIGHT } from '../shared/dig.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { inSun } from '../shared/shade.ts';
import { SPRINT, WALK_SPEED, type PlayerState } from '../shared/sim.ts';
import { feltTemp } from '../shared/temperature.ts';
import {
  CANTEEN_SIPS, drainPerSecond, DRINK_COOLDOWN_MS, FILL_COOLDOWN_MS, FILL_SLACK, SIP_WATER, WATER_MAX,
} from '../shared/water.ts';

/** While draining, a 'water' update goes out this often (the client eases between them). */
const SEND_MS = 500;
/** Sun or shade is re-checked this often per player (a ray march over the terrain, shared/shade.ts). */
const SHADE_MS = 250;
/** Not draining, a 'water' update still goes out when the felt temperature moved this much (°C). */
const SEND_TEMP_STEP = 0.5;
/** After a death, no drain and no drink/fill for this long (the client shows the death screen). */
const RESPAWN_GRACE_MS = 3000;

export type Thirst = {
  water: number;
  sips: number;
  heat: boolean; // draining right now
  temp: number; // felt temperature (°C)
  shade: boolean; // no direct sun on the head (also at night and in the base)
  shadeAt: number; // when shade was last checked
  sentTemp: number; // temp and shade in the last 'water' sent
  sentShade: boolean;
  sentAt: number;
  lastDrink: number;
  lastFill: number;
  diedAt: number;
};

export function newThirst(water = WATER_MAX, sips = CANTEEN_SIPS): Thirst {
  const w = Number.isFinite(water) ? Math.min(WATER_MAX, Math.max(0, water)) : WATER_MAX;
  const s = Number.isInteger(sips) ? Math.min(CANTEEN_SIPS, Math.max(0, sips)) : CANTEEN_SIPS;
  return {
    water: w, sips: s, heat: false, temp: 20, shade: true, shadeAt: -Infinity, sentTemp: 20, sentShade: true,
    sentAt: 0, lastDrink: 0, lastFill: 0, diedAt: -Infinity,
  };
}

export function waterMsg(t: Thirst): ServerMsg {
  t.sentTemp = t.temp;
  t.sentShade = t.shade;
  return { t: 'water', water: Math.round(t.water * 100) / 100, sips: t.sips, heat: t.heat, temp: Math.round(t.temp * 10) / 10, shade: t.shade };
}

/**
 * Advance one player's thirst by `dt` seconds at time of day `tod`. Returns 'died' when the bar runs out
 * (the caller respawns and calls revive), 'send' when the client should get a 'water' update, else null.
 */
export function tickThirst(t: Thirst, dt: number, s: PlayerState, input: number, tod: number, now: number): 'died' | 'send' | null {
  const inside = inBase(s.x, s.y, s.z);
  if (now - t.shadeAt >= SHADE_MS) {
    t.shadeAt = now;
    t.shade = inside || !inSun(s.x, s.y + EYE_HEIGHT, s.z, tod);
  }
  t.temp = feltTemp(tod, !t.shade, inside);
  if (now - t.diedAt < RESPAWN_GRACE_MS) return null;
  const sprinting = (input & SPRINT) !== 0 && Math.hypot(s.vx, s.vz) > WALK_SPEED + 0.5;
  const rate = drainPerSecond(t.temp, sprinting);
  const heat = rate > 0;
  t.water = Math.max(0, t.water - rate * dt);
  if (t.water <= 0) return 'died';
  const changed = t.shade !== t.sentShade || Math.abs(t.temp - t.sentTemp) >= SEND_TEMP_STEP;
  if (heat !== t.heat || changed || (heat && now - t.sentAt >= SEND_MS)) {
    t.heat = heat;
    t.sentAt = now;
    return 'send';
  }
  return null;
}

/** Back to full after dying. */
export function revive(t: Thirst, now: number) {
  t.water = WATER_MAX;
  t.sips = CANTEEN_SIPS;
  t.heat = false;
  t.diedAt = now;
  t.sentAt = now;
}

/** One sip from the canteen. False (and nothing changes) if empty, too soon or mid-respawn. */
export function drink(t: Thirst, now: number): boolean {
  if (t.sips <= 0 || now - t.lastDrink < DRINK_COOLDOWN_MS || now - t.diedAt < RESPAWN_GRACE_MS) return false;
  t.lastDrink = now;
  t.sips--;
  t.water = Math.min(WATER_MAX, t.water + SIP_WATER);
  t.sentAt = now;
  return true;
}

/** Refill the canteen at the base (its supply is endless). False if not in the base or too soon. */
export function fill(t: Thirst, s: PlayerState, now: number): boolean {
  if (!inBase(s.x, s.y, s.z, FILL_SLACK) || now - t.lastFill < FILL_COOLDOWN_MS) return false;
  t.lastFill = now;
  t.sips = CANTEEN_SIPS;
  t.sentAt = now;
  return true;
}
