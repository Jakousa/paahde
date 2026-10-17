// Footprints in the sand: a client-side, purely visual ring buffer of small dark decals that fade out.
// Avatars call `footprints.add()` when a foot plants; one InstancedMesh draws them all.
// Prints whose ground gets dug or piled are erased, so they never float over a hole.
import * as THREE from 'three/webgpu';
import { clamp, float, instancedBufferAttribute } from 'three/tsl';
import { EDIT_CELL, EDIT_CHUNK, edits, heightAt, normalAt } from '../shared/terrain.ts';
import { time } from './world/env.ts';

const MAX = 1024;
const LIFE = 90; // seconds until a print has fully faded
const CHUNK_M = EDIT_CHUNK * EDIT_CELL;
const ERASE_DY = 0.03; // ground moved more than this under a print → erase it

class Footprints {
  readonly mesh: THREE.InstancedMesh;
  private spawn = new Float32Array(MAX).fill(-1e6);
  // Where each print sits (ground height at placement), to erase it if the ground changes.
  private px = new Float32Array(MAX);
  private py = new Float32Array(MAX).fill(NaN);
  private pz = new Float32Array(MAX);
  private dirty = new Set<string>();
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

    // Edits fire per vertex; collect the touched chunks and check prints once per batch.
    const prev = edits.onChange;
    edits.onChange = (cx, cz) => {
      prev?.(cx, cz);
      if (this.dirty.size === 0) queueMicrotask(() => this.eraseDisturbed());
      this.dirty.add(`${cx},${cz}`);
    };
  }

  private eraseDisturbed() {
    let changed = false;
    for (let i = 0; i < MAX; i++) {
      const y = this.py[i];
      if (Number.isNaN(y)) continue;
      const x = this.px[i], z = this.pz[i];
      if (!this.dirty.has(`${Math.floor(x / CHUNK_M)},${Math.floor(z / CHUNK_M)}`)) continue;
      if (Math.abs(heightAt(x, z) - y) <= ERASE_DY) continue;
      this.py[i] = NaN;
      this.m.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, this.m);
      changed = true;
    }
    this.dirty.clear();
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
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
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.spawnAttr.needsUpdate = true;
  }
}

export const footprints = new Footprints();
