// The scrap mace (shared/mace.ts) as a model: a length of scrap pipe, ~55 cm, with a rag bound round the grip and a
// lump of junk welded on its end, bolts and a bent plate sticking out of it. Built in the laser pistol's frame like the
// wrench (src/models/wrench.ts) and held on the same mount: the right fist closes round the grip at the origin, the pipe
// standing up through it (+Y) with the head above. Forward is +Z. `obj` pivots at the fist (the swing turns it there).
import * as THREE from 'three/webgpu';

const RUST = new THREE.MeshStandardNodeMaterial({ color: 0x7a4b2c, roughness: 0.85, metalness: 0.5, flatShading: true });
const STEEL = new THREE.MeshStandardNodeMaterial({ color: 0x6b6e70, roughness: 0.55, metalness: 0.85, flatShading: true });
const RAG = new THREE.MeshStandardNodeMaterial({ color: 0x8c7a5a, roughness: 1, metalness: 0 });

export function maceModel(): { obj: THREE.Group } {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(x, y, z);
    o.rotation.set(rx, ry, rz);
    g.add(o);
    return o;
  };
  // The pipe, from just under the fist up into the head, and a cap on its bottom end.
  add(new THREE.CylinderGeometry(0.014, 0.014, 0.46, 8), STEEL, 0, 0.16, 0);
  add(new THREE.CylinderGeometry(0.018, 0.018, 0.02, 8), RUST, 0, -0.075, 0);
  // The rag bound round the grip, in a few turns.
  for (let i = 0; i < 4; i++) add(new THREE.CylinderGeometry(0.019, 0.019, 0.024, 8), RAG, 0, -0.045 + i * 0.03, 0, 0.12 * (i % 2 ? 1 : -1), 0, 0.1);
  // The head: a lump of junk round the pipe's end (two crushed blocks and a drum's end), welded on askew.
  const top = 0.4;
  add(new THREE.IcosahedronGeometry(0.055, 0), RUST, 0, top, 0, 0.3, 0.5, 0.2);
  add(new THREE.BoxGeometry(0.07, 0.06, 0.08), RUST, 0.012, top - 0.02, -0.006, 0.25, 0.7, -0.15);
  add(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 9), STEEL, -0.01, top + 0.035, 0.01, 0.4, 0, 0.3);
  // A bent plate through it like a blade, and the bolts sticking out every way.
  add(new THREE.BoxGeometry(0.006, 0.05, 0.11), STEEL, 0, top + 0.01, 0.02, 0.35, 0, 0.12);
  const bolt = new THREE.CylinderGeometry(0.005, 0.009, 0.05, 6);
  const dirs: [number, number, number][] = [[1, 0.2, 0.3], [-1, 0.3, -0.2], [0.2, 0.1, 1], [-0.3, -0.2, -1], [0.6, 1, -0.4], [-0.5, 0.8, 0.6], [0.7, -0.6, -0.5], [-0.6, -0.5, 0.7]];
  const up = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3();
  for (const [x, y, z] of dirs) {
    d.set(x, y, z).normalize();
    const o = add(bolt, STEEL, d.x * 0.065, top + d.y * 0.065, d.z * 0.065);
    o.quaternion.setFromUnitVectors(up, d);
  }
  return { obj: g };
}
