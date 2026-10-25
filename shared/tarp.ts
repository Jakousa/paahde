// The tarp (shared/placed.ts TARP): shade you build yourself, a square of canvas pitched as a sail on four poles, each pole
// held up by two guy lines staked out in the sand. One corner high, one low, the other two between, so the canvas twists
// a little and sheds the wind. Put up with the wrench like the other buildings (shared/tables.ts BUILD_TABLE), anywhere
// on the sand; R turns it a quarter at a time (4 turns: which way the high corner points).
//
// The rig here is what both sides need: the poles (their collision is shared/placed.ts PLACEABLES.tarp's boxes), and the
// canvas's corners, which shared/shade.ts tests the sun's rays against (two triangles), so standing under it cools you
// like any shade (server/water.ts). Every pole stands on its own patch of sand (heightAt) and holds its corner a fixed
// height over it, so the canvas follows the ground. The client draws it (src/world/tarps.ts): the canvas subdivided,
// sagging between the corners, its edges cut in like a real sail's, billowing in the wind on the GPU.
//
// Deterministic: + - * / and heightAt only.
import { heightAt } from './terrain.ts';

/** Half the canvas's side (m): 5.8 m square, room for three or four under it. */
export const TARP_HALF = 2.9;
/** How high each pole holds its corner over the sand under it (m), round the square from (−, −): the high corner, two
 *  between, the low one opposite the high. */
const POLE_H = [3.3, 2.6, 2.15, 2.6];
/** Corners in the tarp's own frame (turn 0), in the same order. */
const CORNER: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
/** The canvas ties on this far under the pole's top (m). */
const TIE = 0.12;
/** Guy lines: two per pole, splayed this far (rad) either side of the corner's diagonal, staked this far out (m). */
const GUY_SPLAY = 0.5, GUY_OUT = 1.7;
/** How far the canvas sags in its middle (m), and how far its edges are cut in at their middle (share of the half). */
export const TARP_SAG = 0.3, TARP_CUT = 0.07;

export type Vec = { x: number; y: number; z: number };
/** A tarp as it stands: poles (foot and top), the canvas's corners (tied under the tops), guy lines (top to stake). */
export type TarpRig = { poles: { foot: Vec; top: Vec }[]; corners: Vec[]; guys: { from: Vec; stake: Vec }[] };

/** Turn `rot` (quarter turns) of a point in the tarp's frame, about its centre (x, z): world (x, z). */
function turn(rot: number, a: number, b: number): [number, number] {
  switch (rot & 3) {
    case 1: return [b, -a];
    case 2: return [-a, -b];
    case 3: return [-b, a];
    default: return [a, b];
  }
}

/** The rig of a tarp at (x, z) turned `rot`, in world coordinates. `ground`: the sand's height (flat for an icon). */
export function tarpRig(x: number, z: number, rot: number, ground: (x: number, z: number) => number = heightAt): TarpRig {
  const poles: TarpRig['poles'] = [], corners: Vec[] = [], guys: TarpRig['guys'] = [];
  const c = Math.SQRT1_2;
  const cs = 1 - GUY_SPLAY * GUY_SPLAY / 2, sn = GUY_SPLAY; // cos, sin of the splay (small angle; deterministic)
  for (let i = 0; i < 4; i++) {
    const [a, b] = CORNER[i];
    const [px, pz] = turn(rot, a * TARP_HALF, b * TARP_HALF);
    const fx = x + px, fz = z + pz, fy = ground(fx, fz);
    const top = { x: fx, y: fy + POLE_H[i], z: fz };
    poles.push({ foot: { x: fx, y: fy - 0.2, z: fz }, top });
    corners.push({ x: fx, y: top.y - TIE, z: fz });
    // Out along the diagonal, either side of it.
    const [dx, dz] = turn(rot, a * c, b * c);
    for (const s of [-1, 1]) {
      const ux = dx * cs - dz * sn * s, uz = dz * cs + dx * sn * s;
      const sx = fx + ux * GUY_OUT, sz = fz + uz * GUY_OUT;
      guys.push({ from: { x: fx, y: top.y - 0.05, z: fz }, stake: { x: sx, y: ground(sx, sz), z: sz } });
    }
  }
  return { poles, corners, guys };
}

/** A point of the canvas at (u, v) ∈ [0, 1]² (u from corner 0 to 1, v from 0 to 3), without the wind: the corners
 *  blended, the edges cut in, sagging in the middle. */
export function canvasAt(r: TarpRig, u: number, v: number, out: Vec = { x: 0, y: 0, z: 0 }): Vec {
  // Cut the edges in: in [−1, 1]², each coordinate pulled in where the other is mid-edge.
  const a = 2 * u - 1, b = 2 * v - 1;
  const a2 = a * (1 - TARP_CUT * (1 - b * b)), b2 = b * (1 - TARP_CUT * (1 - a * a));
  const s = (a2 + 1) / 2, t = (b2 + 1) / 2;
  const [c0, c1, c2, c3] = r.corners;
  const w0 = (1 - s) * (1 - t), w1 = s * (1 - t), w2 = s * t, w3 = (1 - s) * t;
  out.x = c0.x * w0 + c1.x * w1 + c2.x * w2 + c3.x * w3;
  out.z = c0.z * w0 + c1.z * w1 + c2.z * w2 + c3.z * w3;
  out.y = c0.y * w0 + c1.y * w1 + c2.y * w2 + c3.y * w3 - TARP_SAG * 16 * u * (1 - u) * v * (1 - v);
  return out;
}
