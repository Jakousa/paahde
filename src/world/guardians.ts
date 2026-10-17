// The walkers (shared/guardians.ts): giant three- and four-legged guardians and the player-sized crawlers, one
// rig at different scales (KINDS). The server says where each body is
// and which way it faces; the legs are procedural, here, on every client:
//
// - Every foot has a rest spot on the ground (REST_R out along its hip socket, turned with the body, led ahead by
//   the body's velocity). A planted foot stays exactly where it landed until its rest spot has drifted STEP_DIST
//   away (or the body has stopped and it's a little off: it settles).
// - Gait: few feet in the air at once, chosen by who is furthest behind. Four legs walk one foot at a time (a slow,
//   heavy wave gait) and diagonal pairs together when hunting; three legs always one at a time. A step lands
//   ahead of the rest spot (by half a step's travel), so the feet lead the body instead of dragging behind it.
// - A swing follows the rest spot as it moves, lifted on a sine arc, eased in and out; it lands with a thud
//   (onFootfall: sound, dust, camera shake) and the body dips on a spring under the weight.
// - The body rides BODY_H over the average height of its feet, pitched and rolled to the plane through them.
// - Each leg is two-bone IK from the hip to the ankle above the foot, the knee bent up and outwards: hip turret
//   yawed to the foot, femur and tibia aimed with explicit bases, the foot flat on the sand.
//
// - The cannon hangs under the body: the turret yaws and the gun pitches (slewing, not snapping) towards the
//   point the server says it aims at, droops forward when idle, glows up as it charges and kicks back on firing.
//
// Models: public/models/guardian.glb (tools/blender/guardians.py), one separate node per part with its origin
// at its joint; boxes stand in until it has loaded.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ANKLE, BODY_H, CRAWLER, FEMUR, GUN_MOUNT, GUN_PIVOT, KINDS, MUZZLE, REST_R, SOCKETS, TIBIA } from '../../shared/guardians.ts';
import { heightAt, normalAt } from '../../shared/terrain.ts';
import type { GuardianFrame } from './botFrames.ts';

/** Drawn within this distance (m), by kind. Lengths and times below are for scale 1; a walker of scale s uses
 *  lengths × s and times × √s (dynamic similarity: small legs swing quicker). */
const SHOW_R = [2000, 260];
/** A planted foot steps once its rest spot is this far away (m); a stopped body settles feet off by SETTLE. */
const STEP_DIST = 9;
const SETTLE = 1.2;
/** Swing time bounds (s) and the lift (m) for a step of length d: LIFT + LIFT_K·d. */
const STEP_MIN = 0.6, STEP_MAX = 1.5;
const LIFT = 1.6, LIFT_K = 0.22;
/** Body spring: stiffness, damping, and the dip when a foot lands (m/s). */
const SPRING_K = 9, SPRING_C = 4.5, LAND_DIP = 0.9;
/** Body tilt limit (radians). */
const MAX_TILT = 0.2;

export type Footfall = { x: number; y: number; z: number; /** 0..1 how hard */ weight: number; /** KINDS index */ kind: number };

type Part = 'body3' | 'body4' | 'hip' | 'femur' | 'tibia' | 'foot' | 'turret' | 'gun';
const NODES: Record<Part, string> = {
  body3: 'Guardian_Body3', body4: 'Guardian_Body4', hip: 'Guardian_Hip', femur: 'Guardian_Femur', tibia: 'Guardian_Tibia', foot: 'Guardian_Foot',
  turret: 'Guardian_Turret', gun: 'Guardian_Gun',
};
/** Cannon slew rates (rad/s): heavy, so a quick sidestep gets ahead of it. */
const TURRET_RATE = 1.1, GUN_RATE = 0.8;
/** Idle: the gun droops this far (rad) below level. */
const GUN_IDLE = 0.5;
/** Recoil (m) on firing, recovering at this rate (per s). */
const RECOIL = 1.2, RECOIL_BACK = 3;

let parts: Record<Part, THREE.Object3D> | null = null;
let loading: Promise<void> | null = null;

/** Stand-in parts with the same origins as the real ones. */
function placeholders(): Record<Part, THREE.Object3D> {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x3a302a, roughness: 0.7, metalness: 0.5 });
  const eye = new THREE.MeshStandardNodeMaterial({ color: 0x220800, emissive: 0xff3a10, emissiveIntensity: 4 });
  eye.name = 'GuardianEye';
  const box = (w: number, h: number, d: number, z = 0, y = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, y, z);
    return new THREE.Mesh(g, m);
  };
  const body = (n: number) => {
    const o = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.CylinderGeometry(4, 3, 3.5, n * 2), m);
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.6), eye);
    e.position.set(0, 0.3, 3.6);
    o.add(hull, e);
    return o;
  };
  const foot = box(2.2, 0.6, 2.2, 0, 0.3);
  return {
    body3: body(3), body4: body(4), hip: new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), m),
    femur: box(1.2, 1.2, FEMUR, FEMUR / 2), tibia: box(0.8, 0.8, TIBIA, TIBIA / 2), foot, ...cannon(m),
  };
}

/** Stand-in turret and gun (until the model has them). */
function cannon(m: THREE.Material): { turret: THREE.Object3D; gun: THREE.Object3D } {
  const glow = new THREE.MeshStandardNodeMaterial({ color: 0x220800, emissive: 0xff3a10, emissiveIntensity: 1 });
  glow.name = 'GuardianGunGlow';
  const turret = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 0.9, 1.6, 10).translate(0, -0.8, 0), m);
  const gun = new THREE.Group();
  gun.add(new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 2.4).translate(0, 0, 0.2), m));
  gun.add(new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, MUZZLE - 1, 10).rotateX(Math.PI / 2).translate(0, 0, (MUZZLE + 1) / 2), m));
  gun.add(new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.12, 6, 12).translate(0, 0, MUZZLE - 0.3), glow));
  return { turret, gun };
}

/** Give `o` its own copies of the materials named `name` (to animate per guardian); returns them. */
function ownMaterials(o: THREE.Object3D, name: string): THREE.MeshStandardMaterial[] {
  const out: THREE.MeshStandardMaterial[] = [];
  o.traverse((c) => {
    const mesh = c as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const own = mats.map((mat) => {
      if (mat.name !== name) return mat;
      const copy = (mat as THREE.MeshStandardMaterial).clone();
      copy.userData.base = copy.emissiveIntensity;
      out.push(copy);
      return copy;
    });
    mesh.material = Array.isArray(mesh.material) ? own : own[0];
  });
  return out;
}

function load(): Promise<void> {
  if (loading) return loading;
  loading = new GLTFLoader().loadAsync('./models/guardian.glb').then(
    (gltf) => {
      const got = {} as Record<Part, THREE.Object3D>;
      for (const k of Object.keys(NODES) as Part[]) {
        const o = gltf.scene.getObjectByName(NODES[k]);
        if (!o && (k === 'turret' || k === 'gun')) {
          got[k] = cannon(new THREE.MeshStandardNodeMaterial({ color: 0x3a302a, roughness: 0.7, metalness: 0.5 }))[k];
          continue;
        }
        if (!o) throw new Error(`guardian.glb has no ${NODES[k]}`);
        o.parent?.remove(o);
        o.position.set(0, 0, 0);
        o.quaternion.identity();
        got[k] = o;
      }
      parts = got;
    },
    (e) => console.warn('guardians: model failed, using boxes', e),
  ) as Promise<void>;
  return loading;
}

/**
 * A part as at most two meshes (one draw call each instead of one per material): the lit materials merged with their
 * colours as vertex colours, the glowing ones (eyes, coils) likewise, unlit. For the crawlers, of which there are many.
 */
function flatten(o: THREE.Object3D): THREE.Object3D {
  const lit: THREE.BufferGeometry[] = [], glow: THREE.BufferGeometry[] = [];
  o.updateMatrixWorld(true);
  const inv = o.matrixWorld.clone().invert();
  o.traverse((c) => {
    const mesh = c as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const g = mesh.geometry.clone().applyMatrix4(inv.clone().multiply(mesh.matrixWorld));
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    const n = g.attributes.position.count, col = new Float32Array(n * 3);
    const emissive = (mat.emissiveIntensity ?? 0) > 0 && mat.emissive && mat.emissive.getHex() !== 0;
    const c3 = emissive ? mat.emissive.clone().multiplyScalar(3) : (mat.color ?? new THREE.Color(0.3, 0.3, 0.3));
    for (let i = 0; i < n; i++) col.set([c3.r, c3.g, c3.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    (emissive ? glow : lit).push(g.index ? g.toNonIndexed() : g);
  });
  const out = new THREE.Group();
  if (lit.length) out.add(new THREE.Mesh(mergeGeometries(lit)!, new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.5 })));
  if (glow.length) out.add(new THREE.Mesh(mergeGeometries(glow)!, new THREE.MeshBasicNodeMaterial({ vertexColors: true })));
  return out;
}

let flatParts: Record<Part, THREE.Object3D> | null = null;

function instance(o: THREE.Object3D): THREE.Object3D {
  const c = o.clone();
  c.traverse((m) => {
    m.castShadow = true;
    m.receiveShadow = false;
    m.matrixAutoUpdate = true;
  });
  return c;
}

type Leg = {
  /** Hip socket in the body frame, and the unit direction the leg splays out (body frame xz). */
  sx: number; sz: number; ox: number; oz: number;
  /** Diagonal pair (four legs) for the trot. */
  group: number;
  foot: THREE.Vector3;
  from: THREE.Vector3;
  /** Swing progress 0..1, or -1 planted. */
  t: number;
  dur: number;
  hip: THREE.Object3D; femur: THREE.Object3D; tibia: THREE.Object3D; footObj: THREE.Object3D;
};

const _v = new THREE.Vector3(), _h = new THREE.Vector3(), _a = new THREE.Vector3(), _k = new THREE.Vector3();
const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3();
const _z = new THREE.Vector3(), _n = { x: 0, y: 1, z: 0 }, _m = new THREE.Matrix4(), _r = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Point `o` along +Z from `from` to `to`, its +Y towards `pole` (perpendicular part), at `from`. */
function aim(o: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, pole: THREE.Vector3) {
  _z.subVectors(to, from).normalize();
  _x.crossVectors(pole, _z);
  if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0);
  _x.normalize();
  _y.crossVectors(_z, _x);
  _m.makeBasis(_x, _y, _z);
  o.quaternion.setFromRotationMatrix(_m);
  o.position.copy(from);
}

class Walker {
  root = new THREE.Group();
  body: THREE.Object3D;
  eyes: THREE.MeshStandardMaterial[] = [];
  legs: Leg[] = [];
  x: number; z: number; yaw: number;
  vx = 0; vz = 0;
  y: number; vy = 0;
  pitch = 0; roll = 0;
  still = 0;
  hunt = 0;
  /** Built from guardian.glb, not the stand-in boxes. */
  usesModel = false;
  private glow = 0;
  turret: THREE.Object3D;
  gun: THREE.Object3D;
  private glows: THREE.MeshStandardMaterial[];
  private gunYaw = 0;
  private gunPitch = GUN_IDLE;
  private charge = 0;
  private recoil = 0;

  private onFootfall: (f: Footfall) => void;
  /** Size (KINDS scale) and its time factor √scale. */
  readonly s: number;
  private ts: number;
  readonly kind: number;
  private noShadows = false;

  constructor(f: GuardianFrame, scene: THREE.Scene, p: Record<Part, THREE.Object3D>, onFootfall: (f: Footfall) => void) {
    this.onFootfall = onFootfall;
    this.kind = f.kind;
    this.s = KINDS[f.kind].scale;
    this.ts = Math.sqrt(this.s);
    this.x = f.x;
    this.z = f.z;
    this.yaw = f.yaw;
    this.y = heightAt(f.x, f.z) + BODY_H * this.s;
    this.body = instance(f.legs === 3 ? p.body3 : p.body4);
    // Own eye and gun-glow materials per guardian, so they can glow hotter while hunting and charging.
    this.eyes = ownMaterials(this.body, 'GuardianEye');
    this.turret = instance(p.turret);
    this.gun = instance(p.gun);
    this.glows = ownMaterials(this.gun, 'GuardianGunGlow');
    this.turret.position.set(0, GUN_MOUNT.y, GUN_MOUNT.z);
    this.gun.position.set(0, GUN_PIVOT, 0);
    this.turret.add(this.gun);
    this.body.add(this.turret);
    this.turret.visible = KINDS[f.kind].gun;
    this.body.scale.setScalar(this.s);
    this.root.add(this.body);
    if (f.kind === CRAWLER) this.noShadows = true;
    SOCKETS[f.legs].forEach(([sx, sz], i) => {
      const l = Math.hypot(sx, sz);
      const leg: Leg = {
        sx, sz, ox: sx / l, oz: sz / l, group: f.legs === 4 ? i % 2 : i, foot: new THREE.Vector3(), from: new THREE.Vector3(), t: -1, dur: 1,
        hip: instance(p.hip), femur: instance(p.femur), tibia: instance(p.tibia), footObj: instance(p.foot),
      };
      for (const o of [leg.hip, leg.femur, leg.tibia, leg.footObj]) o.scale.setScalar(this.s);
      this.rest(leg, 0, leg.foot);
      this.root.add(leg.hip, leg.femur, leg.tibia, leg.footObj);
      this.legs.push(leg);
    });
    if (this.noShadows) this.root.traverse((o) => (o.castShadow = false));
    scene.add(this.root);
  }

  /** Leg's rest spot on the ground, led `lead` seconds ahead along the body's velocity, into `out`. */
  private rest(leg: Leg, lead: number, out: THREE.Vector3) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const lx = leg.ox * REST_R * this.s, lz = leg.oz * REST_R * this.s;
    out.x = this.x + lx * c + lz * s + this.vx * lead;
    out.z = this.z - lx * s + lz * c + this.vz * lead;
    out.y = heightAt(out.x, out.z);
    return out;
  }

  update(f: GuardianFrame, dt: number) {
    if (dt <= 0) return;
    // Velocity from the interpolated track, smoothed (the server sends 10 Hz).
    const k = 1 - Math.exp(-dt * 3);
    this.vx += ((f.x - this.x) / dt - this.vx) * k;
    this.vz += ((f.z - this.z) / dt - this.vz) * k;
    // Teleported (debug, or back in range): stand it on its feet where it is now.
    if (Math.hypot(f.x - this.x, f.z - this.z) > 30 * this.s) {
      this.x = f.x;
      this.z = f.z;
      this.yaw = f.yaw;
      this.vx = this.vz = 0;
      this.y = heightAt(f.x, f.z) + BODY_H * this.s;
      for (const leg of this.legs) {
        leg.t = -1;
        this.rest(leg, 0, leg.foot);
      }
    }
    const turn = Math.atan2(Math.sin(f.yaw - this.yaw), Math.cos(f.yaw - this.yaw)) / dt;
    this.x = f.x;
    this.z = f.z;
    this.yaw = f.yaw;
    this.hunt = f.hunt;
    const speed = Math.hypot(this.vx, this.vz);
    // Turning on the spot moves the feet too: count it as speed at the feet.
    const S = this.s, T = this.ts;
    const footSpeed = speed + Math.abs(turn) * REST_R * S;
    this.still = footSpeed < 0.25 * T ? this.still + dt : 0;

    // Gait: how many feet may swing at once, and how long a swing takes so they keep up (Froude speed: speed/√s).
    const n = this.legs.length;
    const together = n === 4 && footSpeed / T > 3.2 ? 2 : 1;
    const dur = Math.min(STEP_MAX * T, Math.max(STEP_MIN * T, (0.8 * STEP_DIST * S * together) / (Math.max(0.5 * T, footSpeed) * n)));

    for (const leg of this.legs) {
      if (leg.t < 0) continue;
      leg.t = Math.min(1, leg.t + dt / leg.dur);
      // The landing spot follows the rest spot as the body moves on, led by half the swing's travel.
      this.rest(leg, leg.dur * 0.5, _p);
      const e = leg.t * leg.t * (3 - 2 * leg.t);
      const span = Math.hypot(_p.x - leg.from.x, _p.z - leg.from.z);
      leg.foot.lerpVectors(leg.from, _p, e);
      leg.foot.y += Math.sin(Math.PI * Math.pow(leg.t, 0.8)) * (LIFT * S + LIFT_K * span);
      if (leg.t >= 1) {
        leg.t = -1;
        leg.foot.copy(_p);
        this.vy -= LAND_DIP * T * Math.min(1, span / (STEP_DIST * S) + 0.3);
        this.onFootfall({ x: _p.x, y: _p.y, z: _p.z, weight: Math.min(1, 0.4 + span / (STEP_DIST * S)), kind: this.kind });
      }
    }
    // Who steps next: the planted foot furthest from its rest spot, if the gait allows.
    let swinging = 0, group = -1;
    for (const leg of this.legs) if (leg.t >= 0) {
      swinging++;
      group = leg.group;
    }
    while (swinging < together) {
      let best: Leg | null = null, bestErr = 0;
      for (const leg of this.legs) {
        if (leg.t >= 0 || (group >= 0 && leg.group !== group)) continue;
        this.rest(leg, 0, _p);
        const err = Math.hypot(_p.x - leg.foot.x, _p.z - leg.foot.z);
        const need = (this.still > 0.6 * T ? SETTLE : STEP_DIST) * S;
        if (err > need && err > bestErr) {
          best = leg;
          bestErr = err;
        }
      }
      if (!best) break;
      best.t = 0;
      best.dur = this.still > 0.6 * T ? 1.1 * T : dur;
      best.from.copy(best.foot);
      group = best.group;
      swinging++;
    }

    // Body: over the feet's average ground, tilted to their plane, on a spring.
    let gy = 0, sp = 0, sr = 0, pp = 0, rr = 0;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    for (const leg of this.legs) {
      const fy = leg.t >= 0 ? heightAt(leg.foot.x, leg.foot.z) : leg.foot.y;
      gy += fy;
    }
    gy /= n;
    for (const leg of this.legs) {
      const fy = (leg.t >= 0 ? heightAt(leg.foot.x, leg.foot.z) : leg.foot.y) - gy;
      const dx = leg.foot.x - this.x, dz = leg.foot.z - this.z;
      const lz = dx * s + dz * c, lx = dx * c - dz * s; // body frame: forward, side
      sp += fy * lz;
      pp += lz * lz;
      sr += fy * lx;
      rr += lx * lx;
    }
    const clamp = (v: number) => Math.max(-MAX_TILT, Math.min(MAX_TILT, v));
    const tk = 1 - Math.exp((-dt * 2) / T);
    this.pitch += (clamp(-Math.atan(sp / Math.max(1, pp))) - this.pitch) * tk;
    this.roll += (clamp(Math.atan(sr / Math.max(1, rr))) - this.roll) * tk;
    // Sags a little while feet are off the ground, and sways with the stride.
    const sag = this.legs.reduce((a, l) => a + (l.t >= 0 ? Math.sin(Math.PI * l.t) : 0), 0) * 0.35 * S;
    const target = gy + BODY_H * S - sag;
    this.vy += ((target - this.y) * (SPRING_K / (T * T)) - this.vy * (SPRING_C / T)) * dt;
    this.y += this.vy * dt;
    if (Math.abs(target - this.y) > 6 * S) this.y = target;

    this.body.position.set(this.x, this.y, this.z);
    this.body.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
    this.body.updateMatrixWorld();
    for (const leg of this.legs) this.pose(leg, dt);

    // The eye: hotter and pulsing while it hunts.
    this.glow += ((this.hunt ? 1 : 0) - this.glow) * (1 - Math.exp(-dt * 2));
    const pulse = this.glow * (0.6 + 0.4 * Math.sin(performance.now() / 120));
    for (const e of this.eyes) e.emissiveIntensity = (e.userData.base as number) * (1 + 3 * pulse);
    this.aimGun(f, dt);
  }

  /** Turret and gun towards the aim point (in the body's frame, so it follows the body's tilt). */
  private aimGun(f: GuardianFrame, dt: number) {
    let yaw = 0, pitch = GUN_IDLE;
    if (f.gun >= 0) {
      _v.set(f.ax, f.ay, f.az);
      this.body.worldToLocal(_v);
      _v.y -= GUN_MOUNT.y + GUN_PIVOT;
      _v.z -= GUN_MOUNT.z;
      yaw = Math.atan2(_v.x, _v.z);
      pitch = Math.atan2(-_v.y, Math.hypot(_v.x, _v.z));
    }
    const slew = (from: number, to: number, rate: number) => {
      const d = Math.atan2(Math.sin(to - from), Math.cos(to - from));
      return from + Math.max(-rate * dt, Math.min(rate * dt, d));
    };
    this.gunYaw = slew(this.gunYaw, yaw, TURRET_RATE);
    this.gunPitch = slew(this.gunPitch, Math.max(-0.35, Math.min(1.4, pitch)), GUN_RATE);
    this.turret.rotation.set(0, this.gunYaw, 0);
    this.recoil = Math.max(0, this.recoil - RECOIL_BACK * dt);
    this.gun.rotation.set(this.gunPitch, 0, 0);
    this.gun.position.set(0, GUN_PIVOT, 0).addScaledVector(_z.set(0, Math.sin(this.gunPitch), -Math.cos(this.gunPitch)), this.recoil);
    // Charging: the coils brighten and flicker faster; after a shot they fade.
    this.charge += ((f.gun === 1 ? 1 : 0) - this.charge) * (1 - Math.exp(-dt * (f.gun === 1 ? 2.5 : 4)));
    const flicker = 0.85 + 0.15 * Math.sin(performance.now() / (60 - 40 * this.charge));
    for (const g of this.glows) g.emissiveIntensity = (g.userData.base as number) * (0.4 + 6 * this.charge * flicker + 4 * this.recoil);
  }

  /** It fired: kick the gun back. The muzzle's world position goes into `out`. */
  fire(out: THREE.Vector3) {
    this.recoil = RECOIL;
    this.charge = 0;
    return this.muzzle(out);
  }

  muzzle(out: THREE.Vector3) {
    this.gun.updateWorldMatrix(true, false);
    return out.set(0, 0, MUZZLE).applyMatrix4(this.gun.matrixWorld);
  }

  /** Two-bone IK from the hip socket to the ankle over the foot. */
  private pose(leg: Leg, _dt: number) {
    _h.set(leg.sx, 0, leg.sz).applyMatrix4(this.body.matrixWorld);
    // Foot flat on the sand (tipped toes-down mid-swing), its +Z pointing away from the body.
    normalAt(leg.foot.x, leg.foot.z, _n);
    _d.set(leg.foot.x - this.x, 0, leg.foot.z - this.z).normalize();
    const air = leg.t >= 0 ? Math.sin(Math.PI * leg.t) : 0;
    _y.set(_n.x, _n.y, _n.z).lerp(UP, air).addScaledVector(_d, -0.5 * air).normalize();
    _x.crossVectors(_y, _d).normalize();
    _z.crossVectors(_x, _y);
    _m.makeBasis(_x, _y, _z);
    leg.footObj.quaternion.setFromRotationMatrix(_m);
    leg.footObj.position.copy(leg.foot);
    const S = this.s, F = FEMUR * S, L = TIBIA * S;
    _a.copy(leg.foot).addScaledVector(_y, ANKLE * S);
    // Knee: bent up and out, in the plane through hip, ankle and the pole.
    _v.subVectors(_a, _h);
    const len = Math.min(F + L - 0.01 * S, Math.max(Math.abs(L - F) + 0.1 * S, _v.length()));
    _v.normalize();
    _r.copy(_d).multiplyScalar(0.35).add(UP).normalize(); // pole
    _p.copy(_r).addScaledVector(_v, -_r.dot(_v)).normalize();
    const along = (F * F - L * L + len * len) / (2 * len);
    const up = Math.sqrt(Math.max(0, F * F - along * along));
    _k.copy(_h).addScaledVector(_v, along).addScaledVector(_p, up);
    // Out-of-reach ankle: the tibia points at it from the knee anyway.
    leg.hip.position.copy(_h);
    leg.hip.rotation.set(this.pitch * 0.5, Math.atan2(_d.x, _d.z), 0, 'YXZ');
    aim(leg.femur, _h, _k, _r);
    aim(leg.tibia, _k, _a, _r);
  }

  dispose() {
    this.root.removeFromParent();
    for (const e of [...this.eyes, ...this.glows]) e.dispose();
  }
}

export class Guardians {
  private walkers = new Map<number, Walker>();
  /** Every foot that lands (src/guardianSound.ts, dust, shake). */
  onFootfall: (f: Footfall) => void = () => {};

  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    void load();
  }

  update(frames: GuardianFrame[], dt: number, focus: { x: number; z: number }) {
    const seen = new Set<number>();
    for (const f of frames) {
      if (Math.hypot(f.x - focus.x, f.z - focus.z) > SHOW_R[f.kind]) continue;
      seen.add(f.id);
      let w = this.walkers.get(f.id);
      if (!w) {
        if (!parts && !loading) void load();
        // Crawlers get the merged parts (cheap), without shadows.
        if (parts && f.kind === CRAWLER && !flatParts) {
          flatParts = Object.fromEntries((Object.keys(parts) as Part[]).map((k) => [k, flatten(parts![k])])) as Record<Part, THREE.Object3D>;
        }
        const p = parts ? (f.kind === CRAWLER ? flatParts! : parts) : (this.fallback ??= placeholders());
        this.walkers.set(f.id, (w = new Walker(f, this.scene, p, (e) => this.onFootfall(e))));
        w.usesModel = parts !== null;
      } else if (!w.usesModel && parts) {
        // The model arrived: swap the boxes out.
        w.dispose();
        this.walkers.delete(f.id);
        seen.delete(f.id);
        continue; // made from the model next frame
      }
      w.update(f, dt);
    }
    for (const [id, w] of this.walkers) {
      if (seen.has(id)) continue;
      w.dispose();
      this.walkers.delete(id);
    }
  }

  /** Guardian `id` fired: its gun recoils; its muzzle (world) into `out`, or null if it isn't drawn. */
  fire(id: number, out: THREE.Vector3): THREE.Vector3 | null {
    return this.walkers.get(id)?.fire(out) ?? null;
  }

  /** Bodies, for sound and the locator: position, height, whether it hunts you. */
  *bodies(): Generator<{ x: number; y: number; z: number; hunt: number; speed: number; kind: number }> {
    for (const w of this.walkers.values()) yield { x: w.x, y: w.y, z: w.z, hunt: w.hunt, speed: Math.hypot(w.vx, w.vz), kind: w.kind };
  }

  private fallback?: Record<Part, THREE.Object3D>;
}
