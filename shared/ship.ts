// The crashed ship: where the players arrive. A cargo lander lying on its belly near the origin of the world (its spot and
// the furrow it ploughed: shared/shipSpot.ts), nose in the sand, its tall tail fin a landmark from far off; the cargo door
// down as a ramp, new players appear at its foot (shipSpawn: server/world.ts). Behind it, along the furrow, the left wing,
// a hull plate and a landing leg. Model and capsules from tools/blender/ship.py (public/models/ship.glb,
// shared/shipModel.ts); drawn by src/world/ship.ts.
//
// It is a small scrap-field site of its own: a few of the starter machines thrown out of its hold (shipSites: machine
// sites "ship:<n>" like a crash site's, shared/crash.ts, carried off and back on the starter timer, server/crash.ts), and
// scrap, cloth and now and then a broken canteen lying about it (shipLootSpot, SHIP_LOOT in shared/tables.ts, rolled in
// shared/lootRoll.ts, laid out by server/loot.ts). The first broken motorcycle lies beside it (shared/lootRoll.ts
// homeBikeSpot).
//
// Solid (collideShip in sim.ts step(); the rules of shared/scrap.ts: a top within a step of the feet is ground,
// anything taller a wall) and it casts shade (shipCasters, shared/shade.ts). Same determinism rules as shared/scrap.ts in
// the collision: + - * /, Math.sqrt, Math.abs, Math.min/max only.
import type { CrashSite } from './crash.ts';
import { WORLD_SEED } from './dunes.ts';
import { mulberry32 } from './noise.ts';
import { COMPONENTS, type ComponentKind } from './salvage.ts';
import { SHIP_DEBRIS, SHIP_NODES, SHIP_POINTS } from './shipModel.ts';
import { SHIP_AT, shipToWorld } from './shipSpot.ts';
import { LEVEL_KINDS } from './tables.ts';
import { baseHeight } from './terrain.ts';

export { SHIP_AT, nearShip, onShipGround } from './shipSpot.ts';

/** A solid capsule in world xz: segment centre ± half·(ax, az), radius r, from its piece's sand (y) up to top. */
type Cap = { x: number; z: number; ax: number; az: number; half: number; r: number; y: number; top: number };

/** A piece as it lies in the world: its glb node, its origin (on the sand), the way its model +Z points (unit), its capsules. */
export type ShipPiece = { node: string; x: number; y: number; z: number; fx: number; fz: number; caps: Cap[] };

let pieces: ShipPiece[] | null = null;

/** The lowest sand round (x, z) at radius r (so nothing floats). */
function lowest(x: number, z: number, r: number, fx: number, fz: number): number {
  let y = baseHeight(x, z);
  for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) y = Math.min(y, baseHeight(x + (a * fz + b * fx) * r, z + (-a * fx + b * fz) * r));
  return y;
}

function place(node: string, x: number, z: number, fx: number, fz: number, y: number): ShipPiece {
  const def = SHIP_NODES.find((n) => n.node === node)!;
  const rx = fz, rz = -fx; // the piece's +X in the world
  return {
    node, x, y, z, fx, fz,
    caps: def.capsules.map((c) => ({
      x: x + c.x * rx + c.z * fx, z: z + c.x * rz + c.z * fz, ax: c.ax * rx + c.az * fx, az: c.ax * rz + c.az * fz,
      half: c.half, r: c.r, y, top: y + c.h,
    })),
  };
}

/** The hull and the debris behind it, in the world (none in the dev test lab). */
export function shipPieces(): ShipPiece[] {
  if (pieces) return pieces;
  const s = SHIP_AT;
  if (!s) return (pieces = []);
  // The hull sits on the lowest sand along its middle; its belly goes a metre under.
  const hull = place('Ship_Hull', s.x, s.z, s.dx, s.dz, lowest(s.x, s.z, 8, s.dx, s.dz));
  const out = [hull];
  for (const [node, lx, lz, c, sn] of SHIP_DEBRIS) {
    const p = shipToWorld(lx, lz);
    // Its +Z, turned (c, sn) from the ship's, then into the world.
    const fx = sn * s.dz + c * s.dx, fz = -sn * s.dx + c * s.dz;
    const r = SHIP_NODES.find((n) => n.node === node)!.radius;
    out.push(place(node, p.x, p.z, fx, fz, lowest(p.x, p.z, r * 0.5, fx, fz)));
  }
  return (pieces = out);
}

/** A point on the hull (SHIP_POINTS, ship-local) in the world. */
export function shipPoint(name: keyof typeof SHIP_POINTS): { x: number; y: number; z: number } {
  const [lx, ly, lz] = SHIP_POINTS[name];
  const p = shipToWorld(lx, lz);
  return { x: p.x, y: shipPieces()[0].y + ly, z: p.z };
}

/** Where new players appear (and the dead, with no bedroll to go back to): the foot of the cargo ramp. Null in the lab. */
export function shipSpawn(): { x: number; z: number } | null {
  if (!SHIP_AT) return null;
  const p = shipPoint('spawn');
  return { x: p.x, z: p.z };
}

const STAND_MARGIN = 0.15;

/** Push `p` out of the ship and its debris; returns the height of a top under its feet to stand on (the ramp's treads,
 *  the debris), or -Infinity. */
export function collideShip(p: { x: number; z: number; vx: number; vz: number }, y: number, prevY: number, radius: number, stepUp: number): number {
  const s = SHIP_AT;
  if (!s || Math.abs(p.x - s.x) > 70 || Math.abs(p.z - s.z) > 70) return -Infinity;
  let support = -Infinity;
  const feet = Math.max(y, prevY);
  for (const pc of shipPieces()) for (const b of pc.caps) {
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

/** The ship's capsules within `r` of (x, z), as shade casters (shared/shade.ts). */
export function shipCasters(x: number, z: number, r: number): Cap[] {
  const s = SHIP_AT;
  if (!s || Math.abs(x - s.x) > r + 70 || Math.abs(z - s.z) > r + 70) return [];
  return shipPieces().flatMap((pc) => pc.caps);
}

// ---- the machines thrown out of its hold ---------------------------------------------------------------------------

/** The numeric site the ship's machines belong to (shared/crash.ts CrashSite.wreck): no crash site has it, so it never
 *  smokes or goes spent. */
export const SHIP_WRECK = -2;
/** Where they lie, ship-local (x, z): out of the tear on the right flank, ahead of the wing, and one back in the furrow. */
const MACHINE_SPOTS: [number, number][] = [[6.0, 5.0], [9.0, 1.0], [2.5, -21]];

let sites: CrashSite[] | null = null;

/** The ship's machines, as small machine sites of a scrap field (level 0: the starter machines). */
export function shipSites(): CrashSite[] {
  if (sites) return sites;
  if (!SHIP_AT) return (sites = []);
  const r = mulberry32(Math.imul(WORLD_SEED, 0x2c1b3c6d) ^ 0x5e1f);
  const kinds = (Object.entries(LEVEL_KINDS[0]) as [ComponentKind, number][]).filter(([k]) => COMPONENTS[k].carry);
  const total = kinds.reduce((a, [, w]) => a + w, 0);
  return (sites = MACHINE_SPOTS.map(([lx, lz], index) => {
    let u = r() * total, kind = kinds[0][0];
    for (const [k, w] of kinds) if ((u -= w) < 0) { kind = k; break; }
    const p = shipToWorld(lx, lz);
    return { id: `ship:${index}`, wreck: SHIP_WRECK, index, level: 0, ...p, yaw: r() * 6.2831853, kind, seed: (r() * 4294967296) >>> 0 };
  }));
}

/** The ship's machine with this id ("ship:<n>"), or null. Ids may come from the network. */
export function shipSiteById(id: unknown): CrashSite | null {
  if (typeof id !== 'string') return null;
  const m = /^ship:(\d)$/.exec(id);
  return (m && shipSites()[Number(m[1])]) || null;
}

// ---- what lies about it --------------------------------------------------------------------------------------------

/** Where its loot lies, ship-local (x, z): round the foot of the ramp, by the nose, under the tear, back along the furrow. */
const LOOT_SPOTS: [number, number][] = [
  [-8, 6], [-7, -3], [-10, 1], [-5, 13], [5, 12.5], [4.5, 1.5], [-3.5, -18], [4, -27], [-2.5, -36], [1.5, -48],
];

/** A spot to lay something out at the ship, from `rand` (shared/lootRoll.ts shipFindSpot). */
export function shipLootSpot(rand: () => number): { x: number; z: number } {
  const [lx, lz] = LOOT_SPOTS[Math.floor(rand() * LOOT_SPOTS.length)];
  return shipToWorld(lx + (rand() - 0.5) * 2, lz + (rand() - 0.5) * 2);
}
