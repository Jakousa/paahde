// Light poles (shared/placed.ts LIGHT_POLE): the mast, its arm and the floodlight on the end, built here in code like the
// beacon (src/world/beacons.ts), and the light they throw on the sand after dusk (shared/power.ts poleDark: lit while
// the grid or its battery gives it power).
//
// Real lights cost every lit material a little and adding one recompiles them all, so the light is a fixed pool of
// spot lights put in the scene at startup (src/world/pooledLight.ts: an unlit one skips its shader work), no shadows,
// handed each frame to the lit poles nearest the camera and faded out towards the edge of their range so a pole
// further off never pops. Past that only its lens glows (it blooms).
import * as THREE from 'three/webgpu';
import { paintedMesh } from './beacons.ts';
import { PooledSpotLight } from './pooledLight.ts';

/** The lens's name in the model: it glows while lit. */
export const POLE_LENS = 'light_pole_lens';
/** The floodlight's lens in the pole's own frame (rot 0; m over the foot, out along the arm). Match shared/placed.ts
 *  PLACEABLES.light_pole. */
const LAMP = { x: 0, y: 5.3, z: 1.3 };
/** The pool: this many poles lit at once round the camera, out to RANGE m (fading over the last FADE m). */
const POOL = 4;
const RANGE = 140;
const FADE = 40;
/** The floodlight: warm, a wide cone straight down, a pool of light about 10 m across. */
const FLOOD = { color: 0xffd6a0, intensity: 11, distance: 26, angle: 1.0, penumbra: 0.65, decay: 1.2 };
const LENS_LIT = new THREE.Color(0xffe2b8).multiplyScalar(4);
const LENS_DARK = new THREE.Color(0x2a2824);

/** A light pole's model: foot, mast, the wire's insulator (shared/wires.ts CONNECTORS), the arm and its brace, and
 *  the floodlight with its lens facing down. */
export function lightPoleModel(): THREE.Group {
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
  // A pipe mast in two lengths, a sleeve where they're joined, a cap.
  add(new THREE.CylinderGeometry(0.06, 0.08, 2.8, 8), 0, 0.3 + 1.4, 0, 0x8a8478);
  add(new THREE.CylinderGeometry(0.05, 0.06, 2.5, 8), 0, 3.1 + 1.25, 0, 0x7d786d);
  add(new THREE.CylinderGeometry(0.09, 0.09, 0.22, 8), 0, 3.1, 0, 0x6c6f72);
  add(new THREE.CylinderGeometry(0.07, 0.07, 0.06, 8), 0, 5.63, 0, 0x55575a);
  // The insulator on a short arm, the wire's socket at its tip.
  add(new THREE.BoxGeometry(0.16, 0.05, 0.05), -0.08, 3.4, 0, 0x6c6f72);
  add(new THREE.CylinderGeometry(0.035, 0.045, 0.14, 8), -0.16, 3.4, 0, 0xd8d0bc);
  // The arm out over +Z, a brace under it back to the mast.
  add(new THREE.BoxGeometry(0.07, 0.07, 1.35), 0, 5.5, 0.66, 0x8a8478);
  const brace = new THREE.BoxGeometry(0.05, 0.05, 0.95);
  brace.rotateX(-Math.PI / 4.6);
  add(brace, 0, 5.15, 0.33, 0x7d786d);
  // The floodlight: a flat housing hung under the arm's end, tipped a little, its fins on top.
  add(new THREE.BoxGeometry(0.42, 0.14, 0.32), LAMP.x, LAMP.y + 0.1, LAMP.z, 0x4a4c4f);
  for (const fx of [-0.12, 0, 0.12]) add(new THREE.BoxGeometry(0.03, 0.06, 0.28), LAMP.x + fx, LAMP.y + 0.2, LAMP.z, 0x3e4044);
  const body = paintedMesh(parts);
  body.name = 'light_pole_body';
  const lensGeo = new THREE.BoxGeometry(0.36, 0.03, 0.26);
  lensGeo.translate(LAMP.x, LAMP.y + 0.02, LAMP.z);
  const lens = new THREE.Mesh(lensGeo, new THREE.MeshBasicNodeMaterial({ color: LENS_DARK }));
  lens.name = POLE_LENS;
  lens.userData.noTier = true;
  lens.castShadow = false;
  const g = new THREE.Group();
  g.add(body, lens);
  return g;
}

/** The lens's colour, lit (bright: it blooms) or dark. */
export const poleLensColor = (lit: boolean, out: THREE.Color) => out.copy(lit ? LENS_LIT : LENS_DARK);

/** Where a pole's floodlight is in the world. */
function lampAt(p: { x: number; y: number; z: number; rot: number }, out: THREE.Vector3): THREE.Vector3 {
  // Turned like three.js's rotation.y = rot·π/2 (shared/placed.ts worldBoxes).
  const c = [1, 0, -1, 0][p.rot & 3], s = [0, 1, 0, -1][p.rot & 3];
  return out.set(p.x + LAMP.x * c + LAMP.z * s, p.y + LAMP.y, p.z - LAMP.x * s + LAMP.z * c);
}

/** The pool of floodlights, handed to the lit poles nearest the camera. */
export class PoleLamps {
  private lights: THREE.SpotLight[] = [];
  private lit: { x: number; y: number; z: number; rot: number }[] = [];
  private at = new THREE.Vector3();

  /** Puts the pool in the scene: call at startup, before the first render. */
  constructor(scene: THREE.Scene) {
    const f = FLOOD;
    for (let i = 0; i < POOL; i++) {
      const light = new PooledSpotLight(f.color, 0, f.distance, f.angle, f.penumbra, f.decay);
      light.castShadow = false;
      scene.add(light, light.target);
      this.lights.push(light);
    }
  }

  /** The poles lit now. */
  set(lit: { x: number; y: number; z: number; rot: number }[]) {
    this.lit = lit;
  }

  /** Every frame: the pool to the lit poles nearest `eye`. */
  update(eye: THREE.Vector3) {
    const near = this.lit
      .map((p) => ({ p, d: Math.hypot(p.x - eye.x, p.z - eye.z) }))
      .filter((n) => n.d < RANGE)
      .sort((a, b) => a.d - b.d)
      .slice(0, POOL);
    this.lights.forEach((light, i) => {
      const n = near[i];
      if (!n) {
        light.intensity = 0;
        return;
      }
      lampAt(n.p, this.at);
      light.position.copy(this.at);
      light.target.position.set(this.at.x, this.at.y - 10, this.at.z);
      light.intensity = FLOOD.intensity * Math.min(1, (RANGE - n.d) / FADE);
    });
  }
}
