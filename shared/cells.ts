// Stable integer ids for grid cells (crash sites, shelters) in a world with no edge.
//
// The first 128×128 cells round the origin keep the ids they had when the world was a ±2000 m square
// ((ix + 64)·128 + (iz + 64), stored in saves); every other cell is numbered after them.

const OLD = 64;
const OLD_COUNT = 128 * 128;
/** Cells this far from the origin on either axis are past any sane journey: ids beyond are rejected. */
const MAX = 1 << 24;

const zig = (n: number) => (n >= 0 ? 2 * n : -2 * n - 1);
const unzig = (n: number) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

/** Id of cell (ix, iz). */
export function cellId(ix: number, iz: number): number {
  if (ix >= -OLD && ix < OLD && iz >= -OLD && iz < OLD) return (ix + OLD) * 128 + (iz + OLD);
  const a = zig(ix), b = zig(iz);
  return OLD_COUNT + (a >= b ? a * a + a + b : a + b * b);
}

/** Cell of id, or null if it isn't one (ids may come from the network). */
export function cellOf(id: number): { ix: number; iz: number } | null {
  if (!Number.isSafeInteger(id) || id < 0) return null;
  if (id < OLD_COUNT) return { ix: Math.floor(id / 128) - OLD, iz: (id % 128) - OLD };
  const n = id - OLD_COUNT, s = Math.floor(Math.sqrt(n)), r = n - s * s;
  const ix = unzig(r < s ? r : s), iz = unzig(r < s ? s : r - s);
  if (Math.abs(ix) > MAX || Math.abs(iz) > MAX || cellId(ix, iz) !== id) return null;
  return { ix, iz };
}

/** True if cell (ix, iz) is within the range ids are given for. */
export const cellInRange = (ix: number, iz: number) => Math.abs(ix) <= MAX && Math.abs(iz) <= MAX;
