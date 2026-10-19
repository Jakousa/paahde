// The harvester: a tracked sand crawler the size of a building, slab-sided and black with rust, grinding slowly over
// the dunes along a long route and sifting the sand for whatever traces of ore it holds (a cutter drum in its maw, a
// sieve tower, a chute spilling the sifted sand behind). It minds its own business until someone comes close or shoots
// it: then its slit eye turns red, its horn sounds and the turret on its tower lobs heavy bolts (the walkers' bolts,
// server/guardians.ts). Anyone it drives over is ground into the sand. Only its four heat vents can hurt it
// (VENT_HP each, shared/rifle.ts hits): with all of them out the engine seizes, it burns where it stopped and its ore
// hopper bursts (shared/tables.ts HARVESTER_SPOILS).
//
// Like the jets (shared/jets.ts) the server (server/harvesters.ts) sends the route and the start time whenever
// something changes, and the rest is plain math on that and the server clock: both sides agree where it is.
// Drawn by src/world/harvesters.ts (model tools/blender/harvester.py), heard via src/harvesterSound.ts.
//
// Its pose: the front and rear axles ride the route WHEELBASE / 2 ahead of and behind the distance it has come, the
// hull between them (so it cuts its corners like a real tracked vehicle), sitting on the four track units' sand.

import { baseHeight } from './terrain.ts';

export type Harvester = {
  id: number;
  /** The route: x, z pairs (m), about STEP apart. */
  pts: number[];
  /** Speed along it (m/s). */
  speed: number;
  /** Server-clock ms it set off from the first point; it leaves at `end` (killed: the wreck goes WRECK_MS after). */
  start: number;
  end: number;
  /** Rifle hits on each heat vent (VENTS; VENT_HP puts it out). */
  vents: number[];
  /** The player it has turned on (0 none): the turret follows them. */
  prey: number;
  /** Killed at server time `at`: it stops where it was then. */
  down?: { at: number };
};

/** Route point spacing (m). */
export const STEP = 20;
/** Crawling speed (m/s). */
export const SPEED = 2.2;
/** Front axle to rear axle (m), and from the left tracks' centres to the right ones'. */
export const WHEELBASE = 18;
export const TRACK = 12;
/** Track unit (local): length, width, height (m). */
export const TRACK_LEN = 10;
export const TRACK_W = 3.4;
export const TRACK_H = 4.2;
/** Footprint (local, m): half width, from the stern to the front of the maw. Anyone in it is run over. */
export const HALF_W = 7.9;
export const STERN = -15.5;
export const BOW = 18.5;
/** The hull's top (m above its ground), the tower's. */
export const HULL_TOP = 12;
export const TOWER_TOP = 17.4;
/** The turret's pivot (local) and the length of its barrels (m). */
export const TURRET = { x: 0, y: 18.6, z: -5 };
export const BARREL = 4.2;
/** The slit eye across the front of the tower (local centre). */
export const EYE = { x: 0, y: 15.4, z: 1.1 };
/** Heat vents (local centres, facing out to the side): the only places a shot hurts it. */
export const VENTS: readonly { x: number; y: number; z: number }[] = [
  { x: 7.65, y: 7.4, z: 5.5 }, { x: 7.65, y: 7.4, z: -6.5 },
  { x: -7.65, y: 7.4, z: 5.5 }, { x: -7.65, y: 7.4, z: -6.5 },
];
/** Vent grille half size (m): along the hull and up. */
export const VENT_HALF = { z: 2.1, y: 1.3 };
export const VENT_HP = 3;
/** The wreck burns this long (ms) before it's cleared. */
export const WRECK_MS = 8 * 60_000;
/** Seen from this far (m) by clients. */
export const SHOW_R = 4000;

/** It notices anyone this near (m) whom its eye can see; it gives up on prey this far off (or unseen this long). */
export const NOTICE_R = 75;
export const LOSE_R = 240;
export const LOSE_MS = 25_000;
/** Shot at, it stays angry at the shooter this long (ms). */
export const ANGER_MS = 90_000;
/** After turning on someone it sounds its horn and waits this long (ms) before the first salvo. */
export const WAKE_MS = 3200;
/** A salvo of SALVO bolts, SALVO_GAP ms apart, every SALVO_MS. */
export const SALVO = 3;
export const SALVO_GAP = 320;
export const SALVO_MS = 5200;

export type HarvesterPose = {
  x: number; y: number; z: number;
  /** three.js yaw (forward = (sin, cos)), nose up (rad), roll (rad, + lifts its +X side). */
  yaw: number; pitch: number; roll: number;
  /** Distance come along the route (m): the tracks and the drum turn by it. */
  s: number;
  /** 0 crawling, 1 a wreck. */
  state: number;
};

export const harvesterPose = (): HarvesterPose => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, s: 0, state: 0 });

/** Route length (m). */
export const routeLength = (pts: number[]) => {
  let l = 0;
  for (let i = 2; i < pts.length; i += 2) l += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return l;
};

/** Cumulative distance at each route point, cached per route. */
const _cum = new WeakMap<number[], Float64Array>();
function cumulative(pts: number[]): Float64Array {
  let c = _cum.get(pts);
  if (c) return c;
  c = new Float64Array(pts.length / 2);
  for (let i = 1; i < c.length; i++) c[i] = c[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  _cum.set(pts, c);
  return c;
}

/** The point `s` m along the route (past either end: on along its first or last leg), into `out`. */
function along(pts: number[], s: number, out: { x: number; z: number }) {
  const c = cumulative(pts), n = c.length;
  let i = 0;
  if (s >= c[n - 1]) i = n - 2;
  else if (s > 0) {
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (c[m] <= s) lo = m;
      else hi = m;
    }
    i = lo;
  }
  const len = c[i + 1] - c[i] || 1, t = (s - c[i]) / len;
  out.x = pts[2 * i] + (pts[2 * i + 2] - pts[2 * i]) * t;
  out.z = pts[2 * i + 1] + (pts[2 * i + 3] - pts[2 * i + 1]) * t;
  return out;
}

/** Sand under a track unit centred on world (x, z), running along (fx, fz): the highest of its middle and ends. */
function trackGround(x: number, z: number, fx: number, fz: number) {
  const e = TRACK_LEN * 0.4;
  return Math.max(baseHeight(x, z), baseHeight(x + fx * e, z + fz * e), baseHeight(x - fx * e, z - fz * e));
}

const _f = { x: 0, z: 0 }, _r = { x: 0, z: 0 };

/** Harvester `h` at server time `t` (ms), into `out`; false before it sets off or after it's gone. */
export function harvesterAt(h: Harvester, t: number, out: HarvesterPose): boolean {
  if (t < h.start || t > h.end) return false;
  const until = h.down ? Math.min(t, h.down.at) : t;
  const s = (h.speed * (until - h.start)) / 1000;
  along(h.pts, s + WHEELBASE / 2, _f);
  along(h.pts, s - WHEELBASE / 2, _r);
  const yaw = Math.atan2(_f.x - _r.x, _f.z - _r.z);
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  // Its +X side: (cos yaw, -sin yaw).
  const sx = fz * (TRACK / 2), sz = -fx * (TRACK / 2);
  const fl = trackGround(_f.x + sx, _f.z + sz, fx, fz), fr = trackGround(_f.x - sx, _f.z - sz, fx, fz);
  const rl = trackGround(_r.x + sx, _r.z + sz, fx, fz), rr = trackGround(_r.x - sx, _r.z - sz, fx, fz);
  out.x = (_f.x + _r.x) / 2;
  out.z = (_f.z + _r.z) / 2;
  out.y = (fl + fr + rl + rr) / 4;
  out.yaw = yaw;
  out.pitch = Math.atan2((fl + fr - rl - rr) / 2, WHEELBASE);
  out.roll = Math.atan2((fl + rl - fr - rr) / 2, TRACK);
  out.s = s;
  out.state = h.down ? (t >= h.down.at ? 1 : 0) : 0;
  return true;
}

/** Local point (lx, ly, lz) of a harvester at pose `p` in the world, into `out` (rotation as three.js Euler 'YXZ'
 *  (−pitch, yaw, roll): Ry · Rx · Rz). */
export function toWorld(p: HarvesterPose, lx: number, ly: number, lz: number, out: { x: number; y: number; z: number }) {
  const cr = Math.cos(p.roll), sr = Math.sin(p.roll);
  const x1 = lx * cr - ly * sr, y1 = lx * sr + ly * cr;
  const cp = Math.cos(-p.pitch), sp = Math.sin(-p.pitch);
  const y2 = y1 * cp - lz * sp, z2 = y1 * sp + lz * cp;
  const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
  out.x = p.x + x1 * cy + z2 * sy;
  out.y = p.y + y2;
  out.z = p.z - x1 * sy + z2 * cy;
  return out;
}

/** World (x, z) in its footprint's frame (ignoring pitch and roll): across (+X side) and along (+ ahead). */
export function toLocal(p: HarvesterPose, x: number, z: number, out: { x: number; z: number }) {
  const dx = x - p.x, dz = z - p.z, c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  out.x = dx * c - dz * s;
  out.z = dx * s + dz * c;
  return out;
}

/** Vents still glowing. */
export const ventsLeft = (h: Harvester) => h.vents.filter((n) => n < VENT_HP).length;
