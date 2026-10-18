// Crouching, posed procedurally over the 'Crouch' clip (src/models/scavenger.ts): hips low and back, knees
// deep and pushed forward over flat feet, the torso leant forward, and short steps whose phase follows the
// ground actually covered (a planted foot moves back under the body at exactly the travel speed, so it
// doesn't skate and the leg IK can pin it). Runs after the mixer, before the hip yaw (which turns the legs
// toward the travel direction) and the leg IK (terrain, foot locking).
//
//   const gait = new CrouchGait(root, model, bones);
//   gait.restore();                       // before mixer.update(): undo last frame's hips move
//   mixer.update(dt);
//   gait.apply(dt, crouching, speed, dir); // 0 weight: no-op (the clips are untouched)
import * as THREE from 'three/webgpu';

/** Root space: forward is -Z, origin at the feet. */
const HIP_Y = 0.62; // hip joint height crouched still (standing ≈ 0.93)
const HIP_Y_MOVING = 0.58; // ...lower while stepping
const HIP_BACK = 0.07; // hips sit back behind the feet (m, +Z)
const ANKLE_Y = 0.084; // ankle height with the foot flat (the standing clips' planted ankle)
const FOOT_OUT = 0.155; // ankle distance from the centre line: knees and feet a little wider than standing
/** Ground covered by a planted foot relative to the hips (m); with the stance share this sets the cadence. */
export const CROUCH_STEP = 0.55;
const STANCE = 0.62; // share of the cycle each foot is down (> 0.5: both feet down for a moment, a careful gait)
/** Ground covered per full cycle (two steps), m. */
export const CROUCH_CYCLE = CROUCH_STEP / STANCE;
const LIFT = 0.09; // swing foot clearance (m)
const LEAN = 0.2; // extra forward lean of the torso over the clip's, still / moving (rad)
const LEAN_MOVING = 0.32;
const ARM_SWING = 0.12; // arms held in, swinging a little against the legs (rad)
const STAGGER = 0.05; // standing still: left foot a little ahead, right a little back (m)

export type CrouchBones = {
  hips: THREE.Object3D;
  spine: THREE.Object3D;
  neck: THREE.Object3D | null;
  head: THREE.Object3D | null;
  /** Thigh, shin, foot (left, right). */
  legs: THREE.Object3D[][];
  /** Upper arms (left, right), or empty. */
  arms: THREE.Object3D[];
};

export class CrouchGait {
  /** 0 standing .. 1 crouched (eased, alongside the mixer's crossfade to 'Crouch'). */
  weight = 0;
  /** 0 still .. 1 stepping (eased from the speed). */
  private move = 0;
  /** Gait cycle position (0..1): left foot touches down at 0, right at 0.5. */
  private phase = 0;
  private root: THREE.Object3D;
  private b: CrouchBones;
  private hipsBase = new THREE.Vector3();
  private moved = false;
  /** Each foot's root-space orientation in the rest pose (flat on the ground, toes ahead). */
  private footRest: THREE.Quaternion[];

  constructor(root: THREE.Object3D, model: THREE.Object3D, bones: CrouchBones) {
    this.root = root;
    this.b = bones;
    model.updateMatrixWorld(true);
    root.getWorldQuaternion(_rq).invert();
    this.footRest = bones.legs.map((l) => l[2].getWorldQuaternion(new THREE.Quaternion()).premultiply(_rq));
  }

  /** Before mixer.update(): put the hips back where the clip had them (a constant track isn't rewritten). */
  restore() {
    if (this.moved) this.b.hips.position.copy(this.hipsBase);
    this.moved = false;
  }

  /**
   * After mixer.update(). `crouching`: crouched on the ground (the 'Crouch' clip is playing or fading in);
   * `speed`: ground speed (m/s); `dir`: 1 stepping forward, -1 backing up.
   */
  apply(dt: number, crouching: boolean, speed: number, dir: number) {
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    this.weight += ((crouching ? 1 : 0) - this.weight) * k(12);
    if (this.weight < 1e-3) {
      this.weight = 0;
      return;
    }
    this.move += ((crouching ? Math.min(1, speed / 0.6) : 0) - this.move) * k(8);
    // One cycle per CROUCH_CYCLE metres: the planted foot keeps pace with the ground.
    if (crouching) this.phase = (this.phase + (speed * dt) / CROUCH_CYCLE) % 1;
    const w = this.weight, m = this.move;
    const b = this.b, root = this.root;
    root.updateMatrixWorld(true);

    // Hips: low and back, dipping as each foot takes the weight (twice a cycle).
    const bob = -0.012 * m * Math.cos(4 * Math.PI * (this.phase - 0.08));
    this.hipsBase.copy(b.hips.position);
    this.moved = true;
    b.hips.getWorldPosition(_a);
    _t.set(0, HIP_Y + (HIP_Y_MOVING - HIP_Y) * m + bob, HIP_BACK);
    // The joint of the thigh sits a little under the hips bone; aim that at the height above.
    b.legs[0][0].getWorldPosition(_c);
    _t.y += _a.y - _c.y;
    root.localToWorld(_t);
    _t.lerp(_a, 1 - w);
    const parent = b.hips.parent!;
    b.hips.position.add(parent.worldToLocal(_t.clone()).sub(parent.worldToLocal(_a.clone())));
    b.hips.updateMatrixWorld(true);

    // Torso forward, the head tipped back up to keep looking ahead; shoulders turning a little with the steps.
    // `sway` follows the left foot (+ while it is behind, as the right one comes through).
    const sway = Math.sin(2 * Math.PI * (this.phase - 0.31)) * m;
    const lean = (LEAN + (LEAN_MOVING - LEAN) * m) * w;
    rotateAboutRoot(root, b.spine, X_AXIS, -lean);
    rotateAboutRoot(root, b.spine, Y_AXIS, -0.06 * sway * dir * w);
    if (b.neck) rotateAboutRoot(root, b.neck, X_AXIS, lean * 0.45);
    if (b.head) rotateAboutRoot(root, b.head, X_AXIS, lean * 0.35);
    // Arms in close, swinging a touch against the legs (each arm forward as its own foot goes back).
    for (let i = 0; i < b.arms.length; i++) {
      const side = i === 0 ? -1 : 1; // root space: the left arm is at -X
      rotateAboutRoot(root, b.arms[i], Z_AXIS, -side * 0.12 * w);
      rotateAboutRoot(root, b.arms[i], X_AXIS, -side * ARM_SWING * sway * dir * w);
    }
    b.spine.updateMatrixWorld(true);

    // Legs: each ankle to its place in the cycle, knees forward and a little out, the foot kept flat.
    for (let i = 0; i < b.legs.length; i++) {
      const [thigh, shin, foot] = b.legs[i];
      const side = i === 0 ? -1 : 1;
      const u = (this.phase + (i === 0 ? 0 : 0.5)) % 1;
      let z: number, lift = 0;
      if (u < STANCE) {
        z = -0.5 + u / STANCE; // planted: front of the step to the back, at the ground's speed
      } else {
        const s = (u - STANCE) / (1 - STANCE);
        z = 0.5 - (s - Math.sin(2 * Math.PI * s) / (2 * Math.PI)); // swing: eased forward, still at both ends
        lift = Math.sin(Math.PI * s) ** 1.5;
      }
      z = z * CROUCH_STEP * dir * m + side * STAGGER * (1 - m);
      _t.set(side * FOOT_OUT, ANKLE_Y + LIFT * lift * m, z);
      foot.getWorldPosition(_a);
      root.localToWorld(_t).lerp(_a, 1 - w);
      _pole.set(side * 0.35, 0.2, -1).transformDirection(root.matrixWorld);
      reach(thigh, shin, foot, _t, _pole);
      // Flat foot (slerped from the clip's by the weight); the toes drop a little as it swings through.
      root.getWorldQuaternion(_rq);
      _fq.copy(_rq).multiply(this.footRest[i]);
      _fq.premultiply(_qa.setFromAxisAngle(_v.set(1, 0, 0).applyQuaternion(_rq), -0.35 * lift * m));
      foot.getWorldQuaternion(_wq);
      _wq.slerp(_fq, w);
      shin.getWorldQuaternion(_pq);
      foot.quaternion.copy(_pq.invert().multiply(_wq));
      foot.updateMatrixWorld(true);
    }
  }
}

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const _a = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _v = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _r = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Vector3();
const _w = new THREE.Vector3();
const _p = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _bend = new THREE.Vector3();
const _from = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _rq = new THREE.Quaternion();
const _fq = new THREE.Quaternion();
const _wq = new THREE.Quaternion();
const _pq = new THREE.Quaternion();

/** Two-bone IK: turn `upper` and `lower` so `end` reaches `target`, the middle joint bending towards `pole` (world). */
function reach(upper: THREE.Object3D, lower: THREE.Object3D, end: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3) {
  upper.getWorldPosition(_s);
  lower.getWorldPosition(_e);
  end.getWorldPosition(_w);
  const a = _s.distanceTo(_e), b = _e.distanceTo(_w);
  _dir.subVectors(target, _s);
  const d = Math.min(a + b - 1e-3, Math.max(Math.abs(a - b) + 1e-3, _dir.length()));
  _dir.normalize();
  const along = (a * a - b * b + d * d) / (2 * d);
  _bend.copy(pole).addScaledVector(_dir, -pole.dot(_dir)).normalize();
  _e.copy(_s).addScaledVector(_dir, along).addScaledVector(_bend, Math.sqrt(Math.max(0, a * a - along * along)));
  aim(upper, lower, _e);
  aim(lower, end, _r.copy(_s).addScaledVector(_dir, d));
}

/** Turn `bone` (the shortest way) so its child lies on the line towards `target` (world). */
function aim(bone: THREE.Object3D, child: THREE.Object3D, target: THREE.Vector3) {
  bone.getWorldPosition(_p);
  _from.subVectors(child.getWorldPosition(_w), _p).normalize();
  _q.setFromUnitVectors(_from, _v.subVectors(target, _p).normalize());
  bone.getWorldQuaternion(_wq);
  bone.parent!.getWorldQuaternion(_pq);
  bone.quaternion.copy(_pq.invert().multiply(_q).multiply(_wq));
  bone.updateMatrixWorld(true);
}

/** Rotate `bone` by `angle` about one of the root's local axes (about X, + = tip back for a model facing -Z). */
function rotateAboutRoot(root: THREE.Object3D, bone: THREE.Object3D, axis: THREE.Vector3, angle: number) {
  _v.copy(axis).transformDirection(root.matrixWorld);
  bone.getWorldQuaternion(_q);
  _v.applyQuaternion(_q.invert());
  bone.quaternion.multiply(_qa.setFromAxisAngle(_v, angle));
}
