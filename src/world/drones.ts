// Night drones (shared/guardians.ts): the hovering body (public/models/drone.glb, rotors spinning) and its
// searchlight, a soft additive cone from the lamp to where it meets the sand plus a bright pool there. Warm white
// while it sweeps, red once it has locked on to someone. Purely visual: the server decides who is lit.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { abs, dot, float, length, normalView, positionViewDirection, pow, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import { BEAM_HALF, beamGround } from '../../shared/guardians.ts';
import { normalAt } from '../../shared/terrain.ts';
import type { DroneFrame } from './botFrames.ts';

const SHOW_R = 900;
/** The lamp, in the body frame. */
const LAMP = new THREE.Vector3(0, -0.4, 0.55);
const WARM = new THREE.Color(1.0, 0.86, 0.62);
const RED = new THREE.Color(1.0, 0.16, 0.08);
/** Beam brightness (HDR, before bloom) and the pool's. */
const BEAM_GAIN = 0.8;
const POOL_GAIN = 2.2;

let model: { body: THREE.Object3D; rotors: THREE.Object3D[] } | null = null;
let loading = false;

function load() {
  if (loading) return;
  loading = true;
  new GLTFLoader().loadAsync('./models/drone.glb').then(
    (gltf) => {
      const body = gltf.scene.getObjectByName('Drone_Body');
      if (!body) throw new Error('drone.glb has no Drone_Body');
      const rotors: THREE.Object3D[] = [];
      for (let i = 0; i < 4; i++) {
        const r = gltf.scene.getObjectByName(`Drone_Rotor_${i}`);
        if (r) rotors.push(r);
      }
      // The beam starts at the lamp's lens.
      body.updateMatrixWorld(true);
      body.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || (m.material as THREE.Material).name !== 'DroneLamp') return;
        m.geometry.computeBoundingBox();
        m.geometry.boundingBox!.getCenter(LAMP).applyMatrix4(m.matrixWorld);
      });
      model = { body, rotors };
    },
    (e) => console.warn('drones: model failed, using a box', e),
  );
}

function placeholder() {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x2c2622, roughness: 0.6, metalness: 0.6 });
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.35, 1.2), m));
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.18), new THREE.MeshBasicNodeMaterial({ color: 0xfff0c0 }));
  lamp.position.copy(LAMP);
  g.add(lamp);
  return g;
}

/** Unit cone along +Z, apex at the origin, radius 1 at z = 1 (open ended). */
const coneGeo = (() => {
  const g = new THREE.CylinderGeometry(0.02, 1, 1, 24, 1, true);
  g.translate(0, -0.5, 0);
  g.rotateX(-Math.PI / 2);
  return g;
})();
const poolGeo = new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2);

type View = {
  root: THREE.Group;
  rotors: THREE.Object3D[];
  beam: THREE.Mesh;
  pool: THREE.Mesh;
  color: THREE.Color;
  model: boolean;
};

const _lamp = new THREE.Vector3(), _dir = new THREE.Vector3(), _hit = { x: 0, y: 0, z: 0 }, _n = { x: 0, y: 1, z: 0 };
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4();

export class Drones {
  private views = new Map<number, View>();
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    load();
  }

  private make(): View {
    const root = new THREE.Group();
    let rotors: THREE.Object3D[] = [];
    if (model) {
      root.add(model.body.clone());
      rotors = model.rotors.map((r) => {
        const c = r.clone();
        root.add(c);
        return c;
      });
    } else root.add(placeholder());
    root.traverse((o) => (o.castShadow = true));
    const color = WARM.clone();
    const tint = uniform(color);
    // Brightest along the axis (facing us) and near the lamp, fading out towards the far end.
    const beamMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const facing = pow(abs(dot(normalView, positionViewDirection)), float(1.5));
    const along = uv().y; // 1 at the lamp, 0 at the far end
    beamMat.colorNode = tint.mul(BEAM_GAIN);
    beamMat.opacityNode = facing.mul(pow(along, float(0.7))).mul(0.5).add(along.mul(along).mul(0.25));
    const beam = new THREE.Mesh(coneGeo, beamMat);
    beam.frustumCulled = false;
    const poolMat = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4,
    });
    const r = length(uv().sub(0.5)).mul(2);
    poolMat.colorNode = tint.mul(POOL_GAIN).mul(vec3(1, 0.95, 0.9));
    poolMat.opacityNode = float(1).sub(smoothstep(0.35, 1.0, r)).mul(0.8);
    const pool = new THREE.Mesh(poolGeo, poolMat);
    pool.frustumCulled = false;
    root.add(beam);
    this.scene.add(root, pool);
    beam.userData.tint = tint;
    return { root, rotors, beam, pool, color, model: model !== null };
  }

  update(frames: DroneFrame[], dt: number, focus: { x: number; z: number }) {
    const seen = new Set<number>();
    const now = performance.now() / 1000;
    for (const f of frames) {
      if (Math.hypot(f.x - focus.x, f.z - focus.z) > SHOW_R) continue;
      seen.add(f.id);
      let v = this.views.get(f.id);
      if (v && !v.model && model) {
        this.drop(v);
        v = undefined;
      }
      if (!v) this.views.set(f.id, (v = this.make()));
      // Hovering: a slow bob and a lean into the way it's going.
      v.root.position.set(f.x, f.y + Math.sin(now * 1.3 + f.id) * 0.25, f.z);
      v.root.rotation.set(0.08, f.yaw, Math.sin(now * 0.9 + f.id) * 0.04, 'YXZ');
      v.rotors.forEach((r, i) => (r.rotation.y += (i % 2 ? -1 : 1) * dt * 60));
      v.color.lerp(f.lock ? RED : WARM, 1 - Math.exp(-dt * 6));
      (v.beam.userData.tint as { value: THREE.Color }).value.copy(v.color);
      // Beam from the lamp to the sand (world space; the cone is a child of the body, so undo its transform).
      v.root.updateMatrixWorld();
      _lamp.copy(LAMP).applyMatrix4(v.root.matrixWorld);
      _dir.set(f.dx, f.dy, f.dz);
      beamGround(_lamp.x, _lamp.y, _lamp.z, f.dx, f.dy, f.dz, _hit);
      const len = Math.max(1, Math.hypot(_hit.x - _lamp.x, _hit.y - _lamp.y, _hit.z - _lamp.z));
      const rad = len * Math.tan(BEAM_HALF);
      v.beam.matrixAutoUpdate = false;
      _z.copy(_dir);
      _x.set(0, 1, 0).cross(_z);
      if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0);
      _x.normalize();
      _y.crossVectors(_z, _x);
      _m.makeBasis(_x.multiplyScalar(rad), _y.multiplyScalar(rad), _z.multiplyScalar(len)).setPosition(_lamp);
      v.beam.matrix.copy(v.root.matrixWorld).invert().multiply(_m);
      // The pool: an ellipse stretched along the beam the flatter it comes in, on the sand.
      normalAt(_hit.x, _hit.z, _n);
      const flat = Math.max(0.25, Math.abs(f.dy));
      _y.set(_n.x, _n.y, _n.z);
      _z.set(f.dx, 0, f.dz).normalize();
      _x.crossVectors(_y, _z).normalize();
      _z.crossVectors(_x, _y);
      _m.makeBasis(_x.multiplyScalar(rad * 1.15), _y, _z.multiplyScalar((rad * 1.15) / flat)).setPosition(_hit.x, _hit.y + 0.05, _hit.z);
      v.pool.matrixAutoUpdate = false;
      v.pool.matrix.copy(_m);
      v.pool.visible = len < 74;
    }
    for (const [id, v] of this.views) if (!seen.has(id)) {
      this.drop(v);
      this.views.delete(id);
    }
  }

  private drop(v: View) {
    v.root.removeFromParent();
    v.pool.removeFromParent();
    (v.beam.material as THREE.Material).dispose();
    (v.pool.material as THREE.Material).dispose();
  }
}
