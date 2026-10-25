// Rock formations standing out of the dunes: sandstone mesas and buttes with cliffs, ledges and scree, fields
// of pillars, broad hills carved by gullies, jagged peaks, and boulders. Part of the bare heightfield
// (baseHeight in shared/terrain.ts is max(dunes, rock)), so they collide, cast shade and render like the dunes;
// sim.ts makes their steep faces walls, dig.ts stops at rock, and the terrain renderer paints them as rock
// (rockCover).
//
// Same determinism rules as shared/dunes.ts: integer hashing and exact IEEE operations only (+ - * /,
// Math.sqrt, Math.floor, Math.abs, Math.min/max). No trig: a rock's long axis is a rejection-sampled
// unit vector, and "angle around a rock" is the unit vector from its centre.
//
// A low-frequency "rockiness" noise decides where the rocky country is, and a "style" noise what kind of rocky
// country it is (mesas, pillars, hills or peaks, blending into each other). The world is cut into ROCK_CELL
// squares; each holds a few formations (more and bigger where it is rocky, a stray boulder now and then
// elsewhere), up to a footprint budget so the dunes keep their room. A formation is one or more rocks, each a
// domain-warped ellipse with a height profile by kind, plus boulders fallen around the big ones; now and then
// one is a giant. Rocks sit on the lowest sand under them, partly buried; overlapping rocks merge (max).
import { ORIGIN } from './origin.ts';
import { biome, blend } from './biomes.ts';
import { canyonAt, canyonOut } from './canyons.ts';
import { cellCache } from './cellCache.ts';
import { duneHeight, ss, vnoise, WORLD_SEED } from './dunes.ts';
import { mulberry32, ridged } from './noise.ts';
import { LAB } from './world.ts';

/** Grid cell size (m). A cell owns the formations whose centres lie in it. */
export const ROCK_CELL = 160;
/** Rocks owned by a cell reach at most this many cells beyond it (giants are ~300 m across). */
const SEARCH = 2;
/** Tallest rock above its foot (m), crags and tilted tops included. */
export const ROCK_H_MAX = 130;
/** Smallest rock radius (m). */
const R_MIN = 1.2;
/** Outline wobble: the ellipse distance is scaled by 1 ± WARP. */
const WARP = 0.22;
/** Normalised distance where a mesa's or pillar's scree apron ends (falling away steeply past it so it meets
 *  the sand without a step). */
const APRON_END = 1.35;
/** No rocks this close to the origin (m). */
const ORIGIN_CLEAR = 150;

/** Kinds. Boulder: rounded. Mesa: flat top, terraced cliffs, scree. Pillar: sheer-sided spire or hoodoo with a
 *  cap and a rubble skirt. Hill: broad dome, gentle enough to climb, cut by gullies running down it. Peak:
 *  steep concave cone with ridges (arêtes) running down from a sharp summit, jagged all over. */
const BOULDER = 0, MESA = 1, PILLAR = 2, HILL = 3, PEAK = 4;
/** Per kind: normalised distance where the rock stops existing. */
const CUT = [1.5, 1.5, 1.5, 1.12, 1.2];

type Rock = {
  x: number; z: number;
  kind: number;
  /** Unit long axis. */
  ax: number; az: number;
  /** Long-axis radius, and 1 / short-axis radius. */
  R: number; invR: number; invRs: number;
  /** Height above its foot, and the foot's height (the lowest sand under it, minus how deep it sits). */
  H: number; y0: number;
  /** Ledge spacing (m). */
  band: number;
  /** Top tilt: height gained per unit of normalised distance along the long and short axes (fraction of H). */
  tu: number; tv: number;
  /** Noise offsets so each rock's outline and crags differ. */
  ox: number; oz: number; seed: number;
  /** Bounding half-size in xz (m), and how far (m) it shows above the sand, for rocksNear. */
  bound: number; reach: number;
};

/** Deterministic PRNG seeded from a cell (integer hashing only). */
function rng(ix: number, iz: number) {
  return mulberry32(Math.imul(ix | 0, 0x2c1b3c6d) ^ Math.imul(iz | 0, 0x297a2d39) ^ Math.imul(WORLD_SEED, 0x9e3779b1) ^ 0x70c4);
}

/** 0 = sand sea, 1 = rocky country. Large blobs a few km across, with ragged edges. */
export function rockiness(x: number, z: number): number {
  // Mud flats (shared/biomes.ts) keep only the stray boulder of the sand sea.
  const flat = 1 - biome('mudflat', x, z);
  if (flat <= 0) return 0;
  const n = vnoise(x * (1 / 700) + 31.7, z * (1 / 700) - 12.3, WORLD_SEED + 21) * 0.65 +
    vnoise(x * (1 / 260), z * (1 / 260), WORLD_SEED + 22) * 0.35;
  return ss((n - 0.45) * (1 / 0.22)) * flat;
}

/** How likely each kind of formation is at (x, z) in full rocky country: two slow noises pick a point in a
 *  square whose corners are mesa, pillar, hill and peak country; every kind keeps a little weight everywhere. */
function styleWeights(x: number, z: number): [number, number, number, number] {
  const a = ss((vnoise(x * (1 / 1300) - 7.1, z * (1 / 1300) + 3.9, WORLD_SEED + 23) - 0.25) * 2);
  const b = ss((vnoise(x * (1 / 1100) + 5.3, z * (1 / 1100) - 9.7, WORLD_SEED + 24) - 0.25) * 2);
  return [0.3 + 2 * (1 - a) * (1 - b), 0.15 + 2 * a * (1 - b), 0.15 + 2 * (1 - a) * b, 0.1 + 1.5 * a * b];
}

/** A rock of `kind`, radius R and height H at (x, z), or null too near the origin. `foot`: something under it
 *  other than the sand (a rock it stands on). */
function makeRock(x: number, z: number, R: number, H: number, kind: number, r: () => number, aspect = 1 + 0.8 * r(),
  foot = -Infinity): Rock | null {
  const dx = x - ORIGIN.x, dz = z - ORIGIN.z;
  const cut = CUT[kind];
  const bound = R * (cut / (1 - WARP)) + 1;
  const clear = ORIGIN_CLEAR + bound;
  if (dx * dx + dz * dz < clear * clear) return null;
  let ax = 1, az = 0;
  for (let i = 0; i < 16; i++) {
    const u = 2 * r() - 1, v = 2 * r() - 1, q = u * u + v * v;
    if (q > 0.01 && q <= 1) { const l = Math.sqrt(q); ax = u / l; az = v / l; break; }
  }
  // Its foot: the lowest sand under its middle, so it never floats; then partly buried.
  const e = R * 0.6;
  const s = WORLD_SEED;
  let low = duneHeight(x, z, s);
  low = Math.min(low, duneHeight(x + ax * e, z + az * e, s), duneHeight(x - ax * e, z - az * e, s));
  low = Math.min(low, duneHeight(x + az * e / aspect, z - ax * e / aspect, s), duneHeight(x - az * e / aspect, z + ax * e / aspect, s));
  low = Math.max(low, foot);
  if (standOn !== null) low = standOn; // (on a canyon's floor: canyonCellRocks)
  const b = r();
  const bury = H * (kind === BOULDER ? 0.15 + 0.3 * b : kind === PILLAR ? 0.02 + 0.06 * b : 0.04 + 0.12 * b);
  const tilt = kind === PILLAR ? 0.25 : 0.4;
  return {
    x, z, kind, ax, az, R, invR: 1 / R, invRs: aspect / R, H, y0: low - bury,
    band: 1.8 + 2.7 * r(), tu: (r() - 0.5) * tilt, tv: (r() - 0.5) * tilt * 0.75, ox: r() * 1000, oz: r() * 1000,
    seed: Math.floor(r() * 1e6), bound, reach: R * Math.min(cut, APRON_END) * (1 + WARP),
  };
}

/** A unit vector in a random direction, written to dir. */
const dir = { x: 1, z: 0 };
function randomDir(r: () => number) {
  for (let i = 0; i < 16; i++) {
    const u = 2 * r() - 1, v = 2 * r() - 1, q = u * u + v * v;
    if (q > 0.01 && q <= 1) { const l = Math.sqrt(q); dir.x = u / l; dir.z = v / l; return; }
  }
  dir.x = 1; dir.z = 0;
}

/** Boulders fallen around a big rock, `m` of them, `spread` × R out. */
function boulders(out: Rock[], rk: Rock, m: number, spread: number, r: () => number) {
  for (let j = 0; j < m; j++) {
    randomDir(r);
    const d = rk.R * (spread + 0.5 * r());
    const R = Math.max(R_MIN, rk.R * (0.05 + 0.13 * r()));
    const b = makeRock(rk.x + dir.x * d, rk.z + dir.z * d, Math.min(R, 9), Math.min(R, 9) * (0.55 + 0.5 * r()), BOULDER, r);
    if (b) out.push(b);
  }
}

/** One formation of `kind` at (x, z); p in [0, 1) picks its size (mostly small). Returns the footprint (m²)
 *  it spends of its cell's budget. */
function formation(out: Rock[], x: number, z: number, kind: number, p: number, giant: number, r: () => number): number {
  if (kind === BOULDER || kind === MESA) {
    const R = ((kind === MESA ? 4 : R_MIN) + 46 * p) * giant;
    const mesa = kind === MESA || R > 9 || (R > 4 && r() < 0.3);
    let t = r();
    if (giant > 1) t = 1 - (1 - t) * (1 - t); // giants are mostly tall: the big cliffs
    // Some mesas are long escarpments.
    const aspect = mesa && r() < 0.25 ? 2 + 2 * r() : 1 + 0.8 * r();
    const H = mesa ? Math.min(90, R * (0.3 + 0.7 * t * t)) : R * (0.55 + 0.5 * t);
    const rock = makeRock(x, z, R, H, mesa ? MESA : BOULDER, r, aspect);
    if (!rock) return 0;
    out.push(rock);
    // Big mesas grow towers: smaller, taller blocks on top, so the formation steps up as buttes.
    if (mesa && R > 12) {
      const m = Math.floor(r() * 3.2);
      for (let j = 0; j < m; j++) {
        randomDir(r);
        const d = R * 0.5 * r() / aspect;
        const Rt = R * (0.25 + 0.35 * r()) / Math.sqrt(aspect);
        const tt = r();
        const tw = makeRock(x + dir.x * d, z + dir.z * d, Rt, Math.min(90, Rt * (0.3 + 0.7 * tt * tt) * (2.2 + 1.5 * r())), MESA, r);
        if (tw) out.push(tw);
      }
    }
    if (R > 6) boulders(out, rock, Math.floor(r() * (2 + R / 8)), 0.95, r);
    return R * R / aspect;
  }
  if (kind === PILLAR) {
    // A field of spires, what is left of a plateau: their tops near its old level, lower towards the edge; a
    // lone tall one now and then.
    const Rc = (6 + 44 * p) * giant;
    const top = Math.min(55, 12 + 30 * r() + Rc * 0.25);
    const m = Rc < 10 ? 1 : 2 + Math.floor(r() * (2 + Rc / 6));
    for (let j = 0; j < m; j++) {
      randomDir(r);
      const f = j === 0 ? 0 : Math.sqrt(r());
      const H = top * (0.55 + 0.45 * r()) * (1 - 0.45 * f * f);
      // Slender ones and stout ones (a butte or two among the spires).
      const s = r();
      const R = Math.max(1.5, H * (0.08 + 0.2 * s * s * s));
      const px = x + dir.x * f * Rc, pz = z + dir.z * f * Rc;
      const pl = makeRock(px, pz, R, H, PILLAR, r, 1 + 0.5 * r());
      if (!pl) continue;
      out.push(pl);
      if (r() < 0.5) boulders(out, pl, 1 + Math.floor(r() * 3), 1.2, r);
    }
    return Rc * Rc * 0.7 + 200;
  }
  if (kind === HILL) {
    const R = Math.min(140, (28 + 62 * p) * giant);
    const H = Math.min(65, R * (0.18 + 0.22 * r()));
    const hill = makeRock(x, z, R, H, HILL, r, 1 + 1.1 * r());
    if (!hill) return 0;
    out.push(hill);
    // Tors: blocks of harder rock left standing on its back.
    const m = Math.floor(r() * 4);
    for (let j = 0; j < m; j++) {
      randomDir(r);
      const d = R * 0.55 * r();
      const tx = x + dir.x * d, tz = z + dir.z * d;
      const Rt = 2.5 + 6 * r();
      const t = makeRock(tx, tz, Rt, Rt * (0.6 + 0.8 * r()), r() < 0.5 ? MESA : BOULDER, r, 1 + 0.8 * r(),
        rockSurface(hill, tx, tz) - 1);
      if (t) out.push(t);
    }
    return R * R * 0.35;
  }
  // PEAK: a main summit and a few lower ones on its shoulders, as a little range.
  const R = Math.min(85, (14 + 46 * p) * giant);
  const H = Math.min(105, R * (0.5 + 0.6 * r()));
  const aspect = 1 + 1.2 * r();
  const pk = makeRock(x, z, R, H, PEAK, r, aspect);
  if (!pk) return 0;
  out.push(pk);
  const m = Math.floor(r() * 3.5);
  for (let j = 0; j < m; j++) {
    // Mostly along its long axis, so they line up into a ridge.
    const side = r() < 0.5 ? -1 : 1, off = (r() - 0.5) * 0.6;
    const d = R * (0.45 + 0.45 * r());
    const sx = x + (pk.ax * side - pk.az * off) * d, sz = z + (pk.az * side + pk.ax * off) * d;
    const Rs = R * (0.35 + 0.3 * r());
    const s = makeRock(sx, sz, Rs, Math.min(105, H * (0.45 + 0.4 * r())), PEAK, r, 1 + 0.8 * r());
    if (s) out.push(s);
  }
  boulders(out, pk, Math.floor(r() * (2 + R / 10)), 0.9, r);
  return R * R * 0.6 / aspect;
}

/** The rocks of the formations whose centres lie in cell (ix, iz). */
function cellRocks(ix: number, iz: number): Rock[] {
  const r = rng(ix, iz);
  const cx = (ix + 0.5) * ROCK_CELL, cz = (iz + 0.5) * ROCK_CELL;
  const k = rockiness(cx, cz);
  const w = styleWeights(cx, cz);
  // Out in the sand sea: a stray boulder or small rock. In the rocks: kinds by the local style.
  const wB = 1.5 * (1 - k) + 0.25, wM = k * w[0], wP = k * w[1], wH = k * w[2] * k, wK = k * w[3];
  const wSum = wB + wM + wP + wH + wK;
  const n = Math.floor(0.12 + 6 * k * k + r());
  // Footprint (m²) the formations may cover, so even rocky country keeps sand between them.
  let budget = (0.02 + 0.3 * k * k) * ROCK_CELL * ROCK_CELL;
  const out: Rock[] = [];
  for (let i = 0; i < n; i++) {
    const x = (ix + r()) * ROCK_CELL, z = (iz + r()) * ROCK_CELL;
    // Mostly small; rocky country grows the big ones.
    const u = r();
    let p = u * u * u;
    if (k < 0.99) p *= u * (1 - k) + k; // u⁴ out in the sand sea, u³ in the rocks
    let c = r() * wSum;
    const kind = (c -= wB) < 0 ? BOULDER : (c -= wM) < 0 ? MESA : (c -= wP) < 0 ? PILLAR : (c -= wH) < 0 ? HILL : PEAK;
    // Now and then a giant: the cliffs and summits you see from kilometres away.
    const giant = kind !== BOULDER && r() < 0.06 * k ? 1.6 + 0.7 * r() : 1;
    if (budget <= 0) break;
    budget -= formation(out, x, z, kind, p, giant, r);
  }
  return withinSearch(out, ix, iz);
}

/** The rocks of cell (ix, iz) that stay within its SEARCH neighbourhood (rocksIn looks no further). */
function withinSearch(out: Rock[], ix: number, iz: number): Rock[] {
  const x0 = (ix - SEARCH) * ROCK_CELL, z0 = (iz - SEARCH) * ROCK_CELL, x1 = (ix + 1 + SEARCH) * ROCK_CELL, z1 = (iz + 1 + SEARCH) * ROCK_CELL;
  return out.filter((rk) => rk.x - rk.bound >= x0 && rk.x + rk.bound <= x1 && rk.z - rk.bound >= z0 && rk.z + rk.bound <= z1);
}

/** Every rock of `own`'s cells (cell (ix, iz)'s and its neighbours') that reaches into cell (ix, iz). */
function reaching(own: (ix: number, iz: number) => Rock[], ix: number, iz: number): Rock[] {
  const l: Rock[] = [];
  const x0 = ix * ROCK_CELL, z0 = iz * ROCK_CELL, x1 = x0 + ROCK_CELL, z1 = z0 + ROCK_CELL;
  for (let j = iz - SEARCH; j <= iz + SEARCH; j++) {
    for (let i = ix - SEARCH; i <= ix + SEARCH; i++) {
      for (const rk of own(i, j)) {
        if (rk.x + rk.bound > x0 && rk.x - rk.bound < x1 && rk.z + rk.bound > z0 && rk.z - rk.bound < z1) l.push(rk);
      }
    }
  }
  return l;
}

/** The highest of rocks `l`'s surfaces at (x, z), or -Infinity. */
function topOf(l: Rock[], x: number, z: number): number {
  let top = -Infinity;
  for (let i = 0; i < l.length; i++) {
    const h = rockSurface(l[i], x, z);
    if (h > top) top = h;
  }
  return top;
}

const ownRocks = cellCache(8192, cellRocks);
const nearRocks = cellCache(4096, (ix, iz) => reaching(ownRocks, ix, iz));
const NO_ROCKS: Rock[] = [];

/** Every rock that reaches into cell (ix, iz) (theirs and their neighbours'). */
function rocksIn(ix: number, iz: number): Rock[] {
  if (LAB) return NO_ROCKS; // the dev test lab (shared/lab.ts) is flat
  return nearRocks(ix, iz);
}

/** Height of one rock's surface at (x, z), or -Infinity outside it. */
function rockSurface(rk: Rock, x: number, z: number): number {
  const dx = x - rk.x, dz = z - rk.z;
  if (Math.abs(dx) > rk.bound || Math.abs(dz) > rk.bound) return -Infinity;
  const cut = CUT[rk.kind];
  const u = (dx * rk.ax + dz * rk.az) * rk.invR;
  const v = (dz * rk.ax - dx * rk.az) * rk.invRs;
  const d0 = Math.sqrt(u * u + v * v);
  if (d0 * (1 - WARP) >= cut) return -Infinity;
  // Wobbly outline: warp the distance with noise at the rock's own scale.
  const f = 1 / (rk.R * 0.4 + 0.8);
  const px = x + rk.ox, pz = z + rk.oz;
  const w = vnoise(px * f, pz * f, rk.seed) * 0.57 + vnoise(px * f * 2.3, pz * f * 2.3, rk.seed + 1) * 0.28 +
    vnoise(px * f * 6.1, pz * f * 6.1, rk.seed + 4) * 0.15;
  const d = d0 * (1 + WARP * (2 * w - 1));
  if (d >= cut) return -Infinity;
  // Which way round the rock (x, z) is: the unit vector out from its centre, for noise that runs downhill.
  const id = 1 / Math.max(d0, 0.05), cu = u * id, cv = v * id;
  let h: number;
  let crag: number; // weathered-lump amplitude (m)
  let dive = APRON_END - 0.05; // past this it dives under the sand
  let beds = 0; // how strongly the sandstone beds show as ledges
  switch (rk.kind) {
    case MESA: {
      // Flat, slightly domed top; cliff around the rim; scree apron at its foot.
      const cliff = ss((1 - d) * (1 / 0.16)) * (1 - 0.1 * d * d + rk.tu * u + rk.tv * v);
      const apron = 0.26 * ss((APRON_END - d) * (1 / 0.5));
      h = rk.H * Math.max(cliff, apron);
      crag = Math.min(0.9, rk.H * 0.04) * ss(h / rk.H * 5);
      beds = 0.55;
      break;
    }
    case PILLAR: {
      // Sheer sides, a domed or tipped cap, a skirt of rubble a few metres high.
      const side = ss((1 - d) * (1 / 0.07)) * (1 - 0.12 * d * d + rk.tu * u + rk.tv * v);
      const skirt = Math.min(0.3, rk.R * 0.8 / rk.H) * ss((APRON_END - d) * (1 / 0.45));
      h = rk.H * Math.max(side, skirt);
      crag = Math.min(0.5, rk.R * 0.12) * ss(h / rk.H * 5);
      beds = 0.7;
      break;
    }
    case HILL: {
      // A broad dome, its flanks cut by gullies running down it (ridged noise round the hill, meandering).
      const g = 1 - ss(d);
      const a = 1.3, mw = (w - 0.5) * 1.1 + d * 0.7;
      const gully = 1 - ridged(cu * a + mw, cv * a - mw, rk.seed + 5);
      const rill = 1 - ridged(cu * a * 2.6 - mw, cv * a * 2.6 + mw * 1.5, rk.seed + 6);
      const flank = ss(d * (1 / 0.3)) * ss((1.02 - d) * (1 / 0.35));
      h = rk.H * (g - flank * (0.36 * gully * gully * gully + 0.06 * rill * rill * rill));
      crag = Math.min(2.2, rk.H * 0.05) * ss(g * 3);
      beds = 0.3;
      dive = 0.97;
      break;
    }
    case PEAK: {
      // Concave cone: steep near the summit, flaring at the foot; arêtes run down from the top with couloirs
      // between them, and the whole face is jagged.
      const g = d < 1 ? (1 - d) * (1 - 0.3 * d) : 0;
      const fw = 1 / (rk.R * 0.5 + 4);
      const big = vnoise(px * fw, pz * fw, rk.seed + 8);
      const ar = ridged(cu * 0.7 + (w - 0.5) * 1.6 + big, cv * 0.7 + d * 0.9 - big, rk.seed + 5);
      const ridges = 0.6 + 0.4 * (1 - ss(d * (1 / 0.25)) * (1 - ar * ar)) - 0.4 * (big - 0.5) * d;
      h = rk.H * Math.max(g * ridges, 0.06 * ss((1.1 - d) * (1 / 0.3)));
      const j = ridged(px * 0.09, pz * 0.09, rk.seed + 6) * 0.65 + ridged(px * 0.23, pz * 0.23, rk.seed + 7) * 0.35;
      h += Math.min(5, rk.H * 0.07) * (2 * j - 1) * ss(g * 3 - 0.3);
      crag = Math.min(0.6, rk.H * 0.02) * ss(g * 5);
      dive = 1.1;
      break;
    }
    default: {
      const g = Math.sqrt(Math.max(0, 1 - d * d));
      h = rk.H * Math.max(g, 0.12 * ss((APRON_END - 0.1 - d) * (1 / 0.35)));
      crag = Math.min(0.9, rk.H * 0.08) * ss(g * 5);
    }
  }
  if (beds > 0 && h > 0) {
    // Sandstone beds: soft steps (ledges and risers) in the cliffs and scree.
    const q = h / rk.band, fl = Math.floor(q);
    h = h * (1 - beds) + rk.band * (fl + ss((q - fl - 0.5) * (1 / 0.5))) * beds;
  }
  // Crags: weathered lumps, none right at the foot so it meets the sand cleanly.
  // Gentle enough (slope ≲ 1) that weathered tops stay walkable.
  if (crag > 0) {
    const c = vnoise(px * 0.18, pz * 0.18, rk.seed + 2) + 0.5 * vnoise(px * 0.47, pz * 0.47, rk.seed + 3);
    h += crag * (c * (2 / 1.5) - 1);
  }
  if (d > dive) h -= rk.R * 2 * (d - dive);
  return rk.y0 + h;
}

/** While set, the rocks being made stand on this height (a canyon's floor) instead of the sand under them. */
let standOn: number | null = null;

/** Rock formations standing on the canyons' floors (shared/canyons.ts): small buttes, boulders and a lone pillar now
 *  and then, made like the desert's, a few per cell out on the floor, their foot on it. Kept apart from the desert's
 *  rocks, which a canyon cuts away: shared/terrain.ts adds these after the cut (canyonRockHeight). */
function canyonCellRocks(ix: number, iz: number): Rock[] {
  const r = rng(ix + 7919, iz - 104729);
  const out: Rock[] = [];
  // (Many spots tried: the floors are a small share of a cell.)
  for (let i = 0; i < 10; i++) {
    const x = (ix + r()) * ROCK_CELL, z = (iz + r()) * ROCK_CELL;
    const u = r(), k = r(), p = r();
    // Out on the floor (its wash), away from the walls' foot, and not every spot.
    if (u > 0.5 || !canyonAt(x, z) || canyonOut.wash === Infinity || canyonOut.foot > 0.6) continue;
    standOn = canyonOut.wash - 1.5;
    // Mostly small buttes and boulders; now and then a pillar, alone (small: no field of spires).
    formation(out, x, z, k < 0.2 ? PILLAR : k < 0.65 ? MESA : BOULDER, k < 0.2 ? p * p * 0.08 : p * p * 0.5, 1, r);
    standOn = null;
  }
  return withinSearch(out, ix, iz);
}

const canyonOwn = cellCache(8192, canyonCellRocks);
const canyonNear = cellCache(4096, (ix, iz) => reaching(canyonOwn, ix, iz));

/** Height of the canyon-floor rock at (x, z), or -Infinity where there is none. Pure function. */
export function canyonRockHeight(x: number, z: number): number {
  return LAB ? -Infinity : topOf(canyonNear(Math.floor(x / ROCK_CELL), Math.floor(z / ROCK_CELL)), x, z);
}

/** Height of the rock at world (x, z), or -Infinity where there is none. Pure function. */
export function rockHeight(x: number, z: number): number {
  return topOf(rocksIn(Math.floor(x / ROCK_CELL), Math.floor(z / ROCK_CELL)), x, z);
}

/** True if a rock (with its scree) reaches within `r` of (x, z), or (x, z) is in a biome where nothing is placed
 *  (`empty`, shared/biomes.ts: the canyons). For keeping wrecks, scrap, crash sites, shelters and finds off rocks. */
export function rocksNear(x: number, z: number, r: number): boolean {
  if (blend(x, z, (b) => (b.empty ? 1 : 0), 0) > 0) return true;
  for (let j = Math.floor((z - r) / ROCK_CELL); j <= Math.floor((z + r) / ROCK_CELL); j++) {
    for (let i = Math.floor((x - r) / ROCK_CELL); i <= Math.floor((x + r) / ROCK_CELL); i++) {
      for (const rk of rocksIn(i, j)) {
        const dx = x - rk.x, dz = z - rk.z, reach = rk.reach + r;
        if (dx * dx + dz * dz < reach * reach) return true;
      }
    }
  }
  return false;
}
