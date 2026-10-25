// Where the crashed ship lies (shared/ship.ts: the wreck players arrive at), and the furrow it ploughed. Kept apart from
// shared/ship.ts so the terrain (shared/terrain.ts: the furrow is part of baseHeight) and the shelters (shared/shelters.ts:
// one with a pump lies near it) can read it without importing what the ship itself needs (the terrain).
//
// The spot is picked from the world seed among a few candidates 40–60 m out from the world's origin (shared/origin.ts:
// where the world is measured from, once the starting bunker's door): the one whose sand under the hull and along its
// furrow is the most even, as the dunes were with the bunker's pad (padLevel), so every world keeps its ship where it
// was. Its door side is flattened into a pad (withShipPad), so the ramp comes down onto the sand. Same determinism
// rules as shared/dunes.ts: + - * /, Math.sqrt, Math.abs, Math.min/max only (no trig), so client and server agree to
// the bit.
//
// Ship frame: origin on the sand under the middle of the hull, +Z the way it was going (the nose: model +Z of
// public/models/ship.glb), +X to its right. World = origin + lx·(dz, -dx) + lz·(dx, dz).
import { ORIGIN, padLevel } from './origin.ts';
import { duneHeight, WORLD_SEED } from './dunes.ts';
import { SHIP_DEBRIS, SHIP_NODES } from './shipModel.ts';
import { LAB } from './world.ts';

/** A candidate: the hull's middle (origin-local) and the way the nose points (normalised below). */
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
    const l = Math.sqrt(a * a + b * b), dx = a / l, dz = b / l, x = ORIGIN.x + lx, z = ORIGIN.z + lz;
    const h = (u: number, v: number) => {
      const wx = x + v * dz + u * dx, wz = z - v * dx + u * dz;
      return padLevel(wx, wz, duneHeight(wx, wz, WORLD_SEED));
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

/** Where the first broken motorcycle lies, ship-local, the first of these that's clear (shared/lootRoll.ts homeBikeSpot):
 *  on its side by the left flank, in view from the ramp's foot. */
export const SHIP_BIKE_SPOTS: [number, number][] = [[-10, 9], [-11, -6], [-13, 3]];

/** Where the ship lies in this world (none in the dev test lab). */
export const SHIP_AT: ShipSpot | null = LAB ? null : pick();

/** Ship-local (lx, lz) to world. */
export function shipToWorld(lx: number, lz: number): { x: number; z: number } {
  const s = SHIP_AT!;
  return { x: s.x + lx * s.dz + lz * s.dx, z: s.z - lx * s.dx + lz * s.dz };
}

/** The solid capsules of the hull and the debris behind it, ship-local (x, z; segment centre ± half·(ax, az), radius r),
 *  the same as shared/ship.ts collides with (from shared/shipModel.ts), without their heights. */
const FOOTPRINT: { x: number; z: number; ax: number; az: number; half: number; r: number }[] = [];
{
  const node = (n: string) => SHIP_NODES.find((d) => d.node === n)!;
  for (const c of node('Ship_Hull').capsules) FOOTPRINT.push({ x: c.x, z: c.z, ax: c.ax, az: c.az, half: c.half, r: c.r });
  for (const [n, lx, lz, c, sn] of SHIP_DEBRIS) {
    // The piece's +X and +Z, ship-local (shared/ship.ts place()).
    const rx = c, rz = -sn, fx = sn, fz = c;
    for (const k of node(n).capsules) {
      FOOTPRINT.push({ x: lx + k.x * rx + k.z * fx, z: lz + k.x * rz + k.z * fz, ax: k.ax * rx + k.az * fx, az: k.ax * rz + k.az * fz, half: k.half, r: k.r });
    }
  }
}

/** Ship-local (lx, lz) of world (x, z). */
function toShip(s: ShipSpot, x: number, z: number): [number, number] {
  const ox = x - s.x, oz = z - s.z;
  return [ox * s.dz - oz * s.dx, ox * s.dx + oz * s.dz];
}

/** Distance from ship-local (lx, lz) to the nearest of the ship's capsules' skins (negative inside one). */
function shipDistance(lx: number, lz: number): number {
  let best = Infinity;
  for (const c of FOOTPRINT) {
    let t = (lx - c.x) * c.ax + (lz - c.z) * c.az;
    t = t < -c.half ? -c.half : t > c.half ? c.half : t;
    const ex = lx - c.x - c.ax * t, ez = lz - c.z - c.az * t;
    best = Math.min(best, Math.sqrt(ex * ex + ez * ez) - c.r);
  }
  return best;
}

/** World (x, z) within `m` of the ship: its hull and the debris behind it, by their real shape (the capsules it collides
 *  with), where nobody digs and nothing is put up. */
export function nearShip(x: number, z: number, m = 0): boolean {
  const s = SHIP_AT;
  if (!s) return false;
  const [lx, lz] = toShip(s, x, z);
  if (lx > 24 + m || lx < -24 - m || lz > 24 + m || lz < -60 - m) return false;
  return shipDistance(lx, lz) < m;
}

/** World rectangle `r` ([x0, z0, x1, z1]) comes within `m` of the ship (nearShip, for a whole footprint): exact for a
 *  segment against a box, so a long footprint can't straddle a slim capsule between the points it's checked at. */
export function rectNearShip(r: number[], m = 0): boolean {
  const s = SHIP_AT;
  if (!s) return false;
  const [cx, cz] = toShip(s, (r[0] + r[2]) / 2, (r[1] + r[3]) / 2);
  const reach = Math.max(r[2] - r[0], r[3] - r[1]);
  if (cx > 24 + m + reach || cx < -24 - m - reach || cz > 24 + m + reach || cz < -60 - m - reach) return false;
  // (The box is axis-aligned in the world, not in the ship's frame: each capsule's segment goes into the world instead.)
  for (const c of FOOTPRINT) {
    const ax = c.x - c.ax * c.half, az = c.z - c.az * c.half, bx = c.x + c.ax * c.half, bz = c.z + c.az * c.half;
    const p = { x: s.x + ax * s.dz + az * s.dx, z: s.z - ax * s.dx + az * s.dz };
    const q = { x: s.x + bx * s.dz + bz * s.dx, z: s.z - bx * s.dx + bz * s.dz };
    if (segmentToRect(p.x, p.z, q.x, q.z, r) < c.r + m) return true;
  }
  return false;
}

/** Distance from segment (ax, az)–(bx, bz) to the axis-aligned rectangle r ([x0, z0, x1, z1]); 0 if they touch. */
function segmentToRect(ax: number, az: number, bx: number, bz: number, r: number[]): number {
  // Clip the segment to the rectangle (Liang–Barsky): any part inside, they touch.
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  if (clip(-dx, ax - r[0]) && clip(dx, r[2] - ax) && clip(-dz, az - r[1]) && clip(dz, r[3] - az) && t0 <= t1) return 0;
  const toRect = (x: number, z: number) => {
    const ex = Math.max(r[0] - x, 0, x - r[2]), ez = Math.max(r[1] - z, 0, z - r[3]);
    return Math.sqrt(ex * ex + ez * ez);
  };
  const toSeg = (x: number, z: number) => {
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x - ax - dx * t, ez = z - az - dz * t;
    return Math.sqrt(ex * ex + ez * ez);
  };
  return Math.min(toRect(ax, az), toRect(bx, bz), toSeg(r[0], r[1]), toSeg(r[2], r[1]), toSeg(r[0], r[3]), toSeg(r[2], r[3]));
}

/** World (x, z) along the furrow behind it, or by the hull (+ margin): no scrap piles or wrecks there. */
export function onShipGround(x: number, z: number, m = 0): boolean {
  const s = SHIP_AT;
  if (!s) return false;
  const [v, u] = toShip(s, x, z);
  return u > -FURROW_END - m && u < HULL_HALF + 10 + m && Math.abs(v) < HULL_SIDE + 4 + m;
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** The furrow: a trench back along the way it came, deepest by the hull, with low banks of thrown sand each side; and
 *  the sand heaped up in front of the nose. */
const TRENCH = { from: -12, depth: 0.75, w0: 3.4, w1: 2.2, bank: 3.2, bankH: 0.4 };
const MOUND = { at: 15.5, len: 5.5, side: 6.5, h: 1.3 };

/** The pad along the door side, ship-local: a flat rectangle (x0..x1 across, z0..z1 along) and its blend (m) back into the
 *  dunes. The door is on the left (-X; shared/shipModel.ts SHIP_POINTS spawn and door): the ramp, its foot and the sand
 *  you arrive on, from the hull's flank to past the foot of the ramp, along the length of the hold. */
const PAD = { x0: -11, x1: -1.5, z0: -6, z1: 9, blend: 6 };
/** Where the hull's height is read round its middle (shared/ship.ts lowest(): its middle, and 8 m out each way). */
const HULL_SAMPLES: [number, number][] = [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8]];

/** The pad's level: the lowest of the sand `raw` (the terrain before the ship's pad and furrow) where the hull's height is
 *  read, which is where the hull comes to lie (shared/ship.ts), so it stays where it was and the ramp's foot meets the
 *  sand. Null with no ship. */
export function shipPadLevel(raw: (x: number, z: number) => number): number | null {
  const s = SHIP_AT;
  if (!s) return null;
  let y = Infinity;
  for (const [lx, lz] of HULL_SAMPLES) {
    const p = shipToWorld(lx, lz);
    y = Math.min(y, raw(p.x, p.z));
  }
  return y;
}

/** Terrain height `h` at world (x, z) with the sand flattened to `level` (shipPadLevel) along the ship's door side. */
export function withShipPad(x: number, z: number, h: number, level: number | null): number {
  const s = SHIP_AT;
  if (!s || level === null) return h;
  const ox = x - s.x, oz = z - s.z;
  if (ox > 30 || ox < -30 || oz > 30 || oz < -30) return h;
  const [lx, lz] = toShip(s, x, z);
  const ex = Math.max(PAD.x0 - lx, 0, lx - PAD.x1), ez = Math.max(PAD.z0 - lz, 0, lz - PAD.z1);
  if (ex === 0 && ez === 0) return level;
  const t = Math.sqrt(ex * ex + ez * ez) / PAD.blend;
  if (t >= 1) return h;
  return level + (h - level) * smooth(t);
}

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
