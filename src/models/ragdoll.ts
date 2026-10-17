// A dead player's body (shared/ragdoll.ts): Verlet particles at the scavenger's joints, held together by distance
// constraints, falling onto the sand under gravity and thrown by the push of whatever killed them.
//
//   const doll = new Ragdoll(bone, push, ground);   // from the pose the body is in right now
//   doll.update(dt);                                  // every frame: step, then turn the bones to follow
//   doll.restore();                                   // back to the pose it started in (the clips take over again)
//
// It starts from the animated pose, so a runner falls mid-stride. The torso (hips, chest, neck, shoulders, hips'
// leg sockets) is braced rigid; head, arms and legs swing on it. Each driven bone keeps the turn it had at the start
// relative to a frame spanned by its particles: when the frame turns, the bone turns with it, so nothing needs to
// know which way the rig's bone axes point.
import * as THREE from 'three/webgpu';

/** Sand (or floor) height under (x, z). */
export type RagdollGround = (x: number, z: number) => number;

const STEP = 1 / 120;
const ITERATIONS = 8;
const GRAVITY = 11; // a touch over 9.8: limp bodies read as floaty otherwise
const AIR_DAMP = 0.999;
/** Share of the sliding speed kept per step on the ground. */
const FRICTION = 0.82;
/** Below this speed (m/s) for a while, the body goes to sleep. */
const REST_SPEED = 0.05;
const RADIUS = 0.07;
const HEAD_RADIUS = 0.12;

// Particles: the joints, by the bone that sits at each (the head's is its crown, above the head bone).
const P = {
  pelvis: 0, chest: 1, neck: 2, head: 3,
  lSh: 4, lElbow: 5, lHand: 6, rSh: 7, rElbow: 8, rHand: 9,
  lHip: 10, lKnee: 11, lAnkle: 12, lToe: 13, rHip: 14, rKnee: 15, rAnkle: 16, rToe: 17,
};
const AT: [number, string][] = [
  [P.pelvis, 'Hips'], [P.chest, 'Spine2'], [P.neck, 'Neck'], [P.head, 'Head'],
  [P.lSh, 'LeftArm'], [P.lElbow, 'LeftForeArm'], [P.lHand, 'LeftHand'], [P.rSh, 'RightArm'], [P.rElbow, 'RightForeArm'], [P.rHand, 'RightHand'],
  [P.lHip, 'LeftUpLeg'], [P.lKnee, 'LeftLeg'], [P.lAnkle, 'LeftFoot'], [P.lToe, 'LeftToeBase'],
  [P.rHip, 'RightUpLeg'], [P.rKnee, 'RightLeg'], [P.rAnkle, 'RightFoot'], [P.rToe, 'RightToeBase'],
];
const TORSO = [P.pelvis, P.chest, P.neck, P.lSh, P.rSh, P.lHip, P.rHip];
/** Limb segments [a, b]: kept at their length. */
const BONES: [number, number][] = [
  [P.neck, P.head], [P.lSh, P.lElbow], [P.lElbow, P.lHand], [P.rSh, P.rElbow], [P.rElbow, P.rHand],
  [P.lHip, P.lKnee], [P.lKnee, P.lAnkle], [P.lAnkle, P.lToe], [P.rHip, P.rKnee], [P.rKnee, P.rAnkle], [P.rAnkle, P.rToe],
  [P.lKnee, P.lToe], [P.rKnee, P.rToe], // the foot keeps its angle to the shin
];
/** [a, b, share of the start distance]: never closer (an elbow or knee doesn't fold flat, the head stays off the chest). */
const APART: [number, number, number][] = [
  [P.lSh, P.lHand, 0.4], [P.rSh, P.rHand, 0.4], [P.lHip, P.lAnkle, 0.45], [P.rHip, P.rAnkle, 0.45],
  [P.head, P.chest, 0.85], [P.head, P.lSh, 0.8], [P.head, P.rSh, 0.8],
];

/** A driven bone: its frame's primary axis runs a→b, the secondary c→d (twist). */
type Driven = { bone: THREE.Object3D; a: number; b: number; c: number; d: number; offset: THREE.Quaternion };

export class Ragdoll {
  private pos: THREE.Vector3[] = [];
  private prev: THREE.Vector3[] = [];
  private rods: { a: number; b: number; len: number; min: boolean }[] = [];
  private driven: Driven[] = [];
  private hips: THREE.Object3D;
  /** Every bone's local transform at the start, for restore(). */
  private saved: { bone: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion }[] = [];
  private acc = 0;
  private still = 0;
  private asleep = false;

  /** null when the rig lacks a bone it needs. `push` is the launch velocity (m/s, world). */
  static from(skeletonRoot: THREE.Object3D, push: THREE.Vector3, ground: RagdollGround): Ragdoll | null {
    const bones = new Map<string, THREE.Object3D>();
    skeletonRoot.traverse((o) => void bones.set(o.name, o));
    for (const [, n] of AT) if (!bones.has(n)) return null;
    for (const n of ['Hips', 'Neck', 'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot']) {
      if (!bones.has(n)) return null;
    }
    return new Ragdoll(skeletonRoot, bones, push, ground);
  }

  private ground: RagdollGround;

  private constructor(skeletonRoot: THREE.Object3D, bones: Map<string, THREE.Object3D>, push: THREE.Vector3, ground: RagdollGround) {
    this.ground = ground;
    skeletonRoot.updateMatrixWorld(true);
    skeletonRoot.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.saved.push({ bone: o, p: o.position.clone(), q: o.quaternion.clone() });
    });
    const at = (n: string) => bones.get(n)!.getWorldPosition(new THREE.Vector3());
    for (const [i, n] of AT) this.pos[i] = at(n);
    // The crown: up the neck→head line from the head bone.
    const head = this.pos[P.head];
    head.add(head.clone().sub(this.pos[P.neck]).normalize().multiplyScalar(0.12));
    // Launch: everyone moves with the push; the chest and head a little more, so the body tumbles rather than slides.
    // With no push (heatstroke, a bite) the knees give and the body pitches forward.
    const lean = this.pos[P.chest].clone().sub(this.pos[P.pelvis]).setY(0);
    const fwd = new THREE.Vector3().subVectors(this.pos[P.lToe], this.pos[P.lAnkle]).setY(0).normalize();
    const nudge = push.lengthSq() < 0.01 ? (lean.lengthSq() > 1e-4 ? lean.normalize() : fwd).multiplyScalar(1.2) : null;
    for (let i = 0; i < this.pos.length; i++) {
      const up = Math.max(0, this.pos[i].y - this.pos[P.pelvis].y);
      const v = nudge ? nudge.clone().multiplyScalar(up) : push.clone().multiplyScalar(1 + 0.35 * up);
      if (nudge && (i === P.lKnee || i === P.rKnee)) v.add(fwd.clone().multiplyScalar(0.8));
      this.prev[i] = this.pos[i].clone().addScaledVector(v, -STEP);
    }
    for (let i = 0; i < TORSO.length; i++) for (let j = i + 1; j < TORSO.length; j++) this.rod(TORSO[i], TORSO[j], 1, false);
    for (const [a, b] of BONES) this.rod(a, b, 1, false);
    for (const [a, b, k] of APART) this.rod(a, b, k, true);

    // Driven bones (parents before children), each with a frame: primary along a limb, secondary for its twist.
    const side = [P.lSh, P.rSh] as const;
    const drive = (n: string, a: number, b: number, c: number, d: number) => {
      const bone = bones.get(n)!;
      const f = this.frame(a, b, c, d, _f);
      const q = bone.getWorldQuaternion(new THREE.Quaternion());
      this.driven.push({ bone, a, b, c, d, offset: f.clone().invert().multiply(q) });
    };
    drive('Hips', P.pelvis, P.chest, P.lHip, P.rHip);
    drive('Neck', P.neck, P.head, side[0], side[1]);
    drive('LeftArm', P.lSh, P.lElbow, P.lElbow, P.lHand);
    drive('LeftForeArm', P.lElbow, P.lHand, P.lSh, P.lElbow);
    drive('RightArm', P.rSh, P.rElbow, P.rElbow, P.rHand);
    drive('RightForeArm', P.rElbow, P.rHand, P.rSh, P.rElbow);
    drive('LeftUpLeg', P.lHip, P.lKnee, P.lKnee, P.lAnkle);
    drive('LeftLeg', P.lKnee, P.lAnkle, P.lAnkle, P.lToe);
    drive('LeftFoot', P.lAnkle, P.lToe, P.lKnee, P.lAnkle);
    drive('RightUpLeg', P.rHip, P.rKnee, P.rKnee, P.rAnkle);
    drive('RightLeg', P.rKnee, P.rAnkle, P.rAnkle, P.rToe);
    drive('RightFoot', P.rAnkle, P.rToe, P.rKnee, P.rAnkle);
    this.hips = bones.get('Hips')!;
  }

  private rod(a: number, b: number, k: number, min: boolean) {
    this.rods.push({ a, b, len: this.pos[a].distanceTo(this.pos[b]) * k, min });
  }

  /** The pelvis (world), where the camera looks while you are down. */
  center(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.pos[P.pelvis]);
  }

  /** Step the body and pose the bones to it. */
  update(dt: number) {
    if (!this.asleep) {
      this.acc = Math.min(this.acc + dt, 0.1);
      while (this.acc >= STEP) {
        this.acc -= STEP;
        this.step();
      }
    }
    this.pose();
  }

  private step() {
    let fastest = 0;
    for (let i = 0; i < this.pos.length; i++) {
      const p = this.pos[i], q = this.prev[i];
      _v.subVectors(p, q).multiplyScalar(AIR_DAMP);
      q.copy(p);
      p.add(_v);
      p.y -= GRAVITY * STEP * STEP;
      fastest = Math.max(fastest, _v.length() / STEP);
    }
    for (let it = 0; it < ITERATIONS; it++) {
      for (const r of this.rods) {
        const a = this.pos[r.a], b = this.pos[r.b];
        _v.subVectors(b, a);
        const d = _v.length();
        if (d < 1e-6 || (r.min && d >= r.len)) continue;
        _v.multiplyScalar((0.5 * (d - r.len)) / d);
        a.add(_v);
        b.sub(_v);
      }
      this.collide();
    }
    // Asleep once it has lain still for half a second (it stays where it is until the respawn).
    this.still = fastest < REST_SPEED ? this.still + STEP : 0;
    if (this.still > 0.5) this.asleep = true;
  }

  /** Keep every particle above the sand; sliding along it loses speed. */
  private collide() {
    for (let i = 0; i < this.pos.length; i++) {
      const p = this.pos[i], q = this.prev[i];
      const floor = this.ground(p.x, p.z) + (i === P.head ? HEAD_RADIUS : RADIUS);
      if (p.y >= floor) continue;
      p.y = floor;
      if (q.y > floor) q.y = floor + (q.y - floor) * 0.2; // most of the bounce is soaked up by the sand
      q.x = p.x + (q.x - p.x) * FRICTION;
      q.z = p.z + (q.z - p.z) * FRICTION;
    }
  }

  /** Orthonormal frame (as a rotation) with x along a→b and the c→d direction in its xy plane. */
  private frame(a: number, b: number, c: number, d: number, out: THREE.Quaternion): THREE.Quaternion {
    _x.subVectors(this.pos[b], this.pos[a]).normalize();
    _y.subVectors(this.pos[d], this.pos[c]);
    _z.crossVectors(_x, _y);
    if (_z.lengthSq() < 1e-8) _z.crossVectors(_x, Math.abs(_x.y) < 0.9 ? UP : SIDE);
    _z.normalize();
    _y.crossVectors(_z, _x);
    return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
  }

  private pose() {
    // The hips go where the pelvis is.
    const parent = this.hips.parent!;
    parent.updateMatrixWorld(true);
    this.hips.position.copy(parent.worldToLocal(_p.copy(this.pos[P.pelvis])));
    for (const d of this.driven) {
      const world = this.frame(d.a, d.b, d.c, d.d, _f).multiply(d.offset);
      d.bone.parent!.getWorldQuaternion(_pq);
      d.bone.quaternion.copy(_pq.invert().multiply(world));
      d.bone.updateMatrixWorld(true);
    }
  }

  /** Put every bone back as it was when the body fell. */
  restore() {
    for (const s of this.saved) {
      s.bone.position.copy(s.p);
      s.bone.quaternion.copy(s.q);
    }
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const SIDE = new THREE.Vector3(1, 0, 0);
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _f = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
