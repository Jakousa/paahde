// Sand vortices: colossal whirlwinds roaming the desert, as far as it goes. The desert is cut into CELL-m squares, and
// the world's seed decides for each whether a vortex roams it (one in CELL_ODDS) and how: it circles a spot inside its
// square for ever, its distance out swelling and shrinking on slow waves, sweeping along fastest where it's heading
// downwind (the dunes' WIND) and labouring where it's heading into it, and never leaves the square. No count, no
// list: the server and every client work out the ones near whatever they're looking at (vorticesNear) from the seed and
// the wall clock (server time + `zero`, sent with the storms), so they agree, and a restart finds them where they were.
// None roams a square that would bring it within START_CLEAR of the world's origin (shared/origin.ts) or the crashed pods.
//
// The debug menu can also summon a short-lived one near you: that one drifts downwind at DRIFT m/s, swinging MEANDER m
// to each side, kept KEEP_OUT from the origin and the pods (sliding round the edge, dying down if it heads deep in).
//
// Gameplay: within PULL_R it drags you in and round (vortexPull, shared/sim.ts), too hard to walk out of past the
// middle of that; a bike gets you out. Inside CORE_R you're dead, thrown high into the air (server/world.ts). Drones
// are dragged in and torn apart (server/drones.ts). Bunkers and shelters keep it out.
import { ORIGIN } from './origin.ts';
import { WIND } from './dunes.ts';
import { indoors } from './shelters.ts';
import { ARRIVAL } from './podSpot.ts';
import { mulberry32 } from './noise.ts';
import { CALM as LAB_OR_BENCH, WORLD_SEED } from './world.ts';

export type Vortex = {
  id: number;
  /** Where its path starts (m), at `start`. */
  x: number;
  z: number;
  /** Server-clock ms: it spins up from `start` (over RAMP_MS) and dies down by `end`. */
  start: number;
  end: number;
  /** Phase of its meander, 0..2π. */
  seed: number;
  /** A roamer: circles (x, z) for ever instead (`end` is never): at `r` m (± a quarter), one lap per `lap` s, `dir` 1
   *  anticlockwise seen from above, −1 clockwise. */
  roam?: { r: number; lap: number; dir: number };
};

/** The squares (m) the desert is cut into, and the odds that a vortex roams one (semi-rare: one per ~22 km²); the radius
 *  (m) one circles at; its speed round it (m/s); how far (m) they keep from the origin and the pods at the least; how
 *  much faster (and slower) one goes heading downwind (and into the wind), as a fraction. */
const CELL = 3000;
const CELL_ODDS = 0.4;
const ORBIT_R: [number, number] = [400, 1000];
const SPEED: [number, number] = [4, 7];
const START_CLEAR = 900;
const WIND_SWAY = 0.5;
/** The never of a roamer's `end` (ms). */
export const NEVER = Number.MAX_SAFE_INTEGER;
const WIND_ANGLE = Math.atan2(WIND.z, WIND.x);

/** Ids of the roamers: past any summoned one's. */
const ROAMER_ID = 1 << 24;
/** The roamer of each square looked at so far (null: none roams it). Ids: by square, so the same everywhere. */
const cells = new Map<number, Vortex | null>();
let cellsZero = NaN;
const cellKey = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

function roamer(i: number, j: number, zero: number): Vortex | null {
  const key = cellKey(i, j);
  const had = cells.get(key);
  if (had !== undefined) return had;
  const rand = mulberry32((WORLD_SEED * 73856093) ^ (i * 19349663) ^ (j * 83492791) ^ 0x5a4d7e31);
  let v: Vortex | null = null;
  if (rand() < CELL_ODDS) {
    const r = ORBIT_R[0] + rand() * (ORBIT_R[1] - ORBIT_R[0]);
    // Its circle (swelling to 1.25 r) stays inside the square.
    const m = r * 1.25 + 60;
    const x = i * CELL + m + rand() * (CELL - 2 * m), z = j * CELL + m + rand() * (CELL - 2 * m);
    const near = AVOID.some((a) => Math.hypot(x - a.x, z - a.z) < START_CLEAR + m);
    const speed = SPEED[0] + rand() * (SPEED[1] - SPEED[0]);
    if (!near) v = {
      id: ROAMER_ID + (key % 16_000_000), x: Math.round(x), z: Math.round(z), start: Math.round(zero), end: NEVER,
      seed: Math.round(rand() * 6283) / 1000,
      roam: { r: Math.round(r), lap: Math.round((Math.PI * 2 * r) / speed), dir: rand() < 0.5 ? 1 : -1 },
    };
  }
  cells.set(key, v);
  return v;
}

/** The roaming vortices whose squares come within `reach` m of (x, z), and `extra` (summoned ones), into `out`.
 *  `zero`: the wall clock's zero on the server clock (the server's −performance.timeOrigin, sent with the storms). */
export function vorticesNear(x: number, z: number, reach: number, zero: number, extra: readonly Vortex[] = [], out: Vortex[] = []): Vortex[] {
  out.length = 0;
  if (!Number.isFinite(zero) || LAB_OR_BENCH) {
    out.push(...extra);
    return out;
  }
  if (zero !== cellsZero) {
    cells.clear();
    cellsZero = zero;
  }
  const i0 = Math.floor((x - reach) / CELL), i1 = Math.floor((x + reach) / CELL);
  const j0 = Math.floor((z - reach) / CELL), j1 = Math.floor((z + reach) / CELL);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const v = roamer(i, j, zero);
    if (v) out.push(v);
  }
  out.push(...extra);
  return out;
}

/** Downwind drift (m/s), and how far (m) it swings to each side of that line. */
export const DRIFT = 5;
export const MEANDER = 260;
/** Spinning up and dying down (ms), inside its life. */
export const RAMP_MS = 15_000;
/** Pulled in from this far (m); dead inside CORE_R (m). PULL_MAX: the pull (m/s) at the core's edge. */
export const PULL_R = 450;
export const CORE_R = 55;
export const PULL_MAX = 20;
/** How much of the pull goes round it rather than in. */
const SWIRL = 0.75;
/** Its centre keeps this far (m) from the origin and the crashed pods. */
export const KEEP_OUT = PULL_R + 150;
const AVOID = ARRIVAL ? [ORIGIN, ARRIVAL] : [ORIGIN];

const PX = -WIND.z, PZ = WIND.x; // across the wind

/** Where its wandering would take it at server time `t` (ms), before it's kept off the origin and the pods. */
function wander<T extends { x: number; z: number }>(v: Vortex, t: number, out: T): T {
  const s = (t - v.start) / 1000;
  const o = v.roam;
  if (o) {
    // Round its territory: the angle runs faster where the way round points downwind (anticlockwise at angle a the
    // heading is (cos a, −sin a); clockwise, the opposite).
    const p = (Math.PI * 2 * s) / o.lap + v.seed;
    const a = o.dir * (p + WIND_SWAY * Math.sin(p + o.dir * WIND_ANGLE + (o.dir < 0 ? Math.PI : 0)));
    const r = o.r * (1 + 0.2 * Math.sin(s * 0.0017 + v.seed * 1.9) + 0.05 * Math.sin(s * 0.011 + v.seed * 3.1));
    out.x = v.x + Math.sin(a) * r;
    out.z = v.z + Math.cos(a) * r;
    return out;
  }
  const along = DRIFT * s + 60 * Math.sin(s * 0.033 + v.seed * 1.7);
  const side = MEANDER * (0.7 * Math.sin(s * 0.021 + v.seed) + 0.3 * Math.sin(s * 0.047 + v.seed * 2.3));
  out.x = v.x + WIND.x * along + PX * side;
  out.z = v.z + WIND.z * along + PZ * side;
  return out;
}

/** The vortex's centre at server time `t` (ms), written into `out`: its wandering, pushed out to KEEP_OUT from the origin
 *  and the pods when it strays nearer (sliding round the edge; one heading deep in has died down, vortexEnvelope). */
export function vortexCentre<T extends { x: number; z: number }>(v: Vortex, t: number, out: T): T {
  wander(v, t, out);
  let x = out.x, z = out.z;
  for (const a of AVOID) {
    const dx = x - a.x, dz = z - a.z, d = Math.hypot(dx, dz);
    if (d >= KEEP_OUT) continue;
    // Pushed out to the edge of the keep-out (straight upwind of it when dead on top).
    const k = d > 1e-3 ? KEEP_OUT / d : 0;
    x = d > 1e-3 ? a.x + dx * k : a.x - WIND.x * KEEP_OUT;
    z = d > 1e-3 ? a.z + dz * k : a.z - WIND.z * KEEP_OUT;
  }
  out.x = x;
  out.z = z;
  return out;
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

const c = { x: 0, z: 0 };

/** Its strength at server time `t`, 0..1: spinning up, dying down, and breaking up where its wandering would take it
 *  deep into the keep-out round the origin or the pods (so it never sweeps round the edge fast; it re-forms past it). */
export function vortexEnvelope(v: Vortex, t: number): number {
  let e = smooth((t - v.start) / RAMP_MS) * smooth((v.end - t) / RAMP_MS);
  if (e <= 0) return 0;
  wander(v, t, c);
  for (const a of AVOID) e *= smooth((Math.hypot(c.x - a.x, c.z - a.z) - KEEP_OUT * 0.35) / (KEEP_OUT * 0.4));
  return e;
}

/** The drag (m/s, xz) on someone standing at (x, y, z) (feet) at server time `t`, into `out`: towards each vortex
 *  near, and round it, stronger the closer. None indoors. Fed to step() alongside the storm (shared/sim.ts). */
export function vortexPull<T extends { x: number; z: number }>(vs: readonly Vortex[], x: number, y: number, z: number, t: number, out: T): T {
  out.x = 0;
  out.z = 0;
  if (!vs.length || indoors(x, y + 1, z)) return out;
  for (const v of vs) {
    const e = vortexEnvelope(v, t);
    if (e <= 0) continue;
    vortexCentre(v, t, c);
    const dx = c.x - x, dz = c.z - z, d = Math.hypot(dx, dz);
    if (d >= PULL_R || d < 1e-3) continue;
    const k = e * PULL_MAX * Math.pow(1 - d / PULL_R, 1.3);
    // Round it the way its dust turns (src/post.ts).
    out.x += (dx / d) * k - (dz / d) * k * SWIRL;
    out.z += (dz / d) * k + (dx / d) * k * SWIRL;
  }
  out.x = Math.round(out.x * 1000) / 1000; // (sent along with each input's replay: keep it exact)
  out.z = Math.round(out.z * 1000) / 1000;
  return out;
}

/** How close (0..1, 1 at its core's edge) the nearest vortex is to (x, z): its roar and grit (src/vortex.ts). */
export function vortexNear(vs: readonly Vortex[], x: number, z: number, t: number): number {
  let k = 0;
  for (const v of vs) {
    const e = vortexEnvelope(v, t);
    if (e <= 0) continue;
    vortexCentre(v, t, c);
    k = Math.max(k, e * smooth(1 - (Math.hypot(c.x - x, c.z - z) - CORE_R) / (PULL_R * 1.5)));
  }
  return k;
}

/** The vortex whose core (x, y, z) (feet) is in at time `t`, or null. Not indoors. */
export function inVortexCore(vs: readonly Vortex[], x: number, y: number, z: number, t: number): Vortex | null {
  if (!vs.length || indoors(x, y + 1, z)) return null;
  for (const v of vs) {
    if (vortexEnvelope(v, t) < 0.5) continue;
    vortexCentre(v, t, c);
    if (Math.hypot(c.x - x, c.z - z) < CORE_R) return v;
  }
  return null;
}
