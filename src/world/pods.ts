// The crashed pods players arrive in (shared/pods.ts): node Pod of public/models/pod.glb (tools/blender/pod.py) in each
// pod's pose (shared/podModel.ts), where shared/pods.ts lays it, and the drogue chute (Pod_Chute) behind the one in the
// pose it was built for; baked into world space and merged into one mesh per material (a handful of draw calls, each
// drawn again in the shadow cascades). They never move. The beacons blink.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { POD_CHUTE_POSE, POD_POSES } from '../../shared/podModel.ts';
import { podPlaces } from '../../shared/pods.ts';
import { tagBig } from './shadowLod.ts';

const MODEL_URL = './models/pod.glb';
const GLOW = 'CrashGlow';

export class PodsView {
  private group = new THREE.Group();
  private glow: THREE.MeshStandardMaterial[] = [];

  constructor(scene: THREE.Scene) {
    const pods = podPlaces();
    if (!pods.length) return;
    scene.add(this.group);
    new GLTFLoader().load(MODEL_URL, (gltf) => {
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      const per = new Map<THREE.Material, THREE.BufferGeometry[]>();
      const bake = (node: THREE.Object3D, place: THREE.Matrix4) => node.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        const g = mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(place, mesh.matrixWorld));
        const list = per.get(mat);
        if (list) list.push(g);
        else per.set(mat, [g]);
      });
      const pod = root.getObjectByName('Pod'), chute = root.getObjectByName('Pod_Chute');
      if (!pod) return console.warn('pod.glb has no Pod');
      const up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
      for (const p of pods) {
        // Its ground frame in the world (yawed so its +Z is its heading), then its pose in that frame.
        const ground = new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y, p.z), q.setFromAxisAngle(up, Math.atan2(p.dx, p.dz)), one);
        const m = POD_POSES[p.pose].m;
        const pose = new THREE.Matrix4().set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], 0, 0, 0, 1);
        bake(pod, new THREE.Matrix4().multiplyMatrices(ground, pose));
        if (chute && p.pose === POD_CHUTE_POSE) bake(chute, ground);
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
    }, undefined, (err) => console.warn('pods: failed to load the model', err));
  }

  /** Every frame: the beacons blink (`t`: seconds). */
  update(t: number) {
    const on = t % 2.4 < 0.25 ? 4 : 0.6;
    for (const m of this.glow) m.emissiveIntensity = on;
  }
}
