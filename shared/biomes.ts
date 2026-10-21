// Biomes: kinds of country that look, feel and play differently from the dune sea, met further out the further you
// go. Every biome is one entry in BIOMES: where it lies (`place`, a weight 0..1 at every point, a pure function of
// position under the same determinism rules as shared/dunes.ts) and what it is like (its properties, below; a
// system that varies by biome reads them through `blend` or `biome`, rather than asking "is this a mud flat").
// New properties go on Biome as the systems that read them are written: its own finds, enemies, sounds...
//
// BIOMES is in order of precedence: each biome claims its weight of what the ones before it left, so where two
// overlap the earlier wins (a canyon's tableland keeps the mud flats out). The dune sea is what is left over.
//
// Placement is each biome's own: the mud flats are noise blobs (`blobs`, below), the canyons long gorges laid out
// along paths (shared/canyons.ts). The terrain reads the weights (shared/dunes.ts, shared/rocks.ts,
// shared/canyons.ts), so does the renderer (per-vertex attributes in src/world/terrain.ts, shaded in
// src/world/sandMaterial.ts), the heat (shared/temperature.ts), the haze (src/blownSand.ts), and anything placed in
// the world (rocksNear keeps finds out of the canyons). The origin stands in for the spawn when a biome grows with
// distance: the base is always within 600 m of it (shared/base.ts findBase), and the base's spot is picked from the
// dunes, which read the biomes, so the biomes cannot measure from the base itself.
//
// To add one: an id, a placement, an entry in BIOMES at its precedence, and whatever reads it (its ground in
// duneHeight or a layout of its own, its look in the sand shader, its properties here).
import { canyonCover } from './canyons.ts';
import { ss, vnoise } from './noise.ts';
import { WORLD_SEED } from './world.ts';

export type BiomeId = 'canyon' | 'mudflat';

export type Biome = {
  id: BiomeId;
  /** How much of it is at (x, z), 0..1, before the biomes ahead of it in BIOMES take their share. */
  place: (x: number, z: number) => number;
  /** Extra felt °C from its ground with the sun at its noon height, in direct sun and in shade (shared/temperature.ts). */
  groundHeat?: { sun: number; shade: number };
  /** The distance haze's density in it, × the dune sea's (src/blownSand.ts). */
  haze?: number;
  /** Nothing is placed in it: no finds, scrap, wrecks, crash sites or shelters (shared/rocks.ts rocksNear). */
  empty?: boolean;
};

/** Blobs a few hundred metres across from a slow noise, covering more of the land the further from the origin: none
 *  inside `from` (m), `cover` (0..1, roughly) of it past `full`. `size`: the blobs' scale (m); `edge`: how soft
 *  their shores are (noise units); `seed`: distinct per biome. */
function blobs(o: { from: number; full: number; cover: number; size: number; edge: number; seed: number }) {
  const inv = 1 / o.size, s = WORLD_SEED + o.seed;
  return (x: number, z: number): number => {
    const d = Math.sqrt(x * x + z * z);
    if (d <= o.from - FADE_IN) return 0;
    const reach = ss((d - o.from) / (o.full - o.from));
    const n = vnoise(x * inv + 13.1, z * inv - 7.7, s) * 0.75 + vnoise(x * inv * 3.1, z * inv * 3.1, s + 1) * 0.25;
    // Threshold on the noise (mostly 0.2..0.8): only its rare peaks clear it at `from`, about `cover` of it past `full`.
    const t = 0.72 - (0.6 * o.cover - 0.11) * reach;
    return ss((n - t) / o.edge) * ss((d - o.from + FADE_IN) / FADE_IN);
  };
}

/** Width (m) of the band inside `from` where blobs fade to nothing, so a patch reaching over it ends softly. */
const FADE_IN = 150;

/** Canyons: Grand Canyon-scale gorges through a sandstone tableland (shared/canyons.ts); the air in them is clearer. */
export const CANYON: Biome = { id: 'canyon', place: (x, z) => canyonCover(x, z), haze: 0.3, empty: true };

/** Dried lake beds: dead flat, cracked mud, no dunes and next to no rocks, no shade, and hotter than the sand. */
export const MUDFLAT: Biome = {
  id: 'mudflat',
  place: blobs({ from: 1000, full: 2400, cover: 0.35, size: 1200, edge: 0.035, seed: 41 }),
  groundHeat: { sun: 7, shade: 3 },
};

/** Every biome, in order of precedence. */
export const BIOMES: Biome[] = [CANYON, MUDFLAT];

/** How much of biome `id` is at (x, z), 0..1, after the biomes ahead of it have taken theirs. */
export function biome(id: BiomeId, x: number, z: number): number {
  let left = 1;
  for (const b of BIOMES) {
    const w = b.place(x, z) * left;
    if (b.id === id) return w;
    left -= w;
    if (left <= 0) return 0;
  }
  return 0;
}

/** The biome with the most weight at (x, z) if it has more than half, else null (the dune sea). */
export function biomeAt(x: number, z: number): BiomeId | null {
  let left = 1;
  for (const b of BIOMES) {
    const w = b.place(x, z) * left;
    if (w > 0.5) return b.id;
    left -= w;
    if (left <= 0) break;
  }
  return null;
}

/** A property at (x, z), blended by the biomes' weights there: `pick` of each biome (`none` where it doesn't have
 *  it), and `none` for what the dune sea has. */
export function blend(x: number, z: number, pick: (b: Biome) => number | undefined, none: number): number {
  let left = 1, v = 0;
  for (const b of BIOMES) {
    const w = b.place(x, z) * left;
    if (w > 0) v += w * (pick(b) ?? none);
    left -= w;
    if (left <= 0) return v;
  }
  return v + left * none;
}
