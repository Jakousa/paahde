// The grinder in your hand: hold the use button and the disc spins up, in the air or on anything. Touched to something hard
// (a machine, scrap, a wreck, the bunker) it throws sparks and sings; on sand it only runs. Where it touches is
// `playerHands.grindAt`, which the disassembly reads (src/teardown) to cut the seams of a machine's shell.
import * as THREE from 'three/webgpu';
import { actionHeld } from './input.ts';
import { teardownSound } from './teardownSound.ts';
import { playerHands } from './water.ts';
import { zaps } from './world/zaps.ts';

/** How far (m) the disc reaches from the eye. */
const REACH = 2.3;
const SPARK_EVERY = 0.035;
const SOUND_EVERY = 0.09;

export class Grinder {
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  /** What is not hard besides the sand (`userData.soft`): the player. */
  private skip: Set<THREE.Object3D>;
  private ray = new THREE.Raycaster();
  private from = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private nrm = new THREE.Vector3();
  private at = { x: 0, y: 0, z: 0 };
  private spark = 0;
  private sound = 0;

  constructor(scene: THREE.Scene, camera: THREE.Camera, skip: THREE.Object3D[]) {
    this.scene = scene;
    this.camera = camera;
    this.skip = new Set(skip);
  }

  /** Every frame; `can`: the player is on foot and alive. */
  update(dt: number, can: boolean) {
    const holding = can && playerHands.held === 'grinder' && !!document.pointerLockElement;
    const using = holding && actionHeld('use');
    playerHands.grind += ((using ? 1 : 0) - playerHands.grind) * Math.min(1, dt * 10);
    if (playerHands.held === 'grinder') playerHands.aim += ((using ? 1 : 0) - playerHands.aim) * Math.min(1, dt * 8);
    playerHands.grindAt = null;
    if (!using) return;

    this.camera.getWorldPosition(this.from);
    this.camera.getWorldDirection(this.dir);
    this.ray.set(this.from, this.dir);
    this.ray.far = REACH;
    const roots = this.scene.children.filter((c) => !this.skip.has(c) && c.visible && !c.userData.soft);
    for (const h of this.ray.intersectObjects(roots, true)) {
      if (!this.hard(h.object)) continue;
      const p = h.point;
      if (h.face) this.nrm.copy(h.face.normal).transformDirection(h.object.matrixWorld);
      else this.nrm.set(0, 1, 0);
      if (this.nrm.dot(this.dir) > 0) this.nrm.negate(); // the side that faces the disc
      this.at.x = p.x;
      this.at.y = p.y;
      this.at.z = p.z;
      playerHands.grindAt = this.at;
      this.spark -= dt;
      if (this.spark <= 0) {
        this.spark = SPARK_EVERY;
        zaps.burst(p.x, p.y, p.z, this.nrm.x, this.nrm.y, this.nrm.z, 3, 0.55);
      }
      this.sound -= dt;
      if (this.sound <= 0) {
        this.sound = SOUND_EVERY;
        teardownSound.turn();
      }
      return;
    }
  }

  /** A mesh a grinder bites on: drawn, solid, not a particle pool or glass. */
  private hard(o: THREE.Object3D): boolean {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh) return false;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible || p.userData.soft || this.skip.has(p)) return false;
    const mat = m.material as THREE.Material | THREE.Material[];
    const one = Array.isArray(mat) ? mat[0] : mat;
    return !!one && !one.transparent && one.visible !== false;
  }
}
