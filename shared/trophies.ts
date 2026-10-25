// The trophies by the crashed ship: each boss kind's first kill (shared/bosses.ts, the 'lives' message's `beaten`) sets up a
// big piece of it, at its full size, on the sand round the ship (shared/ship.ts): the worm's head rearing out of the sand
// with its jaws spread, the colossus's head sunk to the chin with its arm raised out of the sand beside it, one of the
// carrier's fan ducts standing on edge, the queen's thorax nose-up with a leg arching out each side. Drawn by
// src/world/trophies.ts; they block (collideTrophies() in sim.ts step()) once setTrophies() has the kind (the server
// on start and on a kill, the client on each 'lives' message).
//
// Each kind's spot (trophyPlaces) is the first of a ring of candidates round the ship, its door side first, that is clear
// of the ship and its furrow, the ramp's foot, the first bike, and the world's layout (scrap, wrecks, crash sites,
// shelters, rocks) and the other trophies, all of it deterministic, so the client and the server agree; its ground is
// never dug (overTrophy), so it can't be undermined.
//
// Same determinism rules as shared/scrap.ts in the collision: + - * /, Math.sqrt, Math.abs, Math.min/max only.
//
// A trophy's own frame: origin on the sand at its spot, +Z facing the ship, +X to its right.

import { BOSS_KINDS, bossBit, type BossKind } from './bosses.ts';
import { crashSitesNear } from './crashsites.ts';
import { rocksNear } from './rocks.ts';
import { SCRAP_CELL, scrapPieces } from './scrap.ts';
import { shelterWithin } from './shelters.ts';
import { nearShip, onShipGround, SHIP_AT, SHIP_BIKE_SPOTS, shipToWorld } from './shipSpot.ts';
import { SHIP_POINTS } from './shipModel.ts';
import { baseHeight, keepUndug } from './terrain.ts';
import { wrecksNear } from './wrecks.ts';

/** How much ground each kind's trophy takes (m round its spot): what of it stands on the sand reaches about this far. */
const TROPHY_R: Record<BossKind, number> = { worm: 9, queen: 15, colossus: 21, carrier: 14 };
/** Spots are tried in this order: the biggest first, so it gets the pick. */
const BY_SIZE: BossKind[] = ['colossus', 'queen', 'carrier', 'worm'];
/** Directions round the ship, ship-local unit (x: its right, z: its nose), the door side (-X) first, then ahead of it,
 *  behind it, and the far side last (no trig). */
const AROUND: [number, number][] = [[-1, 0], [-0.866, 0.5], [-0.866, -0.5], [-0.5, 0.866], [-0.5, -0.866], [0, 1],
  [0.5, 0.866], [1, 0], [0.866, 0.5], [0.866, -0.5], [0.5, -0.866], [0, -1]];
/** How far out from the ship's middle they stand: past its ground, near enough to be seen from the ramp. */
const RINGS = [30, 40, 52, 66, 82];
/** What each trophy keeps clear of beyond its own ground (m). */
const CLEAR = { ship: 6, spawn: 10, bike: 4, scrap: 2, wreck: 8, site: 6, rock: 2, shelter: 6, trophy: 6 };

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

const dist = (ax: number, az: number, bx: number, bz: number) => Math.sqrt((ax - bx) * (ax - bx) + (az - bz) * (az - bz));

/** Is world (x, z) clear for a trophy taking `r` round it, apart from the others already placed? */
function clearFor(x: number, z: number, r: number, others: { x: number; z: number; r: number }[]): boolean {
  if (nearShip(x, z, r + CLEAR.ship) || onShipGround(x, z, r * 0.5)) return false;
  const spawn = shipToWorld(SHIP_POINTS.spawn[0], SHIP_POINTS.spawn[2]);
  if (dist(x, z, spawn.x, spawn.z) < r + CLEAR.spawn) return false;
  for (const [lx, lz] of SHIP_BIKE_SPOTS) {
    const b = shipToWorld(lx, lz);
    if (dist(x, z, b.x, b.z) < r + CLEAR.bike) return false;
  }
  if (others.some((o) => dist(x, z, o.x, o.z) < r + o.r + CLEAR.trophy)) return false;
  if (rocksNear(x, z, r + CLEAR.rock) || shelterWithin(x, z, r + CLEAR.shelter)) return false;
  if (wrecksNear(x, z, r + CLEAR.wreck).length) return false;
  if (crashSitesNear(x, z, r + 300).some((s) => dist(s.x, s.z, x, z) < r + s.radius + CLEAR.site)) return false;
  const reach = r + CLEAR.scrap;
  for (let iz = Math.floor((z - reach) / SCRAP_CELL); iz <= Math.floor((z + reach) / SCRAP_CELL); iz++) {
    for (let ix = Math.floor((x - reach) / SCRAP_CELL); ix <= Math.floor((x + reach) / SCRAP_CELL); ix++) {
      if (scrapPieces(ix, iz).some((p) => dist(p.x, p.z, x, z) < reach)) return false;
    }
  }
  return true;
}

function place(kind: BossKind, x: number, z: number): TrophyPlace {
  const s = SHIP_AT!;
  let fx = s.x - x, fz = s.z - z;
  const d = Math.sqrt(fx * fx + fz * fz);
  fx /= d;
  fz /= d;
  let y = baseHeight(x, z);
  const r = TROPHY_R[kind] * 0.5;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) {
    y = Math.min(y, baseHeight(x + dx * r, z + dz * r));
  }
  return { x, y, z, fx, fz };
}

let places: Partial<Record<BossKind, TrophyPlace>> | null = null;
/** Where each kind's trophy stands (none in the dev test lab, which has no ship), worked out on first use. */
export function trophyPlaces(): Partial<Record<BossKind, TrophyPlace>> {
  if (places) return places;
  places = {};
  if (!SHIP_AT) return places;
  const taken: { x: number; z: number; r: number }[] = [];
  for (const kind of BY_SIZE) {
    const r = TROPHY_R[kind];
    let spot: { x: number; z: number } | null = null;
    for (const d of RINGS) {
      for (const [ux, uz] of AROUND) {
        const p = shipToWorld(ux * d, uz * d);
        if (clearFor(p.x, p.z, r, taken)) {
          spot = p;
          break;
        }
      }
      if (spot) break;
    }
    // (Nowhere clear on every ring: the outermost door-side spot, whatever lies there.)
    spot ??= shipToWorld(-RINGS[RINGS.length - 1], 0);
    taken.push({ ...spot, r });
    places[kind] = place(kind, spot.x, spot.z);
  }
  return places;
}

/** True over a trophy's ground (+ margin): never dug, so it can't be undermined. */
export function overTrophy(x: number, z: number, margin = 0): boolean {
  const s = SHIP_AT;
  if (!s || Math.abs(x - s.x) > 130 || Math.abs(z - s.z) > 130) return false;
  const ps = trophyPlaces();
  for (const k of BOSS_KINDS) {
    const p = ps[k];
    if (!p) continue;
    const dx = x - p.x, dz = z - p.z, r = TROPHY_R[k] + margin;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}

keepUndug(overTrophy);

/** A post in world coordinates (bottom: the sand). */
type WorldPost = { x: number; z: number; ax: number; az: number; half: number; r: number; y: number; top: number };

function worldPosts(k: BossKind): WorldPost[] {
  const p = trophyPlaces()[k];
  if (!p) return [];
  const rx = p.fz, rz = -p.fx; // +X of the trophy's frame
  return POSTS[k].map((q) => ({
    x: p.x + q.x * rx + q.z * p.fx, z: p.z + q.x * rz + q.z * p.fz,
    ax: q.ax * rx + q.az * p.fx, az: q.ax * rz + q.az * p.fz, half: q.half, r: q.r, y: p.y, top: p.y + q.top,
  }));
}

let up: WorldPost[] = [];

/** The kinds beaten (shared/bosses.ts bossBit mask): their trophies stand and block. */
export function setTrophies(beaten: number) {
  up = BOSS_KINDS.filter((k) => beaten & bossBit(k)).flatMap(worldPosts);
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
