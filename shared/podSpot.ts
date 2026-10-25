// Where the crashed escape pods lie (shared/pods.ts: what players arrive in), and the furrows they ploughed. Kept apart
// from shared/pods.ts so the terrain (shared/terrain.ts: the furrows are part of baseHeight), the shelters (one with a
// pump lies near them), the scrap and the wrecks can read it without importing what the pods themselves need (the
// terrain).
//
// Picked from the world seed: a few clusters of four spots round the world's origin (shared/origin.ts), 37–67 m out,
// each pod a short walk from the next, all of them come down the same way give or take; the cluster whose sand under
// the pods and along their furrows is the most even wins. Same determinism rules as shared/dunes.ts: + - * /,
// Math.sqrt, Math.abs, Math.min/max only (no trig), so client and server agree to the bit.
//
// A pod's frame: origin on the sand under its middle, +Z the way it was going (the nose: model +Z of
// public/models/pod.glb), +X across. World = origin + lx·(dz, -dx) + lz·(dx, dz). How it lies in that frame (its pose:
// tilt, roll, how deep) is one of POD_POSES (shared/podModel.ts), by its index.
import { duneHeight, WORLD_SEED } from './dunes.ts';
import { mulberry32 } from './noise.ts';
import { ORIGIN } from './origin.ts';
import { POD_POSES } from './podModel.ts';
import { LAB } from './world.ts';

/** A pod in the world: its middle on the sand, the way its nose points (unit), its pose (POD_POSES). */
export type PodSpot = { x: number; z: number; dx: number; dz: number; pose: number };

/** Where the cluster's middle is looked for, origin-local (unit directions × CLUSTER_R; no trig). */
const CLUSTER_DIRS: [number, number][] = [[0, 1], [0.7071, 0.7071], [1, 0], [0.7071, -0.7071], [0, -1], [-0.7071, -0.7071],
  [-1, 0], [-0.7071, 0.7071]];
const CLUSTER_R = 52;
/** The pods in the cluster's frame (v across the way they came, u along it), each with its turn off the cluster's heading
 *  (cosine, sine): spread out across, staggered along, so no furrow runs into another pod. */
const LAYOUT: [number, number, number, number][] = [[0, 0, 1, 0], [10.5, -5, 0.9888, 0.1494], [-11, -3, 0.9950, -0.0998],
  [-4.5, 13, 0.9801, 0.1987]];
/** How far each spot may wander from the layout (m), by the seed. */
const JITTER = 2.5;
/** What a pod and its furrow take, pod-local: its half length ahead and across, how far back its furrow runs. */
const HULL_FRONT = 3.4, HULL_SIDE = 2.2, FURROW_END = 13;

function pick(): PodSpot[] {
  const r = mulberry32(Math.imul(WORLD_SEED, 0x51ed270b) ^ 0x70d5);
  let best: PodSpot[] = [], bestScore = Infinity;
  CLUSTER_DIRS.forEach(([ox, oz], ci) => {
    // The way they came: across the line from the origin, one way or the other by the seed.
    const side = r() < 0.5 ? 1 : -1, hx = -oz * side, hz = ox * side;
    const cx = ORIGIN.x + ox * CLUSTER_R, cz = ORIGIN.z + oz * CLUSTER_R;
    let score = ci * 0.02;
    const pods: PodSpot[] = LAYOUT.map(([v, u, c, s], i) => {
      const jv = (r() - 0.5) * 2 * JITTER, ju = (r() - 0.5) * 2 * JITTER;
      const x = cx + (v + jv) * hz + (u + ju) * hx, z = cz - (v + jv) * hx + (u + ju) * hz;
      // Its heading: the cluster's, turned (c, s).
      const dx = s * hz + c * hx, dz = -s * hx + c * hz;
      const h = (lu: number, lv: number) => duneHeight(x + lv * dz + lu * dx, z - lv * dx + lu * dz, WORLD_SEED);
      let lo = Infinity, hi = -Infinity, tlo = Infinity, thi = -Infinity;
      for (let lu = -3; lu <= HULL_FRONT; lu += 1.6) for (let lv = -HULL_SIDE - 2; lv <= HULL_SIDE + 2; lv += 2) {
        const y = h(lu, lv);
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
      for (let lu = -3; lu >= -FURROW_END; lu -= 2.5) {
        const y = h(lu, 0);
        tlo = Math.min(tlo, y);
        thi = Math.max(thi, y);
      }
      score += hi - lo + 0.4 * (thi - tlo);
      return { x, z, dx, dz, pose: i % POD_POSES.length };
    });
    if (score < bestScore) {
      bestScore = score;
      best = pods;
    }
  });
  return best;
}

/** The pods in this world (none in the dev test lab). The first is the one the first bike lies by. */
export const PODS: PodSpot[] = LAB ? [] : pick();

/** The middle of the pods, where players arrive (the locator's home, the shelter with a pump near it, the trophies keep
 *  clear of it); null in the lab. */
export const ARRIVAL: { x: number; z: number } | null = PODS.length
  ? { x: PODS.reduce((a, p) => a + p.x, 0) / PODS.length, z: PODS.reduce((a, p) => a + p.z, 0) / PODS.length }
  : null;
/** How far from ARRIVAL the pods and their furrows reach, at most (m). */
export const ARRIVAL_R = 34;

/** Pod-local (lx, lz) of pod `p` to world. */
export function podToWorld(p: PodSpot, lx: number, lz: number): { x: number; z: number } {
  return { x: p.x + lx * p.dz + lz * p.dx, z: p.z - lx * p.dx + lz * p.dz };
}

/** Pod-local (lx, lz) of world (x, z). */
function toPod(p: PodSpot, x: number, z: number): [number, number] {
  const ox = x - p.x, oz = z - p.z;
  return [ox * p.dz - oz * p.dx, ox * p.dx + oz * p.dz];
}

/** Distance from pod-local (lx, lz) to the skin of pod `p`'s capsules (negative inside). */
function podDistance(p: PodSpot, lx: number, lz: number): number {
  let best = Infinity;
  for (const c of POD_POSES[p.pose].caps) {
    let t = (lx - c.x) * c.ax + (lz - c.z) * c.az;
    t = t < -c.half ? -c.half : t > c.half ? c.half : t;
    const ex = lx - c.x - c.ax * t, ez = lz - c.z - c.az * t;
    best = Math.min(best, Math.sqrt(ex * ex + ez * ez) - c.r);
  }
  return best;
}

/** World (x, z) within `m` of a pod's hull, by its real shape (the capsules it collides with): where nobody digs and
 *  nothing is put up. Nothing more round it is kept. */
export function nearPod(x: number, z: number, m = 0): boolean {
  for (const p of PODS) {
    const ox = x - p.x, oz = z - p.z, reach = 4 + m;
    if (ox > reach || ox < -reach || oz > reach || oz < -reach) continue;
    const [lx, lz] = toPod(p, x, z);
    if (podDistance(p, lx, lz) < m) return true;
  }
  return false;
}

/** World (x, z) on a pod's ground (+ margin): by its hull or along the furrow behind it. No scrap piles or wrecks
 *  there (the layout keeps off it; players may build on it). */
export function onPodGround(x: number, z: number, m = 0): boolean {
  if (!ARRIVAL) return false;
  const ax = x - ARRIVAL.x, az = z - ARRIVAL.z, far = ARRIVAL_R + m;
  if (ax > far || ax < -far || az > far || az < -far) return false;
  for (const p of PODS) {
    const [v, u] = toPod(p, x, z);
    if (u > -FURROW_END - m && u < HULL_FRONT + 1.5 + m && Math.abs(v) < HULL_SIDE + 1.5 + m) return true;
  }
  return false;
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** The furrow behind each pod: a shallow trench back along the way it came, deepest at its tail, with low banks of thrown
 *  sand each side; and the sand it ploughed up heaped round its nose. Its flanks are left flat (players stand there). */
const TRENCH = { from: -1.6, depth: 0.45, w0: 1.5, w1: 0.9, bank: 1.6, bankH: 0.32 };
const MOUND = { at: 2.3, len: 1.9, side: 2.4, h: 0.75 };

/** Terrain height `h` at world (x, z) with the pods' furrows and the heaps at their noses (shared/terrain.ts baseHeight). */
export function withPodFurrows(x: number, z: number, h: number): number {
  if (!ARRIVAL) return h;
  const ax = x - ARRIVAL.x, az = z - ARRIVAL.z;
  if (ax > ARRIVAL_R || ax < -ARRIVAL_R || az > ARRIVAL_R || az < -ARRIVAL_R) return h;
  for (const p of PODS) {
    const ox = x - p.x, oz = z - p.z;
    if (ox > 16 || ox < -16 || oz > 16 || oz < -16) continue;
    const u = ox * p.dx + oz * p.dz, v = Math.abs(ox * p.dz - oz * p.dx);
    if (u < TRENCH.from && u > -FURROW_END) {
      // 0 at the tail, 1 where it fades out; the trench narrows and shallows back along it, and eases in at the tail.
      const t = (TRENCH.from - u) / (FURROW_END + TRENCH.from);
      const d = TRENCH.depth * (1 - smooth((t - 0.5) / 0.5)) * smooth(t / 0.08), w = TRENCH.w0 + (TRENCH.w1 - TRENCH.w0) * t;
      if (v < w) {
        const q = v / w;
        return h - d * (1 - q * q);
      }
      if (v < w + TRENCH.bank) {
        const q = (v - w) / TRENCH.bank, b = 4 * q * (1 - q);
        return h + (d / TRENCH.depth) * TRENCH.bankH * b * b;
      }
      continue;
    }
    const du = (u - MOUND.at) / MOUND.len;
    if (du > -1 && du < 1 && v < MOUND.side) {
      const a = 1 - du * du, q = v / MOUND.side, c = 1 - q * q;
      return h + MOUND.h * a * a * c * c;
    }
  }
  return h;
}

/** Where the first broken motorcycle lies, pod-local to the first pod (shared/lootRoll.ts homeBikeSpot): the first of
 *  these that's clear, on its side ahead of the pod, in view from where you stand by its hatch. */
export const POD_BIKE_SPOTS: [number, number][] = [[-3.5, 5.5], [4, 5], [-4.5, -4]];
