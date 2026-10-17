// Shade: is a point in the sun's line of sight? Used by the server for the felt temperature
// (shared/temperature.ts, server/water.ts), at the player's head, a few times a second.
//
// A ray from the point towards the sun (shared/sun.ts) is marched over the terrain (heightAt: the dunes,
// the base's pad and every dig), with steps that grow with distance, giving up after MAX_DIST. On the way
// it also tests the base's surface buildings (the entrance hut and the skylight's collar, as boxes) and,
// near the start, the scrap piles' hitboxes (shared/scrap.ts). The sun at or below the horizon is shade.
//
// Deterministic (no time, no randomness), but it uses the sun's trig, so it is not bit-exact across JS
// engines: fine, since only the server decides. Cost: ~80 heightAt calls worst case (~20 µs), usually far
// fewer, since the ray stops as soon as it rises above the highest possible ground.
import { BASE, HUT, ROOM_Z, SKY, W } from './base.ts';
import { MAX_EDIT_MM } from './dig.ts';
import { scrapPieces, scrapTaken, SCRAP_CELL, type ScrapPiece } from './scrap.ts';
import { DECL, skyVector, sunHourAngle, type Vec3 } from './sun.ts';
import { ROCK_H_MAX } from './rocks.ts';
import { heightAt } from './terrain.ts';

/** How far towards the sun the ray looks for something in the way (m). */
const MAX_DIST = 180;
/** First step, and how much each step grows with distance (step = STEP0 + STEP_GROWTH · t). */
const STEP0 = 0.2, STEP_GROWTH = 0.05;
/** No ground is higher than this (m): erg ±12 + big dunes 30 + small 3.5 + piled sand + margin, or a
 *  rock (shared/rocks.ts) standing on top of all that. */
const GROUND_MAX = 12 + 30 + 3.5 + ROCK_H_MAX + MAX_EDIT_MM / 1000 + 1;
/** Scrap is tested only this close (m): it is low, so it only shades at a low sun and up close. */
const SCRAP_DIST = 25;
/** Sun this close to the horizon (sin of its elevation) counts as set. */
const MIN_SUN_Y = 0.01;

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

const sun: Vec3 = { x: 0, y: 0, z: 0 };

/** The unit vector towards the sun at a time of day (the same one the client's sky and shadows use). */
export function sunDirection(tod: number, out: Vec3 = sun): Vec3 {
  return skyVector(sunHourAngle(tod), DECL, out);
}

/** True if the sun at time of day `tod` shines on world point (x, y, z): above the horizon and nothing in the way. */
export function inSun(x: number, y: number, z: number, tod: number): boolean {
  const d = sunDirection(tod);
  if (d.y < MIN_SUN_Y) return false;
  for (const b of BOXES) if (hitsBox(x, y, z, d, b, MAX_DIST)) return false;
  let cell = NaN, pieces: ScrapPiece[] = [];
  for (let t = STEP0; t < MAX_DIST; t += STEP0 + STEP_GROWTH * t) {
    const px = x + d.x * t, py = y + d.y * t, pz = z + d.z * t;
    if (py > GROUND_MAX) return true;
    if (py < heightAt(px, pz)) return false;
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
