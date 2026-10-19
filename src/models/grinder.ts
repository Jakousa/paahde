// The grinder as a model, from boxes and cylinders: a hand angle grinder like a real one. A long motor housing, a gear head at the
// front with the disc beside it standing in the same plane as the housing (the spindle across the body) behind a half guard,
// and a side handle leaning up and to the left from the head. Built in the laser pistol's frame like the jammer
// (src/models/jammer.ts) but with its origin on the housing's axis where the right fist closes round it: forward +Z, up +Y.
// The hands (tools/models/hands.py "grinder clips", node `GrinderMount`) hold it the way the numbers there say: the right
// fist round the housing (z -0.07..0.15, r 0.03), the left round the handle (from (0, 0.028, 0.21) along (0.25, 0.968, 0), r 0.013).
// `disc` spins about its X axis while it grinds (src/grinder.ts).
import * as THREE from 'three/webgpu';

const BODY = new THREE.MeshStandardNodeMaterial({ color: 0x35558f, roughness: 0.65, metalness: 0.3 });
const DARK = new THREE.MeshStandardNodeMaterial({ color: 0x1f1f23, roughness: 0.6, metalness: 0.35 });
const STEEL = new THREE.MeshStandardNodeMaterial({ color: 0xa4a8ab, roughness: 0.4, metalness: 0.85 });
const DISC = new THREE.MeshStandardNodeMaterial({ color: 0x232225, roughness: 0.85, metalness: 0.2 });

export function grinderModel(): { obj: THREE.Group; disc: THREE.Object3D } {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(x, y, z);
    g.add(o);
    return o;
  };
  // The housing: the motor body (blue) with a dark rear cap, and a tapering neck to the head.
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.15, 14).rotateX(Math.PI / 2), BODY, 0, 0, 0.005);
  add(new THREE.CylinderGeometry(0.031, 0.031, 0.04, 14).rotateX(Math.PI / 2), DARK, 0, 0, -0.05);
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 14).rotateX(Math.PI / 2), DARK, 0, 0, 0.095);
  add(new THREE.CylinderGeometry(0.026, 0.03, 0.05, 14).rotateX(Math.PI / 2), BODY, 0, 0, 0.135);
  // The gear head: a steel casing with a boss for the spindle.
  add(new THREE.BoxGeometry(0.056, 0.056, 0.07), STEEL, 0, 0, 0.225);
  add(new THREE.CylinderGeometry(0.018, 0.018, 0.012, 12).rotateZ(Math.PI / 2), DARK, 0.03, 0, 0.225);
  // The side handle, leaning up and to the left from the head, with a knob.
  const up = new THREE.Vector3(0.25, 0.968, 0).normalize();
  const base = new THREE.Vector3(0, 0.028, 0.21);
  const rod = add(new THREE.CylinderGeometry(0.013, 0.013, 0.1, 10), DARK, 0, 0, 0);
  rod.position.copy(base).addScaledVector(up, 0.05);
  rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  const knob = add(new THREE.SphereGeometry(0.017, 10, 8), DARK, 0, 0, 0);
  knob.position.copy(base).addScaledVector(up, 0.105);
  // The disc, on a spindle out to the left of the head: in the housing's own plane, so its edge shows from behind.
  const disc = new THREE.Group();
  disc.position.set(0.05, 0, 0.225);
  g.add(disc);
  disc.add(new THREE.Mesh(new THREE.CylinderGeometry(0.056, 0.056, 0.004, 28).rotateZ(Math.PI / 2), DISC));
  disc.add(new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.009, 8).rotateZ(Math.PI / 2), STEEL));
  // A radial mark that shows it turn.
  const mark = new THREE.Mesh(new THREE.BoxGeometry(0.0056, 0.1, 0.008), STEEL);
  mark.position.x = 0.002;
  disc.add(mark);
  // The half guard over the back and top of the disc.
  const guard = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.022, 20, 1, true, Math.PI / 4, Math.PI).rotateZ(Math.PI / 2), STEEL.clone());
  (guard.material as THREE.MeshStandardNodeMaterial).side = THREE.DoubleSide;
  guard.position.set(0.05, 0, 0.225);
  g.add(guard);
  return { obj: g, disc };
}
