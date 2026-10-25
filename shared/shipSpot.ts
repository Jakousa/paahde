// Where the crashed ship lies (shared/ship.ts: the wreck players arrive at), and the furrow it ploughed. Kept apart from
// shared/ship.ts so the terrain (shared/terrain.ts: the furrow is part of baseHeight) and the shelters (shared/shelters.ts:
// one with a pump lies near it) can read it without importing what the ship itself needs (the terrain).
//
// The spot is picked from the world seed among a few candidates out in front of the base's door (BASE: where the world
// is measured from), clear of the bunker, the mast, the trophies' ground and the pad: the one whose sand under the hull
// and along its furrow is the most even. Same determinism rules as shared/dunes.ts: + - * /, Math.sqrt, Math.abs,
// Math.min/max only (no trig), so client and server agree to the bit.
//
// Ship frame: origin on the sand under the middle of the hull, +Z the way it was going (the nose: model +Z of
// public/models/ship.glb), +X to its right. World = origin + lx·(dz, -dx) + lz·(dx, dz).
import { BASE, withPad } from './base.ts';
import { duneHeight, WORLD_SEED } from './dunes.ts';
import { LAB } from './world.ts';

/** A candidate: the hull's middle (base-local) and the way the nose points (normalised below). */
const CANDIDATES: [number, number, number, number][] = [
  [-8, 50, 0.94, 0.34], [8, 50, -0.94, 0.34], [-10, 58, 0.8, -0.6], [10, 58, -0.8, -0.6],
  [-46, 36, 0.6, 0.8], [46, 38, -0.6, 0.8],
];
/** The hull's half length and half width with its wing (m), and how far back its furrow runs from the middle. */
const HULL_HALF = 14, HULL_SIDE = 10, FURROW_END = 60;

export type ShipSpot = { x: number; z: number; dx: number; dz: number };

function pick(): ShipSpot {
  let best: ShipSpot = { x: 0, z: 0, dx: 0, dz: 1 }, bestScore = Infinity;
  CANDIDATES.forEach(([lx, lz, a, b], i) => {
    const l = Math.sqrt(a * a + b * b), dx = a / l, dz = b / l, x = BASE.x + lx, z = BASE.z + lz;
    const h = (u: number, v: number) => {
      const wx = x + v * dz + u * dx, wz = z - v * dx + u * dz;
      return withPad(wx, wz, duneHeight(wx, wz, WORLD_SEED));
    };
    let lo = Infinity, hi = -Infinity, tlo = Infinity, thi = -Infinity;
    for (let u = -HULL_HALF; u <= HULL_HALF; u += 4) for (let v = -HULL_SIDE; v <= HULL_SIDE; v += 5) {
      const y = h(u, v);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    for (let u = -HULL_HALF; u >= -FURROW_END; u -= 6) {
      const y = h(u, 0);
      tlo = Math.min(tlo, y);
      thi = Math.max(thi, y);
    }
    const score = hi - lo + 0.5 * (thi - tlo) + i * 0.05;
    if (score < bestScore) {
      bestScore = score;
      best = { x, z, dx, dz };
    }
  });
  return best;
}

/** Where the ship lies in this world (none in the dev test lab). */
export const SHIP_AT: ShipSpot | null = LAB ? null : pick();

/** Ship-local (lx, lz) to world. */
export function shipToWorld(lx: number, lz: number): { x: number; z: number } {
  const s = SHIP_AT!;
  return { x: s.x + lx * s.dz + lz * s.dx, z: s.z - lx * s.dx + lz * s.dz };
}

/** World (x, z) within the hull's footprint (its wing too) + margin, where nothing else goes and nobody digs. */
export function nearShip(x: number, z: number, m = 0): boolean {
  const s = SHIP_AT;
  if (!s) return false;
  const ox = x - s.x, oz = z - s.z, u = ox * s.dx + oz * s.dz, v = ox * s.dz - oz * s.dx;
  return Math.abs(u) < HULL_HALF + 2 + m && Math.abs(v) < HULL_SIDE + 1 + m;
}

/** World (x, z) along the furrow behind it, or by the hull (+ margin): no scrap piles or wrecks there. */
export function onShipGround(x: number, z: number, m = 0): boolean {
  const s = SHIP_AT;
  if (!s) return false;
  const ox = x - s.x, oz = z - s.z, u = ox * s.dx + oz * s.dz, v = ox * s.dz - oz * s.dx;
  return u > -FURROW_END - m && u < HULL_HALF + 10 + m && Math.abs(v) < HULL_SIDE + 4 + m;
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** The furrow: a trench back along the way it came, deepest by the hull, with low banks of thrown sand each side; and
 *  the sand heaped up in front of the nose. */
const TRENCH = { from: -12, depth: 0.75, w0: 3.4, w1: 2.2, bank: 3.2, bankH: 0.4 };
const MOUND = { at: 15.5, len: 5.5, side: 6.5, h: 1.3 };

/** Terrain height `h` at world (x, z) with the ship's furrow and the heap at its nose (shared/terrain.ts baseHeight). */
export function withShipFurrow(x: number, z: number, h: number): number {
  const s = SHIP_AT;
  if (!s) return h;
  const ox = x - s.x, oz = z - s.z;
  if (ox > 80 || ox < -80 || oz > 80 || oz < -80) return h;
  const u = ox * s.dx + oz * s.dz, v = Math.abs(ox * s.dz - oz * s.dx);
  if (u < TRENCH.from && u > -FURROW_END) {
    // 0 at the hull's end, 1 where it fades out; the trench narrows and shallows back along it.
    const t = (TRENCH.from - u) / (FURROW_END + TRENCH.from);
    const d = TRENCH.depth * (1 - smooth((t - 0.6) / 0.4)), w = TRENCH.w0 + (TRENCH.w1 - TRENCH.w0) * t;
    if (v < w) {
      const q = v / w;
      return h - d * (1 - q * q);
    }
    if (v < w + TRENCH.bank) {
      const q = (v - w) / TRENCH.bank, b = 4 * q * (1 - q);
      return h + (d / TRENCH.depth) * TRENCH.bankH * b * b;
    }
    return h;
  }
  const du = (u - MOUND.at) / MOUND.len;
  if (du > -1 && du < 1 && v < MOUND.side) {
    const a = 1 - du * du, q = v / MOUND.side, c = 1 - q * q;
    return h + MOUND.h * a * a * c * c;
  }
  return h;
}
