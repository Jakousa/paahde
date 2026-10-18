// Rock formations: sandstone mesas and buttes with cliffs, ledges and scree, and boulders, standing out
// of the dunes. Part of the base heightfield (baseHeight in shared/terrain.ts is max(dunes, rock)), so
// they collide, cast shade and render like the dunes; sim.ts makes their steep faces walls, dig.ts stops
// at rock, and the terrain renderer paints them as rock (rockCover).
//
// Same determinism rules as shared/dunes.ts: integer hashing and exact IEEE operations only (+ - * /,
// Math.sqrt, Math.floor, Math.abs, Math.min/max). No trig: a rock's long axis is a rejection-sampled
// unit vector.
//
// A low-frequency "rockiness" noise decides where the rocky country is. The world is cut into ROCK_CELL
// squares; each holds a few formations (more and bigger where it is rocky, a stray boulder now and then
// elsewhere). A formation is one rock — a domain-warped ellipse with a height profile: a flat-topped mesa
// with terraced cliffs and a scree apron, or a rounded boulder — plus a few boulders around the big ones.
// Rocks sit on the lowest sand under them, partly buried; overlapping rocks merge (max).
import { BASE } from './base.ts';
import { duneHeight, ss, vnoise, WORLD_SEED } from './dunes.ts';

/** Grid cell size (m). A rock's centre lies in its cell and it reaches less than a cell beyond. */
export const ROCK_CELL = 160;
/** Biggest rock radius (m) along its long axis: up to ~100 m across. */
const R_MIN = 1.2, R_MAX = 50;
/** Tallest rock above its foot (m). */
export const ROCK_H_MAX = 45;
/** Outline wobble: the ellipse distance is scaled by 1 ± WARP. */
const WARP = 0.22;
/** Normalised distance where the scree apron ends, and where the rock stops existing (falling away
 *  steeply in between so it meets the sand without a step). */
const APRON_END = 1.35, D_CUT = 1.5;
/** No rocks this close to the base (m). */
const BASE_CLEAR = 150;

type Rock = {
  x: number; z: number;
  /** Unit long axis. */
  ax: number; az: number;
  /** Long-axis radius, and 1 / short-axis radius. */
  R: number; invR: number; invRs: number;
  /** Height above its foot, and the foot's height (the lowest sand under it, minus how deep it sits). */
  H: number; y0: number;
  /** Mesa (flat top, cliffs, ledges, scree) or boulder (rounded). */
  mesa: boolean;
  /** Ledge spacing (m) for mesas. */
  band: number;
  /** Top tilt: height gained per unit of normalised distance along the long and short axes (fraction of H). */
  tu: number; tv: number;
  /** Noise offsets so each rock's outline and crags differ. */
  ox: number; oz: number; seed: number;
  /** Bounding half-size in xz (m). */
  bound: number;
};

/** Deterministic PRNG seeded from a cell (integer hashing only). */
function rng(ix: number, iz: number) {
  let h = Math.imul(ix | 0, 0x2c1b3c6d) ^ Math.imul(iz | 0, 0x297a2d39) ^ Math.imul(WORLD_SEED, 0x9e3779b1) ^ 0x70c4;
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 0 = sand sea, 1 = rocky country. Large blobs a few km across, with ragged edges. */
export function rockiness(x: number, z: number): number {
  const n = vnoise(x * (1 / 700) + 31.7, z * (1 / 700) - 12.3, WORLD_SEED + 21) * 0.65 +
    vnoise(x * (1 / 260), z * (1 / 260), WORLD_SEED + 22) * 0.35;
  return ss((n - 0.45) * (1 / 0.22));
}

function makeRock(x: number, z: number, R: number, mesa: boolean, r: () => number, tall = 1): Rock | null {
  const dx = x - BASE.x, dz = z - BASE.z;
  const bound = R * (D_CUT / (1 - WARP)) + 1;
  const clear = BASE_CLEAR + bound;
  if (dx * dx + dz * dz < clear * clear) return null;
  let ax = 1, az = 0;
  for (let i = 0; i < 16; i++) {
    const u = 2 * r() - 1, v = 2 * r() - 1, q = u * u + v * v;
    if (q > 0.01 && q <= 1) { const l = Math.sqrt(q); ax = u / l; az = v / l; break; }
  }
  const aspect = 1 + 0.8 * r();
  const t = r();
  const H = mesa ? Math.min(ROCK_H_MAX, R * (0.3 + 0.7 * t * t) * tall) : R * (0.55 + 0.5 * t);
  // Its foot: the lowest sand under its middle, so it never floats; then partly buried.
  const e = R * 0.6;
  const s = WORLD_SEED;
  let low = duneHeight(x, z, s);
  low = Math.min(low, duneHeight(x + ax * e, z + az * e, s), duneHeight(x - ax * e, z - az * e, s));
  low = Math.min(low, duneHeight(x + az * e / aspect, z - ax * e / aspect, s), duneHeight(x - az * e / aspect, z + ax * e / aspect, s));
  const bury = H * (mesa ? 0.04 + 0.12 * r() : 0.15 + 0.3 * r());
  return {
    x, z, ax, az, R, invR: 1 / R, invRs: aspect / R, H, y0: low - bury, mesa,
    band: 1.8 + 2.7 * r(), tu: (r() - 0.5) * 0.4, tv: (r() - 0.5) * 0.3, ox: r() * 1000, oz: r() * 1000, seed: Math.floor(r() * 1e6), bound,
  };
}

/** The rocks whose centres lie in cell (ix, iz). */
function cellRocks(ix: number, iz: number): Rock[] {
  const r = rng(ix, iz);
  const cx = (ix + 0.5) * ROCK_CELL, cz = (iz + 0.5) * ROCK_CELL;
  const k = rockiness(cx, cz);
  const n = Math.floor(0.12 + 6 * k * k + r());
  const out: Rock[] = [];
  for (let i = 0; i < n; i++) {
    const x = (ix + r()) * ROCK_CELL, z = (iz + r()) * ROCK_CELL;
    // Mostly small; rocky country grows the big ones.
    const u = r();
    let p = u * u * u;
    if (k < 0.99) p *= u * (1 - k) + k; // u⁴ out in the sand sea, u³ in the rocks
    const R = R_MIN + (R_MAX - R_MIN) * p;
    const mesa = R > 9 || (R > 4 && r() < 0.3);
    const rock = makeRock(x, z, R, mesa, r);
    if (!rock) continue;
    out.push(rock);
    // Big mesas grow towers: smaller, taller blocks on top, so the formation steps up as buttes.
    if (mesa && R > 12) {
      const m = Math.floor(r() * 3.2);
      for (let j = 0; j < m; j++) {
        const d = R * 0.5 * r();
        let u2 = 2 * r() - 1, v2 = 2 * r() - 1;
        const q = Math.sqrt(u2 * u2 + v2 * v2) || 1;
        const t = makeRock(x + (u2 / q) * d, z + (v2 / q) * d, R * (0.25 + 0.35 * r()), true, r, 2.2 + 1.5 * r());
        if (t) out.push(t);
      }
    }
    // Boulders fallen off the big ones.
    if (R > 6) {
      const m = Math.floor(r() * (2 + R / 8));
      for (let j = 0; j < m; j++) {
        let u2 = 2 * r() - 1, v2 = 2 * r() - 1;
        const q = Math.sqrt(u2 * u2 + v2 * v2) || 1;
        u2 /= q;
        v2 /= q;
        const d = R * (0.95 + 0.5 * r());
        const b = makeRock(x + u2 * d, z + v2 * d, Math.max(R_MIN, R * (0.05 + 0.13 * r())), false, r);
        if (b) out.push(b);
      }
    }
  }
  return out;
}

const own = new Map<number, Rock[]>();
const near = new Map<number, Rock[]>();
const cellKey = (ix: number, iz: number) => (ix + 2 ** 25) * 2 ** 26 + (iz + 2 ** 25);

function ownRocks(ix: number, iz: number): Rock[] {
  const k = cellKey(ix, iz);
  let l = own.get(k);
  if (!l) own.set(k, (l = cellRocks(ix, iz)));
  return l;
}

/** Every rock that reaches into cell (ix, iz) (theirs and their neighbours'). */
function rocksIn(ix: number, iz: number): Rock[] {
  const k = cellKey(ix, iz);
  let l = near.get(k);
  if (l) return l;
  l = [];
  const x0 = ix * ROCK_CELL, z0 = iz * ROCK_CELL, x1 = x0 + ROCK_CELL, z1 = z0 + ROCK_CELL;
  for (let j = iz - 1; j <= iz + 1; j++) {
    for (let i = ix - 1; i <= ix + 1; i++) {
      for (const rk of ownRocks(i, j)) {
        if (rk.x + rk.bound > x0 && rk.x - rk.bound < x1 && rk.z + rk.bound > z0 && rk.z - rk.bound < z1) l.push(rk);
      }
    }
  }
  // Long-lived processes (the server) walk the whole world: keep the caches bounded.
  if (near.size > 4096) { near.clear(); own.clear(); }
  near.set(k, l);
  return l;
}

/** Height of one rock's surface at (x, z), or -Infinity outside it. */
function rockSurface(rk: Rock, x: number, z: number): number {
  const dx = x - rk.x, dz = z - rk.z;
  if (Math.abs(dx) > rk.bound || Math.abs(dz) > rk.bound) return -Infinity;
  const u = (dx * rk.ax + dz * rk.az) * rk.invR;
  const v = (dz * rk.ax - dx * rk.az) * rk.invRs;
  const d0 = Math.sqrt(u * u + v * v);
  if (d0 * (1 - WARP) >= D_CUT) return -Infinity;
  // Wobbly outline: warp the distance with noise at the rock's own scale.
  const f = 1 / (rk.R * 0.4 + 0.8);
  const px = x + rk.ox, pz = z + rk.oz;
  const w = vnoise(px * f, pz * f, rk.seed) * 0.57 + vnoise(px * f * 2.3, pz * f * 2.3, rk.seed + 1) * 0.28 +
    vnoise(px * f * 6.1, pz * f * 6.1, rk.seed + 4) * 0.15;
  const d = d0 * (1 + WARP * (2 * w - 1));
  if (d >= D_CUT) return -Infinity;
  let g: number;
  if (rk.mesa) {
    // Flat, slightly domed top; cliff around the rim; scree apron at its foot.
    const cliff = ss((1 - d) * (1 / 0.16)) * (1 - 0.1 * d * d + rk.tu * u + rk.tv * v);
    const apron = 0.26 * ss((APRON_END - d) * (1 / 0.5));
    g = Math.max(cliff, apron);
  } else {
    g = Math.sqrt(Math.max(0, 1 - d * d));
    g = Math.max(g, 0.12 * ss((APRON_END - 0.1 - d) * (1 / 0.35)));
  }
  let h = rk.H * g;
  if (rk.mesa) {
    // Sandstone beds: soft steps (ledges and risers) in the cliffs and scree.
    const q = h / rk.band, fl = Math.floor(q);
    h = h * 0.45 + rk.band * (fl + ss((q - fl - 0.5) * (1 / 0.5))) * 0.55;
  }
  // Crags: weathered lumps, none right at the foot so it meets the sand cleanly.
  // Gentle enough (slope ≲ 1) that weathered tops stay walkable.
  const amp = Math.min(0.9, rk.H * (rk.mesa ? 0.04 : 0.08)) * ss(g * 5);
  if (amp > 0) {
    const c = vnoise(px * 0.18, pz * 0.18, rk.seed + 2) + 0.5 * vnoise(px * 0.47, pz * 0.47, rk.seed + 3);
    h += amp * (c * (2 / 1.5) - 1);
  }
  // Past the apron it dives under the sand.
  if (d > APRON_END - 0.05) h -= rk.R * 2 * (d - (APRON_END - 0.05));
  return rk.y0 + h;
}

/** Height of the rock at world (x, z), or -Infinity where there is none. Pure function. */
export function rockHeight(x: number, z: number): number {
  const l = rocksIn(Math.floor(x / ROCK_CELL), Math.floor(z / ROCK_CELL));
  let top = -Infinity;
  for (let i = 0; i < l.length; i++) {
    const h = rockSurface(l[i], x, z);
    if (h > top) top = h;
  }
  return top;
}

/** True if a rock (with its scree) reaches within `r` of (x, z). For keeping wrecks and scrap off rocks. */
export function rocksNear(x: number, z: number, r: number): boolean {
  const ix = Math.floor(x / ROCK_CELL), iz = Math.floor(z / ROCK_CELL);
  for (const rk of rocksIn(ix, iz)) {
    const dx = x - rk.x, dz = z - rk.z, reach = rk.R * APRON_END * (1 + WARP) + r;
    if (dx * dx + dz * dz < reach * reach) return true;
  }
  // r may reach into the next cell.
  if (r > 0) {
    for (let j = Math.floor((z - r) / ROCK_CELL); j <= Math.floor((z + r) / ROCK_CELL); j++) {
      for (let i = Math.floor((x - r) / ROCK_CELL); i <= Math.floor((x + r) / ROCK_CELL); i++) {
        if (i === ix && j === iz) continue;
        for (const rk of rocksIn(i, j)) {
          const dx = x - rk.x, dz = z - rk.z, reach = rk.R * APRON_END * (1 + WARP) + r;
          if (dx * dx + dz * dz < reach * reach) return true;
        }
      }
    }
  }
  return false;
}

