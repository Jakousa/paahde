// Feet that stick to the sand: runs after the animation mixer on a skinned character.
//
//   1. Terrain: each foot target is lifted/lowered by the ground height under it relative to under the
//      root, and the whole body drops so the lower foot can still reach (pelvis drop).
//   2. Locking: while the clip says a foot is planted (ankle near the clip's lowest ankle height), it is
//      pinned where it landed in the world; it lets go when the clip lifts it or when it has been dragged
//      too far (turning in place, network corrections), and the offset then eases back out.
//   3. Two-bone IK (Holden, "Simple Two Joint IK") puts the ankle on the target, keeping the knee in the
//      plane the animation bent it in; the foot keeps its animated world orientation, tilted to the slope.
//
// References: theorangeduck.com/page/simple-two-joint, theorangeduck.com/page/code-vs-data-driven-displacement.
import * as THREE from 'three/webgpu';

export type Ground = (x: number, z: number) => number;

const LOCK_ON = 0.03; // ankle within this of the clip's lowest ankle = planted (m)
const SWING = 0.4; // ...and not moving forward faster than this relative to the body (m/s): a swinging foot comes in low
const DRAG_RELEASE = 0.2; // a locked foot let go when the animated foot is this far away (m)
const TWIST_RELEASE = 0.6; // ...or when the body has turned this much since it planted (rad; staggered per leg)
const RELEASE_HALF_LIFE = 0.06; // s
const RELOCK = 0.02; // a released foot may plant again once within this of the animated foot (m)
const MAX_DROP = 0.3; // pelvis drop limit (m)
const MAX_TILT = 0.5; // foot slope alignment limit (rad)
const TELEPORT = 1.5; // root jumps further than this in a frame → drop all locks (m)

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _ca = new THREE.Vector3();
const _ba = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _cb = new THREE.Vector3();
const _ta = new THREE.Vector3();
const _ax0 = new THREE.Vector3();
const _ax1 = new THREE.Vector3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qf = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _qr = new THREE.Quaternion();
const _qs = new THREE.Quaternion();

class Leg {
  locked = false;
  lock = new THREE.Vector3(); // world position the planted ankle is pinned to
  lockYaw = 0; // body yaw when it planted
  offset = new THREE.Vector3(); // ankle target − animated ankle, eased to 0 after a release
  prevLocal = new THREE.Vector3(NaN, NaN, NaN); // animated ankle in root space, last frame
  readonly hip: THREE.Object3D;
  readonly knee: THREE.Object3D;
  readonly ankle: THREE.Object3D;
  constructor(hip: THREE.Object3D, knee: THREE.Object3D, ankle: THREE.Object3D) {
    this.hip = hip;
    this.knee = knee;
    this.ankle = ankle;
  }
}

export class LegIk {
  private root: THREE.Object3D;
  private body: THREE.Object3D;
  private legs: Leg[];
  private drop = 0;
  private weight = 0;
  private last = new THREE.Vector3(NaN, NaN, NaN);

  /** `body` is moved down for the pelvis drop (the animated model under the placement root). */
  constructor(root: THREE.Object3D, body: THREE.Object3D, legs: [THREE.Object3D, THREE.Object3D, THREE.Object3D][]) {
    this.root = root;
    this.body = body;
    this.legs = legs.map(([h, k, a]) => new Leg(h, k, a));
  }

  /**
   * After mixer.update(). `minAnkle` is the current clip's lowest ankle height above the feet (model
   * space, from footContact()), or null to skip locking (airborne, sliding). `ground` null = flat.
   */
  update(dt: number, grounded: boolean, minAnkle: number | null, ground: Ground | null) {
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    this.root.getWorldPosition(_v);
    if (!(this.last.distanceTo(_v) < TELEPORT)) for (const l of this.legs) this.release(l, true);
    this.last.copy(_v);
    const rootX = _v.x, rootY = _v.y, rootZ = _v.z;
    const g0 = ground ? ground(rootX, rootZ) : 0;
    _v.set(0, 0, -1).transformDirection(this.root.matrixWorld);
    const yaw = Math.atan2(-_v.x, -_v.z);

    this.weight += ((grounded ? 1 : 0) - this.weight) * k(grounded ? 8 : 20);
    if (this.weight < 0.01) {
      this.body.position.y = this.drop = 0;
      for (const l of this.legs) this.release(l, true);
      return;
    }

    // Animated ankle positions (before the pelvis drop) and the targets they want.
    this.body.position.y = 0;
    this.root.updateMatrixWorld(true);
    const targets: THREE.Vector3[] = [];
    let lowest = 0;
    const decay = Math.pow(0.5, dt / RELEASE_HALF_LIFE);
    for (let i = 0; i < this.legs.length; i++) {
      const l = this.legs[i];
      const anim = l.ankle.getWorldPosition(new THREE.Vector3());
      const local = this.root.worldToLocal(_n.copy(anim));
      const forward = (l.prevLocal.z - local.z) / Math.max(dt, 1e-4); // root faces -Z
      l.prevLocal.copy(local);
      const planted = minAnkle !== null && anim.y - rootY < minAnkle + LOCK_ON && !(forward > SWING);
      // After a release, step back under the body before planting again (else it re-pins in place).
      if (planted && !l.locked && l.offset.lengthSq() < RELOCK * RELOCK) {
        l.locked = true;
        l.lock.copy(anim).add(l.offset); // land where the eased foot is, so nothing pops
        l.lockYaw = yaw;
      } else if (!planted && l.locked) {
        this.release(l, false, anim);
      }
      const twist = Math.abs(Math.atan2(Math.sin(yaw - l.lockYaw), Math.cos(yaw - l.lockYaw)));
      if (l.locked && (Math.hypot(l.lock.x - anim.x, l.lock.z - anim.z) > DRAG_RELEASE || twist > TWIST_RELEASE * (i === 0 ? 0.8 : 1.2))) {
        this.release(l, false, anim);
      }
      if (!l.locked) l.offset.multiplyScalar(decay);
      const t = l.locked ? new THREE.Vector3(l.lock.x, anim.y, l.lock.z) : anim.clone().add(l.offset);
      const rise = ground ? ground(t.x, t.z) - g0 : 0;
      t.y += rise;
      lowest = Math.min(lowest, rise);
      targets.push(t);
    }

    // Drop the body so the lower foot is in reach (uphill feet bend the knee instead).
    this.drop += (Math.max(lowest, -MAX_DROP) - this.drop) * k(12);
    this.body.position.y = this.drop * this.weight;
    this.root.updateMatrixWorld(true);

    for (let i = 0; i < this.legs.length; i++) {
      const l = this.legs[i];
      const t = targets[i];
      l.ankle.getWorldPosition(_c);
      t.lerp(_c, 1 - this.weight);
      l.ankle.getWorldQuaternion(_qf); // animated foot orientation, kept through the IK
      solveTwoBone(l.hip, l.knee, l.ankle, t);
      let tilt = _qs.identity();
      if (ground) {
        const e = 0.15;
        _n.set(ground(t.x - e, t.z) - ground(t.x + e, t.z), 2 * e, ground(t.x, t.z - e) - ground(t.x, t.z + e)).normalize();
        const ang = Math.min(_n.angleTo(_up), MAX_TILT);
        if (ang > 1e-4) tilt = _qs.setFromAxisAngle(_v.crossVectors(_up, _n).normalize(), ang * this.weight);
      }
      // foot local = parentWorld⁻¹ · tilt · animatedWorld
      l.ankle.parent!.getWorldQuaternion(_qi).invert();
      l.ankle.quaternion.copy(_qi.multiply(tilt).multiply(_qf));
      l.ankle.updateMatrixWorld(true);
    }
  }

  /** Whether leg `i` is pinned to the ground this frame (for debugging/tests). */
  planted(i: number) {
    return this.legs[i].locked;
  }

  private release(l: Leg, hard: boolean, anim?: THREE.Vector3) {
    if (l.locked && !hard && anim) l.offset.set(l.lock.x - anim.x, 0, l.lock.z - anim.z);
    if (hard) l.offset.set(0, 0, 0);
    l.locked = false;
  }
}

/** Rotate hip and knee so the ankle reaches `t` (world), bending in the plane of the current pose. */
function solveTwoBone(hip: THREE.Object3D, knee: THREE.Object3D, ankle: THREE.Object3D, t: THREE.Vector3) {
  hip.getWorldPosition(_a);
  knee.getWorldPosition(_b);
  ankle.getWorldPosition(_c);
  const lab = _ba.subVectors(_b, _a).length();
  const lcb = _cb.subVectors(_b, _c).length();
  const lat = THREE.MathUtils.clamp(_ta.subVectors(t, _a).length(), 0.01, lab + lcb - 0.002);

  const acAb0 = Math.acos(clampDot(_ca.subVectors(_c, _a).normalize(), _v.copy(_ba).normalize()));
  const baBc0 = Math.acos(clampDot(_ab.subVectors(_a, _b).normalize(), _v.subVectors(_c, _b).normalize()));
  const acAt0 = Math.acos(clampDot(_ca, _v.copy(_ta).normalize()));
  const acAb1 = Math.acos(THREE.MathUtils.clamp((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat), -1, 1));
  const baBc1 = Math.acos(THREE.MathUtils.clamp((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb), -1, 1));

  _ax0.crossVectors(_ca, _ba);
  if (_ax0.lengthSq() < 1e-8) _ax0.set(1, 0, 0).transformDirection(hip.matrixWorld); // straight leg: bend about the hip's X
  _ax0.normalize();
  _ax1.crossVectors(_ca, _ta);
  const hasAx1 = _ax1.lengthSq() > 1e-10;
  _ax1.normalize();

  hip.getWorldQuaternion(_qa);
  knee.getWorldQuaternion(_qb);
  const inv = _qi.copy(_qa).invert();
  const r0 = _qr.setFromAxisAngle(_v.copy(_ax0).applyQuaternion(inv), acAb1 - acAb0);
  const r2 = hasAx1 ? new THREE.Quaternion().setFromAxisAngle(_v.copy(_ax1).applyQuaternion(inv), acAt0) : new THREE.Quaternion();
  hip.quaternion.multiply(r0.multiply(r2));
  const r1 = _qr.setFromAxisAngle(_v.copy(_ax0).applyQuaternion(_qb.invert()), baBc1 - baBc0);
  knee.quaternion.multiply(r1);
  hip.updateMatrixWorld(true);
}

function clampDot(a: THREE.Vector3, b: THREE.Vector3) {
  return THREE.MathUtils.clamp(a.dot(b), -1, 1);
}

/**
 * Lowest ankle height above the feet each clip reaches. Samples `model` with its own mixer, so pass
 * the shared, un-parented glTF scene (not a live instance) and cache the result.
 */
export function lowestAnkles(model: THREE.Object3D, clips: THREE.AnimationClip[], ankleNames: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const mixer = new THREE.AnimationMixer(model);
  const p = new THREE.Vector3();
  const ankles = ankleNames.map((n) => model.getObjectByName(n)).filter((o) => o !== undefined);
  const base = model.position.y;
  const rest: [THREE.Object3D, THREE.Vector3, THREE.Quaternion][] = [];
  model.traverse((o) => rest.push([o, o.position.clone(), o.quaternion.clone()]));
  for (const clip of clips) {
    const action = mixer.clipAction(clip).play();
    let lo = Infinity;
    for (let i = 0; i <= 24; i++) {
      mixer.setTime((clip.duration * i) / 24);
      model.updateMatrixWorld(true);
      for (const a of ankles) lo = Math.min(lo, a.getWorldPosition(p).y - base);
    }
    action.stop();
    out.set(clip.name, lo);
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(model);
  for (const [o, pos, q] of rest) {
    o.position.copy(pos);
    o.quaternion.copy(q);
  }
  model.updateMatrixWorld(true);
  return out;
}
