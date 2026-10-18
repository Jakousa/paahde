// The jammer (shared/jammer.ts) as a model, from boxes and cylinders: a raked grip under a squat olive body, a little
// yagi antenna (boom and four elements) pointing forward, a whip aerial at the back and a lamp on top that the tool
// blinks (src/jammer.ts). Built in the laser pistol's frame (tools/models/pistol.py): origin at the grip where the
// hand closes, forward +Z, up +Y, so the hands hold it with the pistol's clips (src/viewmodel.ts).
import * as THREE from 'three/webgpu';

const BODY = new THREE.MeshStandardNodeMaterial({ color: 0x5a5440, roughness: 0.75, metalness: 0.25 });
const DARK = new THREE.MeshStandardNodeMaterial({ color: 0x24201c, roughness: 0.6, metalness: 0.4 });
const STEEL = new THREE.MeshStandardNodeMaterial({ color: 0x9a9c94, roughness: 0.4, metalness: 0.8 });
/** The lamp's lit colour (HDR, before bloom); src/jammer.ts scales it. */
export const LAMP_ON = new THREE.Color(1.0, 0.55, 0.12).multiplyScalar(4);

/** One jammer; `lamp` is this copy's own lamp material (its colour set every frame by whoever holds it). */
export function jammerModel(): { obj: THREE.Group; lamp: THREE.MeshBasicNodeMaterial } {
  const g = new THREE.Group();
  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, rx = 0) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    o.position.set(x, y, z);
    o.rotation.x = rx;
    g.add(o);
    return o;
  };
  /** A rod from a to b. */
  const rod = (r: number, a: THREE.Vector3, b: THREE.Vector3, m: THREE.Material) => {
    const len = a.distanceTo(b);
    const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), m);
    o.position.copy(a).add(b).multiplyScalar(0.5);
    o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    g.add(o);
    return o;
  };
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // Grip, its top leaning forward like the pistol's (28°), and a trigger guard.
  box(0.028, 0.095, 0.036, DARK, 0, 0.004, -0.004, 0.49);
  box(0.006, 0.006, 0.03, DARK, 0, 0.03, 0.035);
  // Body.
  box(0.048, 0.044, 0.15, BODY, 0, 0.066, 0.035);
  box(0.05, 0.008, 0.11, DARK, 0, 0.044, 0.045);
  box(0.04, 0.03, 0.006, DARK, 0, 0.066, 0.112);
  // Yagi: the boom out front with four elements, longest at the back.
  rod(0.0035, V(0, 0.066, 0.112), V(0, 0.066, 0.31), STEEL);
  [[0.14, 0.12], [0.19, 0.1], [0.24, 0.088], [0.29, 0.078]].forEach(([z, w]) => rod(0.0022, V(-w / 2, 0.066, z), V(w / 2, 0.066, z), STEEL));
  // Whip aerial at the back, raked back a little.
  rod(0.0045, V(0.016, 0.088, -0.03), V(0.016, 0.1, -0.03), DARK);
  rod(0.0016, V(0.016, 0.1, -0.03), V(0.016, 0.2, -0.055), STEEL);
  // The lamp on top, near the back where the eye sees it.
  const lamp = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  const l = new THREE.Mesh(new THREE.SphereGeometry(0.0065, 10, 8), lamp);
  l.position.set(-0.012, 0.089, -0.02);
  g.add(l);
  box(0.018, 0.004, 0.018, DARK, -0.012, 0.088, -0.02);
  return { obj: g, lamp };
}
