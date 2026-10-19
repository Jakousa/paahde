// The grinder as a model, from boxes and cylinders: a hand angle grinder (an electric motor, a battery and scrap in a
// housing) with its disc out front behind a half guard. Built in the laser pistol's frame like the jammer
// (src/models/jammer.ts): origin at the grip, forward +Z, up +Y, so the hands hold it with the pistol's clips
// (src/viewmodel.ts). `disc` spins while it grinds (src/teardown).
import * as THREE from 'three/webgpu';

const BODY = new THREE.MeshStandardNodeMaterial({ color: 0xb8742a, roughness: 0.7, metalness: 0.3 });
const DARK = new THREE.MeshStandardNodeMaterial({ color: 0x26211d, roughness: 0.6, metalness: 0.4 });
const STEEL = new THREE.MeshStandardNodeMaterial({ color: 0x9a9c94, roughness: 0.4, metalness: 0.8 });
const DISC = new THREE.MeshStandardNodeMaterial({ color: 0x6b6258, roughness: 0.9, metalness: 0.2 });

export function grinderModel(): { obj: THREE.Group; disc: THREE.Object3D } {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(x, y, z);
    o.rotation.set(rx, ry, rz);
    g.add(o);
    return o;
  };
  // Grip, raked like the pistol's, under the motor housing.
  add(new THREE.BoxGeometry(0.028, 0.095, 0.036), DARK, 0, 0.004, -0.004, 0.49);
  // Motor housing along the axis, a battery pack under its back, the neck and gear head at the front.
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.15, 12).rotateX(Math.PI / 2), BODY, 0, 0.07, 0.02);
  add(new THREE.BoxGeometry(0.04, 0.03, 0.07), DARK, 0, 0.034, -0.03);
  add(new THREE.BoxGeometry(0.05, 0.05, 0.05), DARK, 0, 0.07, 0.115);
  // The disc, on a spindle out to the side of the head, behind a half guard.
  const disc = new THREE.Group();
  disc.position.set(0, 0.07, 0.15);
  g.add(disc);
  const d = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.004, 24), DISC);
  d.rotation.x = Math.PI / 2;
  disc.add(d);
  disc.add(new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.012, 8).rotateX(Math.PI / 2), STEEL));
  const guard = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.014, 16, 1, true, 0, Math.PI).rotateX(Math.PI / 2), DARK);
  guard.position.set(0, 0.07, 0.15);
  guard.rotation.z = Math.PI / 2;
  guard.material = DARK;
  g.add(guard);
  return { obj: g, disc };
}
