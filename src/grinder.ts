// The grinder in your hand: hold the use button and the disc spins up, in the air or on anything. Touched to something hard
// (a machine, scrap, a wreck, the bunker) it throws sparks and sings; on sand it only runs. Where it touches is
// `playerHands.grindAt`, which the disassembly reads (src/teardown) to cut the seams of a machine's shell.
import * as THREE from 'three/webgpu';
import { actionHeld } from './input.ts';
import { teardownSound } from './teardownSound.ts';
import { playerHands } from './water.ts';

/** How far (m) the disc reaches from the eye. */
const REACH = 2.3;
const SOUND_EVERY = 0.09;
/** The meshes within NEAR m of the eye (and under BIG m across) are the ones tested, collected every REFRESH s. */
const NEAR = 5;
const BIG = 60;
const REFRESH = 0.4;

const N = 320;
const RATE = 140; // sparks a second
const GRAVITY = 9.5;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
const FWD = new THREE.Vector3(0, 0, 1);

/** The sparks: short hot streaks stretched along their flight. They leave along the way the disc is being drawn over the surface
 *  (a cut across sends them sideways, a cut downward sends them down) and then fall; held still, they just drop. */
class Sparks {
  readonly mesh: THREE.InstancedMesh;
  private pos = new Float32Array(N * 3);
  private vel = new Float32Array(N * 3);
  private age = new Float32Array(N).fill(9);
  private life = new Float32Array(N).fill(1);
  private next = 0;
  private owe = 0;
  /** Where the disc touched last frame, and the drawing speed along the surface (smoothed). */
  private last = new THREE.Vector3();
  private have = false;
  private drag = new THREE.Vector3();

  constructor() {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicNodeMaterial({ color: 0xffffff }), N);
    this.mesh.frustumCulled = false;
    this.mesh.userData.soft = true; // not something the grinder bites on
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < N; i++) {
      this.mesh.setMatrixAt(i, _m);
      this.mesh.setColorAt(i, _c.setRGB(0, 0, 0));
    }
  }

  /** The disc is on something at (x, y, z), its surface facing `n`: this frame's sparks. */
  emit(dt: number, x: number, y: number, z: number, n: THREE.Vector3, _on: boolean) {
    // how the contact point is moving over the surface
    _p.set(x, y, z);
    if (this.have && dt > 0) {
      _s.copy(_p).sub(this.last).divideScalar(dt);
      _s.addScaledVector(n, -_s.dot(n)); // along the surface only
      this.drag.lerp(_s, Math.min(1, dt * 12));
    } else this.drag.set(0, 0, 0);
    this.last.copy(_p);
    this.have = true;
    const speed = Math.min(5, this.drag.length());
    this.owe += RATE * dt;
    while (this.owe >= 1) {
      this.owe--;
      const i = this.next;
      this.next = (i + 1) % N;
      // the way the cut is going (and a little out from the surface), spread; held still it is a fall
      const k = speed > 0.15 ? 1 : 0;
      const dirx = k ? this.drag.x / speed : 0, diry = k ? this.drag.y / speed : -1, dirz = k ? this.drag.z / speed : 0;
      const v = 1.5 + Math.random() * 4.5 + speed * 0.8;
      const sx = (Math.random() - 0.5) * 1.4, sy = (Math.random() - 0.5) * 1.4, sz = (Math.random() - 0.5) * 1.4;
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
      this.vel[i * 3] = (dirx * 1.6 + n.x * 0.6 + sx) * v * 0.55;
      this.vel[i * 3 + 1] = (diry * 1.6 + n.y * 0.6 + sy - 0.3) * v * 0.55;
      this.vel[i * 3 + 2] = (dirz * 1.6 + n.z * 0.6 + sz) * v * 0.55;
      this.age[i] = 0;
      this.life[i] = 0.3 + Math.random() * 0.55;
    }
  }

  /** The disc is off the surface: the next touch starts a fresh drag. */
  lost() {
    this.have = false;
    this.owe = 0;
  }

  update(dt: number) {
    let live = false;
    for (let i = 0; i < N; i++) {
      if (this.age[i] >= this.life[i]) continue;
      live = true;
      const t = (this.age[i] += dt) / this.life[i];
      if (t >= 1) {
        _m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _m);
        continue;
      }
      const v = i * 3;
      this.vel[v + 1] -= GRAVITY * dt;
      const k = Math.exp(-dt * 0.9);
      this.vel[v] *= k;
      this.vel[v + 2] *= k;
      this.pos[v] += this.vel[v] * dt;
      this.pos[v + 1] += this.vel[v + 1] * dt;
      this.pos[v + 2] += this.vel[v + 2] * dt;
      _s.set(this.vel[v], this.vel[v + 1], this.vel[v + 2]);
      const sp = _s.length();
      // a streak along the flight: longer the faster it goes, thinning as it cools
      const len = Math.min(0.28, Math.max(0.02, sp * 0.045)) * (1 - 0.4 * t);
      _q.setFromUnitVectors(FWD, sp > 1e-4 ? _s.divideScalar(sp) : FWD);
      _p.set(this.pos[v], this.pos[v + 1], this.pos[v + 2]);
      _m.compose(_p, _q, _s.set(0.007 * (1 - 0.5 * t), 0.007 * (1 - 0.5 * t), len));
      this.mesh.setMatrixAt(i, _m);
      // white-hot to orange to dull red
      this.mesh.setColorAt(i, _c.setRGB(3.4 - 1.4 * t, 1.5 - 1.1 * t, 0.5 - 0.45 * t));
    }
    if (live) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }
}

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
  private sparks: Sparks;
  private sound = 0;

  constructor(scene: THREE.Scene, camera: THREE.Camera, skip: THREE.Object3D[]) {
    this.scene = scene;
    this.camera = camera;
    this.skip = new Set(skip);
    this.sparks = new Sparks();
    scene.add(this.sparks.mesh);
  }

  /** Every frame; `can`: the player is on foot and alive. */
  update(dt: number, can: boolean) {
    const holding = can && playerHands.held === 'grinder' && !!document.pointerLockElement;
    const using = holding && actionHeld('use');
    playerHands.grind += ((using ? 1 : 0) - playerHands.grind) * Math.min(1, dt * 10);
    // held out in front in both hands, the way a grinder is (the jammer's two-handed pose)
    if (playerHands.held === 'grinder') playerHands.aim += ((can ? 1 : 0) - playerHands.aim) * Math.min(1, dt * 6);
    playerHands.grindAt = null;
    this.sparks.update(dt);
    if (!using) {
      this.sparks.lost();
      return;
    }

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
      this.sparks.emit(dt, p.x, p.y, p.z, this.nrm, true);
      this.sound -= dt;
      if (this.sound <= 0) {
        this.sound = SOUND_EVERY;
        teardownSound.turn();
      }
      return;
    }
    this.sparks.lost(); // the disc runs in the air
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
