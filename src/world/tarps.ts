// Tarps (shared/tarp.ts, shared/placed.ts TARP): sand-coloured canvas pitched as a pyramid on a tall dark pole, its
// corners staked low on short lines, the doorway's edge up on a short pole with a guy line. Built here in code from the rig the server's shade uses, so what you see shading you is what
// cools you. Each tarp is three meshes: the canvas, the poles and stakes (vertex colours), the guy lines (no shadow:
// they're thinner than a shadow texel). Their materials are shared by every tarp; the geometry is each one's own
// (each stands on its own sand), a few hundred triangles.
//
// The canvas moves in the wind on the GPU: a 12×12 grid (split along its ridges) pushed in and out along its normal in
// the vertex shader by waves running downwind (env.ts windDir), pinned at the peak, the corners and the doorway's point,
// with a slow billow that breathes with the gusts. How hard is `TARP_WIND`, the shared wind (shared/power.ts windSpeed, the windmills' wind: gusts, the day,
// storms), set every frame by src/world/placed.ts. The shading normal follows the waves (the surface's tangents, from the
// geometry, bent by the waves' slope), so the folds catch the low sun.
import * as THREE from 'three/webgpu';
import { attribute, color, cos, dot, faceDirection, Fn, float, max, min, mix, normalLocal, positionLocal, sin, smoothstep, uniform, uv, vec2, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { canvasAt, tarpRig, type TarpRig, type Vec } from '../../shared/tarp.ts';
import { nightLevel, sunColor, time, windDir } from './env.ts';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;
/** Grid cells along each side of the canvas. */
const N = 12;
/** The wind on the tarps (m/s), shared/power.ts windSpeed. */
export const TARP_WIND = uniform(4);

/** Desert tan, its sun-bleached top and dusty hem; dark pipe poles; hemp-brown rope; weathered wooden stakes. */
const CANVAS = 0xae7f4f, HEM = 0x6e5034, POLE = 0x2e2824, CAP = 0x46403a, ROPE = 0x6b5843, STAKE = 0x4a3826;

let canvasMat: THREE.MeshStandardNodeMaterial | null = null;
let rigMat: THREE.MeshStandardNodeMaterial | null = null;
let ropeMat: THREE.MeshStandardNodeMaterial | null = null;

/** The canvas material: the waves in the vertex shader, the hem darker, the underside lit a little through the cloth. */
function canvasMaterial() {
  if (canvasMat) return canvasMat;
  const m = new THREE.MeshStandardNodeMaterial({ color: CANVAS, roughness: 1, metalness: 0, side: THREE.DoubleSide });
  const seed = attribute('seed', 'float') as F;
  const tu = attribute('tanU', 'vec3') as V3, tv = attribute('tanV', 'vec3') as V3;
  const nrm = attribute('normal', 'vec3') as V3;
  // How free a point is: 0 where it's tied (a corner, the peak, the doorway's point), ~1 mid-face.
  const free = Fn(([q]: [V2]) => {
    const e = min(q, vec2(1).sub(q));
    const pin = min(min(e.length(), q.sub(0.5).length()), q.sub(vec2(0.5, 1)).length());
    return smoothstep(0, 0.3, pin);
  });
  // The lift (m) at canvas point q (uv) and local position p: two waves running downwind and a slow billow.
  const lift = Fn(([q, p]: [V2, V3]) => {
    const v = TARP_WIND;
    const amp = min(float(0.015).add(v.mul(0.008)), 0.25);
    const speed = float(1.4).add(v.mul(0.16));
    const along = dot(p.xz, windDir);
    const across = dot(p.xz, vec2(windDir.y, windDir.x.negate()));
    const t = time.mul(speed);
    const w1 = sin(along.mul(1.3).sub(t.mul(2.1)).add(seed));
    const w2 = sin(along.mul(2.6).add(across.mul(1.1)).sub(t.mul(3.3)).add(seed.mul(1.7))).mul(0.45);
    const w3 = cos(across.mul(0.9).add(t.mul(0.6)).add(seed.mul(0.6))).mul(0.3);
    // The billow: the walls breathe in and out with the gusts.
    const bulge = min(v.mul(0.008), 0.15).mul(sin(time.mul(0.7).add(seed)));
    return free(q).mul(amp.mul(w1.add(w2).add(w3)).add(bulge));
  });
  m.positionNode = Fn(() => {
    const q = uv(), p = positionLocal;
    const e = 1 / N;
    const h = lift(q, p);
    // Out along the normal; the slope along each grid direction from a step there (the tangents are the step's length on
    // the canvas) bends the normal.
    const hu = lift(q.add(vec2(e, 0)), p.add(tu.mul(e))).sub(h);
    const hv = lift(q.add(vec2(0, e)), p.add(tv.mul(e))).sub(h);
    const du = tu.mul(e).add(nrm.mul(hu)), dv = tv.mul(e).add(nrm.mul(hv));
    normalLocal.assign(dv.cross(du).normalize());
    return p.add(nrm.mul(h));
  })();
  // The hem: a darker band along the edges; a little sun through the cloth underneath, by day.
  const q = uv();
  const edge = min(min(q.x, q.y), min(q.x.oneMinus(), q.y.oneMinus()));
  m.colorNode = mix(color(HEM), color(CANVAS), smoothstep(0.012, 0.03, edge));
  // Underneath, the sun glows through the cloth (stronger by day, none at night); on top a touch of it.
  const under = faceDirection.mul(-0.5).add(0.5);
  m.emissiveNode = (sunColor as unknown as V3).mul(color(CANVAS) as unknown as V3).mul(under.mul(0.1).add(0.015)).mul(max(float(1).sub(nightLevel), 0));
  canvasMat = m;
  return m;
}

function rigMaterial() {
  return (rigMat ??= new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.3 }));
}
function ropeMaterial() {
  return (ropeMat ??= new THREE.MeshStandardNodeMaterial({ color: ROPE, roughness: 1, metalness: 0 }));
}

/** The canvas grid, relative to `o`: positions, uvs, the tangents along u and v (for the wind's normal), a seed. */
function canvasGeometry(r: TarpRig, o: Vec, seed: number): THREE.BufferGeometry {
  const n = N + 1;
  const pos = new Float32Array(n * n * 3), uvs = new Float32Array(n * n * 2), tu = new Float32Array(n * n * 3), tv = new Float32Array(n * n * 3);
  const a: Vec = { x: 0, y: 0, z: 0 }, b: Vec = { x: 0, y: 0, z: 0 }, c: Vec = { x: 0, y: 0, z: 0 };
  const d = 1e-3;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / N, v = j / N, k = j * n + i;
      canvasAt(r, u, v, a);
      pos.set([a.x - o.x, a.y - o.y, a.z - o.z], k * 3);
      uvs.set([u, v], k * 2);
      // d(position)/du and /dv, per unit of u and v.
      canvasAt(r, Math.min(1, u + d), v, b);
      canvasAt(r, Math.max(0, u - d), v, c);
      const su = Math.min(1, u + d) - Math.max(0, u - d);
      tu.set([(b.x - c.x) / su, (b.y - c.y) / su, (b.z - c.z) / su], k * 3);
      canvasAt(r, u, Math.min(1, v + d), b);
      canvasAt(r, u, Math.max(0, v - d), c);
      const sv = Math.min(1, v + d) - Math.max(0, v - d);
      tv.set([(b.x - c.x) / sv, (b.y - c.y) / sv, (b.z - c.z) / sv], k * 3);
    }
  }
  // Wound so the front face looks up and out (v before u). Each cell is split along the ridge through it (the diagonals
  // from the peak to the corners), so the faces stay flat and the ridges sharp.
  const idx: number[] = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * n + i;
      if (i < N / 2 === j < N / 2) idx.push(k, k + n, k + n + 1, k, k + n + 1, k + 1);
      else idx.push(k, k + n, k + 1, k + 1, k + n, k + n + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('tanU', new THREE.BufferAttribute(tu, 3));
  g.setAttribute('tanV', new THREE.BufferAttribute(tv, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(new Float32Array(n * n).fill(seed), 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  // The waves lift it: room for them in the bounds (culling, shadows).
  g.computeBoundingSphere();
  g.boundingSphere!.radius += 0.3;
  return g;
}

/** A cylinder of radius r from a to b (relative to o), `sides` round, in colour `hex` (vertex colours) or none. */
function rod(a: Vec, b: Vec, o: Vec, r0: number, r1: number, sides: number, hex?: number): THREE.BufferGeometry {
  const dir = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, sides, 1, true);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  g.translate((a.x + b.x) / 2 - o.x, (a.y + b.y) / 2 - o.y, (a.z + b.z) / 2 - o.z);
  return colour(g, hex);
}

function colour(g: THREE.BufferGeometry, hex?: number): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  if (hex === undefined) return out;
  const c = new THREE.Color(hex), n = out.getAttribute('position').count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

/** A tarp at (x, y, z) turned `rot` (y: what shared/placed.ts placedY says it stands on), as a group placed there.
 *  `id` varies its waves; `flat` stands it on level ground at y (the icon). */
export function tarpModel(x: number, y: number, z: number, rot: number, id = 0, flat = false): THREE.Group {
  const o = { x, y, z };
  const r = flat ? tarpRig(x, z, rot, () => y) : tarpRig(x, z, rot);
  const canvas = new THREE.Mesh(canvasGeometry(r, o, (id * 2.399) % (2 * Math.PI)), canvasMaterial());
  canvas.name = 'tarp_canvas';
  canvas.castShadow = canvas.receiveShadow = true;
  const rig: THREE.BufferGeometry[] = [], ropes: THREE.BufferGeometry[] = [];
  for (const p of r.poles) {
    rig.push(rod(p.foot, p.top, o, 0.055, 0.04, 7, POLE));
    rig.push(rod({ ...p.top, y: p.top.y - 0.03 }, { ...p.top, y: p.top.y + 0.04 }, o, 0.055, 0.055, 7, CAP));
  }
  for (const gy of r.guys) {
    // The line, and a stake leaning back from it, driven into the sand.
    ropes.push(rod(gy.from, gy.stake, o, 0.011, 0.011, 3));
    const dx = gy.stake.x - gy.from.x, dz = gy.stake.z - gy.from.z, l = Math.hypot(dx, dz) || 1;
    const top = { x: gy.stake.x + (dx / l) * 0.08, y: gy.stake.y + 0.22, z: gy.stake.z + (dz / l) * 0.08 };
    rig.push(rod({ ...gy.stake, y: gy.stake.y - 0.1 }, top, o, 0.018, 0.03, 4, STAKE));
  }
  const body = new THREE.Mesh(mergeGeometries(rig.map((g) => (g.deleteAttribute('uv'), g))), rigMaterial());
  body.name = 'tarp_rig';
  body.castShadow = body.receiveShadow = true;
  const lines = new THREE.Mesh(mergeGeometries(ropes.map((g) => (g.deleteAttribute('uv'), g))), ropeMaterial());
  lines.name = 'tarp_lines';
  lines.castShadow = false;
  lines.receiveShadow = true;
  const grp = new THREE.Group();
  grp.position.set(x, y, z);
  grp.add(canvas, body, lines);
  return grp;
}
