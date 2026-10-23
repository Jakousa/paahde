// The bosses' delayed blasts (a missile, a bomb, a footfall, a stab landing when the view draws it): what's due goes
// off, and kills whoever it hits, once each a tick. Each kind digs its own craters and sends its own effects.
import type { BossOut, BossPlayer } from './bosses.ts';
import type { DeathCause } from '../shared/protocol.ts';
import { blastPush } from '../shared/ragdoll.ts';

/** Those of `list` due by `now` (at ≤ now) go off (`go`); returns the rest. */
export function due<T extends { at: number }>(list: T[], now: number, go: (e: T) => void): T[] {
  if (!list.length) return list;
  return list.filter((e) => {
    if (e.at > now) return true;
    go(e);
    return false;
  });
}

/** A blast at (x, y, z): everyone not safe (and not already killed this tick) that `hit` says it hit dies of `cause`,
 *  thrown away from it (shared/ragdoll.ts blastPush, reaching pushR m). */
export function blast(out: BossOut, players: BossPlayer[], x: number, y: number, z: number, cause: DeathCause, pushR: number, hit: (p: BossPlayer) => boolean) {
  for (const p of players) {
    if (p.safe || !hit(p) || out.kills.some((k) => k.id === p.id)) continue;
    out.kills.push({ id: p.id, cause, push: blastPush(x, y, z, p.x, p.y, p.z, pushR) });
  }
}

/** Hit tests: within r (m) of (x, y, z), the feet raised `up` m; or within r flat and h up or down. */
export const ball = (x: number, y: number, z: number, r: number, up = 0) => (p: BossPlayer) => Math.hypot(p.x - x, p.y + up - y, p.z - z) <= r;
export const column = (x: number, y: number, z: number, r: number, h: number) => (p: BossPlayer) => Math.hypot(p.x - x, p.z - z) <= r && Math.abs(p.y - y) <= h;
