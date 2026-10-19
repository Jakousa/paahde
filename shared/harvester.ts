// The harvester: a tracked sand crawler the size of a building, one slab-sided monolith of rust-black iron grinding
// slowly over the dunes along a long route, sifting the sand for whatever traces of ore it holds (a cutter drum in its
// maw, a slot at the stern spilling the sifted sand). It pays no one any mind, except whoever stands in its lane right
// ahead of it (a wide wedge: inSight): then it turns towards them, opens up and charges (CHARGE m/s, faster than anyone can run or slide: you have to get out of
// its lane) until the lane has been clear for a while. Anyone it drives over is ground into the sand. Its only weak points are the three glowing
// intake cores in its maw, over the drum (CORE_HP rifle hits each): to kill it you have to stand in front of it.
// With all three out it seizes, burns where it stopped and its ore hopper bursts (shared/tables.ts HARVESTER_SPOILS).
//
// Like the jets (shared/jets.ts) the server (server/harvesters.ts) sends the route, the pace and its state whenever
// something changes, and the rest is plain math on that and the server clock: both sides agree where it is. The pace
// is a list of stretches, each from a server time, a distance along the route and a speed, ramping at a steady rate
// to a target speed and holding it (paceAt); the server starts a new one when it speeds up or slows down.
// Drawn by src/world/harvesters.ts (model tools/blender/harvester.py), heard via src/harvesterSound.ts.
//
// Its pose: the front and rear axles ride the route WHEELBASE / 2 ahead of and behind the distance it has come, the
// hull between them (so it cuts its corners like a real tracked vehicle), sitting on the four track units' sand.

import { baseHeight } from './terrain.ts';

/** From server time `t` (ms), `s` m along the route at `v` m/s, ramping by `a` m/s² to `to` m/s and holding it. */
export type Pace = { t: number; s: number; v: number; a: number; to: number };

export type Harvester = {
  id: number;
  /** The route: x, z pairs (m), about STEP apart. */
  pts: number[];
  /** Its pace, oldest first (the first from when it set off). */
  pace: Pace[];
  /** Server-clock ms it set off from the first point. It's gone past the route's end, or (killed) at `end`. */
  start: number;
  end: number;
  /** Rifle hits on each intake core (CORES; CORE_HP puts it out). */
  cores: number[];
  /** Charging someone ahead of it. */
  charging: boolean;
  /** Killed at server time `at`: it stops where it was then. */
  down?: { at: number };
};

/** Route point spacing (m). */
export const STEP = 20;
/** Crawling speed, charging speed (m/s; a player walks 7.5, sprints 11, slides at most 18), and how fast it gets up
 *  to it and back (m/s²). */
export const SPEED = 2.2;
export const CHARGE = 22;
export const SPEED_UP = 4;
export const SLOW_DOWN = 2;
/** Front axle to rear axle (m), and from the left tracks' centres to the right ones'. */
export const WHEELBASE = 30;
export const TRACK = 18;
/** Track unit (local): length, width (m). */
export const TRACK_LEN = 14;
export const TRACK_W = 5;
/** Footprint (local, m): half width, from the stern to the front of the maw. Anyone in it is run over. */
export const HALF_W = 12.4;
export const STERN = -25.4;
export const BOW = 27.8;
/** The hull's top (m above its ground). */
export const HULL_TOP = 19;
/** What it sees: a wedge ahead of its bow, LANE m either side of its middle at the bow and widening by SPREAD m a metre,
 *  out to SIGHT m. Anyone in it sets it charging, turning towards them; it calms down CALM_MS after it's empty. */
export const SIGHT = 170;
export const LANE = HALF_W + 4;
export const SPREAD = 0.7;
export const CALM_MS = 5000;

/** Whether local (lx, lz) (toLocal) is in its sight. */
export const inSight = (lx: number, lz: number) => lz >= BOW - 2 && lz < BOW + SIGHT && Math.abs(lx) < LANE + (lz - BOW) * SPREAD;
/** Intake cores (local centres, facing forward) on the throat wall over the drum, in plain view from in front under
 *  the raised hood; their half size (m). */
export const CORES: readonly { x: number; y: number; z: number }[] = [
  { x: -6, y: 8.2, z: 22.4 }, { x: 0, y: 8.2, z: 22.4 }, { x: 6, y: 8.2, z: 22.4 },
];
export const CORE_HALF = 1.6;
export const CORE_HP = 4;
/** The wreck burns this long (ms) before it's cleared. */
export const WRECK_MS = 8 * 60_000;
/** Seen from this far (m) by clients. */
export const SHOW_R = 4000;

export type HarvesterPose = {
  x: number; y: number; z: number;
  /** three.js yaw (forward = (sin, cos)), nose up (rad), roll (rad, + lifts its +X side). */
  yaw: number; pitch: number; roll: number;
  /** Distance come along the route (m): the tracks and the drum turn by it; its speed now (m/s). */
  s: number;
  v: number;
  /** 0 crawling, 1 a wreck. */
  state: number;
};

export const harvesterPose = (): HarvesterPose => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, s: 0, v: 0, state: 0 });

/** Route length (m). */
export const routeLength = (pts: number[]) => {
  let l = 0;
  for (let i = 2; i < pts.length; i += 2) l += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return l;
};

const _pv = { s: 0, v: 0 };
/** How far along (m) and how fast (m/s) a pace has it at server time `t` (ms). */
export function paceAt(pace: Pace[], t: number, out = _pv): { s: number; v: number } {
  let p = pace[0];
  for (let i = pace.length - 1; i > 0; i--) if (pace[i].t <= t) {
    p = pace[i];
    break;
  }
  const dt = Math.max(0, (t - p.t) / 1000);
  const ramp = p.a === 0 ? 0 : Math.max(0, (p.to - p.v) / p.a);
  const r = Math.min(dt, ramp);
  out.s = p.s + p.v * r + (p.a * r * r) / 2 + p.to * (dt - r);
  out.v = dt < ramp ? p.v + p.a * dt : p.to;
  return out;
}

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

/** The route up to and including its first point at least `s` m along: what has to stay the same for its pose up to
 *  there to stay the same (the server swaps what comes after when it steers). */
export function routeCut(pts: number[], s: number): number[] {
  const c = cumulative(pts);
  let i = 0;
  while (i < c.length - 1 && c[i] < s) i++;
  return pts.slice(0, 2 * i + 2);
}

/** Sand under a track unit centred on world (x, z), running along (fx, fz): the highest of its middle and ends. */
function trackGround(x: number, z: number, fx: number, fz: number) {
  const e = TRACK_LEN * 0.4;
  return Math.max(baseHeight(x, z), baseHeight(x + fx * e, z + fz * e), baseHeight(x - fx * e, z - fz * e));
}

const _f = { x: 0, z: 0 }, _r = { x: 0, z: 0 };

/** Harvester `h` at server time `t` (ms), into `out`; false before it sets off or once it's gone. */
export function harvesterAt(h: Harvester, t: number, out: HarvesterPose): boolean {
  if (t < h.start || (h.end && t > h.end)) return false;
  const pv = paceAt(h.pace, h.down ? Math.min(t, h.down.at) : t);
  const s = pv.s;
  if (s > cumulative(h.pts)[h.pts.length / 2 - 1]) return false;
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
  out.v = h.down && t >= h.down.at ? 0 : pv.v;
  out.state = h.down && t >= h.down.at ? 1 : 0;
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

/** Cores still glowing. */
export const coresLeft = (h: Harvester) => h.cores.filter((n) => n < CORE_HP).length;
