// Where a downed jet (shared/jets.ts) crashed: the wreck of the plane stays for good (drawn by src/world/jets.ts), its right engine torn off
// and lying a little way on as a machine to take apart (kind jet_engine, level 2: the good parts), the sand dug up round them
// (server/world.ts). The server keeps the list (server/jetcrash.ts, saved in the world's database) and sends it to everyone;
// the engines are machine sites like any other (shared/crash.ts, ids "jet:<n>").
import type { CrashSite } from './crash.ts';

export interface JetCrash {
  id: number;
  /** The flight it was (shared/jets.ts Jet.id), while that is still in the air list. */
  jet: number;
  /** The plane's wreck pose (the origin at its centre; three.js: heading, nose up, roll). */
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  bank: number;
  /** The engine on the ground: where and which way it lies. */
  ex: number;
  ez: number;
  eyaw: number;
  /** Seeds what is in the engine. */
  seed: number;
}

/** How many crash sites the world keeps; the oldest go first. */
export const JET_CRASH_MAX = 12;

let crashes = new Map<number, JetCrash>();
const sites = new Map<number, CrashSite>();
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
  for (const c of list) crashes.set(c.id, c);
  for (const f of jetCrashListeners) f();
}

function siteOf(c: JetCrash): CrashSite {
  let s = sites.get(c.id);
  if (!s) {
    // (worked in place, never spent: like the lab's machines)
    sites.set(c.id, (s = { id: `jet:${c.id}`, wreck: -1, index: 0, level: 2, lab: true, x: c.ex, z: c.ez, yaw: c.eyaw, kind: 'jet_engine', seed: c.seed }));
  }
  return s;
}

/** Every torn-off engine, as a machine site. */
export function jetSites(): CrashSite[] {
  return jetCrashList().map(siteOf);
}

/** The engine site with this id ("jet:<n>"), or null. Ids may come from the network. */
export function jetSiteById(id: unknown): CrashSite | null {
  if (typeof id !== 'string') return null;
  const m = /^jet:(\d{1,9})$/.exec(id);
  const c = m ? crashes.get(Number(m[1])) : undefined;
  return c ? siteOf(c) : null;
}

// ---- what the players bump into -------------------------------------------------------------------------------------------------
// The wreck's pieces as upright-free capsules in the plane's own frame (x across, z along its heading; tools/blender/machines/plane.py
// wreck()): a centre, the axis, half its length, radius and height of the top above the sand. The wreck lies with its belly at
// y - WRECK_BELLY, so tops are above that. The rules are shared/crashsites.ts collideCrash's: a top within `stepUp` below the feet is ground.
const WRECK_BELLY = 1.75;
const STAND_MARGIN = 0.15;
type Piece = { x: number; z: number; ax: number; az: number; half: number; r: number; h: number };
const dir = (a: number) => [Math.sin(a), Math.cos(a)] as const;
const piece = (x: number, z: number, a: number, half: number, r: number, h: number): Piece => ({ x, z, ax: dir(a)[0], az: dir(a)[1], half, r, h });
const WRECK_PIECES: Piece[] = [
  piece(0, 2.5, 0, 4.5, 1.75, 3.4), // the front of the body, on its belly
  piece(-1.6, -5.8, 0.22, 3.5, 1.5, 3.0), // the back of the body, cracked off behind it
  piece(1.9, 12, 0.3, 3.5, 1.0, 1.8), // the nose, off and nodded into the sand
  piece(-5.4, 1.2, Math.PI / 2, 3.6, 2.6, 1.3), // the left wing, drooping
  piece(-6.0, 1.6, 0, 0.9, 0.95, 1.6), // its engine
  piece(3.0, 0.5, Math.PI / 2, 1.6, 2.6, 1.0), // the stub of the right wing
  piece(6.5, -13, 0.7, 2.8, 1.5, 2.4), // the tail, on its side with the fins
  piece(21, -10, Math.PI / 2 - 0.45, 4.2, 2.2, 0.9), // the right wing's outer part, flat on the sand
];

/** Collide a player (circle of `radius` at feet height y; prevY is last tick's) with the crashed planes: walls that push the position
 *  out and take the velocity into them away, in place; returns the highest top within `stepUp` of the feet that they stand on, or -Infinity. */
export function collideJetWrecks(p: { x: number; z: number; vx: number; vz: number }, y: number, prevY: number, radius: number, stepUp: number): number {
  if (!crashes.size) return -Infinity;
  let support = -Infinity;
  const feet = Math.max(y, prevY);
  for (const c of crashes.values()) {
    if (Math.abs(p.x - c.x) > 40 + radius || Math.abs(p.z - c.z) > 40 + radius) continue;
    const sy = Math.sin(c.yaw), cy = Math.cos(c.yaw), base = c.y - WRECK_BELLY;
    for (const q of WRECK_PIECES) {
      // (into the world: local x is (cos, -sin) of the heading, local z is (sin, cos))
      const bx = c.x + q.x * cy + q.z * sy, bz = c.z - q.x * sy + q.z * cy;
      const ax = q.ax * cy + q.az * sy, az = -q.ax * sy + q.az * cy;
      const reach = q.half + q.r + radius;
      if (Math.abs(p.x - bx) > reach || Math.abs(p.z - bz) > reach) continue;
      let t = (p.x - bx) * ax + (p.z - bz) * az;
      t = t < -q.half ? -q.half : t > q.half ? q.half : t;
      const qx = bx + ax * t, qz = bz + az * t;
      let ex = p.x - qx, ez = p.z - qz;
      const d = Math.sqrt(ex * ex + ez * ez);
      const top = base + q.h;
      if (feet >= top - stepUp) {
        if (d < q.r + STAND_MARGIN && top > support) support = top;
        continue;
      }
      const R = q.r + radius;
      if (d >= R) continue;
      if (d > 1e-9) { ex /= d; ez /= d; } else { ex = az; ez = -ax; }
      p.x = qx + ex * R;
      p.z = qz + ez * R;
      const vn = p.vx * ex + p.vz * ez;
      if (vn < 0) { p.vx -= vn * ex; p.vz -= vn * ez; }
    }
  }
  return support;
}
