// The wrench (the build tool, src/placing.ts) as a model, from boxes: a combination spanner, ~23 cm, a flat handle with
// an open jaw at one end and a ring at the other. Built in the laser pistol's frame like the jammer (src/models/jammer.ts),
// held on the same mount with the pistol's clips: the right fist closes round the handle at the origin, the handle
// standing up through it (+Y) with the jaw above the fist, open upwards, and the ring below. Forward is +Z.
import * as THREE from 'three/webgpu';

const STEEL = new THREE.MeshStandardNodeMaterial({ color: 0xb4b8bb, roughness: 0.35, metalness: 0.9 });
const DARK = new THREE.MeshStandardNodeMaterial({ color: 0x5c5f62, roughness: 0.5, metalness: 0.8 });

export function wrenchModel(): { obj: THREE.Group } {
  const g = new THREE.Group();
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, m = STEEL) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    o.position.set(x, y, z);
    g.add(o);
    return o;
  };
  // The handle: flat (thin across X, wide along Z), a little wider towards the ends, a stamped groove down it.
  box(0.007, 0.17, 0.02, 0, 0.025, 0);
  box(0.008, 0.12, 0.006, 0, 0.025, 0, DARK);
  box(0.0075, 0.03, 0.024, 0, 0.115, 0);
  // The open jaw: a head on the handle's end and two prongs with the slot between them, tipped 15° like a real one.
  const head = new THREE.Group();
  head.position.set(0, 0.135, 0);
  head.rotation.x = (15 * Math.PI) / 180;
  g.add(head);
  const prong = (z: number) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(0.0085, 0.026, 0.01), STEEL);
    o.position.set(0, 0.016, z);
    head.add(o);
  };
  head.add(new THREE.Mesh(new THREE.BoxGeometry(0.0085, 0.014, 0.038), STEEL));
  prong(-0.014);
  prong(0.014);
  // The ring end below the fist: a twelve-point box end, as a short torus lying in the handle's plane.
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.012, 0.0045, 6, 12).rotateY(Math.PI / 2), STEEL);
  ring.position.set(0, -0.072, 0);
  g.add(ring);
  return { obj: g };
}
