// How many people a boss is up against, so each kind's brain can scale up for a crowd (more bombs, more spiders,
// faster stomps...). Everyone who could be hurt within CROWD_R of it counts; one player is the baseline.
import type { Boss, BossPlayer } from './bosses.ts';
import { indoors } from '../shared/shelters.ts';

/** People this far (m, flat) from a boss count against it. */
export const CROWD_R = 350;
/** More than this many count as this many: past it, a boss is as hard as it gets. */
export const CROWD_MAX = 6;

/** People up against `b` (at least 1, at most CROWD_MAX). */
export function crowd(b: Boss, players: BossPlayer[], r = CROWD_R): number {
  let n = 0;
  for (const p of players) if (!p.safe && b.foes.has(p.id) && !indoors(p.x, p.y, p.z) && Math.hypot(p.x - b.x, p.z - b.z) < r) n++;
  return Math.max(1, Math.min(CROWD_MAX, n));
}

/** `base` grown by `per` (a fraction) for every person past the first: base × (1 + per × (n − 1)). */
export function scaled(base: number, n: number, per: number): number {
  return base * (1 + per * (n - 1));
}
