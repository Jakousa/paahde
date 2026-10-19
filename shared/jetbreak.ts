// A jet breaking up: when its nose meets the sand it comes apart into the pieces of shared/jetpieces.ts (tools/blender/machines/plane.py), each
// of which flies on with its own share of the plane's speed and a kick of its own, tumbles under gravity, hits the sand, bounces, slides, settles
// to lie flat on the slope under it, and splashes the sand where it lands hard. Plain math from the impact (shared/jets.ts jetImpact) and the
// jet's id, so the server (which stamps the craters and keeps where they ended up) and every client (which draws them flying) agree.
import { JET_PIECES } from './jetpieces.ts';
import { baseHeight } from './terrain.ts';

export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];

/** Seconds the pieces are simulated for: by then they lie still. */
export const BREAK_S = 9;
/** The step (s). */
export const BREAK_DT = 1 / 30;
const GRAVITY = 12;
const AIR = 0.05;
const FRICTION = 2.4;
const BOUNCE = 0.22;
/** Hits harder than this (m/s into the sand) splash it. */
const SPLASH_V = 5;

// ---- a little vector and quaternion math (x, y, z, w) ----------------------------------------------------------------------------
export const qMul = (a: Q4, b: Q4): Q4 => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export function qRot(q: Q4, v: V3): V3 {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}
const qNorm = (q: Q4): Q4 => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};
const qAxis = (x: number, y: number, z: number, a: number): Q4 => {
  const s = Math.sin(a / 2);
  return [x * s, y * s, z * s, Math.cos(a / 2)];
};
/** The plane's orientation: the way src/world/jets.ts turns it (three.js order YXZ: yaw, then nose up, then bank). */
export const planeQuat = (yaw: number, pitch: number, bank: number): Q4 =>
  qMul(qMul(qAxis(0, 1, 0, yaw), qAxis(1, 0, 0, -pitch)), qAxis(0, 0, 1, -bank));
function qSlerp(a: Q4, b: Q4, t: number): Q4 {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1;
  d *= s;
  const bb: Q4 = [b[0] * s, b[1] * s, b[2] * s, b[3] * s];
  return qNorm([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
}
/** The turn that takes unit `a` to unit `b`. */
function qBetween(a: V3, b: V3): Q4 {
  const c: V3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.9999) return [1, 0, 0, 0];
  return qNorm([c[0], c[1], c[2], 1 + d]);
}

/** The sand's slope: a unit normal at (x, z). */
function normal(x: number, z: number): V3 {
  const e = 0.9, dx = baseHeight(x + e, z) - baseHeight(x - e, z), dz = baseHeight(x, z + e) - baseHeight(x, z - e);
  const l = Math.hypot(dx, 2 * e, dz);
  return [-dx / l, (2 * e) / l, -dz / l];
}

export interface BreakEvent {
  /** Seconds after the impact, and where. */
  t: number;
  x: number;
  z: number;
  /** A splash of this radius (m) and depth (mm); `slide` ones are the small furrows a piece scrapes along. */
  r: number;
  mm: number;
  slide?: true;
}

/** What became of an engine: still on its wing ('on'), torn off and lying whole (a machine to take apart) or wrecked in the landing. */
export type Fate = 'on' | 'machine' | 'wreck';
/** The engines' pieces, left then right (shared/jetpieces.ts ids), the odds each tears off the wing and, if it does, is wrecked in the landing. */
export const ENGINES = ['engineL', 'engineR'];
export const ENGINE_OFF = 0.8;
export const ENGINE_WRECKED = 0.3;

export interface Breakup {
  /** What became of each engine (ENGINES order) and, for a wrecked one, when (s after the impact) it was wrecked: from then on its piece is the husk. */
  fates: Fate[];
  wrecked: number[];
  /** Per piece (in JET_PIECES order), per step: x, y, z, qx, qy, qz, qw, flags (1: on the sand, 2: moving fast). */
  states: Float32Array[];
  steps: number;
  events: BreakEvent[];
  /** Where each piece lies in the end: x, y, z, qx, qy, qz, qw. */
  final: number[][];
}
export const STATE_W = 8;

/** The impact: where the plane's centre was, how it was turned and its velocity. */
export interface Impact {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  bank: number;
  vx: number;
  vy: number;
  vz: number;
}

/** Deterministic noise from a seed: a PRNG (as shared/crash.ts seeded, kept here so this has no other imports). */
function rng(seed: number) {
  let h = seed | 0;
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function breakup(im: Impact, seed: number): Breakup {
  const rand = rng(seed * 7919 + 13);
  const qPlane = planeQuat(im.yaw, im.pitch, im.bank);
  const steps = Math.round(BREAK_S / BREAK_DT);
  const n = JET_PIECES.length;
  const states: Float32Array[] = [];
  const events: BreakEvent[] = [];
  const final: number[][] = [];
  const fr = rng(seed * 104729 + 7);
  const fates: Fate[] = ENGINES.map(() => {
    const off = fr() < ENGINE_OFF, dead = fr() < ENGINE_WRECKED;
    return !off ? 'on' : dead ? 'wreck' : 'machine';
  });
  const wrecked = ENGINES.map(() => -1);
  for (let i = 0; i < n; i++) {
    const d = JET_PIECES[i];
    const out = new Float32Array(steps * STATE_W);
    const ei = ENGINES.indexOf(d.id);
    if (ei >= 0 && fates[ei] === 'on') {
      // still on its wing: it goes where the wing goes
      const pi = JET_PIECES.findIndex((q) => q.id === d.parent), par = JET_PIECES[pi], ps = states[pi];
      const rel: V3 = [d.pivot[0] - par.pivot[0], d.pivot[1] - par.pivot[1], d.pivot[2] - par.pivot[2]];
      for (let k = 0; k < steps; k++) {
        const o = k * STATE_W, qp: Q4 = [ps[o + 3], ps[o + 4], ps[o + 5], ps[o + 6]], r = qRot(qp, rel);
        out.set([ps[o] + r[0], ps[o + 1] + r[1], ps[o + 2] + r[2], qp[0], qp[1], qp[2], qp[3], ps[o + 7]], o);
      }
      states.push(out);
      const e = (steps - 1) * STATE_W;
      final.push([out[e], out[e + 1], out[e + 2], out[e + 3], out[e + 4], out[e + 5], out[e + 6]].map((v, j) => Math.round(v * (j < 3 ? 100 : 10000)) / (j < 3 ? 100 : 10000)));
      continue;
    }
    // start: where it sat on the plane, moving with it (less of it the heavier it is), kicked away from the plane's axis and up
    const off = qRot(qPlane, d.pivot);
    let px = im.x + off[0], py = im.y + off[1], pz = im.z + off[2];
    let q: Q4 = qPlane;
    const side = Math.sign(d.pivot[0]) || (rand() < 0.5 ? -1 : 1);
    const big = d.caps.reduce((m, c) => Math.max(m, c.r), 0);
    const light = 1 / (0.5 + big);
    const kx = qRot(qPlane, [side * (1.5 + rand() * 5) * (0.6 + light), 0, 0]);
    let vx = im.vx * d.f + kx[0] + (rand() - 0.5) * 6, vy = im.vy * d.f * 0.3 + (3 + rand() * 9) * (0.5 + light * 0.5), vz = im.vz * d.f + kx[2] + (rand() - 0.5) * 6;
    let wx = (rand() - 0.5) * 2 * (1.2 + 2.5 * light), wy = (rand() - 0.5) * 2 * (0.8 + 2 * light), wz = (rand() - 0.5) * 2 * (1.2 + 2.5 * light);
    let calm = 0, lastHit = -1, lastSlide = -1;
    // it settles into the sand, each a little differently
    let lo = Infinity, hi = -Infinity;
    for (const pt of d.pts) {
      lo = Math.min(lo, pt[1]);
      hi = Math.max(hi, pt[1]);
    }
    const sinkTo = (hi - lo) * (0.5 + rand() * 0.4); // sinks 50 to 90% of its own height
    let sink = 0;
    for (let k = 0; k < steps; k++) {
      const t = k * BREAK_DT;
      // fly
      vy -= GRAVITY * BREAK_DT;
      const air = Math.exp(-AIR * BREAK_DT);
      vx *= air;
      vy *= air;
      vz *= air;
      px += vx * BREAK_DT;
      py += vy * BREAK_DT;
      pz += vz * BREAK_DT;
      const wl = Math.hypot(wx, wy, wz);
      if (wl > 1e-4) q = qNorm(qMul(qAxis(wx / wl, wy / wl, wz / wl, wl * BREAK_DT), q));
      // the sand: the deepest of its contact points
      let pen = 0;
      for (const pt of d.pts) {
        const r = qRot(q, pt);
        const g = baseHeight(px + r[0], pz + r[2]);
        const p = g - sink - (py + r[1]);
        if (p > pen) pen = p;
      }
      let flags = 0;
      if (pen > 0) {
        flags = 1;
        py += pen;
        const nrm = normal(px, pz);
        const vn = vx * nrm[0] + vy * nrm[1] + vz * nrm[2];
        if (vn < 0) {
          const s = -vn;
          if (s > SPLASH_V && t - lastHit > 0.35) {
            lastHit = t;
            const mm = Math.min(1600, 150 + s * 55);
            events.push({ t, x: px, z: pz, r: Math.min(4.5, 1.1 + big * 0.9), mm });
            if (ei >= 0 && fates[ei] === 'wreck' && wrecked[ei] < 0) {
              wrecked[ei] = t; // wrecked in the landing: a blast and a deep bowl
              events.push({ t, x: px, z: pz, r: 3.2, mm: 1100 });
            }
          }
          const e = s > 3 ? BOUNCE : 0;
          vx -= (1 + e) * vn * nrm[0];
          vy -= (1 + e) * vn * nrm[1];
          vz -= (1 + e) * vn * nrm[2];
          // it lands tumbling: some of the fall goes into turning
          wx += (nrm[2] * vz - nrm[1] * vy) * 0.01 * s;
          wz += (nrm[1] * vx - nrm[0] * vz) * 0.01 * s;
        }
        const f = Math.min(1, FRICTION * BREAK_DT * (big > 0.8 ? 1 : 0.6));
        const vt = vx * nrm[0] + vy * nrm[1] + vz * nrm[2];
        const tx = vx - vt * nrm[0], ty = vy - vt * nrm[1], tz = vz - vt * nrm[2];
        vx -= tx * f;
        vy -= ty * f;
        vz -= tz * f;
        const speed = Math.hypot(tx, ty, tz);
        if (speed > 3) {
          flags |= 2;
          if (t - lastSlide > 0.6 && big > 0.8) {
            lastSlide = t;
            events.push({ t, x: px, z: pz, r: 0.9 + big * 0.5, mm: 220 + speed * 14, slide: true });
          }
        }
        // turning slows on the sand and it settles to lie flat on the slope
        if (speed < 6) sink += (sinkTo - sink) * Math.min(1, 0.9 * BREAK_DT);
        const damp = Math.max(0, 1 - 5 * BREAK_DT);
        wx *= damp;
        wy *= damp;
        wz *= damp;
        const up = qRot(q, [0, 1, 0]);
        q = qSlerp(q, qNorm(qMul(qBetween(up, nrm), q)), Math.min(1, (speed > 12 ? 0.8 : 3) * BREAK_DT));
        if (speed < 0.5 && Math.hypot(wx, wy, wz) < 0.5) calm++;
        else calm = 0;
        if (calm > 12) {
          vx = vy = vz = 0;
          wx = wy = wz = 0;
        }
      }
      out.set([px, py, pz, q[0], q[1], q[2], q[3], flags], k * STATE_W);
    }
    if (ei >= 0 && fates[ei] === 'wreck' && wrecked[ei] < 0) wrecked[ei] = 1.5; // (it never hit hard: wrecked anyway)
    states.push(out);
    const o = (steps - 1) * STATE_W;
    final.push([out[o], out[o + 1], out[o + 2], out[o + 3], out[o + 4], out[o + 5], out[o + 6]].map((v, j) => Math.round(v * (j < 3 ? 100 : 10000)) / (j < 3 ? 100 : 10000)));
  }
  events.sort((a, b) => a.t - b.t);
  if (events.length > 70) events.length = 70;
  return { fates, wrecked, states, steps, events, final };
}
