// The trophies: each boss kind's first kill (shared/bosses.ts, the 'lives' message's `beaten`) gives the world a big
// piece of it, at its full size, to put up where anyone likes: the worm's head rearing out of the sand with its jaws spread,
// the colossus's head sunk to the chin with its arm raised out of the sand beside it, one of the carrier's fan ducts
// standing on edge, the queen's thorax nose-up with a leg arching out each side.
//
// A trophy is a building like the others (shared/placed.ts, kinds `trophy_<boss>`): it appears in the wrench's build menu
// (src/buildMenu.ts) once its kind is beaten and while it isn't standing anywhere (trophyFree: one per kind per world),
// costs nothing (shared/crafting.ts BUILDS), and anyone can take it down with the wrench and put it up again elsewhere.
// It's never lost: taken down, it's back in the menu. Winning (server/world.ts `beaten`) doesn't depend on it standing.
// Its footprint and what of it blocks (its boxes) come from POSTS, recentred on the footprint's middle (CENTRE), so the
// ground kept clear round it is its own shape and no more. Drawn by src/world/trophies.ts (from the bosses' models,
// handed to src/world/placed.ts).

import { BOSS_KINDS, bossBit, type BossKind } from './bosses.ts';

/** A trophy's placed kind. */
export const TROPHY: Record<BossKind, string> = { worm: 'trophy_worm', carrier: 'trophy_carrier', colossus: 'trophy_colossus', queen: 'trophy_queen' };
/** The boss kind a placed kind is the trophy of, or null. */
export const trophyBoss = (kind: string): BossKind | null => BOSS_KINDS.find((k) => TROPHY[k] === kind) ?? null;
export const isTrophy = (kind: string) => trophyBoss(kind) !== null;

/** What blocks, in the trophy's frame (origin on the sand where the model stands, +Z its front, +X its right): segment
 *  centre (x, z) ± half along X (`ax` 1) or Z (`ax` 0), radius r, top above the sand. Tall ones are walls. */
type Post = { x: number; z: number; ax: 0 | 1; half: number; r: number; top: number };
const POSTS: Record<BossKind, Post[]> = {
  // The head (and the segment sunk behind it).
  worm: [{ x: 0, z: -0.5, ax: 0, half: 1.8, r: 4.6, top: 12 }],
  // The head, the forearm, the upper arm along the sand.
  colossus: [{ x: 0, z: 0.6, ax: 0, half: 0.8, r: 3.6, top: 6 }, { x: 7, z: -4.5, ax: 0, half: 0.6, r: 3, top: 12 },
    { x: 13.5, z: -5, ax: 1, half: 5.5, r: 2.4, top: 3.5 }],
  // The duct's bottom where it goes into the sand, across.
  carrier: [{ x: 0, z: -0.5, ax: 1, half: 8.8, r: 3, top: 20 }],
  // The thorax, the legs' feet where they go back into the sand (the knees are overhead).
  queen: [{ x: 0, z: 1.5, ax: 0, half: 3.5, r: 4, top: 7 }, { x: -12.5, z: 1.6, ax: 0, half: 0, r: 0.9, top: 4 },
    { x: 12.5, z: 1.6, ax: 0, half: 0, r: 0.9, top: 4 }],
};

type Box = { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };
const box = (p: Post): Box => ({
  x0: p.x - (p.ax ? p.half : 0) - p.r, x1: p.x + (p.ax ? p.half : 0) + p.r, y0: 0, y1: p.top,
  z0: p.z - (p.ax ? 0 : p.half) - p.r, z1: p.z + (p.ax ? 0 : p.half) + p.r,
});

/** Where the middle of each kind's footprint is in the model's frame: the placed thing stands there, the model is drawn
 *  that much back (src/world/trophies.ts). */
export const CENTRE = {} as Record<BossKind, { x: number; z: number }>;
/** The trophies as shared/placed.ts PLACEABLES: footprint, boxes, out on the sand, and they sink into it on a slope. */
export const TROPHY_PLACEABLES: Record<string, { hx: number; hz: number; boxes: Box[]; sand: true; gap: number; tilt: number; turns: number }> = {};
for (const k of BOSS_KINDS) {
  const bs = POSTS[k].map(box);
  const x0 = Math.min(...bs.map((b) => b.x0)), x1 = Math.max(...bs.map((b) => b.x1));
  const z0 = Math.min(...bs.map((b) => b.z0)), z1 = Math.max(...bs.map((b) => b.z1));
  const c = (CENTRE[k] = { x: (x0 + x1) / 2, z: (z0 + z1) / 2 });
  TROPHY_PLACEABLES[TROPHY[k]] = {
    hx: (x1 - x0) / 2, hz: (z1 - z0) / 2, sand: true, gap: 1, tilt: 2.5, turns: 4,
    boxes: bs.map((b) => ({ ...b, x0: b.x0 - c.x, x1: b.x1 - c.x, z0: b.z0 - c.z, z1: b.z1 - c.z })),
  };
}

/** Can trophy `kind` be put up now: its boss kind beaten (`beaten`: shared/bosses.ts bossBit mask) and not standing yet
 *  (`list`: what's placed)? */
export function trophyFree(kind: string, beaten: number, list: readonly { kind: string }[]): boolean {
  const k = trophyBoss(kind);
  return !!k && !!(beaten & bossBit(k)) && !list.some((p) => p.kind === kind);
}

/** Where each kind's trophy stood round the world's origin (local x, z, and turn) before they were put up by hand: the old
 *  worlds that beat a boss get theirs there (server/bunkerGone.ts). */
export const OLD_TROPHY_SPOTS: Record<BossKind, { x: number; z: number; rot: number }> = {
  worm: { x: -27, z: 6, rot: 1 }, queen: { x: 27, z: 8, rot: 3 }, colossus: { x: -28, z: -24, rot: 1 }, carrier: { x: 32, z: -32, rot: 3 },
};
