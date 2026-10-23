// Procedural dune field: the base heightfield under the edit layer (see terrain.ts).
//
// Shared by server physics (every tick) and client meshing (per vertex), so it must be deterministic
// across JS engines and cheap (~0.2 µs/call). Only exact IEEE operations are used: + - * /, Math.sqrt,
// Math.floor, Math.abs, Math.min/max and Math.imul hashing. No Math.sin/cos/exp/pow (implementation-
// defined last bits differ between V8 and Firefox/Safari), no Math.random, no time, no mutable state
// beyond scratch variables that are fully rewritten before being read.
//
// Model (all in metres, Y up):
//   - A dominant wind blows towards +WIND. Distance along the wind, domain-warped by low-frequency
//     noise so crests meander, is cut into periods; each period holds one dune with a long gentle
//     windward (stoss) slope, a slightly rounded sharp brink and a straight slip face at the angle of
//     repose (~32°), ending in a soft toe and a flat interdune corridor.
//   - Crest height varies along each crest; where it drops to zero the ridge breaks into separate
//     crescents whose low ends are pushed downwind (barchan horns).
//   - A second, smaller dune train (slightly different wind angle) rides on the windward slopes and in
//     the corridors, but not on slip faces.
//   - A regional "sand supply" mask flattens some areas into pans; a very gentle erg undulation on top.
//   - Mud flats (shared/biomes.ts) have no sand supply at all: flat, slightly sunk, the erg undulation damped.

/** Seeds the dunes, scrap, wrecks and crash sites, and so where the base goes (shared/base.ts); per world
 *  (shared/world.ts). */
export { WORLD_SEED } from './world.ts';

/** Unit vector the wind blows towards (xz). Slip faces face this way; ripples run perpendicular. */
export const WIND = { x: 0.3162277660168379, z: 0.9486832980505138 }; // normalize(1, 3)
const WX = WIND.x, WZ = WIND.z;
// Small dunes: wind rotated by ~17° (cos/sin precomputed so no trig is evaluated at runtime).
const C17 = 0.9563047559630354, S17 = 0.29237170472273677;
const W2X = WX * C17 - WZ * S17, W2Z = WX * S17 + WZ * C17;

/** Shifts the noise so (0, 0) lands on a pleasant spot (high windward shoulder with a view). */
const OFFSET_X = 540;
const OFFSET_Z = -270;

const SLIP = 0.62; // tan(32°), slip-face slope in world space

// Big dunes
const L1 = 260; // period along the (warped) wind axis
const CREST1 = 0.6 * L1; // crest position within the period
const H1_MIN = 12, H1_MAX = 30;
const MEGA = 1.0; // in rare megadune regions big crests grow by up to this fraction (to ~60 m)
const HORN1 = 70; // how far low crest ends are pushed downwind
const WARP1 = 110; // domain-warp amplitude (m)
/** How far (m) a mud flat's floor lies under the land around it: a dried lake bed. */
const MUD_SINK = 2.5;
// Small dunes
const L2 = 42;
const CREST2 = 0.7 * L2;
const H2_MAX = 3.5;
const HORN2 = 6;

import { hash2, ss, vnoise } from './noise.ts';
import { biome } from './biomes.ts';
export { hash2, ss, vnoise };

// Derivatives of the last vnoiseD call (scratch, overwritten every call).
let ndx = 0, ndz = 0;
/** Value noise in [0, 1) that also writes its gradient (per unit input) to ndx/ndz. */
function vnoiseD(x: number, z: number, seed: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const tx = x - ix, tz = z - iz;
  const fx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
  const fz = tz * tz * tz * (tz * (tz * 6 - 15) + 10);
  const dfx = 30 * tx * tx * (tx * (tx - 2) + 1);
  const dfz = 30 * tz * tz * (tz * (tz - 2) + 1);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  const k = a - b - c + d;
  ndx = (b - a + k * fz) * dfx;
  ndz = (c - a + k * fx) * dfz;
  return a + (b - a) * fx + (c - a) * fz + k * fx * fz;
}

/** 1D value noise in [0, 1) along t, an independent curve per integer `row`. */
function vnoise1(t: number, row: number, seed: number): number {
  const i = Math.floor(t);
  let f = t - i;
  f = f * f * (3 - 2 * f);
  const a = hash2(i, row, seed), b = hash2(i + 1, row, seed);
  return a + (b - a) * f;
}

/** Polynomial smooth min (k = blend width). */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/**
 * One asymmetric dune of height h. s = position along the wind within its period (0 = upwind trough),
 * crest = s of the brink, slip = slip-face slope in s units, kc/kt = crest/toe rounding (m).
 * Windward: h·x²(2−x), x = s/crest — zero slope at the trough, still climbing at the brink (sharp).
 */
function dune(s: number, crest: number, h: number, slip: number, kc: number, kt: number): number {
  if (h <= 0 || s <= 0) return 0;
  const x = s / crest;
  const wind = x < 1 ? h * x * x * (2 - x) : h * x; // continue linearly past the crest (slope h/crest)
  const lee = h - (s - crest) * slip;
  // Scale rounding with height so it stays continuous at the brink for low dunes (top >= kt there).
  kc = Math.min(kc, h * 0.5);
  kt = Math.min(kt, h * 0.4);
  const top = smin(wind, lee, kc);
  // Downwind of the brink, round the toe into the corridor floor (smooth max with 0). Upwind the
  // windward slope already starts at 0 with zero slope.
  return s > crest ? -smin(-top, 0, kt) : top;
}

/** The erg undulation under the dunes (x, z already offset), with the mud flats' sink: the floor of the corridors. */
function erg(x: number, z: number, S: number, mud: number): number {
  return (vnoise(x * (1 / 1600), z * (1 / 1600), S + 13) - 0.5) * 24 * (1 - 0.6 * mud) - MUD_SINK * mud;
}

/** The floor the dunes stand on at world (x, z): the interdune corridors' height, under every dune crest (rocks
 *  rise from it too). Poison gas (shared/gas.ts) lies a few metres deep over it. */
export function duneFloor(x: number, z: number, seed: number): number {
  return erg(x + OFFSET_X, z + OFFSET_Z, seed | 0, biome('mudflat', x, z));
}

/** The dune floor at (x, z) as if no mud flat were there (the canyons, shared/canyons.ts, which keep the mud flats
 *  away, are laid out on it). */
export function dryFloor(x: number, z: number, seed: number): number {
  return erg(x + OFFSET_X, z + OFFSET_Z, seed | 0, 0);
}

/** Procedural dune height at world (x, z). Pure function. `mud`: the mud flats' weight there, if known. */
export function duneHeight(x: number, z: number, seed: number, mud = biome('mudflat', x, z)): number {
  const S = seed | 0;
  // Mud flats (shared/biomes.ts): no sand to make dunes of, a dead flat floor a little sunk into the land.
  x += OFFSET_X;
  z += OFFSET_Z;

  // Regional sand supply: 0 = flat pan, 1 = full dune field.
  const supply = (vnoise(x * (1 / 1100), z * (1 / 1100), S + 11) * 0.7 + vnoise(x * (1 / 430), z * (1 / 430), S + 12) * 0.3) * (1 - mud);
  const big = ss((supply - 0.08) * (1 / 0.3));
  const small = ss((supply - 0.06) * (1 / 0.25));
  // Very gentle erg undulation.
  let h = erg(x, z, S, mud);

  const across = z * WX - x * WZ;

  // ---- Big dunes ----
  let mask2 = small; // where small dunes may appear
  if (big > 0) {
    // Domain warp (2 octaves) with analytic gradient so the slip face keeps its world-space angle.
    let w = vnoiseD(x * (1 / 520), z * (1 / 520), S + 1);
    let gx = ndx * (1 / 520), gz = ndz * (1 / 520);
    w += 0.5 * vnoiseD(x * (1 / 230), z * (1 / 230), S + 2);
    gx += ndx * (0.5 / 230);
    gz += ndz * (0.5 / 230);
    const along = x * WX + z * WZ + (w - 0.75) * WARP1;
    gx = WX + gx * WARP1;
    gz = WZ + gz * WARP1;
    const grad = Math.sqrt(gx * gx + gz * gz); // |∇along|: world slope = slope in `along` units · grad

    const t = along * (1 / L1);
    const k = Math.floor(t);
    const s = (t - k) * L1;
    const seedK = hash2(k, 7, S + 3);
    // Crest height along the crest: breaks into separate crescents where the noise is low.
    const n = vnoise1(across * (1 / 260) + seedK * 64, k, S + 4) * 0.85 + vnoise1(across * (1 / 90), k, S + 5) * 0.15;
    const c = ss((n - 0.22) * (1 / 0.5));
    // Rare megadune regions: a slow noise lifts every crest there, up to twice as high.
    const mega = ss((vnoise(x * (1 / 600), z * (1 / 600), S + 14) - 0.7) * (1 / 0.15));
    const hk = (H1_MIN + (H1_MAX - H1_MIN) * seedK) * (1 + MEGA * mega) * c * big;
    const sp = s - HORN1 * (1 - c) * (1 - c); // low parts lag downwind: barchan horns
    const slip = SLIP / grad;
    // Cap by a slope ending at the period's end so a long slip face never cuts into the next dune.
    h += Math.min(dune(sp, CREST1, hk, slip, 1.2, 4), (L1 - s) * slip);

    // Small dunes stay off the upper windward slope, the brink and the slip face.
    if (hk > 0.01) {
      const toe = CREST1 + hk / slip;
      // Ramp back in after the toe; forced to 1 by the period's end so it is continuous across periods.
      const up = sp < CREST1 ? 1 - ss((sp / CREST1 - 0.55) * (1 / 0.4)) : Math.max(ss((sp - toe) * (1 / 25)), ss((s - (L1 - 20)) * (1 / 20)));
      mask2 *= 1 - (1 - up) * ss(hk * (1 / 4));
    }
  }

  // ---- Small dunes ----
  if (mask2 > 0) {
    const w = vnoiseD(x * (1 / 150), z * (1 / 150), S + 6);
    const gx = W2X + ndx * (55 / 150), gz = W2Z + ndz * (55 / 150);
    const slip = (SLIP * 0.85) / Math.sqrt(gx * gx + gz * gz);
    const along = x * W2X + z * W2Z + w * 55;
    const across2 = z * W2X - x * W2Z;
    const t = along * (1 / L2);
    const k = Math.floor(t);
    const s = (t - k) * L2;
    const n = vnoise1(across2 * (1 / 55) + hash2(k, 9, S + 7) * 64, k, S + 8);
    const c = ss((n - 0.25) * (1 / 0.5));
    const hk = H2_MAX * (0.5 + 0.5 * hash2(k, 11, S + 9)) * c * mask2;
    h += Math.min(dune(s - HORN2 * (1 - c) * (1 - c), CREST2, hk, slip, 0.4, 1.5), (L2 - s) * slip);
  }
  return h;
}
