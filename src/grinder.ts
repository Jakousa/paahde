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
/** The meshes within NEAR m of the eye (and under BIG m across) are the ones tested, collected every REFRESH s. */
const NEAR = 5;
const BIG = 60;
const REFRESH = 0.4;

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
  private near: THREE.Mesh[] = [];
  private c = new THREE.Vector3();
  private age = 0;
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
    this.refresh(dt);
    for (const h of this.ray.intersectObjects(this.near, false)) {
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

  /** Every few tenths of a second, while the disc runs: the solid meshes close to the eye are collected, so the ray tests only those
   *  (a ray through the whole scene would walk every instance of every pool). */
  private refresh(dt: number) {
    this.age -= dt;
    if (this.age > 0) return;
    this.age = REFRESH;
    this.near.length = 0;
    this.collect(this.scene);
  }

  private collect(o: THREE.Object3D) {
    if (!o.visible || o.userData.soft || this.skip.has(o)) return;
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      if (!(m as THREE.InstancedMesh).isInstancedMesh && this.solid(m)) this.near.push(m);
      return; // (meshes are leaves here: nothing hangs off one that a grinder could bite on separately)
    }
    for (const c of o.children) this.collect(c);
  }

  /** A mesh a grinder bites on, near enough to matter: drawn, opaque, not huge (the sky, the terrain's chunks), within reach soon. */
  private solid(m: THREE.Mesh): boolean {
    const mat = m.material as THREE.Material | THREE.Material[];
    const one = Array.isArray(mat) ? mat[0] : mat;
    if (!one || one.transparent || one.visible === false || one.side === THREE.BackSide) return false;
    const g = m.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    const bs = g.boundingSphere;
    if (!bs) return false;
    const r = bs.radius * m.matrixWorld.getMaxScaleOnAxis();
    if (r > BIG) return false;
    this.c.copy(bs.center).applyMatrix4(m.matrixWorld);
    return this.c.distanceTo(this.from) - r < NEAR;
  }
}
