// A receiver (shared/bosses.ts RECEIVERS) as a model, from boxes and cylinders, matching the one lying on the sand
// (tools/blender/finds.py): the jammer's raked grip (src/models/jammer.ts) under a squat body in its boss's colour, a
// round dial on top leaning back to the holder with a needle that points to the boss (src/receiver.ts turns it), a
// stub antenna on the nose, the cell's slot in the flank and a lamp at the back. Built
// in the laser pistol's frame like the jammer (origin at the grip, forward +Z, up +Y), so the hands hold it with the
// jammer's clips (src/viewmodel.ts).
import * as THREE from 'three/webgpu';
import type { BossKind } from '../../shared/bosses.ts';

/** Body and trim colours per boss (tools/blender/finds.py rcv_<kind>): the carrier's teal-grey, the queen's oxblood,
 *  the colossus's rusty iron, the worm's sand with dark bands. */
const BODY: Record<BossKind, [number, number]> = {
  carrier: [0x5a7272, 0x2c3a3a], queen: [0x5c1a17, 0x2a0d0b], colossus: [0xa0521f, 0x55280f], worm: [0xc9a556, 0x2e2520],
};
const DARK = new THREE.MeshStandardNodeMaterial({ color: 0x24201c, roughness: 0.6, metalness: 0.4 });
const STEEL = new THREE.MeshStandardNodeMaterial({ color: 0x9a9c94, roughness: 0.4, metalness: 0.8 });
const FACE = new THREE.MeshStandardNodeMaterial({ color: 0x1e1f22, roughness: 0.5, metalness: 0.1 });
const RIM = new THREE.MeshStandardNodeMaterial({ color: 0xc4c8cc, roughness: 0.4, metalness: 0.7 });
const TICK = new THREE.MeshStandardNodeMaterial({ color: 0xe8e2d4, roughness: 0.7 });
const BRASS = new THREE.MeshStandardNodeMaterial({ color: 0xc9a24a, roughness: 0.3, metalness: 1 });
const NEEDLE = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1.0, 0.6, 0.25).multiplyScalar(1.4) });
const bodies = new Map<BossKind, [THREE.Material, THREE.Material]>();
/** The lamp's lit colour (HDR, before bloom); src/receiver.ts scales it. */
export const RECEIVER_LAMP = new THREE.Color(0.35, 1.0, 0.3).multiplyScalar(4);

/** One receiver of `kind`; `needle` turns about Y (0: straight ahead, + to the left), `lamp` is this copy's own. */
export function receiverModel(kind: BossKind): { obj: THREE.Group; needle: THREE.Object3D; lamp: THREE.MeshBasicNodeMaterial } {
  let mats = bodies.get(kind);
  if (!mats) {
    const m = (c: number) => new THREE.MeshStandardNodeMaterial({ color: c, roughness: 0.7, metalness: 0.3 });
    mats = [m(BODY[kind][0]), m(BODY[kind][1])];
    bodies.set(kind, mats);
  }
  const [body, trim] = mats;
  const g = new THREE.Group();
  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, rx = 0, to: THREE.Object3D = g) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    o.position.set(x, y, z);
    o.rotation.x = rx;
    to.add(o);
    return o;
  };
  const cyl = (r: number, h: number, m: THREE.Material, x: number, y: number, z: number, to: THREE.Object3D = g, n = 20) => {
    const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, n), m);
    o.position.set(x, y, z);
    to.add(o);
    return o;
  };
  // Grip and trigger guard: the jammer's.
  box(0.028, 0.095, 0.036, DARK, 0, 0.004, -0.004, 0.49);
  box(0.006, 0.006, 0.03, DARK, 0, 0.03, 0.035);
  // Body, its underside and nose plate; the worm's dark bands.
  box(0.06, 0.056, 0.13, body, 0, 0.071, 0.03);
  box(0.062, 0.008, 0.1, trim, 0, 0.045, 0.035);
  box(0.048, 0.04, 0.006, trim, 0, 0.071, 0.095);
  if (kind === 'worm') for (const z of [-0.018, 0.078]) box(0.063, 0.059, 0.012, trim, 0, 0.071, z);
  // The cell's slot in the right flank: dark opening, steel frame, brass contacts.
  box(0.002, 0.024, 0.048, DARK, 0.0305, 0.07, 0.03);
  for (const dy of [-0.014, 0.014]) box(0.004, 0.004, 0.056, STEEL, 0.0315, 0.07 + dy, 0.03);
  for (const dz of [-0.026, 0.026]) box(0.004, 0.032, 0.004, STEEL, 0.0315, 0.07, 0.03 + dz);
  for (const z of [0.02, 0.04]) box(0.003, 0.004, 0.004, BRASS, 0.032, 0.062, z);
  // The dial, leaning back toward the holder: local +Y out of the face, +Z twelve o'clock.
  const dial = new THREE.Group();
  dial.position.set(0, 0.111, 0.035);
  dial.rotation.x = -0.4;
  g.add(dial);
  cyl(0.028, 0.022, trim, 0, -0.011, 0, dial);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.0285, 0.0285, 0.005, 24, 1, true), RIM);
  rim.position.y = 0.0025;
  dial.add(rim);
  cyl(0.0225, 0.002, FACE, 0, 0, 0, dial);
  for (let i = 0; i < 7; i++) {
    const a = -2.1 + i * 0.7, long = i % 3 === 0;
    const t = box(0.0016, 0.001, long ? 0.006 : 0.004, TICK, Math.sin(a) * 0.0175, 0.0015, Math.cos(a) * 0.0175, 0, dial);
    t.rotation.y = a;
  }
  const needle = new THREE.Group();
  needle.position.y = 0.0025;
  dial.add(needle);
  const n = new THREE.Mesh(new THREE.BoxGeometry(0.0024, 0.0012, 0.017), NEEDLE);
  n.position.z = 0.0075;
  needle.add(n);
  cyl(0.003, 0.004, STEEL, 0, 0.0005, 0, needle, 8);
  // Stubby antenna on the nose.
  cyl(0.0075, 0.01, DARK, 0, 0.104, 0.08);
  const a0 = new THREE.Vector3(0, 0.109, 0.08), a1 = new THREE.Vector3(0, 0.154, 0.092);
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.0042, 0.0042, a0.distanceTo(a1), 8), DARK);
  rod.position.copy(a0).add(a1).multiplyScalar(0.5);
  rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), a1.clone().sub(a0).normalize());
  g.add(rod);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.0058, 8, 6), DARK);
  tip.position.set(0, 0.156, 0.092);
  g.add(tip);
  // The lamp at the back, where the eye sees it.
  const lamp = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  const l = new THREE.Mesh(new THREE.SphereGeometry(0.0065, 10, 8), lamp);
  l.position.set(-0.012, 0.104, -0.02);
  g.add(l);
  box(0.018, 0.004, 0.018, DARK, -0.012, 0.1, -0.02);
  return { obj: g, needle, lamp };
}
