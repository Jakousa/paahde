// Echoes off the walls round you: canyon walls, mesas, big rocks. Sound goes through src/acoustics.ts `placed`,
// which asks here for the taps to add to a sound: one late copy per wall near you, from that wall's direction.
//
// `listen` (every frame, from the camera) casts one of RAYS level rays a frame, so a full sweep takes a quarter of a
// second. Each marches the heightfield outwards to REACH m and keeps, for its direction, where the ground first stands
// up into a wall (`at`: higher than WALL_SLOPE over the distance), how much of the sky in that direction it fills
// (`cover`: how high the highest of it stands, as an angle) and how hard it is (`hard`: rock rings, sand swallows).
// Indoors (a shelter) none of it: the roof would read as walls all round.
//
// A tap for a sound at `src` heard at the ear: late by the detour via the wall (src → wall → ear, less the direct
// path), and at most ECHO of the direct sound, less the further the detour goes. Between two walls facing each other
// close enough (a narrow reach), the sound bounces between them: a few more taps, a crossing apart, each fainter
// (flutter). All the taps together carry at most ECHO_SUM of the direct sound's energy, however many walls there are.
// `enclosure` (0..1: how much of the sky round you is rock wall) sets how much of the canyon reverb sounds play into.
import { baseHeight, rockTop } from '../shared/terrain.ts';
import { indoors } from '../shared/shelters.ts';
import { ss } from '../shared/noise.ts';

export type P = { x: number; y: number; z: number };

/** Directions probed, and how far (m). */
const RAYS = 16;
const REACH = 1100;
/** Ground rising more than this over the distance (rise / run) stands as a wall in that direction. */
const WALL_SLOPE = 0.15;
/** Cover: from this slope up to the highest ground being FULL_SLOPE over its distance (~40°), the direction is all wall. */
const FULL_SLOPE = 0.85;
/** No wall nearer than this (m): a dune lip or a dug hole by your feet isn't an echo. */
const NEAREST = 8;
/** How much rock and sand give back. */
const ROCK = 1;
const SAND = 0.2;
/** Most of the direct sound a tap carries, and from how long a detour (m) it falls (by its square root). */
const ECHO = 0.32;
const ECHO_REF = 120;
/** All the taps' energy at most this share of the direct sound's. */
const ECHO_SUM = 0.3;
/** Taps per sound at most, the quietest worth making (absolute gain), and how close (s) two can come before they're
 *  heard as one (merged: their energy added, from the louder's wall). */
const MAX_TAPS = 8;
const MERGE_S = 0.03;
const QUIET = 0.004;
/** Flutter: walls facing each other at most this far apart (m), each bounce this much of the last, and how many. */
const FLUTTER_W = 260;
const FLUTTER = 0.55;
const FLUTTER_N = 3;

type Wall = { x: number; y: number; z: number; d: number; w: number };
/** Per direction: its wall, or null; `w` = cover × hardness. */
const walls: (Wall | null)[] = new Array(RAYS).fill(null);
let next = 0;
let inside = false;
const ear = { x: 0, y: 0, z: 0 };

/** A sound on the ground at (x, z), at the ear's height (for those that only know where on the map they are). */
export function atEar(x: number, z: number): P {
  return { x, y: ear.y, z };
}

/** How much of the sky round you is rock wall, 0..1 (follows `listen`). */
export let enclosure = 0;

/** Every frame, with the camera position: probe the next direction. */
export function listen(cam: P) {
  ear.x = cam.x; ear.y = cam.y; ear.z = cam.z;
  inside = indoors(cam.x, cam.y, cam.z);
  const i = next;
  next = (next + 1) % RAYS;
  walls[i] = inside ? null : probe(cam, (i / RAYS) * Math.PI * 2);
  let e = 0;
  for (const w of walls) if (w) e += w.w;
  // Smoothed, so a ray flipping on a ridge doesn't swing the reverb.
  enclosure += (e / RAYS - enclosure) * 0.1;
}

function probe(o: P, a: number): Wall | null {
  const dx = Math.cos(a), dz = Math.sin(a);
  let at = -1, top = 0, r = 3;
  while (r < REACH) {
    const x = o.x + dx * r, z = o.z + dz * r;
    const s = (baseHeight(x, z) - o.y) / r;
    if (at < 0 && s > WALL_SLOPE) at = r;
    if (s > top) top = s;
    // Past the wall's top by a good way, nothing behind it is heard.
    if (at > 0 && r > at * 3 && s < top * 0.5) break;
    r += Math.max(3, r * 0.08);
  }
  if (at < 0) return null;
  const d = Math.max(NEAREST, at), x = o.x + dx * d, z = o.z + dz * d;
  // Hard where the face is bare rock (looked at a little behind its foot, past the sand banked against it).
  const fx = o.x + dx * (at + 6), fz = o.z + dz * (at + 6);
  const hard = rockTop(fx, fz) >= baseHeight(fx, fz) - 0.05 ? ROCK : SAND;
  const cover = ss((top - WALL_SLOPE) / (FULL_SLOPE - WALL_SLOPE));
  // The echo comes off the face a little above the ear, where most of it stands.
  return { x, y: o.y + Math.min(d * top, 40) * 0.5, z, d, w: cover * hard };
}

export type Tap = { delay: number; gain: number; x: number; y: number; z: number; path: number };
const taps: Tap[] = [];

/**
 * The echoes of a sound at `src` (null: at the ear, your own), heard at the ear `listen` last had, as taps
 * relative to its direct sound: delay (s) after it, gain (× the direct sound's level `amp`, the absolute gain it's
 * heard at, to drop the inaudible ones), where it comes from and how far it went. Reused array.
 */
export function echoTaps(src: P | null, amp: number, hear: number, speed: number): Tap[] {
  taps.length = 0;
  if (inside) return taps;
  const s = src ?? ear;
  const direct = Math.hypot(s.x - ear.x, s.y - ear.y, s.z - ear.z);
  let sum = 0;
  for (const w of walls) {
    if (!w || w.w < 0.02) continue;
    const path = Math.hypot(s.x - w.x, s.y - w.y, s.z - w.z) + Math.hypot(w.x - ear.x, w.y - ear.y, w.z - ear.z);
    if (path > hear) continue;
    const g = ECHO * w.w * Math.min(1, Math.sqrt(Math.max(direct, ECHO_REF) / path));
    taps.push({ delay: (path - direct) / speed, gain: g, x: w.x, y: w.y, z: w.z, path });
    sum += g * g;
  }
  // Flutter between the closest pair of walls facing each other.
  let best = Infinity, a: Wall | null = null, b: Wall | null = null;
  for (let i = 0; i < RAYS / 2; i++) {
    const p = walls[i], q = walls[i + RAYS / 2];
    if (p && q && p.w > 0.3 && q.w > 0.3 && p.d + q.d < Math.min(best, FLUTTER_W)) { best = p.d + q.d; a = p; b = q; }
  }
  if (a && b) {
    const first = taps.find((t) => t.x === a.x && t.z === a.z);
    if (first) {
      for (let k = 1; k <= FLUTTER_N; k++) {
        const w = k % 2 ? b : a, g = first.gain * FLUTTER ** k, path = first.path + 2 * best * k;
        if (path > hear) break;
        taps.push({ delay: first.delay + (2 * best * k) / speed, gain: g, x: w.x, y: w.y, z: w.z, path });
        sum += g * g;
      }
    }
  }
  taps.sort((p, q) => p.delay - q.delay);
  let n = 0;
  for (const t of taps) {
    const last = n > 0 ? taps[n - 1] : null;
    if (last && t.delay - last.delay < MERGE_S) {
      if (t.gain > last.gain) { last.x = t.x; last.y = t.y; last.z = t.z; }
      last.gain = Math.hypot(last.gain, t.gain);
    } else taps[n++] = t;
  }
  taps.length = n;
  const norm = sum > ECHO_SUM ? Math.sqrt(ECHO_SUM / sum) : 1;
  for (const t of taps) t.gain *= norm;
  taps.sort((p, q) => q.gain - p.gain);
  if (taps.length > MAX_TAPS) taps.length = MAX_TAPS;
  while (taps.length && taps[taps.length - 1].gain * amp < QUIET) taps.length--;
  return taps;
}
