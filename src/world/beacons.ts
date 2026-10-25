// Beacons (shared/placed.ts BEACON): the mast and lamp head, built here in code (a handful of boxes and cylinders, one
// mesh with vertex colours and the lens), and the columns of light the lit ones shine into the sky (shared/power.ts:
// lit while the grid or its battery gives it power).
//
// The beams are markers, to be seen from kilometres off, so they're cheap: every beam in the world is one instanced
// draw of a single quad. Each quad stands on its lamp and turns about the vertical to face the camera in the vertex
// shader (a cylindrical billboard), and widens with distance so it never thins out to less than a few pixels; additive,
// no depth write (dunes in front still hide it), a soft bright core and a faint glow either side, fading out with
// height. It takes only part of the aerial haze, like the crash sites' smoke, so it still reads on the horizon, and is
// brighter by day (over the amber sky) than at night, when a little shows against the dark.
import * as THREE from 'three/webgpu';
import { abs, cameraPosition, float, instancedBufferAttribute, length, max, mix, positionGeometry, positionWorld, pow, sin, smoothstep, uv, vec2, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { BEACON_COLORS } from '../../shared/placed.ts';
import { hazeFactor, nightLevel, time } from './env.ts';

/** Where the lens sits (m over the foot): the beam starts here. Match shared/placed.ts PLACEABLES.beacon_light. */
export const LENS_TOP = 3.75;
/** The beam's height (m). */
const BEAM_H = 520;
/** Its width close by (m), and how much it widens with distance (m per m: about six pixels across at any range). */
const BEAM_W = 0.4;
const BEAM_SPREAD = 0.005;
/** Share of the haze the beam takes on. */
const HAZE = 0.4;
/** Most beams drawn (shared/placed.ts MAX_BEACONS). */
const CAPACITY = 32;

/** The lens's name in the model: it glows in its colour while lit. */
export const LENS = 'beacon_lens';

/** A beacon's model: foot, mast, the wire's insulator on its arm (shared/wires.ts CONNECTORS), lamp head, and the lens. */
export function beaconModel(): THREE.Group {
  const parts: [THREE.BufferGeometry, number][] = [];
  const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, hex: number) => {
    g.translate(x, y, z);
    parts.push([g, hex]);
  };
  // A foot welded from scrap plate, a second plate turned on it.
  add(new THREE.BoxGeometry(0.6, 0.16, 0.6), 0, 0.08, 0, 0x6a4a34);
  const top = new THREE.BoxGeometry(0.42, 0.14, 0.42);
  top.rotateY(Math.PI / 4);
  add(top, 0, 0.23, 0, 0x7a5238);
  // A pipe mast, a collar half way.
  add(new THREE.CylinderGeometry(0.055, 0.075, 3.05, 8), 0, 0.3 + 3.05 / 2, 0, 0x8a8478);
  add(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 8), 0, 1.8, 0, 0x6c6f72);
  // The insulator on a short arm, the wire's socket at its tip.
  add(new THREE.BoxGeometry(0.16, 0.05, 0.05), 0.08, 3.1, 0, 0x6c6f72);
  add(new THREE.CylinderGeometry(0.035, 0.045, 0.14, 8), 0.16, 3.1, 0, 0xd8d0bc);
  // The lamp head: a drum, a rim round its top.
  add(new THREE.CylinderGeometry(0.19, 0.17, 0.3, 14), 0, 3.45, 0, 0x55575a);
  add(new THREE.CylinderGeometry(0.21, 0.21, 0.05, 14), 0, 3.6, 0, 0x3e4044);
  const geos = parts.map(([g, hex]) => {
    const c = new THREE.Color(hex);
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g.index ? g.toNonIndexed() : g;
  });
  const body = new THREE.Mesh(mergeAll(geos), new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.45 }));
  body.name = 'beacon_body';
  const lensGeo = new THREE.CylinderGeometry(0.16, 0.18, 0.12, 14);
  lensGeo.translate(0, LENS_TOP - 0.06, 0);
  const lens = new THREE.Mesh(lensGeo, new THREE.MeshBasicNodeMaterial({ color: 0x1a1c1e }));
  lens.name = LENS;
  lens.userData.noTier = true;
  lens.castShadow = false;
  const g = new THREE.Group();
  g.add(body, lens);
  return g;
}

/** Non-indexed geometries with position, normal, uv and colour, as one. */
function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv', 'color']) {
    const size = geos[0].getAttribute(name).itemSize;
    const arr = new Float32Array(geos.reduce((n, g) => n + g.getAttribute(name).count * size, 0));
    let o = 0;
    for (const g of geos) {
      const a = g.getAttribute(name).array as Float32Array;
      arr.set(a, o);
      o += a.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  return out;
}

/** The lens's colour while lit (bright: it blooms), and dark: tinted glass, so R's next colour shows without power too. */
export function lensColor(color: number | undefined, lit: boolean, out: THREE.Color): THREE.Color {
  out.setHex(BEACON_COLORS[color ?? 0] ?? BEACON_COLORS[0]);
  return lit ? out.multiplyScalar(3) : out.multiplyScalar(0.08);
}

/** Every lit beacon's beam, in one draw. */
export class BeaconBeams {
  private mesh: THREE.Mesh;
  private base = new Float32Array(CAPACITY * 3);
  private color = new Float32Array(CAPACITY * 3);
  private baseAttr = new THREE.InstancedBufferAttribute(this.base, 3);
  private colorAttr = new THREE.InstancedBufferAttribute(this.color, 3);

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
    const base = instancedBufferAttribute(this.baseAttr, 'vec3') as unknown as Node<'vec3'>;
    const col = instancedBufferAttribute(this.colorAttr, 'vec3') as unknown as Node<'vec3'>;
    // Turned about the vertical to face the camera, wider the further off.
    const toCam = cameraPosition.xz.sub(base.xz);
    const d = max(length(toCam), 0.01);
    const across = vec2(toCam.y.negate(), toCam.x).div(d);
    const w = max(float(BEAM_W), d.mul(BEAM_SPREAD));
    const p = positionGeometry;
    m.positionNode = vec3(base.x.add(across.x.mul(p.x).mul(w)), base.y.add(p.y.mul(BEAM_H)), base.z.add(across.y.mul(p.x).mul(w)));
    // Across: a hot core and a soft glow; up: bright at the lamp, thinning out into the sky.
    const u = abs(uv().x.mul(2).sub(1));
    const soft = float(1).sub(smoothstep(0, 1, u));
    const profile = pow(soft, 6).add(pow(soft, 1.5).mul(0.22));
    const v = uv().y;
    const up = pow(float(1).sub(v), 1.8).mul(smoothstep(0, 0.0005, v));
    const shimmer = sin(time.mul(1.3).add(base.x.mul(0.37)).add(v.mul(40))).mul(0.06).add(1);
    const clear = float(1).sub(hazeFactor(positionWorld).mul(HAZE));
    const gain = mix(float(3.2), float(1), nightLevel);
    m.colorNode = col.mul(profile.mul(up).mul(shimmer).mul(clear).mul(gain));
    this.mesh = new THREE.Mesh(geo, m);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 3; // after the smoke
    scene.add(this.mesh);
  }

  /** The lit beacons: each lamp's top and its colour (BEACON_COLORS index). */
  set(lit: { x: number; y: number; z: number; color?: number }[]) {
    const c = new THREE.Color();
    const n = Math.min(lit.length, CAPACITY);
    for (let i = 0; i < n; i++) {
      const b = lit[i];
      this.base.set([b.x, b.y + LENS_TOP, b.z], i * 3);
      c.setHex(BEACON_COLORS[b.color ?? 0] ?? BEACON_COLORS[0]);
      this.color.set([c.r, c.g, c.b], i * 3);
    }
    this.baseAttr.needsUpdate = this.colorAttr.needsUpdate = true;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
  }
}
