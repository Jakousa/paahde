// The crashed ship players arrive at (shared/ship.ts): the hull and the debris behind it from public/models/ship.glb
// (tools/blender/ship.py), each piece where shared/ship.ts lays it, baked into world space and merged into one mesh per
// material (a handful of draw calls, each drawn again in the shadow cascades). It never moves. The fin's lamp blinks.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { shipPieces } from '../../shared/ship.ts';
import { tagBig } from './shadowLod.ts';

const MODEL_URL = './models/ship.glb';
const GLOW = 'CrashGlow';

export class ShipView {
  private group = new THREE.Group();
  private glow: THREE.MeshStandardMaterial[] = [];

  constructor(scene: THREE.Scene) {
    const pieces = shipPieces();
    if (!pieces.length) return;
    scene.add(this.group);
    new GLTFLoader().load(MODEL_URL, (gltf) => {
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      const per = new Map<THREE.Material, THREE.BufferGeometry[]>();
      const m = new THREE.Matrix4(), place = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
      for (const pc of pieces) {
        const node = root.getObjectByName(pc.node);
        if (!node) {
          console.warn(`ship.glb has no ${pc.node}`);
          continue;
        }
        place.compose(new THREE.Vector3(pc.x, pc.y, pc.z), q.setFromAxisAngle(up, Math.atan2(pc.fx, pc.fz)), new THREE.Vector3(1, 1, 1));
        node.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material);
          const g = mesh.geometry.clone().applyMatrix4(m.multiplyMatrices(place, mesh.matrixWorld));
          const list = per.get(mat);
          if (list) list.push(g);
          else per.set(mat, [g]);
        });
      }
      for (const [mat, list] of per) {
        const mesh = new THREE.Mesh(list.length === 1 ? list[0] : mergeGeometries(list)!, mat);
        const glow = mat.name === GLOW;
        if (glow) this.glow.push(mat as THREE.MeshStandardMaterial);
        mesh.castShadow = !glow;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        if (!glow) tagBig(mesh);
        this.group.add(mesh);
      }
    }, undefined, (err) => console.warn('ship: failed to load the model', err));
  }

  /** Every frame: the lamps blink (`t`: seconds). */
  update(t: number) {
    const on = t % 2.4 < 0.25 ? 4 : 0.6;
    for (const m of this.glow) m.emissiveIntensity = on;
  }
}
