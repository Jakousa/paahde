// Canyons: long, deep gorges cut through a sandstone tableland, on the scale of the Grand Canyon (if not quite its
// size). Each is a meandering centreline 8–14 km long with a few side canyons; along it a raised plateau of rock (its
// rim) stands out of the dunes with cliffs round its edge, and the gorge is cut down through it to a sandy wash
// 220–400 m under the dune floor. It changes along its length between reaches: wide ones, where the walls step down
// in terraces (cliffs and ledges) over up to 1.7 × their height, with big spurs between amphitheatres and buttes
// ("temples") standing in them, about 1.5 km rim to rim; and narrow ones, steeper, their floor pinching to 15 m. At
// both ends (and at the far end of each side canyon) the floor climbs to the desert over a kilometre or more and the
// plateau sinks into the sand: the ways in. Patches of dried mud lie down the floor, rocks stand on it (pillars, small
// buttes, boulders: canyonRockHeight in shared/rocks.ts), and the wind keeps the tableland's edges bare. The canyons
// are a biome (CANYON in shared/biomes.ts): canyonCover is its weight, ahead of the mud flats, which so keep out of it.
//
// Part of the base heightfield (shared/terrain.ts `ground`): the plateau is rock added to the rocks, the gorge a
// cut that lowers everything above it to bare rock (its walls), with the wash's sand on its floor. Same
// determinism rules as shared/dunes.ts: integer hashing and exact IEEE operations only, no trig (a direction is
// turned by adding a bit of its perpendicular and normalising).
import { dryFloor } from './dunes.ts';
import { hash2, ss, vnoise } from './noise.ts';
import { wallY } from './strata.ts';
import { LAB, WORLD_SEED } from './world.ts';

/** Grid cell (m) that owns at most one canyon system, starting in it. */
export const CANYON_CELL = 6000;
/** Share of cells that have one. */
const ODDS = 0.8;
/** Canyons owned by a cell reach at most this many cells beyond it. */
const SEARCH = 3;
/** No part of a canyon's zone this close to the origin (m): the base is within 600 m of it (shared/base.ts
 *  findBase), and its spot is picked from the dunes, which read the canyons, so they can't measure from the base. */
const BASE_CLEAR = 1000;
/** Lookup grid (m): each cell lists the canyon segments whose zone reaches into it. */
const FINE = 128;
/** Raw centreline step (m), before smoothing. */
const STEP = 400;
/** How far the walls of the widest reaches lean back, × their height: a canyon 400 m deep is ~1.5 km rim to rim. */
const RUN_MAX = 1.7;

type Canyon = {
  /** Smoothed centreline points, and the arc length at each. */
  xs: number[]; zs: number[]; s: number[];
  /** Per point: the gorge's floor (bedrock under the wash) and the plateau's top, absolute heights (m). */
  floor: number[]; rim: number[];
  /** Per point: the dune floor (m), what the plateau rises from. */
  gnd: number[];
  /** How far (m) from the centreline anything of it reaches: walls, plateau, wobble. */
  reach: number;
  /** Plateau width (m) beyond the wall top. */
  shelf: number;
  seed: number;
};

/** Deterministic PRNG seeded from a cell (integer hashing only), as in shared/rocks.ts. */
function rng(ix: number, iz: number) {
  let h = Math.imul(ix | 0, 0x1b873593) ^ Math.imul(iz | 0, 0x3c6ef372) ^ Math.imul(WORLD_SEED, 0x9e3779b1) ^ 0x5ca1;
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ridged(x: number, z: number, seed: number): number {
  return 1 - Math.abs(2 * vnoise(x, z, seed) - 1);
}

/** A meandering raw path of `n` steps from (x, z) heading (dx, dz), smoothed (Chaikin, twice). */
function walk(x: number, z: number, dx: number, dz: number, n: number, r: () => number): [number[], number[]] {
  const px = [x], pz = [z];
  let bend = 0;
  for (let i = 0; i < n; i++) {
    // Curvature drifts, so it swings in long bends rather than zigzags.
    bend = bend * 0.6 + (r() - 0.5) * 0.4;
    const nx = dx - dz * bend, nz = dz + dx * bend, l = Math.sqrt(nx * nx + nz * nz);
    dx = nx / l; dz = nz / l;
    x += dx * STEP; z += dz * STEP;
    px.push(x); pz.push(z);
  }
  let xs = px, zs = pz;
  for (let k = 0; k < 2; k++) {
    const ox = [xs[0]], oz = [zs[0]];
    for (let i = 0; i + 1 < xs.length; i++) {
      ox.push(0.75 * xs[i] + 0.25 * xs[i + 1], 0.25 * xs[i] + 0.75 * xs[i + 1]);
      oz.push(0.75 * zs[i] + 0.25 * zs[i + 1], 0.25 * zs[i] + 0.75 * zs[i + 1]);
    }
    ox.push(xs[xs.length - 1]); oz.push(zs[zs.length - 1]);
    xs = ox; zs = oz;
  }
  return [xs, zs];
}

/** A canyon along (xs, zs): `depth` m under the dune floor and its plateau `lift` m over it in the middle. Open at
 *  its end, and at its start too unless `start` gives the floor and rim height there (a side canyon's mouth). */
function canyon(xs: number[], zs: number[], depth: number, lift: number, r: () => number,
  start?: { floor: number; rim: number }): Canyon {
  const n = xs.length, s = [0];
  for (let i = 1; i < n; i++) {
    const dx = xs[i] - xs[i - 1], dz = zs[i] - zs[i - 1];
    s.push(s[i - 1] + Math.sqrt(dx * dx + dz * dz));
  }
  const L = s[n - 1], ramp = Math.min(1600, L * 0.3);
  const floor: number[] = [], rim: number[] = [], gnd: number[] = [];
  for (let i = 0; i < n; i++) {
    const g = dryFloor(xs[i], zs[i], WORLD_SEED);
    gnd.push(g);
    const out = ss((L - s[i]) / ramp);
    if (start) {
      // A side canyon: from its mouth's floor and rim, out to the desert at its far end.
      const k = ss(s[i] / (L * 0.8));
      floor.push(g - 4 + (start.floor + 2 - g + 4) * (1 - k * k));
      rim.push(g + (start.rim - g) * out);
    } else {
      const d = ss(s[i] / ramp) * out;
      floor.push(g - 4 - depth * d);
      rim.push(g + lift * ss(d * 1.6));
    }
  }
  const shelf = 60 + 200 * r();
  // Walls reach out up to RUN_MAX × their height (the wide reaches), the floor up to ~90 m, spurs and wobble ~90 m.
  let hMax = 0;
  for (let i = 0; i < n; i++) hMax = Math.max(hMax, rim[i] - floor[i]);
  return { xs, zs, s, floor, rim, gnd, reach: 90 + hMax * RUN_MAX + 90 + shelf * 1.5 + 40, shelf, seed: Math.floor(r() * 1e6) };
}

/** The canyon system starting in cell (ix, iz): a main gorge and its side canyons, or none. */
function cellCanyons(ix: number, iz: number): Canyon[] {
  if (LAB) return [];
  const r = rng(ix, iz);
  if (r() > ODDS) return [];
  const x0 = (ix + r()) * CANYON_CELL, z0 = (iz + r()) * CANYON_CELL;
  let dx = 1, dz = 0;
  for (let i = 0; i < 16; i++) {
    const u = 2 * r() - 1, v = 2 * r() - 1, q = u * u + v * v;
    if (q > 0.01 && q <= 1) { const l = Math.sqrt(q); dx = u / l; dz = v / l; break; }
  }
  const [xs, zs] = walk(x0, z0, dx, dz, 20 + Math.floor(r() * 14), r);
  const main = canyon(xs, zs, 220 + 180 * r(), 25 + 40 * r(), r);
  const out = [main];
  const m = 1 + Math.floor(r() * 3);
  for (let j = 0; j < m; j++) {
    // Off the main gorge's middle stretch, turned 35–70° to one side.
    const i = Math.floor(xs.length * (0.25 + 0.5 * r()));
    const tx = xs[i + 1] - xs[i - 1], tz = zs[i + 1] - zs[i - 1], tl = Math.sqrt(tx * tx + tz * tz);
    const side = r() < 0.5 ? -1 : 1, k = 0.7 + 0.8 * r();
    let bx = tx / tl - side * (tz / tl) * k, bz = tz / tl + side * (tx / tl) * k;
    const bl = Math.sqrt(bx * bx + bz * bz);
    bx /= bl; bz /= bl;
    const [bxs, bzs] = walk(xs[i], zs[i], bx, bz, 4 + Math.floor(r() * 6), r);
    const b = canyon(bxs, bzs, 0, 0, r, { floor: main.floor[i], rim: main.rim[i] });
    // Where it still runs in the main gorge (whose floor may climb faster than its own), keep its floor over the
    // main one's, so it never digs a trench in it.
    for (let p = 0; p < b.xs.length; p++) {
      let best = Infinity, f = 0;
      for (let q = 0; q < xs.length; q++) {
        const ex = b.xs[p] - xs[q], ez = b.zs[p] - zs[q], d2 = ex * ex + ez * ez;
        if (d2 < best) { best = d2; f = main.floor[q]; }
      }
      if (best < 600 * 600) b.floor[p] = Math.max(b.floor[p], f + 1.5);
    }
    out.push(b);
  }
  // Keep the base clear: drop the whole system if any of it comes near.
  for (const c of out) {
    for (let i = 0; i < c.xs.length; i += 2) {
      const bx = c.xs[i], bz = c.zs[i], clear = BASE_CLEAR + c.reach;
      if (bx * bx + bz * bz < clear * clear) return [];
    }
  }
  return out;
}

const own = new Map<number, Canyon[]>();
const cellKey = (ix: number, iz: number) => (ix + 2 ** 25) * 2 ** 26 + (iz + 2 ** 25);

function ownCanyons(ix: number, iz: number): Canyon[] {
  const k = cellKey(ix, iz);
  let l = own.get(k);
  if (!l) own.set(k, (l = cellCanyons(ix, iz)));
  return l;
}

/** Dev helper (?spawn=canyon, server/world.ts): the deep point (over 200 m under its rim) of a canyon's centreline
 *  nearest (x, z), or null. */
export function canyonFloorNear(x: number, z: number): { x: number; z: number } | null {
  const cx = Math.floor(x / CANYON_CELL), cz = Math.floor(z / CANYON_CELL);
  let best = Infinity, out: { x: number; z: number } | null = null;
  for (let j = cz - SEARCH - 1; j <= cz + SEARCH + 1; j++) {
    for (let i = cx - SEARCH - 1; i <= cx + SEARCH + 1; i++) {
      for (const c of ownCanyons(i, j)) {
        for (let p = 0; p < c.xs.length; p++) {
          const d2 = (c.xs[p] - x) ** 2 + (c.zs[p] - z) ** 2;
          if (c.rim[p] - c.floor[p] > 200 && d2 < best) { best = d2; out = { x: c.xs[p], z: c.zs[p] }; }
        }
      }
    }
  }
  return out;
}

/** Segment i of canyon c (from point i to i + 1). */
type Seg = { c: Canyon; i: number };
const fine = new Map<number, Seg[]>();
const NONE: Seg[] = [];

/** The canyon segments whose zone reaches into lookup cell (fx, fz). */
function segsIn(fx: number, fz: number): Seg[] {
  const k = cellKey(fx, fz);
  let l = fine.get(k);
  if (l) return l;
  const x0 = fx * FINE, z0 = fz * FINE, x1 = x0 + FINE, z1 = z0 + FINE;
  const cx = Math.floor((x0 + FINE / 2) / CANYON_CELL), cz = Math.floor((z0 + FINE / 2) / CANYON_CELL);
  l = [];
  for (let j = cz - SEARCH; j <= cz + SEARCH; j++) {
    for (let i = cx - SEARCH; i <= cx + SEARCH; i++) {
      for (const c of ownCanyons(i, j)) {
        for (let p = 0; p + 1 < c.xs.length; p++) {
          const ax = c.xs[p], az = c.zs[p], bx = c.xs[p + 1], bz = c.zs[p + 1];
          if (Math.max(ax, bx) + c.reach > x0 && Math.min(ax, bx) - c.reach < x1 &&
            Math.max(az, bz) + c.reach > z0 && Math.min(az, bz) - c.reach < z1) l.push({ c, i: p });
        }
      }
    }
  }
  if (l.length === 0) l = NONE;
  // Long-lived processes (the server) walk the whole world: keep the caches bounded.
  if (fine.size > 8192) { fine.clear(); own.clear(); }
  fine.set(k, l);
  return l;
}

/** How much (0..1) a canyon's zone covers (x, z): 1 within its walls and tableland, fading out past them. */
export function canyonCover(x: number, z: number): number {
  const segs = segsIn(Math.floor(x / FINE), Math.floor(z / FINE));
  let cover = 0;
  for (let k = 0; k < segs.length; k++) {
    const { c, i } = segs[k];
    const ax = c.xs[i], az = c.zs[i], ex = c.xs[i + 1] - ax, ez = c.zs[i + 1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)));
    const qx = x - ax - ex * t, qz = z - az - ez * t;
    const v = ss((c.reach - Math.sqrt(qx * qx + qz * qz)) * (1 / 250));
    if (v > cover) cover = v;
  }
  return cover;
}

/** How much dried mud (0..1) lies on a canyon's floor at (x, z), for the cracked-clay look (src/world/terrain.ts). */
export function canyonMud(x: number, z: number): number {
  return canyonAt(x, z) ? canyonOut.mud : 0;
}

/** What the canyons do at a point: `cut` (the gorge's surface: walls and the bedrock under its floor; Infinity
 *  where it cuts nothing), `wash` (the sand on its floor and banked against the foot of its walls), `plateau`
 *  (the tableland's rock, -Infinity off it) and `bare` (0..1: how much of the sand on the tableland the wind has
 *  stripped, 1 along its edges), `mud` (0..1: dried mud on its floor) and `foot` (0..1: how near the foot of a wall, where
 *  rockfall lies; the floor's rocks keep off it, shared/rocks.ts). Written by canyonAt. */
export const canyonOut = { cut: Infinity, wash: Infinity, plateau: -Infinity, bare: 0, mud: 0, foot: 0 };

/** Fill canyonOut for (x, z); false (and nothing written) where no canyon reaches. */
export function canyonAt(x: number, z: number): boolean {
  const segs = segsIn(Math.floor(x / FINE), Math.floor(z / FINE));
  if (segs.length === 0) return false;
  const o = canyonOut;
  o.cut = Infinity; o.wash = Infinity; o.plateau = -Infinity; o.bare = 0; o.mud = 0; o.foot = 0;
  // Nearest point on each canyon's centreline (segments come grouped by canyon, in order).
  let k = 0;
  while (k < segs.length) {
    const c = segs[k].c;
    let best = Infinity, bi = 0, bt = 0, side = 1;
    for (; k < segs.length && segs[k].c === c; k++) {
      const i = segs[k].i;
      const ax = c.xs[i], az = c.zs[i], ex = c.xs[i + 1] - ax, ez = c.zs[i + 1] - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)));
      const qx = x - ax - ex * t, qz = z - az - ez * t, d2 = qx * qx + qz * qz;
      if (d2 < best) { best = d2; bi = i; bt = t; side = ex * qz - ez * qx < 0 ? -1 : 1; }
    }
    if (best >= c.reach * c.reach) continue;
    profile(c, x, z, Math.sqrt(best), side, c.s[bi] + (c.s[bi + 1] - c.s[bi]) * bt,
      c.floor[bi] + (c.floor[bi + 1] - c.floor[bi]) * bt, c.rim[bi] + (c.rim[bi + 1] - c.rim[bi]) * bt,
      c.gnd[bi] + (c.gnd[bi + 1] - c.gnd[bi]) * bt);
  }
  return o.cut < Infinity || o.plateau > -Infinity;
}

/** One canyon's cross-section at distance d from its centreline (on its `side`, ±1), arc length s along it. */
function profile(c: Canyon, x: number, z: number, d: number, side: number, s: number, floor: number, rim: number, gnd: number) {
  const o = canyonOut, sd = c.seed;
  const h = Math.max(0, rim - floor);
  // Reaches: the floor's width and how far the walls lean back go together, from narrow gorges to wide valleys with
  // stepped, sloping walls.
  const n = ss((vnoise(s * (1 / 900), 0.5, sd) - 0.2) * (1 / 0.65));
  // (Pinched and widened along the way by a faster noise: tight stretches between wider flats.)
  const wf = Math.max(15, (14 + 56 * n * n) * (0.35 + 1.05 * ss((vnoise(s * (1 / 260), 1.3, sd + 16) - 0.22) * 1.8)));
  // (Never steeper than ~65° overall: steeper, the heightfield's grid shows on the walls, and a deep gorge closes up
  // into a dark V.)
  const run = Math.max(3, h * (0.45 + (RUN_MAX - 0.45) * n * n));
  // Wobbly walls, with buttresses and fins jutting out of them, gullies between; in the wide reaches, big spurs
  // running down between amphitheatres.
  // (All of it fades where the canyon is shallow, towards its ends: there it would stand up as teeth.)
  const deep = ss(h * (1 / 80));
  const wob = (vnoise(x * (1 / 90), z * (1 / 90), sd + 1) - 0.5) * (6 + wf * 0.4 + run * 0.06) * deep;
  // (Noise in world space, domain-warped: buttresses of no fixed spacing. Spaced along the canyon, they lined up into
  // teeth.)
  const fs = 1 / (45 + run * 0.12), wx = vnoise(x * (1 / 130), z * (1 / 130), sd + 2) * 2.5, wz = vnoise(x * (1 / 130), z * (1 / 130), sd + 9) * 2.5;
  // (Rounded crests and nothing finer than ~40 m: on an 80° wall a metre sideways is five up, so sharp or fine
  // detail stood out of the mesh as spikes and a comb along the top.)
  const fr = 2 * vnoise(x * fs + wx, z * fs + wz, sd + 3) - 1;
  const fin = 1 - fr * fr;
  const spur = Math.min(90, 3 + run * 0.15) * (0.25 + 1.1 * vnoise(s * (1 / 350), 3.5, sd + 10)) * deep;
  // (None on the floor and fading out towards the foot of the walls, so the floor meets a smooth apron instead of
  // cutting across the flutes, which stood out of the sand as teeth.)
  const de = d + (wob + ss(fin) * ss(fin) * spur) * ss((d - wf * 0.9 - 4) * (1 / 45));
  // Bedrock under the wash, then the wall up to the rim: cliffs and slopes as the rock column has them
  // (shared/strata.ts), so the same pale band is a cliff and the same red shale a slope all along it.
  let cut: number;
  const t = (de - wf) / run;
  if (t <= 0) cut = floor - 2;
  else if (t < 1) cut = wallY(floor, rim, t, run) + 1.5 * t * (vnoise(x * 0.11, z * 0.11, sd + 4) - 0.5);
  else cut = rim + (de - wf - run) * 1.5;
  // Talus: a concave apron of rockfall at the wall's foot, ~30°, so the floor meets the wall in a fan rather than a
  // sharp crease (which the mesh grid drew as a row of teeth).
  // (No wider than a third of the floor: in the tight stretches the two fans met in a V.)
  const ht = Math.min(10, 3 + h * 0.03, wf * 0.33 / 1.8) * deep + 1, wt = ht * 1.8, q = (de - wf + wt) / wt;
  if (q > 0) cut = Math.max(cut, floor - 2 + (ht + 2) * Math.min(1, q) * Math.min(1, q));
  const foot = (1 - ss(Math.abs(de - wf) / (wt + 18))) * ss(h * (1 / 40));
  if (foot > o.foot) o.foot = foot;
  // Buttes ("temples") standing in the wide reaches: flat-topped, cliff-sided, stepped, short of the rim.
  if (t < 1 && run > 250) cut = Math.max(cut, butte(x, z, floor, h, sd) * ss((run - 250) / 150) * ss((d - wf * 0.6) / 40) +
    (floor - 2) * (1 - ss((run - 250) / 150) * ss((d - wf * 0.6) / 40)));
  if (cut < o.cut) o.cut = cut;
  // The wash: a metre or few of sand, rippled into low bars, banked up the foot of the walls. Only on this canyon's
  // own floor and wall foot; the lowest of them where two meet, so a side canyon's wash runs into the main one's.
  if (t < 0.3) {
    // (Banked a few metres up the foot of the walls, no more.)
    let wash = floor - 0.6 + 2 * vnoise(x * (1 / 55), z * (1 / 55), sd + 5) + 0.5 * Math.max(0, Math.min(12, de - wf + 3));
    // Dried mud: where the last flood stood, a band wandering down the middle of the floor, in patches, dead flat
    // (cracked clay, as on the mud flats).
    const room = Math.max(0, wf * 0.6 - 3);
    const m = (vnoise(s * (1 / 240), 7.7, sd + 13) - 0.5) * 1.6 * room;
    const mud = ss(1 - Math.abs(d * side - m) / (wf * 0.45 + 3)) * ss((vnoise(x * (1 / 70), z * (1 / 70), sd + 14) - 0.35) * 5);
    if (mud > 0) {
      wash += (floor - 0.3 - wash) * mud;
      if (mud > o.mud) o.mud = mud;
    }
    if (wash < o.wash) o.wash = wash;
  }
  // The tableland: a weathered top at the rim's height out to `shelf` past the wall top, then a cliff down to
  // the dunes. Its edge wanders in bays and headlands.
  const edge = wf + run + c.shelf * (0.35 + 1.1 * vnoise(x * (1 / 260), z * (1 / 260), sd + 6));
  // Where it hardly rises (towards its ends) it sinks under the sand instead of lying on it.
  const lift = rim - gnd;
  const top = rim + (1.2 * (vnoise(x * 0.06, z * 0.06, sd + 7) - 0.5) + 0.8 * ridged(x * 0.02, z * 0.02, sd + 8)) * ss(lift * 0.2) -
    6 * (1 - ss(lift * (1 / 6)));
  // (A short cliff, then a steep slope down to the dunes: a sheer drop's top edge cast a sawtooth shadow.)
  const dd = Math.max(0, de - edge), p = top - Math.min(dd, 8) * 2.2 - Math.max(0, dd - 8) * 0.9;
  if (p > o.plateau) o.plateau = p;
  // The wind strips the sand off its edges (the rim over the gorge and the outer cliffs): bare caprock there.
  const fromEdge = Math.min(de - wf - run, edge - de);
  if (fromEdge > -20) { const b = 1 - ss((fromEdge - 15) * (1 / 70)); if (b > o.bare) o.bare = b; }
}

/** Grid (m) of the buttes: at most one per cell, somewhere in it. */
const BUTTE_CELL = 260;

/** The highest butte at (x, z) in a canyon `h` m deep from `floor` (stepped like the walls, by the rock column), or
 *  its floor. */
function butte(x: number, z: number, floor: number, h: number, sd: number): number {
  const ix = Math.floor(x / BUTTE_CELL), iz = Math.floor(z / BUTTE_CELL);
  let top = floor - 2;
  for (let j = iz - 1; j <= iz + 1; j++) {
    for (let i = ix - 1; i <= ix + 1; i++) {
      if (hash2(i, j, sd + 11) > 0.55) continue;
      const cx = (i + 0.2 + 0.6 * hash2(i, j, sd + 12)) * BUTTE_CELL, cz = (j + 0.2 + 0.6 * hash2(i, j, sd + 13)) * BUTTE_CELL;
      const R = 40 + 70 * hash2(i, j, sd + 14);
      const dx = x - cx, dz = z - cz;
      // A wobbly outline, and the cliffs stepping out in terraces down to a skirt of talus.
      const w = vnoise(x * (1 / 45), z * (1 / 45), sd + 15) - 0.5;
      const e = Math.sqrt(dx * dx + dz * dz) / R * (1 + 0.45 * w);
      if (e >= 2.2) continue;
      const H = h * (0.45 + 0.45 * hash2(i, j, sd + 16));
      const y = wallY(floor, floor + H, 1 - (e - 0.7) * (1 / 1.5), R * 1.5);
      if (y > top) top = y;
    }
  }
  return top;
}
