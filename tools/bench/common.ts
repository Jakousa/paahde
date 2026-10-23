// What every benchmark shares (docs/bench.md): the world they run in, seeded dice, a stopwatch and what a run reports.

/** The world every benchmark runs in: its id is its seed, so the desert is the same on both commits. */
export const BENCH_WORLD_ID = 'bench0001';

/** Units whose numbers are counts of work (draws, triangles, pieces): steady from run to run, so any real change shows. The
 *  rest wobble with the machine (times) or with timing (what a live server sends). */
export const COUNT_UNITS = new Set(['', 'k']);

/** One run of a case: its numbers (value and unit; lower is better for all of them) and texts that tell if behaviour
 *  changed (a checksum of where the physics took everyone, say). */
export type Sample = { m: Record<string, [number, string]>; info?: Record<string, string> };

/** Math.random from a seed (mulberry32, like shared/noise.ts), for the game code a case runs. */
export function seedRandom(seed: number) {
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Milliseconds `f` takes. */
export function time(f: () => void): number {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
}

/** A short hash of numbers (rounded to `digits` decimals): the same numbers, the same text. */
export function checksum(xs: number[], digits = 3): string {
  let h = 0x811c9dc5;
  for (const x of xs) for (const c of x.toFixed(digits)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}
