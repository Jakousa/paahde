// The tarp (shared/placed.ts TARP): shade you build yourself, a square of canvas pitched as a pyramid ("mid") over one
// tall centre pole, its four corners staked down close to the sand on short lines, so its sides are steep walls that
// keep out a low morning or evening sun too. One side's edge is lifted in the middle on a short pole and a guy line: the
// doorway. Put up with the wrench like the other buildings (shared/tables.ts BUILD_TABLE), anywhere on the sand; R turns
// it a quarter at a time (4 turns: which way the doorway faces, best away from the sun).
//
// The rig here is what both sides need: the poles and the closed edges (their collision is shared/placed.ts
// PLACEABLES.tarp's boxes), and the canvas, which shared/shade.ts tests the sun's rays against (a fan of triangles round
// the peak), so standing inside cools you like any shade (server/water.ts). The peak, every corner and the doorway's
// point each stand a fixed height over their own sand (heightAt), so the canvas follows the ground. The client draws it
// (src/world/tarps.ts): the canvas subdivided, sagging between its ridges, billowing in the wind on the GPU.
//
// The canvas over its square, (a, b) ∈ [−1, 1]² from the centre (b = +1 the doorway's side): along each ray from the
// peak to the edge it runs straight down to the edge's height there (a cone over the square), so each side between two
// corners is one flat face, and the doorway's side two, folded at the ridge up to its pole.
//
// Deterministic: + - * / and heightAt only.
import { heightAt } from './terrain.ts';

/** Half the canvas's side (m): a 6.4 m square, room for three or four to stand round the pole. */
export const TARP_HALF = 3.2;
/** The peak (top of the centre pole), the corners, and the doorway's point, over their sand (m). */
export const TARP_PEAK = 3.8;
const CORNER_H = 0.4, DOOR_H = 2.3;
/** Corners in the tarp's own frame (turn 0), round the square from (−, −); the doorway is mid-way along +b (+Z). */
const CORNER: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
/** Corner lines: staked this far (m) out along the diagonal. The doorway's guy line: this far out in front. */
const CORNER_OUT = 0.55, DOOR_OUT = 1.6;
/** How far the faces sag between their ridges (m, at the middle of a face). */
export const TARP_SAG = 0.14;

export type Vec = { x: number; y: number; z: number };
/** A tarp as it stands: its centre pole and door pole (foot and top), the canvas's corners (0..3), its peak and its
 *  doorway's point, and the lines from a point on the canvas or a pole to a stake. */
export type TarpRig = { poles: { foot: Vec; top: Vec }[]; corners: Vec[]; peak: Vec; door: Vec; guys: { from: Vec; stake: Vec }[];
  /** Turned frame: world (x, z) = centre + a·(ax, az) + b·(bx, bz), in metres. */
  cx: number; cz: number; ax: number; az: number; bx: number; bz: number };

/** Turn `rot` (quarter turns) of a point in the tarp's frame, about its centre: world offset. Matches three.js's
 *  rotation.y = rot·π/2 and shared/placed.ts worldBoxes. */
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
  const [ax, az] = turn(rot, TARP_HALF, 0), [bx, bz] = turn(rot, 0, TARP_HALF);
  const at = (a: number, b: number, h: number): Vec => {
    const px = x + a * ax + b * bx, pz = z + a * az + b * bz;
    return { x: px, y: ground(px, pz) + h, z: pz };
  };
  const peak = at(0, 0, TARP_PEAK), door = at(0, 1, DOOR_H);
  const corners = CORNER.map(([a, b]) => at(a, b, CORNER_H));
  const foot = (v: Vec, h: number): Vec => ({ x: v.x, y: v.y - h - 0.2, z: v.z });
  const poles = [{ foot: foot(peak, TARP_PEAK), top: peak }, { foot: foot(door, DOOR_H), top: door }];
  const k = 1 + CORNER_OUT / (TARP_HALF * Math.SQRT2);
  const guys = [
    ...CORNER.map(([a, b], i) => ({ from: corners[i], stake: at(a * k, b * k, 0) })),
    { from: { ...door, y: door.y - 0.05 }, stake: at(0, 1 + DOOR_OUT / TARP_HALF, 0) },
  ];
  return { poles, corners, peak, door, guys, cx: x, cz: z, ax, az, bx, bz };
}

/** The canvas's edge points in order round the square, for a fan from the peak: each corner, then the middle of the edge
 *  after it (the doorway's point on the +b edge, between corners 2 and 3). */
export function tarpRim(r: TarpRig): Vec[] {
  const mid = (p: Vec, q: Vec): Vec => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, z: (p.z + q.z) / 2 });
  const [c0, c1, c2, c3] = r.corners;
  return [c0, mid(c0, c1), c1, mid(c1, c2), c2, r.door, c3, mid(c3, c0)];
}

/** A point of the canvas at (u, v) ∈ [0, 1]² (u along a, v along b), without the wind. */
export function canvasAt(r: TarpRig, u: number, v: number, out: Vec = { x: 0, y: 0, z: 0 }): Vec {
  const a = 2 * u - 1, b = 2 * v - 1;
  const ra = a < 0 ? -a : a, rb = b < 0 ? -b : b;
  const s = ra > rb ? ra : rb; // 0 at the peak, 1 on the edge
  out.x = r.cx + a * r.ax + b * r.bx;
  out.z = r.cz + a * r.az + b * r.bz;
  if (s < 1e-9) {
    out.y = r.peak.y;
    return out;
  }
  // Where the ray from the peak meets the edge: on which side, and t ∈ [−1, 1] along it.
  const [c0, c1, c2, c3] = r.corners;
  let p: Vec, q: Vec, t: number, door = false;
  if (ra >= rb) {
    t = b / s;
    [p, q] = a > 0 ? [c1, c2] : [c0, c3];
  } else {
    t = a / s;
    [p, q] = b > 0 ? [c3, c2] : [c0, c1];
    door = b > 0;
  }
  const w = (t + 1) / 2;
  let edge = p.y + (q.y - p.y) * w;
  const tt = t < 0 ? -t : t;
  if (door) edge += (r.door.y - edge) * (1 - tt);
  // Sag: none on the ridges (to the corners, and to the doorway's point), most mid-face and mid-way down.
  let g = 1 - t * t;
  if (door) g *= 4 * tt < 1 ? 4 * tt : 1;
  out.y = r.peak.y + (edge - r.peak.y) * s - TARP_SAG * 4 * s * (1 - s) * g;
  return out;
}
