// Biomes: regions of the desert that look, feel and play differently from the dune sea, met further out the
// further you go. Each biome is a weight 0..1 at every point, a pure function of position (same determinism rules
// as shared/dunes.ts: integer hashing and exact IEEE operations only), read by the terrain (shared/dunes.ts,
// shared/rocks.ts), the renderer (per-vertex attributes in src/world/terrain.ts, shaded in src/world/sandMaterial.ts)
// and the heat (shared/temperature.ts).
//
// Where a biome lies: a slow noise picks blobs a few hundred metres across, and how much of the land they cover
// grows with the distance from the world's origin, from nothing inside `from` to `cover` past `full`. The origin
// stands in for the spawn: the base is always within 600 m of it (shared/base.ts findBase), and the base's spot
// is picked from the dunes, which read the biomes, so the biomes cannot measure from the base itself.
//
// The dune sea is what is left where no biome's weight reaches. To add one: a Biome below, a weight function, and
// whatever reads it (its ground in duneHeight, its look in the sand shader, its heat).
import { ss, vnoise } from './noise.ts';
import { WORLD_SEED } from './world.ts';

type Biome = {
  /** Distance (m) from the origin where the first, rare, small patches appear (none inside it)... */
  from: number;
  /** ...and past which it covers its full share of the land. */
  full: number;
  /** Rough share of the land it covers past `full` (0..1). */
  cover: number;
  /** Size of its blobs (m): the scale of the noise picking them. */
  size: number;
  /** Width of its edge, in noise units (larger: softer, wider shores). */
  edge: number;
  /** Noise seed offset, distinct per biome. */
  seed: number;
};

/** Dried lake beds: dead flat, cracked mud, no dunes and next to no rocks, no shade, and hotter than the sand. */
export const MUDFLAT: Biome = { from: 1000, full: 2400, cover: 0.35, size: 700, edge: 0.05, seed: 41 };

/** Width (m) of the band inside `from` where a biome fades to nothing, so a patch reaching over it ends softly. */
const FADE_IN = 150;

/** Weight 0..1 of biome `b` at (x, z). */
function weight(b: Biome, x: number, z: number): number {
  const d = Math.sqrt(x * x + z * z);
  if (d <= b.from - FADE_IN) return 0;
  const reach = ss((d - b.from) / (b.full - b.from));
  const s = WORLD_SEED + b.seed;
  const inv = 1 / b.size;
  const n = vnoise(x * inv + 13.1, z * inv - 7.7, s) * 0.75 + vnoise(x * inv * 3.1, z * inv * 3.1, s + 1) * 0.25;
  // Threshold on the noise (mostly 0.2..0.8): only its rare peaks clear it at `from`, about `cover` of it past `full`.
  const t = 0.72 - (0.6 * b.cover - 0.11) * reach;
  return ss((n - t) / b.edge) * ss((d - b.from + FADE_IN) / FADE_IN);
}

/** How much of a mud flat (shared MUDFLAT) is at (x, z): 1 out on the flat, 0 off it. */
export function mudflat(x: number, z: number): number {
  return weight(MUDFLAT, x, z);
}
