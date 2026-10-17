// Server side of survival (shared/water.ts): builds up (or cools off) each player's heat meter by the felt
// temperature (shared/temperature.ts; sun or shade from shared/shade.ts at the player's head), validates
// sips and canteen refills, and says when a player has died of heatstroke (server/index.ts respawns them).
import { atPump, inBase } from '../shared/base.ts';
import { EYE_HEIGHT } from '../shared/dig.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { inSun } from '../shared/shade.ts';
import { SPRINT, WALK_SPEED, type PlayerState } from '../shared/sim.ts';
import { feltTemp } from '../shared/temperature.ts';
import {
  CANTEEN_SIPS, DRINK_COOLDOWN_MS, FILL_COOLDOWN_MS, FILL_SLACK, HEAT_MAX, heatPerSecond, SIP_COOL,
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
  sips: number;
  rising: boolean; // heat building up right now
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

export function newHeat(heat = 0, sips = CANTEEN_SIPS): Heat {
  const h = Number.isFinite(heat) ? Math.min(HEAT_MAX, Math.max(0, heat)) : 0;
  const s = Number.isInteger(sips) ? Math.min(CANTEEN_SIPS, Math.max(0, sips)) : CANTEEN_SIPS;
  return {
    heat: h, sips: s, rising: false, temp: 20, shade: true, shadeAt: -Infinity, sentTemp: 20, sentShade: true,
    sentAt: 0, lastDrink: 0, lastFill: 0, diedAt: -Infinity,
  };
}

export function waterMsg(t: Heat): ServerMsg {
  t.sentTemp = t.temp;
  t.sentShade = t.shade;
  return { t: 'water', heat: Math.round(t.heat * 100) / 100, sips: t.sips, rising: t.rising, temp: Math.round(t.temp * 10) / 10, shade: t.shade };
}

/**
 * Advance one player's heat by `dt` seconds at time of day `tod`. Returns 'died' when the meter is full
 * (the caller respawns and calls revive), 'send' when the client should get a 'water' update, else null.
 */
export function tickHeat(t: Heat, dt: number, s: PlayerState, input: number, tod: number, now: number): 'died' | 'send' | null {
  const inside = inBase(s.x, s.y, s.z);
  if (now - t.shadeAt >= SHADE_MS) {
    t.shadeAt = now;
    t.shade = inside || !inSun(s.x, s.y + EYE_HEIGHT, s.z, tod);
  }
  t.temp = feltTemp(tod, !t.shade, inside);
  if (now - t.diedAt < RESPAWN_GRACE_MS) return null;
  const sprinting = (input & SPRINT) !== 0 && Math.hypot(s.vx, s.vz) > WALK_SPEED + 0.5;
  const rate = heatPerSecond(t.temp, sprinting);
  const rising = rate > 0;
  const before = t.heat;
  t.heat = Math.min(HEAT_MAX, Math.max(0, t.heat + rate * dt));
  if (t.heat >= HEAT_MAX) return 'died';
  const moving = t.heat !== before;
  const changed = t.shade !== t.sentShade || Math.abs(t.temp - t.sentTemp) >= SEND_TEMP_STEP;
  const settled = moving && t.heat === 0; // just cooled right down: say so now, not on the next tick
  if (rising !== t.rising || changed || settled || (moving && now - t.sentAt >= SEND_MS)) {
    t.rising = rising;
    t.sentAt = now;
    return 'send';
  }
  return null;
}

/** Cooled right down after dying. */
export function revive(t: Heat, now: number) {
  t.heat = 0;
  t.sips = CANTEEN_SIPS;
  t.rising = false;
  t.diedAt = now;
  t.sentAt = now;
}

/** One sip from the canteen. False (and nothing changes) if empty, too soon or mid-respawn. */
export function drink(t: Heat, now: number): boolean {
  if (t.sips <= 0 || now - t.lastDrink < DRINK_COOLDOWN_MS || now - t.diedAt < RESPAWN_GRACE_MS) return false;
  t.lastDrink = now;
  t.sips--;
  t.heat = Math.max(0, t.heat - SIP_COOL);
  t.sentAt = now;
  return true;
}

/** Refill the canteen at the base's pump (its supply is endless). False if not at the pump or too soon. */
export function fill(t: Heat, s: PlayerState, now: number): boolean {
  if (!atPump(s.x, s.y, s.z, FILL_SLACK) || now - t.lastFill < FILL_COOLDOWN_MS) return false;
  t.lastFill = now;
  t.sips = CANTEEN_SIPS;
  t.sentAt = now;
  return true;
}
