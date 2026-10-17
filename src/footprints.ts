// Footprints in the sand: a client-side, purely visual ring buffer of small dark decals that fade out.
// Avatars call `footprints.add()` when a foot plants; one InstancedMesh draws them all.
import * as THREE from 'three/webgpu';
import { clamp, float, instancedBufferAttribute } from 'three/tsl';
import { normalAt } from '../shared/terrain.ts';
import { time } from './world/env.ts';

const MAX = 1024;
const LIFE = 90; // seconds until a print has fully faded

class Footprints {
  readonly mesh: THREE.InstancedMesh;
  private spawn = new Float32Array(MAX).fill(-1e6);
  private spawnAttr: THREE.InstancedBufferAttribute;
  private next = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private n = { x: 0, y: 1, z: 0 };
  private up = new THREE.Vector3(0, 1, 0);
  private nv = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private p = new THREE.Vector3();

  constructor() {
    // A rounded sole: an ellipse, lying flat (normal +Y), toe towards -Z.
    const geo = new THREE.CircleGeometry(0.5, 10);
    geo.rotateX(-Math.PI / 2);
    geo.scale(0.15, 1, 0.3);
    this.spawnAttr = new THREE.InstancedBufferAttribute(this.spawn, 1);
    const age = time.sub(instancedBufferAttribute(this.spawnAttr, 'float'));
    const mat = new THREE.MeshBasicNodeMaterial({ color: 0x3a1a0a, transparent: true, depthWrite: false });
    mat.opacityNode = float(0.32).mul(clamp(float(1).sub(age.div(LIFE)), 0, 1));
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.frustumCulled = false;
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) this.mesh.setMatrixAt(i, this.m);
    this.mesh.renderOrder = 1;
  }

  /** A foot planted at ground point (x, y, z) facing yaw `facing` (0 = -Z). */
  add(x: number, y: number, z: number, facing: number, size = 1) {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    normalAt(x, z, this.n);
    this.nv.set(this.n.x, this.n.y, this.n.z);
    this.q.setFromUnitVectors(this.up, this.nv);
    this.q2.setFromAxisAngle(this.up, facing);
    this.q.multiply(this.q2);
    this.p.set(x, y + 0.02, z);
    this.s.setScalar(size);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.spawn[i] = time.value;
    this.spawnAttr.needsUpdate = true;
  }
}

export const footprints = new Footprints();
