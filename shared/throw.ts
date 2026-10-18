// Throwing scrap: scrap (shared/items.ts SCRAP) taken out from the hotbar is thrown with the use
// button (src/throw.ts), so someone with no gun and a bag of junk can still knock a drone out of the sky. The server
// takes the item out of the bag and flies it (server/throws.ts) on a plain ballistic arc; passing within THROW_HIT of
// a flying drone it counts as a rifle hit (shared/rifle.ts DRONE_HP) and bounces off; on the sand it lies where it
// landed as dropped loot (shared/loot.ts), to be picked up again.
import { SCRAP } from './items.ts';

/** What can be thrown. */
export const THROWABLE = new Set([SCRAP]);
/** Launch speed (m/s) and gravity on the arc (m/s², lighter than a player's: it's a game): straight up it climbs
 *  about THROW_SPEED² / 2G = 33 m, over a drone's DRONE_ALT. */
export const THROW_SPEED = 30;
export const THROW_G = 13.5;
/** At most one throw every THROW_MS. */
export const THROW_MS = 550;
/** A throw counts against a drone passing this close (m) to its centre: the drone's size, the junk's, and slack for
 *  the client drawing drones 250 ms in the past. */
export const THROW_HIT = 3;
/** Bouncing off a drone it keeps this much of its speed, back the way it came. */
export const BOUNCE = 0.25;
/** Lost if it's still flying after this long (s). */
export const FLIGHT_MAX = 8;

/** One leg of a flight: from (x, y, z) with velocity (vx, vy, vz) at server time `time` (ms). */
export type TossPath = { time: number; x: number; y: number; z: number; vx: number; vy: number; vz: number };

/** Where a toss is `t` seconds into its leg, into `out`. */
export function tossAt<T extends { x: number; y: number; z: number }>(p: TossPath, t: number, out: T): T {
  out.x = p.x + p.vx * t;
  out.y = p.y + p.vy * t - 0.5 * THROW_G * t * t;
  out.z = p.z + p.vz * t;
  return out;
}
