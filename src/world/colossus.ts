// The colossus (shared/colossus.ts) as drawn: a 67 m iron biped with a furnace in its chest. The server says where its
// hips are, which way it faces and where each foot stands or is stepping to (server/colossus.ts); the rest is here:
//
// - Each foot swings from where it stood to the server's spot in the time the server gives: heel up and rolled onto
//   the toes first, lifted on an arc (higher for a longer step), toes up before the heel strikes, flat on the sand.
//   A landing is a footfall: a deep boom carried a kilometre (src/colossusSound.ts), dust, the camera shaking (felt a
//   moment before it's heard). A planted foot sinks into the footprint it just dug.
// - The big stomp: the foot rises high over its prey and hangs there trembling (a hiss, the furnace flaring, the knee
//   pistons venting), then slams: a shockwave of dust, a long shake.
// - The hips ride HIP_H over the feet, dipping on a spring as each foot lands and rising as it passes, swaying over the
//   planted foot and rolling with it; the torso twists against the stride, the arms swing against the legs, the head
//   turns to its prey. Legs are two-bone IK from the hip sockets to the ankles, knees forward.
// - Weak points (src/world/bossParts.ts): the furnace core in its chest, both kneecaps, the two exhaust stacks on its back.
// - The shoulder pods (against a crowd, server/colossus.ts salvo): their lids swing up and the tube mouths blink red
//   with a klaxon; then each missile ('missile' bossFx: launch spot, landing spot, flight time, shoulder) climbs out of
//   its pod trailing smoke and arcs down (shared/colossus.ts missileAt), its landing spot glowing red on the sand, a
//   whistle over it before it bursts.
// - Dead: the furnace gutters, the knees buckle, and it topples like a felled tower along its fall direction (the
//   server's), hitting the sand FALL_S after it died (the server digs the furrow then); it smokes and, at the end,
//   sinks into the sand.
//
// Model: public/models/colossus.glb (tools/blender/colossus.py), one node per part with its origin at its joint;
// each part drawn as two merged meshes (lit and glowing), boxes standing in until it has loaded.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOSSES, type BossSnap } from '../../shared/bosses.ts';
import {
  ANKLE_H, BIG_LIFT, BIG_S, BUCKLE_S, CORE, CORE_R, FALL_S, FOREARM, HIP_H, HIP_X, HOLD_S, KNEE, KNEE_R, MISSILE_KILL_R,
  missileAt, MOOD_STOMP, NECK, POD, RAISE_S, S_FALL, S_FOOT, S_LOOK, S_MOOD, S_PODS, SALVO_TELL_S, SHIN, SHOULDER_X, SHOULDER_Y, SLAM_S, STRIDE, THIGH, UPPER_ARM, VENT, VENT_DIR, VENT_R, WAIST_Y,
} from '../../shared/colossus.ts';
import { float, length, smoothstep, uv, vec3 } from 'three/tsl';
import { heightAt, normalAt } from '../../shared/terrain.ts';
import { colossusSound } from '../colossusSound';
import { guardianSound } from '../guardianSound';
import { rifleSound } from '../rifleSound';
import { tyreDust } from '../tyreDust';
import { weakPoint, type BossCtx, type BossFxMsg, type BossView } from './bossParts';
import { zaps } from './zaps';

/** A normal step's lift (m): LIFT plus LIFT_K per metre of step. */
const LIFT = 3, LIFT_K = 0.13;
/** Hips: spring stiffness and damping, the dip (m/s) a footfall gives, the sway (m) over the planted foot, the roll
 *  (rad) with it, the torso's twist (rad) against the stride, the arms' swing (rad). */
const SPRING_K = 3.2, SPRING_C = 2.6, LAND_DIP = 2.4, SWAY = 1.6, ROLL = 0.045, TWIST = 0.09, ARM_SWING = 0.32;
/** Footfall camera shake: up to SHAKE m at the foot, falling off over SHAKE_D m; the big stomp's BIG_SHAKE over
 *  BIG_SHAKE_D, kept up for a while. The ground carries it at GROUND_SPEED m/s (felt before it's heard). */
const SHAKE = 0.9, SHAKE_D = 220, BIG_SHAKE = 1.5, BIG_SHAKE_D = 320, GROUND_SPEED = 1200;
/** Dead: the hips sink this far as the knees buckle; it falls this far over (rad) about a line this far ahead of its
 *  feet, and the wreck lies this much lower; it sinks in over the last SINK_S of the wreck's time. */
const BUCKLE_DROP = 8, FALL_ANGLE = 1.42, PIVOT_AHEAD = 5, REST_DROP = 2.5, SINK_S = 40, SINK_DEPTH = 22;
/** Wreck smoke puffs per second. */
const WRECK_SMOKE = 4;

type Part = 'pelvis' | 'torso' | 'head' | 'upperArm' | 'forearm' | 'thigh' | 'shin' | 'foot';
const NODES: Record<Part, string> = {
  pelvis: 'Colossus_Pelvis', torso: 'Colossus_Torso', head: 'Colossus_Head', upperArm: 'Colossus_UpperArm',
  forearm: 'Colossus_Forearm', thigh: 'Colossus_Thigh', shin: 'Colossus_Shin', foot: 'Colossus_Foot',
};

const litMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.65, metalness: 0.5 });

/** The shoulder pods (on struts on its upper back): a box of tubes (W × H × D m, its top at POD), a lid hinged at the back that swings up OPEN rad;
 *  the tube mouths (2 × 3) glow when open. */
const POD_W = 4.4, POD_H = 3.4, POD_D = 6, POD_OPEN = 1.9;
const podGeo = new THREE.BoxGeometry(POD_W, POD_H, POD_D).translate(0, -POD_H / 2, 0);
const lidGeo = new THREE.BoxGeometry(POD_W + 0.4, 0.5, POD_D + 0.3).translate(0, 0.25, POD_D / 2 + 0.15);
const strutGeo = new THREE.BoxGeometry(1.6, 4, 1.6).translate(0, -POD_H - 1.6, 0.5);
const mouthGeo = new THREE.CylinderGeometry(0.6, 0.6, 0.3, 10).translate(0, 0.05, 0);
const podMat = new THREE.MeshStandardNodeMaterial({ color: 0x2b2420, roughness: 0.6, metalness: 0.6 });
/** A missile: body along +Z, nose cone, four fins; its motor a glow sprite behind. */
const missileGeo = (() => {
  const body = new THREE.CylinderGeometry(0.35, 0.35, 3, 8).rotateX(Math.PI / 2);
  const nose = new THREE.ConeGeometry(0.35, 1, 8).rotateX(Math.PI / 2).translate(0, 0, 2);
  const fins = [0, 1].map((i) => new THREE.BoxGeometry(1.5, 0.06, 0.6).rotateZ((i * Math.PI) / 2).translate(0, 0, -1.3));
  return mergeGeometries([body.toNonIndexed(), nose.toNonIndexed(), ...fins.map((f) => f.toNonIndexed())]);
})();
const missileMat = new THREE.MeshStandardNodeMaterial({ color: 0x3a302a, roughness: 0.5, metalness: 0.6 });
/** The landing spot: a ring on the sand MISSILE_KILL_R across. */
const markGeo = new THREE.RingGeometry(0.82, 1, 40).rotateX(-Math.PI / 2);
const MARK_LIFT = 0.35;
/** Smoke puffs per second behind a missile. */
const TRAIL_RATE = 22;
/** The whistle starts this long (s) before a missile lands. */
const WHISTLE_S = 1.6;

function flareMat(r: number, g: number, b: number) {
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const f = float(1).sub(smoothstep(0, 1, length(uv().sub(0.5)).mul(2)));
  m.colorNode = vec3(r, g, b);
  m.opacityNode = f.mul(f).mul(f);
  return m;
}
const motorMat = flareMat(3.2, 1.3, 0.35);

type Missile = {
  t0: number; T: number; side: number; to: THREE.Vector3; from: THREE.Vector3 | null;
  mesh: THREE.Group; mark: THREE.Mesh; trail: number; whistled: boolean;
};
type Pod = { group: THREE.Group; lid: THREE.Group; open: number };

/** Merged geometries per part: lit (vertex colours) and glowing. */
type Geo = { lit: THREE.BufferGeometry | null; glow: THREE.BufferGeometry | null };
let geos: Record<Part, Geo> | null = null;
let loading: Promise<void> | null = null;

function flatten(o: THREE.Object3D): Geo {
  const lit: THREE.BufferGeometry[] = [], glow: THREE.BufferGeometry[] = [];
  o.updateMatrixWorld(true);
  const inv = o.matrixWorld.clone().invert();
  o.traverse((c) => {
    const mesh = c as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];
    const src = mesh.geometry.clone().applyMatrix4(inv.clone().multiply(mesh.matrixWorld));
    // One draw per material group in the glTF: split by groups (or the whole thing).
    const groups = src.groups.length ? src.groups : [{ start: 0, count: src.index ? src.index.count : src.attributes.position.count, materialIndex: 0 }];
    const flat = src.index ? src.toNonIndexed() : src;
    for (const g of groups) {
      const mat = mats[g.materialIndex ?? 0] ?? mats[0];
      const part = new THREE.BufferGeometry();
      for (const k of ['position', 'normal']) {
        const a = flat.attributes[k] as THREE.BufferAttribute;
        part.setAttribute(k, new THREE.BufferAttribute((a.array as Float32Array).slice(g.start * 3, (g.start + g.count) * 3), 3));
      }
      const n = g.count, col = new Float32Array(n * 3);
      const emissive = (mat.emissiveIntensity ?? 0) > 0 && mat.emissive && mat.emissive.getHex() !== 0;
      const c3 = emissive ? mat.emissive.clone().multiplyScalar(4) : (mat.color ?? new THREE.Color(0.3, 0.3, 0.3));
      for (let i = 0; i < n; i++) col.set([c3.r, c3.g, c3.b], i * 3);
      part.setAttribute('color', new THREE.BufferAttribute(col, 3));
      (emissive ? glow : lit).push(part);
    }
  });
  return { lit: lit.length ? mergeGeometries(lit) : null, glow: glow.length ? mergeGeometries(glow) : null };
}

function load(): Promise<void> {
  if (loading) return loading;
  loading = new GLTFLoader().loadAsync('./models/colossus.glb').then(
    (gltf) => {
      const got = {} as Record<Part, Geo>;
      for (const k of Object.keys(NODES) as Part[]) {
        const o = gltf.scene.getObjectByName(NODES[k]);
        if (!o) throw new Error(`colossus.glb has no ${NODES[k]}`);
        o.parent?.remove(o);
        o.position.set(0, 0, 0);
        o.quaternion.identity();
        got[k] = flatten(o);
      }
      geos = got;
    },
    (e) => console.warn('colossus: model failed, using boxes', e),
  ) as Promise<void>;
  return loading;
}

/** Stand-in boxes with the real parts' origins. */
function placeholder(k: Part): Geo {
  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  const g = {
    pelvis: box(12, 6, 8, 0, 0.6, 0), torso: box(22, 20, 14, 0, 10, 0), head: box(5, 4.5, 6, 0, 2.4, 0.8),
    upperArm: box(4.5, UPPER_ARM, 4.5, 0, -UPPER_ARM / 2, 0), forearm: box(5.5, FOREARM + 4, 5.5, 0, -(FOREARM + 4) / 2, 0),
    thigh: box(6, 6, THIGH, 0, 0, THIGH / 2), shin: box(5, 5, SHIN, 0, 0, SHIN / 2), foot: box(6, 2.5, 10, 0, -ANKLE_H + 1.25, 1.5),
  }[k];
  const n = g.attributes.position.count, col = new Float32Array(n * 3).fill(0.12);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return { lit: g, glow: null };
}

type Leg = {
  /** Planted spot (sole under the ankle) or swing: from, to (the server's), progress 0..1 (-1 planted), length (s),
   *  kind (0 step, 1 big stomp), the sole's ground height under the ankle (eases down into a fresh footprint). */
  from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number; kind: number; ground: number;
  /** Foot yaw: now, at the swing's start, and the server's last seen seconds-left. */
  yaw: number; yaw0: number; left: number;
  /** Drawn this frame: the ankle (world), the foot's pitch (heel up +). */
  ankle: THREE.Vector3; pitch: number;
  thigh: THREE.Group; shin: THREE.Group; foot: THREE.Group;
};

const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _h = new THREE.Vector3(), _k = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _p = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4(), _e = new THREE.Euler();
const _n = { x: 0, y: 1, z: 0 };
const UP = new THREE.Vector3(0, 1, 0);
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
/** Toe and heel contact points, foot-local (origin at the ankle). */
const TOE = new THREE.Vector3(0, -ANKLE_H, 7.0), HEEL = new THREE.Vector3(0, -ANKLE_H, -3.4);

/** Point `o` along +Z from `from` to `to`, its +Y towards `pole` (the perpendicular part), at `from`. */
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

export class ColossusView implements BossView {
  readonly points: THREE.Object3D[] = [];
  readonly snapS = true;
  private scene: THREE.Scene;
  /** Everything; `fall` tips it all over when it dies. */
  readonly root = new THREE.Group();
  private fall = new THREE.Group();
  private parts = {} as Record<'pelvis' | 'torso' | 'head', THREE.Group>;
  private arms: { upper: THREE.Group; fore: THREE.Group }[] = [];
  private legs: Leg[] = [];
  private glowMat = new THREE.MeshBasicNodeMaterial({ vertexColors: true });
  private built = false;
  private placed = false;
  /** Hips: smoothed velocity, height and its spring, sway, look. */
  private x = 0;
  private z = 0;
  private yaw = 0;
  private vx = 0;
  private vz = 0;
  private y = 0;
  private vy = 0;
  private sway = 0;
  private headYaw = 0;
  private headPitch = 0;
  private glow = 1;
  private lean = 0;
  /** Camera shakes on their way through the ground: [due (s, ctx time), amount]. */
  private shakes: [number, number][] = [];
  private clock = 0;
  /** Dying: seconds since death drawn so far (-1 alive), the hips' height and feet then, slammed yet. */
  private dead = -1;
  private y0 = 0;
  private slammed = false;
  private smoke = 0;
  /** Stomp tell played for this stomp. */
  private told = false;
  /** The shoulder pods (+X, −X), their mouths' glow, open last frame; missiles in the air. */
  private pods: Pod[] = [];
  private podGlow = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  private markMat = new THREE.MeshBasicNodeMaterial({ color: 0xff2a10, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  private podsOpen = false;
  private missiles: Missile[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.root.add(this.fall);
    const g = (): THREE.Group => new THREE.Group();
    this.parts = { pelvis: g(), torso: g(), head: g() };
    this.fall.add(this.parts.pelvis);
    this.parts.pelvis.add(this.parts.torso);
    this.parts.torso.position.set(0, WAIST_Y, 0);
    this.parts.torso.add(this.parts.head);
    this.parts.head.position.set(NECK[0], NECK[1], NECK[2]);
    for (let i = 0; i < 2; i++) {
      const upper = g(), fore = g();
      upper.position.set(i === 0 ? SHOULDER_X : -SHOULDER_X, SHOULDER_Y, 0);
      if (i === 1) upper.scale.x = -1; // the model's arm is the +X one
      fore.position.set(0, -UPPER_ARM, 0);
      upper.add(fore);
      this.parts.torso.add(upper);
      this.arms.push({ upper, fore });
      const leg: Leg = {
        from: new THREE.Vector3(), to: new THREE.Vector3(), t: -1, dur: 1, kind: 0, ground: 0, yaw: 0, yaw0: 0, left: 0,
        ankle: new THREE.Vector3(), pitch: 0, thigh: g(), shin: g(), foot: g(),
      };
      this.fall.add(leg.thigh, leg.shin, leg.foot);
      this.legs.push(leg);
    }
    // Weak points: 0 the core, 1–2 the knees (legs 0, 1), 3–4 the stacks (+X, −X).
    const core = weakPoint(CORE_R);
    core.position.set(CORE[0], CORE[1], CORE[2]);
    this.parts.torso.add(core);
    this.points.push(core);
    for (const leg of this.legs) {
      const p = weakPoint(KNEE_R);
      p.position.set(KNEE[0], KNEE[1], KNEE[2]);
      p.rotation.x = -Math.PI / 2; // facing the shin's front (+Y)
      leg.shin.add(p);
      this.points.push(p);
    }
    for (const sx of [1, -1]) {
      const p = weakPoint(VENT_R);
      p.position.set(VENT[0] * sx, VENT[1], VENT[2]);
      p.lookAt(p.position.clone().add(new THREE.Vector3(VENT_DIR[0] * sx, VENT_DIR[1], VENT_DIR[2])));
      this.parts.torso.add(p);
      this.points.push(p);
    }
    for (const sx of [1, -1]) {
      const group = new THREE.Group(), lid = new THREE.Group();
      group.position.set(POD[0] * sx, POD[1], POD[2]);
      const body = new THREE.Mesh(podGeo, podMat);
      body.castShadow = true;
      lid.position.set(0, 0, -POD_D / 2);
      const lidMesh = new THREE.Mesh(lidGeo, podMat);
      lidMesh.castShadow = true;
      lid.add(lidMesh);
      const strut = new THREE.Mesh(strutGeo, podMat);
      strut.position.x = -0.8 * sx; // towards the spine
      group.add(body, lid, strut);
      for (let i = 0; i < 6; i++) {
        const m = new THREE.Mesh(mouthGeo, this.podGlow);
        m.position.set(((i % 2) - 0.5) * 2.2, 0, (Math.floor(i / 2) - 1) * 1.8);
        group.add(m);
      }
      this.parts.torso.add(group);
      this.pods.push({ group, lid, open: 0 });
    }
    this.dress(false);
    scene.add(this.root);
    void load().then(() => this.dress(true));
  }

  /** Put the parts' meshes on (the model once loaded, boxes till then). */
  private dress(real: boolean) {
    if (this.built || (real && !geos)) return;
    if (real) this.built = true;
    const geo = (k: Part) => (real && geos ? geos[k] : placeholder(k));
    const wear = (o: THREE.Group, k: Part) => {
      for (const c of [...o.children]) if (c.userData.skin) o.remove(c);
      const g = geo(k);
      for (const [gg, mat] of [[g.lit, litMat], [g.glow, this.glowMat]] as const) {
        if (!gg) continue;
        const m = new THREE.Mesh(gg, mat);
        m.userData.skin = true;
        m.castShadow = gg === g.lit;
        o.add(m);
      }
    };
    wear(this.parts.pelvis, 'pelvis');
    wear(this.parts.torso, 'torso');
    wear(this.parts.head, 'head');
    for (const a of this.arms) {
      wear(a.upper, 'upperArm');
      wear(a.fore, 'forearm');
    }
    for (const l of this.legs) {
      wear(l.thigh, 'thigh');
      wear(l.shin, 'shin');
      wear(l.foot, 'foot');
    }
  }

  update(s: BossSnap, ctx: BossCtx) {
    const dt = Math.min(ctx.dt, 0.1);
    if (dt <= 0) return;
    this.clock += dt;
    this.applyShakes(ctx);
    this.updateMissiles(ctx, dt);
    this.updatePods(s.dead > 0 ? 0 : s.s[S_PODS] ?? 0, ctx, dt);
    if (s.dead > 0) return this.die(s, ctx, dt);
    const first = !this.placed || Math.hypot(s.x - this.x, s.z - this.z) > 60;
    const k = 1 - Math.exp(-dt * 2);
    if (!first) {
      this.vx += ((s.x - this.x) / dt - this.vx) * k;
      this.vz += ((s.z - this.z) / dt - this.vz) * k;
    }
    this.x = s.x;
    this.z = s.z;
    this.yaw = s.yaw;
    this.feet(s, ctx, dt, first);
    if (first) {
      this.placed = true;
      this.vx = this.vz = 0;
      this.y = (this.legs[0].ground + this.legs[1].ground) / 2 + HIP_H;
      this.vy = 0;
    }
    this.pose(s, ctx, dt);
  }

  /** Follow the server's feet: a new spot starts a swing from where the foot is. */
  private feet(s: BossSnap, ctx: BossCtx, dt: number, first: boolean) {
    this.legs.forEach((leg, i) => {
      const o = i * S_FOOT;
      const x = s.s[o], y = s.s[o + 1], z = s.s[o + 2], left = s.s[o + 3], kind = s.s[o + 4];
      if (x === undefined) return;
      if (first) {
        leg.to.set(x, y, z);
        leg.from.copy(leg.to);
        leg.ground = y;
        leg.t = -1;
        leg.yaw = leg.yaw0 = this.yaw;
        leg.left = left;
        return;
      }
      const moved = Math.hypot(x - leg.to.x, z - leg.to.z) > 0.3;
      if (kind === 1 && leg.kind === 1 && leg.t >= 0) {
        // The big stomp follows its prey while it rises.
        leg.to.set(x, y, z);
      } else if (moved || (kind === 1 && leg.kind !== 1) || left > leg.left + 0.3) {
        if (leg.t < 0) leg.from.set(leg.to.x, leg.ground, leg.to.z);
        else leg.from.set(leg.ankle.x, leg.ground, leg.ankle.z); // retargeted mid-swing: from where it is
        leg.to.set(x, y, z);
        leg.kind = kind;
        leg.yaw0 = leg.yaw;
        if (kind === 1) {
          leg.dur = BIG_S;
          leg.t = clamp01(1 - left / BIG_S);
          this.told = false;
        } else {
          leg.dur = Math.max(0.6, left > 0 ? left : 1);
          leg.t = 0;
        }
        colossusSound.lift(leg.from.x, leg.from.y, leg.from.z, ctx.ear, kind === 1);
      } else if (leg.t < 0) {
        // Planted: only the sand under it changed (its own footprint dug): sink in.
        leg.to.y = y;
      }
      leg.left = left;
      if (leg.t < 0) {
        leg.ground += (leg.to.y - leg.ground) * (1 - Math.exp(-dt * 5));
        leg.yaw = leg.yaw0 + Math.atan2(Math.sin(leg.yaw - leg.yaw0), Math.cos(leg.yaw - leg.yaw0));
        return;
      }
      leg.t = Math.min(1, leg.t + dt / leg.dur);
      // The foot turns to the body's heading as it swings.
      const dy = Math.atan2(Math.sin(this.yaw - leg.yaw0), Math.cos(this.yaw - leg.yaw0));
      leg.yaw = leg.yaw0 + dy * smooth(leg.t * 1.2);
      if (leg.t >= 1) this.land(leg, ctx);
    });
  }

  /** A foot comes down. */
  private land(leg: Leg, ctx: BossCtx) {
    const big = leg.kind === 1;
    const span = Math.hypot(leg.to.x - leg.from.x, leg.to.z - leg.from.z);
    const w = big ? 1.6 : Math.min(1, 0.4 + span / STRIDE);
    leg.t = -1;
    leg.kind = 0;
    leg.ground = leg.to.y;
    leg.yaw0 = leg.yaw;
    this.vy -= LAND_DIP * (big ? 1.6 : w);
    const { x, y, z } = leg.to;
    colossusSound.footfall(x, y, z, w, ctx.ear, big);
    const d = Math.hypot(x - ctx.ear.x, y - ctx.ear.y, z - ctx.ear.z);
    if (big) {
      // Shockwave: a ring of dust thrown out fast, a column, and a long shake.
      ctx.thump(x, y, z, 0, 44, 16, 9);
      ctx.thump(x, y, z, 0, 16, 5, 13);
      for (let i = 0; i < 6; i++) this.shakes.push([this.clock + d / GROUND_SPEED + i * 0.22, BIG_SHAKE * Math.exp(-d / BIG_SHAKE_D) * (1 - i / 7)]);
    } else {
      ctx.thump(x, y, z, 0, Math.round(10 + 10 * w), 4 + 3 * w, 6 + 2 * w);
      this.shakes.push([this.clock + d / GROUND_SPEED, SHAKE * w * Math.exp(-d / SHAKE_D)]);
    }
  }

  private applyShakes(ctx: BossCtx) {
    if (!this.shakes.length) return;
    this.shakes = this.shakes.filter(([at, a]) => {
      if (at > this.clock) return true;
      if (a > 0.003) ctx.shake(a);
      return false;
    });
  }

  /** Where the sole is and how it's tipped, for a leg mid-swing (or planted). */
  private footPose(leg: Leg) {
    if (leg.t < 0) {
      leg.pitch = 0;
      leg.ankle.set(leg.to.x, leg.ground + ANKLE_H, leg.to.z);
      return;
    }
    const u = leg.t;
    let px: number, pz: number, lift: number, pitch: number, pivot: THREE.Vector3;
    if (leg.kind === 1) {
      // Big stomp: up and over (aiming), a trembling hold, the slam.
      const T = u * BIG_S;
      const e = smooth(T / RAISE_S);
      px = leg.from.x + (leg.to.x - leg.from.x) * e;
      pz = leg.from.z + (leg.to.z - leg.from.z) * e;
      const base = leg.from.y + (leg.to.y - leg.from.y) * e;
      if (T < RAISE_S) {
        lift = BIG_LIFT * Math.sin((e * Math.PI) / 2);
        pitch = 0.35 * Math.sin(Math.min(1, T / (RAISE_S * 0.5)) * Math.PI) - 0.18 * e;
      } else if (T < RAISE_S + HOLD_S) {
        const h = (T - RAISE_S) / HOLD_S;
        lift = BIG_LIFT + 0.8 * Math.sin(h * Math.PI * 0.5) + Math.sin(T * 41) * 0.12 + Math.sin(T * 27) * 0.1;
        pitch = -0.18 - 0.05 * h;
      } else {
        const k = clamp01((T - RAISE_S - HOLD_S) / SLAM_S);
        lift = (BIG_LIFT + 0.8) * (1 - k * k);
        pitch = -0.23 * (1 - k);
      }
      pivot = HEEL;
      leg.ankle.set(px, base + lift, pz);
      // Pivot about the heel: shift so the heel point is where the path says.
      this.tip(leg, pivot, pitch);
      return;
    }
    const e = smooth((u - 0.1) / 0.8);
    px = leg.from.x + (leg.to.x - leg.from.x) * e;
    pz = leg.from.z + (leg.to.z - leg.from.z) * e;
    const span = Math.hypot(leg.to.x - leg.from.x, leg.to.z - leg.from.z);
    const climb = Math.max(0, leg.to.y - leg.from.y);
    const base = leg.from.y + (leg.to.y - leg.from.y) * e;
    lift = Math.sin(Math.PI * clamp01((u - 0.07) / 0.86)) * (LIFT + LIFT_K * span + climb);
    if (u < 0.15) pitch = 0.5 * smooth(u / 0.15);
    else if (u < 0.5) pitch = 0.5 * (1 - smooth((u - 0.15) / 0.35));
    else if (u < 0.85) pitch = -0.28 * smooth((u - 0.5) / 0.35);
    else pitch = -0.28 * (1 - smooth((u - 0.85) / 0.15));
    pivot = u < 0.5 ? TOE : HEEL;
    leg.ankle.set(px, base + lift + ANKLE_H, pz);
    this.tip(leg, pivot, pitch);
  }

  /** Tip the foot by `pitch` about its contact point `pivot` (foot-local), keeping that point where it'd be flat. */
  private tip(leg: Leg, pivot: THREE.Vector3, pitch: number) {
    leg.pitch = pitch;
    // flat: pivot world = ankle + R(yaw)·pivot; tipped: ankle' = pivotWorld − R(yaw)·Rx(pitch)·pivot
    _q.setFromAxisAngle(UP, leg.yaw);
    _p.copy(pivot).applyQuaternion(_q).add(leg.ankle);
    _e.set(pitch, leg.yaw, 0, 'YXZ');
    _q2.setFromEuler(_e);
    _v.copy(pivot).applyQuaternion(_q2);
    leg.ankle.copy(_p).sub(_v);
  }

  private pose(s: BossSnap, ctx: BossCtx, dt: number) {
    const mood = s.s[S_MOOD] ?? 0;
    for (const leg of this.legs) this.footPose(leg);
    // Hips: over the feet's ground, on a spring; sway over the planted foot; dip and rise with the stride.
    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    const gy = (this.legs[0].ground + this.legs[1].ground) / 2;
    let swing = 0, side = 0, stomp = 0;
    this.legs.forEach((leg, i) => {
      if (leg.t < 0) return;
      if (leg.kind === 1) stomp = leg.t * BIG_S;
      const lift = Math.sin(Math.PI * leg.t);
      swing = Math.max(swing, lift);
      side += (i === 0 ? -1 : 1) * lift; // lean away from the swinging foot, over the planted one
    });
    const raiseUp = mood === MOOD_STOMP ? 1.5 : 0;
    const target = gy + HIP_H + swing * 0.9 - (1 - swing) * 0.4 + raiseUp;
    this.vy += ((target - this.y) * SPRING_K - this.vy * SPRING_C) * dt;
    this.y += this.vy * dt;
    if (Math.abs(target - this.y) > 12) (this.y = target), (this.vy = 0);
    this.sway += (side * SWAY - this.sway) * (1 - Math.exp(-dt * 2.5));
    // Stomp: lean back while the foot is up, then into the slam.
    let lean = 0.035 * Math.min(1, Math.hypot(this.vx, this.vz) / 3);
    if (stomp > 0) {
      const slam = stomp > RAISE_S + HOLD_S;
      lean = slam ? 0.14 : -0.09 * smooth(stomp / RAISE_S);
    }
    this.lean += (lean - this.lean) * (1 - Math.exp(-dt * (stomp > RAISE_S + HOLD_S ? 9 : 2.5)));
    const hx = this.x + c * this.sway, hz = this.z - sn * this.sway;
    const P = this.parts.pelvis;
    P.position.set(hx, this.y, hz);
    P.rotation.set(this.lean * 0.4, this.yaw, -this.sway / SWAY * ROLL, 'YXZ');
    // Stride phase: how far foot 0 is ahead of foot 1 (body frame), for the twist and the arms.
    const ahead = (i: number) => (this.legs[i].ankle.x - this.x) * sn + (this.legs[i].ankle.z - this.z) * c;
    const phase = Math.max(-1, Math.min(1, (ahead(0) - ahead(1)) / STRIDE));
    const T = this.parts.torso;
    T.rotation.set(this.lean * 0.6, -phase * TWIST, this.sway / SWAY * ROLL * 0.5, 'YXZ');
    this.arms.forEach((a, i) => {
      const sw = (i === 0 ? 1 : -1) * phase * ARM_SWING;
      const up = stomp > 0 && stomp < RAISE_S + HOLD_S ? -0.35 * smooth(stomp / RAISE_S) : 0;
      a.upper.rotation.set(-sw + up, 0, i === 0 ? 0.07 : -0.07, 'XYZ');
      a.fore.rotation.set(-0.25 - Math.max(0, -sw) * 0.5 + up * 1.4, 0, 0);
    });
    // Head: to its prey, else ahead.
    let hy = 0, hp = 0.12;
    if (mood > 0) {
      const lx = s.s[S_LOOK] - hx, lz = s.s[S_LOOK + 1] - hz;
      hy = Math.max(-0.9, Math.min(0.9, Math.atan2(Math.sin(Math.atan2(lx, lz) - this.yaw), Math.cos(Math.atan2(lx, lz) - this.yaw)) + phase * TWIST));
      const ly = heightAt(s.s[S_LOOK], s.s[S_LOOK + 1]) - (this.y + WAIST_Y + NECK[1]);
      hp = Math.max(-0.2, Math.min(0.6, Math.atan2(-ly, Math.hypot(lx, lz))));
    }
    const hk = 1 - Math.exp(-dt * 1.5);
    this.headYaw += (hy - this.headYaw) * hk;
    this.headPitch += (hp - this.headPitch) * hk;
    this.parts.head.rotation.set(this.headPitch, this.headYaw, 0, 'YXZ');
    this.root.updateMatrixWorld(true);
    for (let i = 0; i < 2; i++) this.ik(this.legs[i], i);
    // Glow: steady roaming, a pulse hunting, flaring through the stomp's hold.
    let g = mood > 0 ? 1.3 + 0.25 * Math.sin(this.clock * 5) : 1;
    if (stomp > 0) {
      g = stomp < RAISE_S ? 1.3 + smooth(stomp / RAISE_S) : stomp < RAISE_S + HOLD_S ? 2.4 + 0.6 * Math.sin(this.clock * 38) : 3;
      if (!this.told && stomp > RAISE_S - 0.2) {
        this.told = true;
        const f = this.legs.find((l) => l.kind === 1);
        if (f) colossusSound.tell(f.ankle.x, f.ankle.y, f.ankle.z, ctx.ear, HOLD_S + 0.2);
      }
      // The knee pistons vent through the hold.
      if (stomp > RAISE_S && stomp < RAISE_S + HOLD_S && Math.random() < dt * 14) {
        const f = this.legs.find((l) => l.kind === 1)!;
        f.shin.getWorldPosition(_v);
        zaps.puff(_v.x + (Math.random() - 0.5) * 4, _v.y - 4, _v.z + (Math.random() - 0.5) * 4, 3, 4);
      }
    }
    this.glow += (g - this.glow) * (1 - Math.exp(-dt * 6));
    this.glowMat.color.setScalar(this.glow);
    colossusSound.engine(hx, this.y, hz, ctx.ear, Math.hypot(this.vx, this.vz) / 3.6, mood > 0);
  }

  /** Two-bone IK from the hip socket to the ankle, the knee forward; the foot at its pose. */
  private ik(leg: Leg, i: number) {
    const P = this.parts.pelvis;
    _h.set(i === 0 ? HIP_X : -HIP_X, 0, 0).applyMatrix4(P.matrixWorld);
    this.fall.worldToLocal(_h);
    _a.copy(leg.ankle);
    this.fall.worldToLocal(_a);
    // Foot: yawed, tipped, and tilted a little to the sand under it when planted.
    _e.set(leg.pitch, leg.yaw, 0, 'YXZ');
    leg.foot.quaternion.setFromEuler(_e);
    if (leg.t < 0 && this.dead < 0) {
      normalAt(leg.to.x, leg.to.z, _n);
      _v.set(_n.x, _n.y, _n.z);
      _q.setFromUnitVectors(UP, _v);
      _q2.identity().slerp(_q, 0.6);
      leg.foot.quaternion.premultiply(_q2);
    }
    leg.foot.position.copy(_a);
    const F = THIGH, L = SHIN;
    _v.subVectors(_a, _h);
    const len = Math.min(F + L - 0.05, Math.max(Math.abs(F - L) + 0.5, _v.length()));
    _v.normalize();
    // Pole: forward and a touch outward (so the knees don't knock).
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    _p.set(s + c * (i === 0 ? 0.15 : -0.15), 0, c - s * (i === 0 ? 0.15 : -0.15));
    if (this.dead >= 0) _p.set(s, 0, c);
    _x.copy(_p).addScaledVector(_v, -_p.dot(_v)).normalize(); // perpendicular part
    const along = (F * F - L * L + len * len) / (2 * len);
    const up = Math.sqrt(Math.max(0, F * F - along * along));
    _k.copy(_h).addScaledVector(_v, along).addScaledVector(_x, up);
    aim(leg.thigh, _h, _k, _p);
    // Out of reach: the shin still points at the ankle (the foot hangs below it).
    _y.copy(_a);
    aim(leg.shin, _k, _y, _p);
  }

  /**
   * Dead: the furnace gutters; the knees buckle (hips sinking, feet planted); then it topples about a line just ahead
   * of its feet, slower then faster, like a tower, slams down along its fall direction, smokes, and sinks in at the end.
   */
  private die(s: BossSnap, ctx: BossCtx, dt: number) {
    const t = s.dead;
    if (this.dead < 0) {
      this.dead = t;
      this.y0 = this.placed ? this.y : (this.legs[0].ground + this.legs[1].ground) / 2 + HIP_H;
      if (!this.placed) {
        this.x = s.x;
        this.z = s.z;
        this.yaw = s.yaw;
        this.feet(s, ctx, dt, true);
        this.placed = true;
      }
      for (const leg of this.legs) {
        if (leg.t >= 0) leg.to.set(leg.ankle.x, heightAt(leg.ankle.x, leg.ankle.z), leg.ankle.z);
        leg.t = -1;
        leg.ground = leg.to.y;
        leg.kind = 0;
      }
      this.slammed = t > FALL_S + 0.3;
      if (t < 0.5) colossusSound.dying(s.x, this.y0, s.z, ctx.ear);
    } else this.dead = t;
    const fallYaw = s.s[S_FALL] ?? this.yaw;
    const fx = Math.sin(fallYaw), fz = Math.cos(fallYaw);
    // Buckle: hips down, torso slumping, a shudder.
    const b = smooth(t / BUCKLE_S);
    const shudder = t < BUCKLE_S ? Math.sin(t * 53) * 0.25 * (1 - t / BUCKLE_S) : 0;
    this.y = this.y0 - BUCKLE_DROP * b + shudder;
    for (const leg of this.legs) this.footPose(leg);
    const P = this.parts.pelvis;
    P.position.set(this.x, this.y, this.z);
    P.rotation.set(0.1 * b, this.yaw, 0, 'YXZ');
    this.parts.torso.rotation.set(0.22 * b + shudder * 0.02, 0, 0.05 * b, 'YXZ');
    this.parts.head.rotation.set(0.5 * b, 0.2 * b, 0, 'YXZ');
    // Falling: the arms fly up ahead of it.
    const f = clamp01((t - BUCKLE_S) / (FALL_S - BUCKLE_S));
    const ang = FALL_ANGLE * f * f;
    this.arms.forEach((a, i) => {
      a.upper.rotation.set(-0.15 * b - 1.6 * smooth(f * 1.3), 0, (i === 0 ? 0.07 : -0.07) + (i === 0 ? 0.2 : -0.2) * f, 'XYZ');
      a.fore.rotation.set(-0.3 - 0.4 * f, 0, 0);
    });
    // Tip everything about a ground line ahead of its feet.
    const ox = (this.legs[0].to.x + this.legs[1].to.x) / 2 + fx * PIVOT_AHEAD;
    const oz = (this.legs[0].to.z + this.legs[1].to.z) / 2 + fz * PIVOT_AHEAD;
    const oy = heightAt(ox, oz);
    const end = Math.max(0, t - (BOSSES.colossus.wreckS - SINK_S)) / SINK_S;
    const rest = t > FALL_S ? REST_DROP * smooth((t - FALL_S) / 0.6) : 0;
    _v.set(Math.cos(fallYaw), 0, -Math.sin(fallYaw));
    _q.setFromAxisAngle(_v, ang);
    this.fall.position.set(ox, oy, oz).sub(_a.set(ox, oy, oz).applyQuaternion(_q));
    this.fall.position.y -= rest + end * end * SINK_DEPTH;
    // A bounce as it lands.
    if (t > FALL_S) this.fall.position.y += Math.sin((t - FALL_S) * 9) * Math.exp(-(t - FALL_S) * 4) * 0.8;
    this.fall.quaternion.copy(_q);
    this.root.updateMatrixWorld(true);
    for (let i = 0; i < 2; i++) this.ik(this.legs[i], i);
    // The furnace gutters out.
    const flick = t < FALL_S ? (Math.sin(t * 31) * Math.sin(t * 11) > 0 ? 1 : 0.2) * (1 - t / FALL_S) : 0;
    this.glow += (flick * 1.4 - this.glow) * (1 - Math.exp(-dt * 12));
    this.glowMat.color.setScalar(Math.max(0, this.glow));
    colossusSound.engine(this.x, this.y, this.z, ctx.ear, 0, false, true);
    if (!this.slammed && t >= FALL_S) {
      this.slammed = true;
      // It hits the sand along its whole length.
      colossusSound.collapse(ox + fx * 35, oy, oz + fz * 35, ctx.ear);
      for (let k = 0; k < 5; k++) {
        const d = 12 + k * 12;
        ctx.thump(ox + fx * d, heightAt(ox + fx * d, oz + fz * d), oz + fz * d, 0, 16, 9, 10);
      }
      const d = Math.hypot(ox + fx * 35 - ctx.ear.x, oz + fz * 35 - ctx.ear.z);
      for (let i = 0; i < 8; i++) this.shakes.push([this.clock + d / GROUND_SPEED + i * 0.2, BIG_SHAKE * 1.2 * Math.exp(-d / 400) * (1 - i / 9)]);
    }
    // The wreck smokes from its chest and stacks.
    if (t > FALL_S && end < 0.8) {
      this.smoke += dt * WRECK_SMOKE;
      while (this.smoke >= 1) {
        this.smoke -= 1;
        const p = this.points[Math.random() < 0.5 ? 0 : 3 + Math.floor(Math.random() * 2)];
        p.getWorldPosition(_v);
        zaps.puff(_v.x + (Math.random() - 0.5) * 6, Math.max(_v.y, heightAt(_v.x, _v.z) + 2), _v.z + (Math.random() - 0.5) * 6, 5, 3);
      }
    }
  }

  /** The pods open for a salvo (a klaxon as they do), the tube mouths blinking, then glowing hot; shut otherwise. */
  private updatePods(open: number, ctx: BossCtx, dt: number) {
    const want = open > 0;
    if (want && !this.podsOpen) {
      this.pods[0].group.getWorldPosition(_v);
      colossusSound.klaxon(_v.x, _v.y, _v.z, ctx.ear, SALVO_TELL_S);
    }
    this.podsOpen = want;
    let g = 0;
    for (const p of this.pods) {
      p.open += ((want ? 1 : 0) - p.open) * (1 - Math.exp(-dt * (want ? 5 : 2)));
      p.lid.rotation.x = -POD_OPEN * p.open;
      g = Math.max(g, p.open);
    }
    const blink = want ? (Math.sin(this.clock * 16) > 0 ? 1 : 0.25) : 1;
    this.podGlow.color.setRGB(3 * g * blink, 0.25 * g * blink, 0.08 * g * blink);
  }

  /** A missile is on its way ('missile': from the pod at (x, y, z), a = landing x, y, z, flight time, shoulder). */
  fx(m: BossFxMsg) {
    if (m.e !== 'missile' || !m.a || m.a.length < 5) return;
    const mesh = new THREE.Group();
    const body = new THREE.Mesh(missileGeo, missileMat);
    body.castShadow = true;
    const motor = new THREE.Sprite(motorMat);
    motor.position.set(0, 0, -2);
    motor.scale.setScalar(2.4);
    mesh.add(body, motor);
    mesh.visible = false;
    this.scene.add(mesh);
    const mark = new THREE.Mesh(markGeo, this.markMat);
    mark.scale.setScalar(MISSILE_KILL_R);
    mark.position.set(m.a[0], m.a[1] + MARK_LIFT, m.a[2]);
    normalAt(m.a[0], m.a[2], _n);
    mark.quaternion.setFromUnitVectors(UP, _v.set(_n.x, _n.y, _n.z));
    mark.visible = false;
    mark.renderOrder = 2;
    this.scene.add(mark);
    this.missiles.push({ t0: m.time, T: m.a[3], side: m.a[4], to: new THREE.Vector3(m.a[0], m.a[1], m.a[2]), from: null, mesh, mark, trail: 0, whistled: false });
  }

  private updateMissiles(ctx: BossCtx, dt: number) {
    if (!this.missiles.length) return;
    let pulse = 0;
    this.missiles = this.missiles.filter((ms) => {
      const t = (ctx.time - ms.t0) / 1000;
      if (t < 0) return true;
      if (!ms.from) {
        // Out of the drawn pod on its side (the server's is near enough; this one is where it's seen).
        ms.from = new THREE.Vector3();
        const pod = this.pods[ms.side > 0 ? 0 : 1];
        if (pod && this.dead < 0) pod.group.getWorldPosition(ms.from);
        else ms.from.copy(ms.to).setY(ms.to.y + 60);
        if (t < 0.5) {
          colossusSound.launch(ms.from.x, ms.from.y, ms.from.z, ctx.ear);
          for (let i = 0; i < 4; i++) zaps.puff(ms.from.x + (Math.random() - 0.5) * 3, ms.from.y + 1 + i, ms.from.z + (Math.random() - 0.5) * 3, 3, 3);
        }
      }
      if (t >= ms.T) {
        ms.mesh.removeFromParent();
        ms.mark.removeFromParent();
        if (t < ms.T + 1) this.blast(ms.to.x, ms.to.y, ms.to.z, ctx);
        return false;
      }
      const f = ms.from;
      missileAt(f.x, f.y, f.z, ms.to.x, ms.to.y, ms.to.z, ms.T, t, _p);
      missileAt(f.x, f.y, f.z, ms.to.x, ms.to.y, ms.to.z, ms.T, t + 0.05, _a);
      ms.mesh.visible = true;
      ms.mesh.position.copy(_p);
      ms.mesh.lookAt(_a);
      ms.mark.visible = true;
      ms.trail += dt * TRAIL_RATE;
      while (ms.trail >= 1) {
        ms.trail -= 1;
        zaps.puff(_p.x, _p.y, _p.z, 1.6, 0.6);
      }
      if (!ms.whistled && t > ms.T - WHISTLE_S) {
        ms.whistled = true;
        colossusSound.incoming(ms.to.x, ms.to.y, ms.to.z, ctx.ear, ms.T - t);
      }
      pulse = Math.max(pulse, t / ms.T);
      return true;
    });
    // The marks burn brighter and blink faster as their missiles come down.
    const k = 0.6 + 0.4 * Math.sin(this.clock * (6 + 20 * pulse));
    this.markMat.color.setRGB(1.6 * k * (0.5 + pulse), 0.16 * k, 0.05 * k);
  }

  /** A missile bursting on the sand. */
  private blast(x: number, y: number, z: number, ctx: BossCtx) {
    zaps.burst(x, y + 0.5, z, 0, 1, 0, 40, 4);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2, v = 6 + Math.random() * 7;
      tyreDust.emit(x + Math.cos(a) * 2, y + 0.5, z + Math.sin(a) * 2, Math.cos(a) * v, 2 + Math.random() * 6, Math.sin(a) * v, 3.5 + Math.random() * 2, 3 + Math.random() * 2);
    }
    for (let i = 0; i < 4; i++) zaps.puff(x + (Math.random() - 0.5) * 4, y + 2 + i * 2, z + (Math.random() - 0.5) * 4, 5, 3);
    ctx.thump(x, y, z, 2.4, 26, 7, 3.2);
    guardianSound.boom(x, y, z, ctx.ear);
    _v.set(x, y, z);
    rifleSound.firework(_v, ctx.ear, 1, 0.75);
  }

  /** Where the shot from `o` along unit `d` first meets its metal (capsules round its limbs and body) within `max`. */
  hull(o: THREE.Vector3, d: THREE.Vector3, max: number): number | null {
    let best: number | null = null;
    const test = (a: THREE.Vector3, b: THREE.Vector3, r: number) => {
      const t = capsule(o, d, a, b, r);
      if (t !== null && t <= max && (best === null || t < best)) best = t;
    };
    const T = this.parts.torso, P = this.parts.pelvis;
    test(_a.set(0, 2, 0).applyMatrix4(T.matrixWorld), _h.set(0, 16, 0).applyMatrix4(T.matrixWorld), 8.5);
    test(_a.set(-HIP_X, 0, 0).applyMatrix4(P.matrixWorld), _h.set(HIP_X, 0, 0).applyMatrix4(P.matrixWorld), 4.5);
    test(_a.set(0, 2, 0.8).applyMatrix4(this.parts.head.matrixWorld), _h.set(0, 3, 0.8).applyMatrix4(this.parts.head.matrixWorld), 3);
    for (const leg of this.legs) {
      test(_a.setFromMatrixPosition(leg.thigh.matrixWorld), _h.setFromMatrixPosition(leg.shin.matrixWorld), 3.2);
      test(_a.setFromMatrixPosition(leg.shin.matrixWorld), _h.setFromMatrixPosition(leg.foot.matrixWorld), 2.8);
      test(_a.set(0, -1.5, -2).applyMatrix4(leg.foot.matrixWorld), _h.set(0, -1.5, 6).applyMatrix4(leg.foot.matrixWorld), 2.4);
    }
    for (const a of this.arms) {
      test(_a.setFromMatrixPosition(a.upper.matrixWorld), _h.setFromMatrixPosition(a.fore.matrixWorld), 2.6);
      test(_a.setFromMatrixPosition(a.fore.matrixWorld), _h.set(0, -15, 0).applyMatrix4(a.fore.matrixWorld), 3.2);
    }
    return best;
  }

  dispose() {
    this.scene.remove(this.root);
    this.glowMat.dispose();
    for (const m of this.missiles) {
      m.mesh.removeFromParent();
      m.mark.removeFromParent();
    }
    this.missiles = [];
    this.podGlow.dispose();
    this.markMat.dispose();
    colossusSound.engine(0, 0, 0, null, 0, false, true);
  }
}

const _c1 = new THREE.Vector3(), _c2 = new THREE.Vector3(), _c3 = new THREE.Vector3();
/** Distance along ray (o, unit d) to a capsule (a–b, radius r), or null: the ray's closest approach to the segment
 *  within r, entering r before it (good enough for sparks). */
function capsule(o: THREE.Vector3, d: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number): number | null {
  const u = _c1.subVectors(b, a), w = _c2.subVectors(o, a);
  const uu = u.dot(u), ud = u.dot(d), uw = u.dot(w), dw = d.dot(w);
  const den = uu - ud * ud;
  const s = Math.max(0, Math.min(1, den > 1e-6 ? (uw - ud * dw) / den : 0)); // along the segment, 0..1
  // Closest point on the segment to the ray, then on the ray to that point.
  const p = _c3.copy(a).addScaledVector(u, s);
  const t = Math.max(0, (p.x - o.x) * d.x + (p.y - o.y) * d.y + (p.z - o.z) * d.z);
  const dx = o.x + d.x * t - p.x, dy = o.y + d.y * t - p.y, dz = o.z + d.z * t - p.z;
  const m2 = dx * dx + dy * dy + dz * dz;
  if (m2 > r * r) return null;
  return Math.max(0, t - Math.sqrt(r * r - m2));
}

