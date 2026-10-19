// Where a downed jet (shared/jets.ts) crashed: the wreck of the plane stays for good (drawn by src/world/jets.ts), its right engine torn off
// and lying a little way on as a machine to take apart (kind jet_engine, level 2: the good parts), the sand dug up round them
// (server/world.ts). The server keeps the list (server/jetcrash.ts, saved in the world's database) and sends it to everyone;
// the engines are machine sites like any other (shared/crash.ts, ids "jet:<n>").
import type { CrashSite } from './crash.ts';
import { ENGINES, qRot, type Fate, type Q4 } from './jetbreak.ts';
import { JET_PIECES } from './jetpieces.ts';

export interface JetCrash {
  id: number;
  /** The flight it was (shared/jets.ts Jet.id), while that is still in the air list. */
  jet: number;
  /** About the middle of the wreck (for culling). */
  x: number;
  z: number;
  /** Where each piece (shared/jetpieces.ts, in order) lies: x, y, z and its turn as a quaternion x, y, z, w. */
  pieces: number[][];
  /** What became of each engine (shared/jetbreak.ts ENGINES: left, right): on its wing, torn off whole (a machine to take apart where it lies) or wrecked. */
  fates: Fate[];
  /** Seeds what is in the engines. */
  seed: number;
}

/** How many crash sites the world keeps; the oldest go first. */
export const JET_CRASH_MAX = 12;

let crashes = new Map<number, JetCrash>();
const sites = new Map<string, CrashSite>();
export const jetCrashListeners: (() => void)[] = [];

export function jetCrashList(): JetCrash[] {
  return [...crashes.values()];
}

/** Replace (`reset`) or add to the list: from the server's 'jetCrashes' message, or its own database. */
export function setJetCrashes(list: JetCrash[], reset = true) {
  if (reset) {
    crashes = new Map();
    sites.clear();
  }
  capCache.clear();
  for (const c of list) crashes.set(c.id, c);
  for (const f of jetCrashListeners) f();
}

/** Engine `k` (0 left, 1 right) of crash `c` as a machine site, if it tore off whole. */
function siteOf(c: JetCrash, k: number): CrashSite | null {
  if (c.fates[k] !== 'machine') return null;
  const id = `jet:${c.id}:${k}`;
  let s = sites.get(id);
  if (!s) {
    const w = c.pieces[JET_PIECES.findIndex((p) => p.id === ENGINES[k])];
    const fwd = qRot([w[3], w[4], w[5], w[6]], [0, 0, 1]);
    // (worked in place, never spent: like the lab's machines)
    sites.set(id, (s = { id, wreck: -1, index: k, level: 2, lab: true, x: w[0], z: w[2], yaw: Math.atan2(fwd[0], fwd[2]), kind: 'jet_engine', seed: (c.seed + k * 7919) >>> 0 }));
  }
  return s;
}

/** Every torn-off engine that lies whole, as a machine site. */
export function jetSites(): CrashSite[] {
  const out: CrashSite[] = [];
  for (const c of crashes.values()) for (let k = 0; k < ENGINES.length; k++) {
    const s = siteOf(c, k);
    if (s) out.push(s);
  }
  return out;
}

/** The engine site with this id ("jet:<n>:<k>"), or null. Ids may come from the network. */
export function jetSiteById(id: unknown): CrashSite | null {
  if (typeof id !== 'string') return null;
  const m = /^jet:(\d{1,9}):([01])$/.exec(id);
  const c = m ? crashes.get(Number(m[1])) : undefined;
  return c ? siteOf(c, Number(m![2])) : null;
}

// ---- what the players bump into -------------------------------------------------------------------------------------------------
// Each piece that is solid (shared/jetpieces.ts `hit`) is a few capsules about its pivot (a slab for a wing or a fin: wide in `r`, thin in `hv`),
// carried to where it lies. The rules are
// shared/crashsites.ts collideCrash's: a top within `stepUp` below the feet is ground, anything taller a wall. A tilted capsule is a horizontal
// one of the length it covers on the ground, as high as its higher end plus its radius.
const STAND_MARGIN = 0.15;
type Cap = { x: number; z: number; ax: number; az: number; half: number; r: number; top: number };
const capCache = new Map<number, Cap[]>();

function capsOf(c: JetCrash): Cap[] {
  let out = capCache.get(c.id);
  if (out) return out;
  out = [];
  JET_PIECES.forEach((d, i) => {
    const w = c.pieces[i];
    // (an engine that lies whole is a machine of its own, with its own hitboxes)
    const ei = ENGINES.indexOf(d.id);
    if (!d.hit || !w || (ei >= 0 && c.fates[ei] === 'machine')) return;
    const q: Q4 = [w[3], w[4], w[5], w[6]];
    // the piece's own up: a slab lying flat is wide and thin, on its side narrow and tall
    const uy = Math.abs(qRot(q, [0, 1, 0])[1]);
    for (const cap of d.caps) {
      const cc = qRot(q, cap.c), a = qRot(q, cap.a);
      const h = Math.hypot(a[0], a[2]);
      const wide = cap.hv + (cap.r - cap.hv) * uy, tall = cap.r - (cap.r - cap.hv) * uy;
      out!.push({
        x: w[0] + cc[0], z: w[2] + cc[2], ax: h > 1e-3 ? a[0] / h : 1, az: h > 1e-3 ? a[2] / h : 0, half: cap.half * h, r: wide,
        top: w[1] + cc[1] + cap.half * Math.abs(a[1]) + tall,
      });
    }
  });
  if (capCache.size > 64) capCache.clear();
  capCache.set(c.id, out);
  return out;
}

/** Collide a player (circle of `radius` at feet height y; prevY is last tick's) with the crashed planes: walls that push the position
 *  out and take the velocity into them away, in place; returns the highest top within `stepUp` of the feet that they stand on, or -Infinity. */
export function collideJetWrecks(p: { x: number; z: number; vx: number; vz: number }, y: number, prevY: number, radius: number, stepUp: number): number {
  if (!crashes.size) return -Infinity;
  let support = -Infinity;
  const feet = Math.max(y, prevY);
  for (const c of crashes.values()) {
    if (Math.abs(p.x - c.x) > 130 + radius || Math.abs(p.z - c.z) > 130 + radius) continue;
    for (const q of capsOf(c)) {
      const reach = q.half + q.r + radius;
      if (Math.abs(p.x - q.x) > reach || Math.abs(p.z - q.z) > reach) continue;
      let t = (p.x - q.x) * q.ax + (p.z - q.z) * q.az;
      t = t < -q.half ? -q.half : t > q.half ? q.half : t;
      const qx = q.x + q.ax * t, qz = q.z + q.az * t;
      let ex = p.x - qx, ez = p.z - qz;
      const d = Math.sqrt(ex * ex + ez * ez);
      if (feet >= q.top - stepUp) {
        if (d < q.r + STAND_MARGIN && q.top > support) support = q.top;
        continue;
      }
      const R = q.r + radius;
      if (d >= R) continue;
      if (d > 1e-9) { ex /= d; ez /= d; } else { ex = q.az; ez = -q.ax; }
      p.x = qx + ex * R;
      p.z = qz + ez * R;
      const vn = p.vx * ex + p.vz * ez;
      if (vn < 0) { p.vx -= vn * ex; p.vz -= vn * ez; }
    }
  }
  return support;
}
