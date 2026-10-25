// Knockback: every hit pushes what it hits. A weapon gives a push (PUSH, kg·m/s); what's hit moves off at push / its
// mass (shared/enemies.ts `mass`) along the blow, slowing under KNOCK_DRAG, so it slides v / KNOCK_DRAG metres in all.
// The light ones (crawlers, drones) are shoved by any hit, weak point or not; the heavy ones (guardians, jets, the
// harvester, the bosses) work out under KNOCK_MIN and stay put. The server moves them (server/guardians.ts,
// server/drones.ts); the hitter's own client shows the shove at once (src/world/shoves.ts), the server's following.
import { ENEMIES, type EnemyKind } from './enemies.ts';

export type Pusher = 'mace' | 'rifle' | 'pistol' | 'throw';
/** What a hit of each weapon pushes with (kg·m/s): the mace swings hard; the rifle's beam kicks more than the pistol's. */
export const PUSH: Record<Pusher, number> = { mace: 900, rifle: 200, pistol: 80, throw: 60 };
/** How fast a knock dies away (1/s). */
export const KNOCK_DRAG = 5;
/** Knocks slower than this (m/s) aren't applied: the heavy things. */
export const KNOCK_MIN = 0.05;
/** A crawler knocked at least this hard (m/s) is staggered out of its lunge (the mace does it, the guns don't). */
export const STAGGER = 4;

/** How fast a hit by `by` knocks a `kind` (m/s), 0 if it's too heavy to notice. */
export function knockSpeed(by: Pusher, kind: EnemyKind): number {
  const v = PUSH[by] / ENEMIES[kind].mass;
  return v < KNOCK_MIN ? 0 : v;
}

/** How far a knock of `v` m/s has carried it `t` s after the hit. */
export function knockOffset(v: number, t: number): number {
  return t <= 0 ? 0 : (v / KNOCK_DRAG) * (1 - Math.exp(-KNOCK_DRAG * t));
}

/** A knock's velocity `dt` s on. */
export const knockDecay = (dt: number) => Math.exp(-KNOCK_DRAG * dt);
