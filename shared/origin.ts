// The world's origin: the point every world's layout is measured from. Site levels go by the distance from it (shared/
// crashsites.ts), and so do the scrap fields, the wrecks, the rocks' and canyons' keep-out, the shelters', the crashed ship's
// spot (shared/shipSpot.ts), the flying wing's odds (server/jets.ts) and the walkers' tiers. Picked per seed: it's where the
// first players' bunker used to stand, and it stays put so every world keeps its layout.
//
// Same determinism rules as shared/dunes.ts: + - * /, Math.sqrt, Math.abs, Math.min/max only.

import { duneHeight, WORLD_SEED } from './dunes.ts';

/**
 * The origin for a seed: the flattest spot of the dunes (least height range over a 40 × 60 m patch) within 600 m of
 * (0, 0), on a 16 m grid, with a slight pull towards (0, 0); `y` the mean height there.
 */
function findOrigin(seed: number) {
  let best = { x: 0, z: 0, y: 0 }, bestScore = Infinity;
  for (let gz = -600; gz <= 600; gz += 16) {
    for (let gx = -600; gx <= 600; gx += 16) {
      const d = Math.sqrt(gx * gx + gz * gz);
      if (d > 600) continue;
      let lo = Infinity, hi = -Infinity, sum = 0, n = 0;
      for (let lz = -40; lz <= 20; lz += 10) {
        for (let lx = -20; lx <= 20; lx += 10) {
          const h = duneHeight(gx + lx, gz + lz, seed);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
          sum += h;
          n++;
        }
      }
      const score = hi - lo + d * 0.004;
      if (score < bestScore) {
        bestScore = score;
        best = { x: gx, z: gz, y: Math.round((sum / n) * 100) / 100 };
      }
    }
  }
  return best;
}

/** The world's origin, picked from the world seed. */
export const ORIGIN = findOrigin(WORLD_SEED);
/** 9 m out from the origin along +Z: the scrap pile nearest the start and the starter wreck are measured from here. */
export const ORIGIN_FRONT = { x: ORIGIN.x, z: ORIGIN.z + 9 };

/** The ground round the origin that the layout keeps clear (where the bunker's pad was, a 28 × 57 m rectangle, then a
 *  24 m blend): scrap piles and wrecks keep 30% of the way out of its blend, crash sites all the way. */
const CLEAR = { x0: -14, x1: 14, z0: -43, z1: 14, blend: 24 };

/** How far out of the origin's ground (world x, z) is: 0 on it, easing up to 1 at the end of its blend. */
export function originClear(x: number, z: number): number {
  const lx = x - ORIGIN.x, lz = z - ORIGIN.z;
  const dx = Math.max(CLEAR.x0 - lx, 0, lx - CLEAR.x1);
  const dz = Math.max(CLEAR.z0 - lz, 0, lz - CLEAR.z1);
  if (dx === 0 && dz === 0) return 0;
  const t = Math.sqrt(dx * dx + dz * dz) / CLEAR.blend;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/** The dunes' height `h` at (x, z) as the layout first saw them, flattened into the bunker's pad round the origin: the
 *  crashed ship's spot was picked on these (shared/shipSpot.ts), and keeps it. Not the terrain: there's no pad now. */
export function padLevel(x: number, z: number, h: number): number {
  const w = originClear(x, z), y = ORIGIN.y - 0.06;
  return w === 1 ? h : y + (h - y) * w;
}
