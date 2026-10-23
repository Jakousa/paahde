// What each cell of a grid holds (rocks, canyons...), worked out the first time it's asked for and kept. Long-lived
// processes (the server) walk the whole world, so it's bounded: past `limit` cells it starts afresh, keeping the last
// lot until they're asked for again (moved over) or the next lot fills, so the cells in use are never all dropped at once.

/** Packs cell (ix, iz) into one safe integer key (|ix|, |iz| < 2^25). */
export const cellKey = (ix: number, iz: number) => (ix + 2 ** 25) * 2 ** 26 + (iz + 2 ** 25);

/** `make(ix, iz)` for each cell, cached. */
export function cellCache<T>(limit: number, make: (ix: number, iz: number) => T): (ix: number, iz: number) => T {
  let cur = new Map<number, T>(), old = new Map<number, T>();
  return (ix, iz) => {
    const k = cellKey(ix, iz);
    let v = cur.get(k);
    if (v !== undefined) return v;
    v = old.get(k);
    if (v === undefined) v = make(ix, iz);
    if (cur.size >= limit) {
      old = cur;
      cur = new Map();
    }
    cur.set(k, v);
    return v;
  };
}
