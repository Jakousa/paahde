// Shade: how much of a player's body is in the sun's line of sight. Used by the server for the felt temperature
// (shared/temperature.ts, server/water.ts), a few times a second per player.
//
// `sunOnBody` casts BODY rays (head, both shoulders, knees; lower when crouching) and weighs them, so standing half
// behind a hut or with the legs below a crest is partial shade. Each ray (`inSun`) goes from the point towards
// the sun (shared/sun.ts) and is tested against:
// - the base's surface buildings (the entrance hut and the skylight's collar, as boxes);
// - crash-site wrecks and debris (their collision capsules, shared/crashsites.ts) within CRASH_DIST;
// - `casters`: things that move, passed in by the caller: other players, their bikes, motorcycles lying on the sand;
// - near the start, the scrap piles' hitboxes (shared/scrap.ts);
// - the terrain (heightAt: dunes, rocks, the base's pad and every dig), marched with steps that grow with distance,
//   giving up after MAX_DIST or once the ray is above the highest possible ground. Where a step lands close
//   over the sand (closer than REFINE × the step), that step is walked again in short substeps, so a thin crest
//   between two far samples isn't missed at a grazing sun.
// The sun at or below the horizon is shade.
//
// Deterministic (no time, no randomness), but it uses the sun's trig, so it is not bit-exact across JS
// engines: fine, since only the server decides. Cost: ~40 µs per ray on average, so ~150–200 µs per body check.
import { BASE, HUT, ROOM_Z, SKY, W } from './base.ts';
import { crashTaken, crashSitesNear, pieceY, type CrashSite } from './crashsites.ts';
import { EYE_HEIGHT, MAX_EDIT_MM } from './dig.ts';
import { scrapPieces, scrapTaken, SCRAP_CELL, type ScrapPiece } from './scrap.ts';
import { DECL, skyVector, sunHourAngle, type Vec3 } from './sun.ts';
import { ROCK_H_MAX } from './rocks.ts';
import { heightAt } from './terrain.ts';

/** How far towards the sun the ray looks for something in the way (m). */
const MAX_DIST = 180;
/** First step, and how much each step grows with distance (step = STEP0 + STEP_GROWTH · t). */
const STEP0 = 0.2, STEP_GROWTH = 0.05;
/** A step that ends closer over the sand than REFINE × its length is walked again in substeps of at most SUBSTEP
 *  (m): a crest between two samples can't rise much more than half the step × the steepest dune slope (~0.6), so
 *  this leaves a 2× margin. Against a 0.1 m reference march at a grazing evening sun, misses fell from 15 to 3 in
 *  825 shaded points, at about the same cost. */
const REFINE = 0.6, SUBSTEP = 0.5;
/** No ground is higher than this (m): erg ±12 + big dunes 30 + small 3.5 + piled sand + margin, or a
 *  rock (shared/rocks.ts) standing on top of all that. */
const GROUND_MAX = 12 + 30 + 3.5 + ROCK_H_MAX + MAX_EDIT_MM / 1000 + 1;
/** Scrap is tested only this close (m): it is low, so it only shades at a low sun and up close. */
const SCRAP_DIST = 25;
/** Crash-site pieces (up to ~6 m tall) are tested this far along the ray (m). */
const CRASH_DIST = 80;
/** Casters (players, bikes) further than this from the point (m, on each axis) are skipped. */
const CASTER_DIST = 30;
/** Sun this close to the horizon (sin of its elevation) counts as set. */
const MIN_SUN_Y = 0.01;

/** Something that casts shade, as a vertical prism over a capsule footprint: segment centre (x, z) ± half·(ax, az)
 *  ((ax, az) a unit vector; any when half is 0), radius r, from height y0 up to y1. `id`: whose it is (a player's
 *  own body and bike don't shade the player). */
export type Caster = { x: number; z: number; ax: number; az: number; half: number; r: number; y0: number; y1: number; id?: number };

/** Body sample points: height above the feet (standing), sideways offset across the sun (m), weight. */
const BODY: [number, number, number][] = [
  [EYE_HEIGHT, 0, 0.35], // head
  [1.3, -0.22, 0.2], // shoulders
  [1.3, 0.22, 0.2],
  [0.5, 0, 0.25], // legs
];
/** Crouching, the points sit this much lower (× height). */
const CROUCH_SCALE = 0.65;

/** Boxes that cast shade (world x0, x1, y0, y1, z0, z1): the entrance hut and the skylight's collar.
 *  Match tools/blender/base/bunker.py build_hut(). */
const BOXES: [number, number, number, number, number, number][] = [
  [BASE.x - W - HUT.t, BASE.x + W + HUT.t, BASE.y - 0.3, BASE.y + HUT.top,
    BASE.z + HUT.z0 - HUT.t, BASE.z + HUT.z1 + HUT.t],
  [BASE.x - SKY.collar, BASE.x + SKY.collar, BASE.y - 0.3, BASE.y + SKY.h,
    BASE.z + ROOM_Z - SKY.collar, BASE.z + ROOM_Z + SKY.collar],
];

/** Does the ray from (ox, oy, oz) along unit d hit the box within maxT? (slab test) */
function hitsBox(ox: number, oy: number, oz: number, d: Vec3, b: readonly number[], maxT: number): boolean {
  let t0 = 0, t1 = maxT;
  const o = [ox, oy, oz], v = [d.x, d.y, d.z];
  for (let a = 0; a < 3; a++) {
    const lo = b[a * 2], hi = b[a * 2 + 1];
    if (Math.abs(v[a]) < 1e-9) {
      if (o[a] < lo || o[a] > hi) return false;
      continue;
    }
    let ta = (lo - o[a]) / v[a], tb = (hi - o[a]) / v[a];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Does the ray from (ox, oy, oz) along unit d (d.y > 0) pass through the prism over a capsule footprint (segment
 * (cx, cz) ± half·(ax, az), radius r, heights y0..y1)? The closest approach of the ray's ground track to the
 * segment, then the ray's height where its track enters and leaves the footprint (it rises, so those bound it).
 */
function hitsPrism(ox: number, oy: number, oz: number, d: Vec3, cx: number, cz: number, ax: number, az: number,
  half: number, r: number, y0: number, y1: number): boolean {
  const wx = ox - cx, wz = oz - cz;
  const hh = d.x * d.x + d.z * d.z;
  if (hh < 1e-9) return wx * wx + wz * wz < r * r && oy < y1; // sun straight overhead
  // Closest points of the track line w + D·t and the segment A·s, then clamped to t ≥ 0 and |s| ≤ half.
  const b = d.x * ax + d.z * az, dw = d.x * wx + d.z * wz, aw = ax * wx + az * wz;
  let s = 0;
  if (half > 0) {
    const den = hh - b * b;
    s = den > 1e-9 ? (hh * aw - b * dw) / den : 0;
    s = s < -half ? -half : s > half ? half : s;
  }
  const t = Math.max(0, ((ax * s - wx) * d.x + (az * s - wz) * d.z) / hh);
  if (half > 0) {
    s = (wx + d.x * t) * ax + (wz + d.z * t) * az;
    s = s < -half ? -half : s > half ? half : s;
  }
  const ex = wx + d.x * t - ax * s, ez = wz + d.z * t - az * s;
  const e2 = ex * ex + ez * ez;
  if (e2 >= r * r) return false;
  const chord = Math.sqrt((r * r - e2) / hh);
  const tIn = Math.max(0, t - chord), tOut = t + chord;
  return oy + d.y * tIn < y1 && oy + d.y * tOut > y0;
}

/** Is (x, y, z) inside a scrap piece's hitbox (its capsule footprint, from the ground up to its top)? */
function inScrap(pieces: ScrapPiece[], x: number, y: number, z: number): boolean {
  for (const pc of pieces) {
    const b = pc.hitbox;
    if (!b || Math.abs(x - pc.x) > b.half + b.r || Math.abs(z - pc.z) > b.half + b.r || scrapTaken.has(pc.key)) continue;
    let t = (x - pc.x) * b.ax + (z - pc.z) * b.az;
    t = t < -b.half ? -b.half : t > b.half ? b.half : t;
    const ex = x - (pc.x + b.ax * t), ez = z - (pc.z + b.az * t);
    if (ex * ex + ez * ez < b.r * b.r && y < heightAt(pc.x, pc.z) + b.h) return true;
  }
  return false;
}

/** Does the ray hit a crash site's wreck or debris within CRASH_DIST? */
function hitsCrash(sites: CrashSite[], ox: number, oy: number, oz: number, d: Vec3): boolean {
  const hl = Math.hypot(d.x, d.z) || 1;
  const ux = d.x / hl, uz = d.z / hl; // the ray's ground track, unit
  for (const s of sites) {
    for (const pc of s.pieces) {
      if (!pc.hitboxes.length || (pc.id && crashTaken.has(pc.id))) continue;
      // Quick reject: the piece's bounding circle off the ground track, or behind / beyond CRASH_DIST.
      const px = pc.x - ox, pz = pc.z - oz;
      const along = px * ux + pz * uz;
      if (along < -pc.reach || along > CRASH_DIST + pc.reach) continue;
      const side = px * uz - pz * ux;
      if (side > pc.reach || side < -pc.reach) continue;
      const y0 = pieceY(pc);
      for (const b of pc.hitboxes) {
        if (hitsPrism(ox, oy, oz, d, b.x, b.z, b.ax, b.az, b.half, b.r, y0 - 0.5, y0 + b.h)) return true;
      }
    }
  }
  return false;
}

const sun: Vec3 = { x: 0, y: 0, z: 0 };

/** The unit vector towards the sun at a time of day (the same one the client's sky and shadows use). */
export function sunDirection(tod: number, out: Vec3 = sun): Vec3 {
  return skyVector(sunHourAngle(tod), DECL, out);
}

/** Crash sites close enough to (x, z) to shade it. */
function sitesNear(x: number, z: number): CrashSite[] {
  return crashSitesNear(x, z, CRASH_DIST + 120);
}

/** One ray from (x, y, z) along d (towards the sun, d.y ≥ MIN_SUN_Y): true if nothing is in the way. */
function rayClear(x: number, y: number, z: number, d: Vec3, sites: CrashSite[], casters: readonly Caster[], self: number): boolean {
  for (const b of BOXES) if (hitsBox(x, y, z, d, b, MAX_DIST)) return false;
  for (const c of casters) {
    if (c.id === self || Math.abs(c.x - x) > CASTER_DIST || Math.abs(c.z - z) > CASTER_DIST) continue;
    if (hitsPrism(x, y, z, d, c.x, c.z, c.ax, c.az, c.half, c.r, c.y0, c.y1)) return false;
  }
  if (sites.length && hitsCrash(sites, x, y, z, d)) return false;
  let cell = NaN, pieces: ScrapPiece[] = [];
  let prevT = 0, prevGap = Infinity;
  for (let t = STEP0; t < MAX_DIST; t += STEP0 + STEP_GROWTH * t) {
    const px = x + d.x * t, py = y + d.y * t, pz = z + d.z * t;
    if (py > GROUND_MAX) return true;
    const gap = py - heightAt(px, pz);
    if (gap < 0) return false;
    const step = t - prevT;
    if (step > SUBSTEP && Math.min(gap, prevGap) < REFINE * step) {
      // Skimming the sand: walk this step again finely, for a crest between the two samples.
      const n = Math.ceil(step / SUBSTEP);
      for (let i = 1; i < n; i++) {
        const u = prevT + (step * i) / n;
        if (y + d.y * u < heightAt(x + d.x * u, z + d.z * u)) return false;
      }
    }
    prevT = t;
    prevGap = gap;
    if (t < SCRAP_DIST) {
      const ix = Math.floor(px / SCRAP_CELL), iz = Math.floor(pz / SCRAP_CELL), c = ix * 100003 + iz;
      if (c !== cell) {
        cell = c;
        pieces = scrapPieces(ix, iz);
      }
      if (pieces.length && inScrap(pieces, px, py, pz)) return false;
    }
  }
  return true;
}

/** True if the sun at time of day `tod` shines on world point (x, y, z): above the horizon and nothing in the way
 *  (`casters` too, except those of `self`). */
export function inSun(x: number, y: number, z: number, tod: number, casters: readonly Caster[] = [], self = -1): boolean {
  const d = sunDirection(tod);
  if (d.y < MIN_SUN_Y) return false;
  return rayClear(x, y, z, d, sitesNear(x, z), casters, self);
}

/**
 * How much of a player standing at feet (x, y, z) is in direct sun at `tod`, 0 (all in shade, or night) .. 1:
 * the weighted BODY points that see the sun. `casters` other than `self`'s own shade them too.
 */
export function sunOnBody(x: number, y: number, z: number, crouching: boolean, tod: number, casters: readonly Caster[] = [], self = -1): number {
  const d = sunDirection(tod);
  if (d.y < MIN_SUN_Y) return 0;
  const hl = Math.hypot(d.x, d.z);
  // Across the sun's direction, on the ground (any way when it is straight overhead).
  const sx = hl > 1e-6 ? -d.z / hl : 1, sz = hl > 1e-6 ? d.x / hl : 0;
  const sites = sitesNear(x, z);
  const k = crouching ? CROUCH_SCALE : 1;
  let lit = 0;
  for (const [h, side, w] of BODY) {
    if (rayClear(x + sx * side, y + h * k, z + sz * side, d, sites, casters, self)) lit += w;
  }
  return Math.min(1, lit);
}
