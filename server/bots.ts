// What the walkers (server/guardians.ts) and the drones (server/drones.ts) share: the player as they see them, their
// kills, the sites near players, and small number helpers.
import { crashSitesNear, type CrashSite } from '../shared/crashsites.ts';
import type { Kind } from '../shared/guardians.ts';
import { indoors } from '../shared/shelters.ts';

/** Players get guardians and drones within this distance (m), crawlers within CRAWLER_SEND_R (server/guardians.ts). */
export const SEND_R = 1200;
/** Crawlers come to a site when someone is this close (m) and leave when nobody is within SITE_LEAVE_R. */
export const SITE_NEAR_R = 300;
export const SITE_LEAVE_R = 450;

/** What the bots need to know about a player (feet position; `safe` = just respawned, can't be hurt). */
export type BotPlayer = { id: number; x: number; y: number; z: number; safe: boolean };
/** Out in the open and not just respawned: can be noticed, chased and hurt. */
export const open = (p: BotPlayer) => !p.safe && !indoors(p.x, p.y, p.z);

/** A walker killed by a rifle (`by` the shooter's id), for the server to drop its parts. */
export type Kill = { kind: Kind | 'drone'; x: number; z: number; by: number };

/** The crash sites within r of any of these players. */
export function sitesNear(players: { x: number; z: number }[], r: number): CrashSite[] {
  const out = new Map<number, CrashSite>();
  for (const p of players) for (const s of crashSitesNear(p.x, p.z, r)) out.set(s.id, s);
  return [...out.values()];
}

export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
export const r2 = (n: number) => Math.round(n * 100) / 100;
export const r3 = (n: number) => Math.round(n * 1000) / 1000;
