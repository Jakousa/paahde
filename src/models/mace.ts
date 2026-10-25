// The scrap mace (shared/mace.ts) as a model: a two-handed club ~1.55 m long, a length of scrap pipe with rags bound
// round the grip and a lump of junk welded on its end (a crushed block, a drum's end, a bent plate through it, bolts
// sticking out every way). Built in the laser pistol's glTF frame like the grinder (src/models/grinder.ts), so it sits
// on the hands' `MaceMount` (tools/models/hands.py) and in the avatar's gun hold (src/models/scavenger.ts): the right
// fist round the shaft at the origin, the left fist MACE_LEFT below it, the shaft along +Z to the head.
import * as THREE from 'three/webgpu';

const RUST = new THREE.MeshStandardNodeMaterial({ color: 0x7a4b2c, roughness: 0.85, metalness: 0.5, flatShading: true });
const DARK_RUST = new THREE.MeshStandardNodeMaterial({ color: 0x5a3622, roughness: 0.9, metalness: 0.45, flatShading: true });
const STEEL = new THREE.MeshStandardNodeMaterial({ color: 0x6b6e70, roughness: 0.55, metalness: 0.85, flatShading: true });
const RAG = new THREE.MeshStandardNodeMaterial({ color: 0x8c7a5a, roughness: 1, metalness: 0 });

/** Where the fists hold it (m along the shaft from the right fist), its ends and the head's centre. */
export const MACE_LEFT = -0.24;
const POMMEL = -0.36, HEAD = 1.12;

export function maceModel(): { obj: THREE.Group } {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(x, y, z);
    o.rotation.set(rx, ry, rz);
    g.add(o);
    return o;
  };
  // Along +Z: a cylinder (built along Y) turned down onto it.
  const rod = (r0: number, r1: number, z0: number, z1: number, m: THREE.Material, seg = 8) =>
    add(new THREE.CylinderGeometry(r1, r0, z1 - z0, seg).rotateX(Math.PI / 2), m, 0, 0, (z0 + z1) / 2);
  // The pipe, a cap on its end, and a collar of weld where the head goes on.
  rod(0.022, 0.022, POMMEL, HEAD - 0.06, STEEL);
  rod(0.034, 0.03, POMMEL - 0.03, POMMEL + 0.01, RUST);
  rod(0.034, 0.04, HEAD - 0.17, HEAD - 0.1, DARK_RUST, 7);
  // Rags bound round both grips, in turns a little askew.
  for (const [z0, n] of [[MACE_LEFT - 0.1, 5], [-0.08, 5]] as const) {
    for (let i = 0; i < n; i++) {
      const o = rod(0.027, 0.027, z0 + i * 0.038, z0 + i * 0.038 + 0.034, RAG);
      o.rotation.y = 0.08 * (i % 2 ? 1 : -1);
    }
  }
  // The head: a crushed block and a lump of slag round the pipe's end, a drum's end welded on askew.
  add(new THREE.IcosahedronGeometry(0.12, 0), RUST, 0, 0, HEAD, 0.3, 0.5, 0.2);
  add(new THREE.BoxGeometry(0.17, 0.14, 0.18), DARK_RUST, 0.02, -0.01, HEAD - 0.02, 0.25, 0.7, -0.15);
  add(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 9), STEEL, -0.01, 0.02, HEAD + 0.08, 1.2, 0, 0.3);
  // A bent plate through it like a blade, and the bolts sticking out every way.
  add(new THREE.BoxGeometry(0.012, 0.11, 0.26), STEEL, 0, 0.01, HEAD + 0.02, 0.35, 0, 0.12);
  const bolt = new THREE.CylinderGeometry(0.007, 0.018, 0.12, 6);
  const dirs: [number, number, number][] = [[1, 0.2, 0.3], [-1, 0.3, -0.2], [0.2, 1, 0.1], [-0.3, -1, -0.1], [0.6, 0.5, 0.8],
    [-0.5, 0.6, 0.7], [0.7, -0.6, 0.5], [-0.6, -0.5, 0.7], [0.1, 0.1, 1], [0.8, -0.3, -0.4], [-0.7, 0.4, -0.5]];
  const up = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3();
  for (const [x, y, z] of dirs) {
    d.set(x, y, z).normalize();
    const o = add(bolt, STEEL, d.x * 0.15, d.y * 0.15, HEAD + d.z * 0.15);
    o.quaternion.setFromUnitVectors(up, d);
  }
  return { obj: g };
}
