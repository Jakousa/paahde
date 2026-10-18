// The trophies at the base: each boss kind's first kill (shared/bosses.ts, the 'lives' message's `beaten`) sets up a
// big piece of it, at its full size, on the sand round the pad (shared/base.ts TROPHY_SPOTS): the worm's head rearing
// out of the sand with its jaws spread, the colossus's head sunk to the chin with its arm raised out of the sand beside it, one
// of the carrier's fan ducts standing on edge, the queen's thorax nose-up with a leg arching out each side. Drawn by
// src/world/trophies.ts; they block (collideTrophies() in sim.ts step()) once setTrophies() has the kind (the server
// on start and on a kill, the client on each 'lives' message).
//
// Same determinism rules as shared/scrap.ts in the collision: + - * /, Math.sqrt, Math.abs, Math.min/max only.
//
// A trophy's own frame: origin on the sand at its spot, +Z facing the base (TROPHY_FACE), +X to its right.

import { BASE, TROPHY_SPOTS } from './base.ts';
import { BOSS_KINDS, bossBit, type BossKind } from './bosses.ts';
import { baseHeight } from './terrain.ts';

/** The point (base-local) every trophy faces. */
const TROPHY_FACE = { x: 0, z: -10 };

/** A blocking post in a trophy's frame: segment centre (x, z) ± half·(ax, az) (unit), radius r, top above the sand. */
type Post = { x: number; z: number; ax: number; az: number; half: number; r: number; top: number };

/** What of each trophy blocks. Tall ones are walls; there's nothing to stand on up there. */
const POSTS: Record<BossKind, Post[]> = {
  // The head (and the segment sunk behind it).
  worm: [{ x: 0, z: -0.5, ax: 0, az: 1, half: 1.8, r: 4.6, top: 12 }],
  // The head, the forearm, the upper arm along the sand.
  colossus: [{ x: 0, z: 0.6, ax: 0, az: 1, half: 0.8, r: 3.6, top: 6 }, { x: 7, z: -4.5, ax: 0, az: 1, half: 0.6, r: 3, top: 12 },
    { x: 13.5, z: -5, ax: 1, az: 0, half: 5.5, r: 2.4, top: 3.5 }],
  // The duct's bottom where it goes into the sand, across.
  carrier: [{ x: 0, z: -0.5, ax: 1, az: 0, half: 8.8, r: 3, top: 20 }],
  // The thorax, the legs' feet where they go back into the sand (the knees are overhead).
  queen: [{ x: 0, z: 1.5, ax: 0, az: 1, half: 3.5, r: 4, top: 7 }, { x: -12.5, z: 1.6, ax: 0, az: 1, half: 0, r: 0.9, top: 4 },
    { x: 12.5, z: 1.6, ax: 0, az: 1, half: 0, r: 0.9, top: 4 }],
};

/** Where a trophy stands in the world: its spot, the sand there (the lowest round it, so nothing floats), and its
 *  facing (unit, world). */
export type TrophyPlace = { x: number; y: number; z: number; fx: number; fz: number };

function place(kind: BossKind): TrophyPlace {
  const s = TROPHY_SPOTS[kind], x = BASE.x + s.x, z = BASE.z + s.z;
  let fx = TROPHY_FACE.x - s.x, fz = TROPHY_FACE.z - s.z;
  const d = Math.sqrt(fx * fx + fz * fz);
  fx /= d;
  fz /= d;
  let y = baseHeight(x, z);
  const r = s.r * 0.5;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) {
    y = Math.min(y, baseHeight(x + dx * r, z + dz * r));
  }
  return { x, y, z, fx, fz };
}

export const TROPHY_PLACES = Object.fromEntries(BOSS_KINDS.map((k) => [k, place(k)])) as Record<BossKind, TrophyPlace>;

/** A post in world coordinates (bottom: the sand). */
type WorldPost = { x: number; z: number; ax: number; az: number; half: number; r: number; y: number; top: number };

const WORLD_POSTS: Record<BossKind, WorldPost[]> = Object.fromEntries(BOSS_KINDS.map((k) => {
  const p = TROPHY_PLACES[k], rx = p.fz, rz = -p.fx; // +X of the trophy's frame
  return [k, POSTS[k].map((q) => ({
    x: p.x + q.x * rx + q.z * p.fx, z: p.z + q.x * rz + q.z * p.fz,
    ax: q.ax * rx + q.az * p.fx, az: q.ax * rz + q.az * p.fz, half: q.half, r: q.r, y: p.y, top: p.y + q.top,
  }))];
})) as Record<BossKind, WorldPost[]>;

let up: WorldPost[] = [];

/** The kinds beaten (shared/bosses.ts bossBit mask): their trophies stand and block. */
export function setTrophies(beaten: number) {
  up = BOSS_KINDS.filter((k) => beaten & bossBit(k)).flatMap((k) => WORLD_POSTS[k]);
}

const STAND_MARGIN = 0.15;

/** Push `p` out of the standing trophies; returns the height of one under its feet to stand on, or -Infinity. */
export function collideTrophies(p: { x: number; z: number; vx: number; vz: number }, y: number, prevY: number, radius: number, stepUp: number): number {
  let support = -Infinity;
  const feet = Math.max(y, prevY);
  for (const b of up) {
    const reach = b.half + b.r + radius;
    if (Math.abs(p.x - b.x) > reach || Math.abs(p.z - b.z) > reach || feet < b.y - 2) continue;
    let t = (p.x - b.x) * b.ax + (p.z - b.z) * b.az;
    t = t < -b.half ? -b.half : t > b.half ? b.half : t;
    const qx = b.x + b.ax * t, qz = b.z + b.az * t;
    let ex = p.x - qx, ez = p.z - qz;
    const d = Math.sqrt(ex * ex + ez * ez);
    if (feet >= b.top - stepUp) {
      if (d < b.r + STAND_MARGIN && b.top > support) support = b.top;
      continue;
    }
    const R = b.r + radius;
    if (d >= R) continue;
    if (d > 1e-9) { ex /= d; ez /= d; } else { ex = b.az; ez = -b.ax; }
    p.x = qx + ex * R;
    p.z = qz + ez * R;
    const vn = p.vx * ex + p.vz * ez;
    if (vn < 0) { p.vx -= vn * ex; p.vz -= vn * ez; }
  }
  return support;
}
