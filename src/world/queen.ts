// The brood queen (shared/queen.ts, shared/bosses.ts) as drawn: public/models/queen.glb (tools/blender/queen.py),
// a thorax with its head and cutters, the brood sac in two halves, and eight legs of four parts each, one rig.
//
// - Feet are the server's (server/queen.ts steps them, BossSnap.s): when one gets a new spot it swings there from
//   where it is in the time the server gives, lifted on an arc, and stabs in with a thud (sound, dust, shake).
// - Legs: the last segment stands leaning out from the vertical (shared/queen.ts TARSUS_LEAN), so the ankle is a
//   fixed offset from the tip; hip to ankle is two-bone IK with the knee bent up, high over the body like a
//   harvestman's.
// - The body rides BODY_H over the feet's average ground on a spring that dips as each group lands, pitched and
//   rolled to their plane; the sac hangs off the pedicel, swaying with turns and breathing; the cutters work while
//   it hunts.
// - Rearing (REAR): the body tips up on its back legs, the front legs rise high, cutters wide, eyes white-hot, a
//   screech; at the slam (RECOVER) the front feet come down hard on the server's slam points: booms, dust, shake.
// - Dying: it twitches, its legs give out one by one in servo jerks with the feet skidding out, the body sinks in
//   stages and crashes onto the sand, the sac splits open along its seam glowing inside, and it smokes; before the
//   server clears it, it sinks into the sand.
// - The brood (src/world/brood.ts): when the server opens the sac (BossSnap.s[S_BROOD + 1]) its halves part a little,
//   pulsing, glowing inside, with a groan and scrabbling, and the spiderlings tumble out from under it.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOSSES, type BossSnap } from '../../shared/bosses.ts';
import {
  ABD_PITCH, BIRTH_MS, BODY_H, FEMUR, FRONT, HUNT, LEGS, PEDICEL, REAR, REAR_MS, RECOVER, restSpot, ROAM, S_BROOD, S_FEET, SOCKETS, TARSUS,
  TARSUS_LEAN, TIBIA,
} from '../../shared/queen.ts';
import { heightAt } from '../../shared/terrain.ts';
import { queenSound } from '../queenSound';
import { rifleSound } from '../rifleSound';
import { weakPoint, type BossCtx, type BossView } from './bossParts';
import { Brood } from './brood';
import { zaps } from './zaps';

/** Hidden past this distance (m). */
const SHOW_R = 2200;
/** A step's lift (m): LIFT + LIFT_K × its length. */
const LIFT = 1.4, LIFT_K = 0.22;
/** Body spring: stiffness, damping (per s), dip when a foot lands (m/s), tilt limit (rad). */
const SPRING_K = 14, SPRING_C = 6, LAND_DIP = 0.35, MAX_TILT = 0.16;
/** Reared up: the body pitches nose-up this much (rad) and rises this much (m); a raised front tip sits here (body
 *  frame, +X side; mirrored for the other). The slam takes SLAM_S. */
const REAR_PITCH = 0.42, REAR_RISE = 2.4, SLAM_S = 0.18;
const RAISED = new THREE.Vector3(5, 7.5, 12.5);
/** Dying (s): twitching, then a leg gives out every LEG_GAP (± a little), each in FAIL_S; the body rests this high
 *  over the sand, the sac split open this far (rad). */
const TWITCH = 0.8, LEG_GAP = 0.32, FAIL_S = 0.6, DEAD_REST = 2.2, SPLIT = 0.38;
/** The wreck sinks into the sand over its last SINK_S seconds. */
const SINK_S = 20;
/** Giving birth: the sac's halves part this far (rad), pulsing; it closes over CLOSE_MS after the clutch is out. */
const BIRTH_SPLIT = 0.11, CLOSE_MS = 900;
/** Where the spiderlings drop from (the sac's frame: its underside). */
const DROP_AT = new THREE.Vector3(0, -1.2, -11);
/** Weak points (index = BOSSES.queen.points order): where on the model (thorax frame, or the sac's unpitched
 *  frame), facing which way, how big (tools/blender/queen.py prints them). */
const POINTS: { on: 'thorax' | 'sac'; p: [number, number, number]; n: [number, number, number]; r: number }[] = [
  { on: 'thorax', p: [0, 0.2, 9.1], n: [0, 0, 1], r: 1.0 },
  { on: 'thorax', p: [-2.0, -2.05, 0.8], n: [-0.4, -1, 0], r: 0.9 },
  { on: 'thorax', p: [2.0, -2.05, 0.8], n: [0.4, -1, 0], r: 0.9 },
  { on: 'sac', p: [-1.7, 4.17, -6.6], n: [-0.3, 1, 0.1], r: 1.2 },
  { on: 'sac', p: [1.7, 4.27, -11.6], n: [0.3, 1, -0.1], r: 1.2 },
  { on: 'sac', p: [0, 1.0, -17.5], n: [0, 0.2, -1], r: 1.1 },
];

type Part = 'thorax' | 'mandL' | 'mandR' | 'abdL' | 'abdR' | 'coxa' | 'femur' | 'tibia' | 'tarsus';
const NODES: Record<Part, string> = {
  thorax: 'Queen_Thorax', mandL: 'Queen_MandibleL', mandR: 'Queen_MandibleR', abdL: 'Queen_AbdomenL', abdR: 'Queen_AbdomenR',
  coxa: 'Queen_Coxa', femur: 'Queen_Femur', tibia: 'Queen_Tibia', tarsus: 'Queen_Tarsus',
};

/** Lit parts share one material (colours as vertex colours); the glowing bits get one per kind, so they can pulse. */
const litMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.65, metalness: 0.45 });
type Glow = 'eyes' | 'sac' | 'legs';

/** The model's parts merged into a lit and a glowing geometry each (two draw calls a part, not one per material). */
type Geo = { lit: THREE.BufferGeometry | null; glow: THREE.BufferGeometry | null; gut: THREE.BufferGeometry | null };
let geos: Record<Part, Geo> | null = null;
let loading: Promise<void> | null = null;

function merge(o: THREE.Object3D): Geo {
  const lit: THREE.BufferGeometry[] = [], glow: THREE.BufferGeometry[] = [], gut: THREE.BufferGeometry[] = [];
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
    const c3 = emissive ? mat.emissive.clone().multiplyScalar(2.5) : (mat.color ?? new THREE.Color(0.3, 0.3, 0.3));
    for (let i = 0; i < n; i++) col.set([c3.r, c3.g, c3.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    (mat.name === 'QueenGut' ? gut : emissive ? glow : lit).push(g.index ? g.toNonIndexed() : g);
  });
  const m = (a: THREE.BufferGeometry[]) => (a.length ? mergeGeometries(a)! : null);
  return { lit: m(lit), glow: m(glow), gut: m(gut) };
}

function load(): Promise<void> {
  loading ??= new GLTFLoader().loadAsync('./models/queen.glb').then(
    (gltf) => {
      const got = {} as Record<Part, Geo>;
      for (const k of Object.keys(NODES) as Part[]) {
        const o = gltf.scene.getObjectByName(NODES[k]);
        if (!o) throw new Error(`queen.glb has no ${NODES[k]}`);
        o.parent?.remove(o);
        o.position.set(0, 0, 0);
        o.quaternion.identity();
        got[k] = merge(o);
      }
      geos = got;
    },
    (e) => console.warn('queen: model failed, using boxes', e),
  ) as Promise<void>;
  return loading;
}

/** Stand-in boxes with the real parts' origins, until the model has loaded. */
function boxes(): Record<Part, Geo> {
  const b = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => {
    const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();
    const col = new Float32Array(g.attributes.position.count * 3).fill(0.12);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return { lit: g, glow: null, gut: null };
  };
  return {
    thorax: b(8, 4, 14, 0, 0, 2), mandL: b(0.6, 0.6, 3, 0, -1, 1.5), mandR: b(0.6, 0.6, 3, 0, -1, 1.5),
    abdL: b(5.5, 7, 16, -2.75, -1, -9), abdR: b(5.5, 7, 16, 2.75, -1, -9),
    coxa: b(1.6, 1.6, 1.6), femur: b(1, 1, FEMUR, 0, 0, FEMUR / 2), tibia: b(0.7, 0.7, TIBIA, 0, 0, TIBIA / 2), tarsus: b(0.5, 0.5, TARSUS, 0, 0, TARSUS / 2),
  };
}

type Leg = {
  /** The server's spot, where the swing started, the drawn tip, and its ground height (without the lift). */
  to: THREE.Vector3; from: THREE.Vector3; foot: THREE.Vector3; ground: number;
  /** Swing progress 0..1 (-1 planted) and length (s); raised (rear) from the server. */
  t: number; dur: number; up: boolean;
  coxa: THREE.Object3D; femur: THREE.Object3D; tibia: THREE.Object3D; tarsus: THREE.Object3D;
};

const UP = new THREE.Vector3(0, 1, 0);
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4();
const _h = new THREE.Vector3(), _a = new THREE.Vector3(), _k = new THREE.Vector3(), _v = new THREE.Vector3();
const _o = new THREE.Vector3(), _pl = new THREE.Vector3(), _q = new THREE.Vector3(), _r = new THREE.Vector3();
const _w = new THREE.Vector3(), _p2 = { x: 0, z: 0 };

/** Point o's +Z from `from` to `to`, its +Y towards `pole`, at `from`. */
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

/** A servo giving up: three quick jerks with holds between, 0..1. */
function jerky(x: number) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const n = 3, k = Math.floor(x * n), f = Math.min(1, (x * n - k) / 0.35);
  return (k + f * f * (3 - 2 * f)) / n;
}
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Distance along unit ray (o, d) to sphere (c, r), or null. */
function sphere(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, r: number): number | null {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z, cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : cc < 0 ? 0 : null;
}

/** Distance along unit ray (o, d) to the capsule a–b of radius r, or null. */
function capsule(o: THREE.Vector3, d: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number): number | null {
  const u = _q.subVectors(b, a), w = _r.subVectors(o, a);
  const uu = u.dot(u), ud = u.dot(d), uw = u.dot(w), dw = d.dot(w);
  const den = uu - ud * ud;
  const sc = Math.max(0, Math.min(1, den > 1e-6 ? (uw - ud * dw) / den : 0));
  const tc = Math.max(0, sc * ud - dw);
  const miss = Math.hypot(a.x + u.x * sc - (o.x + d.x * tc), a.y + u.y * sc - (o.y + d.y * tc), a.z + u.z * sc - (o.z + d.z * tc));
  return miss > r ? null : Math.max(0, tc - Math.sqrt(r * r - miss * miss));
}

export class QueenView implements BossView {
  readonly points: THREE.Object3D[] = [];
  readonly snapS = true;
  private scene: THREE.Scene;
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private sacPivot = new THREE.Group();
  private sacL = new THREE.Group();
  private sacR = new THREE.Group();
  private mandL = new THREE.Group();
  private mandR = new THREE.Group();
  /** The sac's unpitched frame (its weak points, hit spheres). */
  private sacFrame = [new THREE.Group(), new THREE.Group()];
  private legs: Leg[] = [];
  private glow: Record<Glow, THREE.MeshBasicNodeMaterial>;
  private gutMat = new THREE.MeshBasicNodeMaterial({ vertexColors: true });
  private usesModel = false;
  private placed = false;
  private x = 0; private z = 0; private yaw = 0; private y = 0; private vy = 0; private vx = 0; private vz = 0;
  private pitch = 0; private roll = 0; private turnRate = 0;
  private raise = 0;
  private hunt = 0;
  private lastMode = -1;
  private lastModeAt = 0;
  private slammed = 0;
  /** Dying: seconds since death (-1 alive), the body's height then, when each leg gives out, what has played. */
  private dead = -1;
  private y0 = 0;
  private failAt: number[] = [];
  private went: boolean[] = [];
  private crashed = false;
  private smoke = 0;
  private brood: Brood;
  private born = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const g = () => new THREE.MeshBasicNodeMaterial({ vertexColors: true });
    this.glow = { eyes: g(), sac: g(), legs: g() };
    this.body.add(this.sacPivot, this.mandL, this.mandR);
    this.sacPivot.position.set(0, PEDICEL.y, PEDICEL.z);
    this.sacPivot.add(this.sacL, this.sacR);
    this.mandL.position.set(-1.0, -0.8, 8.3);
    this.mandR.position.set(1.0, -0.8, 8.3);
    this.root.add(this.body);
    // Weak points: on the thorax, or on the sac (in its drooped frame).
    const sacFrame = this.sacFrame;
    sacFrame.forEach((f, i) => ((f.rotation.x = ABD_PITCH), (i ? this.sacR : this.sacL).add(f)));
    for (let i = 0; i < BOSSES.queen.points; i++) {
      const d = POINTS[i], p = weakPoint(d.r);
      p.position.set(...d.p);
      p.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...d.n).normalize());
      (d.on === 'thorax' ? this.body : sacFrame[d.p[0] > 0 ? 1 : 0]).add(p);
      this.points.push(p);
    }
    for (let i = 0; i < LEGS; i++) {
      const o = () => new THREE.Group();
      const leg: Leg = { to: new THREE.Vector3(), from: new THREE.Vector3(), foot: new THREE.Vector3(), ground: 0, t: -1, dur: 1, up: false, coxa: o(), femur: o(), tibia: o(), tarsus: o() };
      this.root.add(leg.coxa, leg.femur, leg.tibia, leg.tarsus);
      this.legs.push(leg);
    }
    this.build(geos ?? boxes());
    this.usesModel = geos !== null;
    if (!geos) void load();
    scene.add(this.root);
    this.brood = new Brood(scene);
  }

  /** Fill the part groups with meshes from `g`. */
  private build(g: Record<Part, Geo>) {
    // `shadow` false: a small part whose shadow nobody misses (each caster is drawn again into every cascade).
    const fill = (o: THREE.Object3D, geo: Geo, glow: Glow, shadow = true) => {
      for (const c of [...o.children]) if ((c as THREE.Mesh).isMesh) o.remove(c);
      const add = (geom: THREE.BufferGeometry | null, mat: THREE.Material, shadow: boolean) => {
        if (!geom) return;
        const m = new THREE.Mesh(geom, mat);
        m.castShadow = shadow;
        o.add(m);
      };
      add(geo.lit, litMat, shadow);
      add(geo.glow, this.glow[glow], false);
      add(geo.gut, this.gutMat, false);
    };
    fill(this.body, g.thorax, 'eyes');
    fill(this.mandL, g.mandL, 'eyes');
    fill(this.mandR, g.mandR, 'eyes');
    fill(this.sacL, g.abdL, 'sac');
    fill(this.sacR, g.abdR, 'sac');
    for (const l of this.legs) {
      fill(l.coxa, g.coxa, 'legs', false);
      fill(l.femur, g.femur, 'legs');
      fill(l.tibia, g.tibia, 'legs');
      fill(l.tarsus, g.tarsus, 'legs', false);
    }
  }

  update(s: BossSnap, ctx: BossCtx) {
    const dt = ctx.dt;
    if (dt <= 0) return;
    if (!this.usesModel && geos) {
      this.build(geos);
      this.usesModel = true;
    }
    const far = !ctx.me || Math.hypot(s.x - ctx.me.x, s.z - ctx.me.z) > SHOW_R;
    this.root.visible = !far;
    const mode = s.s[0], modeAt = s.s[1], rearMs = s.s[S_BROOD] || REAR_MS, birthAt = s.s[S_BROOD + 1] || 0;
    if (!this.placed || Math.hypot(s.x - this.x, s.z - this.z) > 40) this.place(s);
    if (s.dead > 0) {
      this.die(s, ctx);
      this.brood.update(s.s, ctx, far, this.dropAt);
      return;
    }
    // Velocity from the interpolated track (smoothed), turn rate.
    const k = 1 - Math.exp(-dt * 3);
    this.vx += ((s.x - this.x) / dt - this.vx) * k;
    this.vz += ((s.z - this.z) / dt - this.vz) * k;
    const turn = Math.atan2(Math.sin(s.yaw - this.yaw), Math.cos(s.yaw - this.yaw)) / dt;
    this.turnRate += (turn - this.turnRate) * k;
    this.x = s.x;
    this.z = s.z;
    this.yaw = s.yaw;

    // Modes: what it's doing, and the one-off sounds as they start.
    const since = ctx.time - modeAt;
    if (modeAt !== this.lastModeAt) {
      const fresh = since < 800;
      if (mode === REAR && fresh) queenSound.screech(this.headPos(_w), ctx.ear, rearMs / 1000);
      if (mode === HUNT && this.lastMode === ROAM && fresh) queenSound.chitter(this.headPos(_w), ctx.ear);
      this.lastMode = mode;
      this.lastModeAt = modeAt;
    }
    let raise: number;
    if (mode === REAR) raise = since < 0 ? 0 : smooth(Math.min(1, since / (rearMs * 0.55)));
    else if (mode === RECOVER) raise = since < 0 ? 1 : 1 - Math.pow(Math.min(1, since / (SLAM_S * 1000)), 2);
    else raise = this.raise * Math.exp(-dt * 3);
    this.raise = raise;
    if (mode === RECOVER && since >= SLAM_S * 1000 && this.slammed !== modeAt) {
      this.slammed = modeAt;
      if (since < 1500) this.slamFx(ctx);
    }
    this.hunt += ((mode === HUNT || mode === REAR ? 1 : 0) - this.hunt) * (1 - Math.exp(-dt * 2));

    this.followFeet(s.s, dt, ctx);

    // Body: over the planted feet's ground, tilted to their plane, on a spring; rearing tips it up.
    let gy = 0, n = 0, sp = 0, pp = 0, sr = 0, rr = 0;
    for (const l of this.legs) if (!l.up) (gy += l.ground), n++;
    gy = n ? gy / n : heightAt(this.x, this.z);
    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    for (const l of this.legs) {
      if (l.up) continue;
      const fy = l.ground - gy, dx = l.foot.x - this.x, dz = l.foot.z - this.z;
      const lz = dx * sn + dz * c, lx = dx * c - dz * sn;
      sp += fy * lz;
      pp += lz * lz;
      sr += fy * lx;
      rr += lx * lx;
    }
    const clamp = (v: number) => Math.max(-MAX_TILT, Math.min(MAX_TILT, v));
    const tk = 1 - Math.exp(-dt * 3);
    this.pitch += (clamp(-Math.atan(sp / Math.max(1, pp))) - this.pitch) * tk;
    this.roll += (clamp(Math.atan(sr / Math.max(1, rr))) - this.roll) * tk;
    const sag = this.legs.reduce((a, l) => a + (l.t >= 0 ? Math.sin(Math.PI * l.t) : 0), 0) * 0.08;
    const target = gy + 0.3 + BODY_H - sag + raise * REAR_RISE;
    this.vy += ((target - this.y) * SPRING_K - this.vy * SPRING_C) * dt;
    this.y += this.vy * dt;
    if (Math.abs(target - this.y) > 5) this.y = target;
    const tremble = raise > 0.9 ? Math.sin(ctx.time * 0.09) * 0.012 : 0;
    this.body.position.set(this.x, this.y, this.z);
    this.body.rotation.set(this.pitch - raise * REAR_PITCH + tremble, this.yaw, this.roll, 'YXZ');
    // The sac: kept low while rearing, swinging out on turns, breathing.
    const breathe = Math.sin(ctx.time * 0.0021) * 0.025;
    this.sacPivot.rotation.set(raise * REAR_PITCH * 0.8 + breathe, Math.max(-0.15, Math.min(0.15, -this.turnRate * 0.25)), 0, 'YXZ');
    // Giving birth: the halves part, pulsing, glowing inside.
    const bs = ctx.time - birthAt;
    if (birthAt && birthAt !== this.born && bs >= 0) {
      this.born = birthAt;
      if (!far && bs < 800) queenSound.birth(this.dropAt(_w), ctx.ear, BIRTH_MS / 1000);
    }
    const open = !birthAt || bs < 0 ? 0 : bs < BIRTH_MS ? smooth(bs / BIRTH_MS) : 1 - smooth((bs - BIRTH_MS - 400) / CLOSE_MS);
    const split = open * BIRTH_SPLIT * (0.75 + 0.25 * Math.sin(ctx.time * 0.025));
    this.sacL.rotation.set(0, -split * 0.3, split, 'YXZ');
    this.sacR.rotation.set(0, split * 0.3, -split, 'YXZ');
    // Cutters: working while it hunts, wide when it rears.
    const jaw = 0.08 + this.hunt * 0.18 * (0.5 + 0.5 * Math.sin(ctx.time * 0.012)) + raise * 0.35;
    this.mandL.rotation.y = -jaw;
    this.mandR.rotation.y = jaw;
    this.body.updateMatrixWorld(true);
    for (let i = 0; i < LEGS; i++) this.pose(i, raise);
    // Glow: eyes hotter while hunting, white-hot reared; the sac's slits breathe.
    const pulse = 0.5 + 0.5 * Math.sin(ctx.time * 0.008);
    this.glow.eyes.color.setScalar(1 + this.hunt * (0.6 + 0.6 * pulse) + raise * 1.5);
    this.glow.sac.color.setScalar(0.75 + 0.35 * Math.sin(ctx.time * 0.0021) + raise * 0.6 + open * (1.2 + 0.6 * Math.sin(ctx.time * 0.025)));
    this.glow.legs.color.setScalar(1);
    this.gutMat.color.setScalar(open * 0.9);
    this.brood.update(s.s, ctx, far, this.dropAt);
  }

  /** Under the sac, where the spiderlings drop from (world). */
  private dropAt = (out: THREE.Vector3) => out.copy(DROP_AT).applyMatrix4(this.sacFrame[0].matrixWorld);

  /** Stand it where the snapshot says, feet where the server has them (came into view, or moved far). */
  private place(s: BossSnap) {
    this.placed = true;
    this.x = s.x;
    this.z = s.z;
    this.yaw = s.yaw;
    this.vx = this.vz = 0;
    this.legs.forEach((l, i) => {
      const o = S_FEET + i * 4;
      if (s.s[o] === undefined) {
        restSpot(s.x, s.z, s.yaw, i, _p2);
        l.to.set(_p2.x, heightAt(_p2.x, _p2.z), _p2.z);
      } else l.to.set(s.s[o], s.s[o + 1], s.s[o + 2]);
      l.foot.copy(l.to);
      l.ground = l.to.y;
      l.t = -1;
    });
    let gy = 0;
    for (const l of this.legs) gy += l.ground;
    this.y = gy / LEGS + 0.3 + BODY_H;
    this.vy = 0;
  }

  /** The feet go where the server puts them, each new spot a swing from where the foot is. */
  private followFeet(f: number[], dt: number, ctx: BossCtx) {
    this.legs.forEach((l, i) => {
      const o = S_FEET + i * 4;
      const x = f[o], y = f[o + 1], z = f[o + 2], left = f[o + 3];
      if (x === undefined) return;
      l.up = left < 0;
      if (Math.abs(x - l.to.x) > 0.05 || Math.abs(z - l.to.z) > 0.05 || Math.abs(y - l.to.y) > 0.05) {
        l.to.set(x, y, z);
        // A front foot coming down from on high (the slam) goes straight there; the slam is played on its own.
        if (FRONT.includes(i) && this.raise > 0.3) {
          l.foot.copy(l.to);
          l.ground = y;
          l.t = -1;
          return;
        }
        l.from.set(l.foot.x, l.ground, l.foot.z);
        l.t = 0;
        l.dur = Math.max(0.25, left > 0 ? left : 0.5);
      }
      if (l.t < 0) return;
      l.t = Math.min(1, l.t + dt / l.dur);
      const e = l.t * l.t * (3 - 2 * l.t);
      const span = Math.hypot(l.to.x - l.from.x, l.to.z - l.from.z);
      l.foot.lerpVectors(l.from, l.to, e);
      l.ground = l.foot.y;
      // Lifted high and stabbed down: the arc peaks early and drops fast.
      l.foot.y += Math.sin(Math.PI * Math.pow(l.t, 0.7)) * (LIFT + LIFT_K * span + Math.max(0, l.to.y - l.from.y));
      if (l.t >= 1) {
        l.t = -1;
        l.foot.copy(l.to);
        l.ground = l.to.y;
        this.vy -= LAND_DIP;
        const w = Math.min(1, 0.45 + span / 8);
        queenSound.stab(l.to, ctx.ear, w);
        ctx.thump(l.to.x, l.to.y + 0.3, l.to.z, 0.45 * w, 6, 2.5, 1.5);
      }
    });
  }

  /** Leg i: tip at its foot (raised in front while rearing), two-bone IK from the hip to the ankle over it. */
  private pose(i: number, raise: number) {
    const l = this.legs[i];
    _h.set(...SOCKETS[i]).applyMatrix4(this.body.matrixWorld);
    // A front leg reared up: its tip held high ahead (body frame, mirrored on the −X side).
    const front = FRONT.includes(i) && raise > 0;
    _pl.copy(l.foot);
    if (front) {
      _v.set(RAISED.x * (i < 4 ? 1 : -1), RAISED.y, RAISED.z);
      _v.applyAxisAngle(UP, this.yaw).add(_o.set(this.x, this.y - REAR_RISE * raise, this.z));
      _pl.lerp(_v, raise);
    }
    _o.set(_pl.x - _h.x, 0, _pl.z - _h.z).normalize();
    // Ankle: inward of and above the tip; reared, the tarsus points down and forward at its prey.
    _a.copy(_pl).addScaledVector(UP, TARSUS * Math.cos(TARSUS_LEAN)).addScaledVector(_o, -TARSUS * Math.sin(TARSUS_LEAN));
    if (front) {
      _v.set(-Math.sin(this.yaw), 0.55, -Math.cos(this.yaw)).normalize().multiplyScalar(TARSUS);
      _k.copy(_pl).add(_v);
      _a.lerp(_k, raise);
    }
    _v.subVectors(_a, _h);
    const len = Math.min(FEMUR + TIBIA - 0.01, Math.max(Math.abs(TIBIA - FEMUR) + 0.1, _v.length()));
    _v.normalize();
    _r.copy(UP).addScaledVector(_o, 0.15).normalize(); // pole
    _q.copy(_r).addScaledVector(_v, -_r.dot(_v)).normalize();
    const along = (FEMUR * FEMUR - TIBIA * TIBIA + len * len) / (2 * len);
    const up = Math.sqrt(Math.max(0, FEMUR * FEMUR - along * along));
    _k.copy(_h).addScaledVector(_v, along).addScaledVector(_q, up);
    _w.copy(_h).add(_o);
    aim(l.coxa, _h, _w, UP);
    aim(l.femur, _h, _k, _r);
    aim(l.tibia, _k, _a, _r);
    aim(l.tarsus, _a, _pl, _o);
  }

  /** The head, world (for sounds). */
  private headPos(out: THREE.Vector3) {
    return out.set(0, 0, 8).applyMatrix4(this.body.matrixWorld);
  }

  /** The front feet hit the sand: booms, dust, shake. */
  private slamFx(ctx: BossCtx) {
    for (const i of FRONT) {
      const f = this.legs[i].foot;
      ctx.thump(f.x, f.y + 0.3, f.z, 2.6, 26, 8, 4);
    }
    const a = this.legs[FRONT[0]].foot, b = this.legs[FRONT[1]].foot;
    _w.addVectors(a, b).multiplyScalar(0.5);
    queenSound.slam(_w, ctx.ear);
    ctx.shake(0.25);
    this.vy -= 3;
  }

  /**
   * Dead: twitches, then the legs give out one by one (feet skidding out), the body sinking in stages and crashing
   * down; the sac splits open. A function of the time since death, so a wreck that comes into view lies as it fell.
   */
  private die(s: BossSnap, ctx: BossCtx) {
    const dt = ctx.dt;
    if (this.dead < 0) {
      this.dead = s.dead;
      this.y0 = s.dead < 0.5 ? this.y : heightAt(this.x, this.z) + BODY_H;
      for (const l of this.legs) l.t = -1;
      const order = this.legs.map((_, i) => i).sort(() => Math.random() - 0.5);
      this.failAt = this.legs.map((_, i) => TWITCH + order.indexOf(i) * LEG_GAP + Math.random() * 0.12);
      this.went = this.failAt.map((a) => a <= this.dead);
      this.crashed = this.dead > Math.max(...this.failAt) + FAIL_S + 0.3;
      this.raise = 0;
    } else this.dead += dt;
    const t = this.dead;
    const fail = this.failAt.map((a) => jerky((t - a) / FAIL_S));
    const sink = fail.reduce((a, b) => a + b, 0) / LEGS;
    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    let tx = 0, tz = 0;
    this.legs.forEach((l, i) => {
      restSpot(this.x, this.z, this.yaw, i, _p2);
      const out = 1 + 0.25 * fail[i];
      l.foot.set(this.x + (_p2.x - this.x) * out, 0, this.z + (_p2.z - this.z) * out);
      l.foot.y = l.ground = heightAt(l.foot.x, l.foot.z) - 0.3;
      l.up = false;
      const sx = SOCKETS[i][0], sz = SOCKETS[i][2];
      tx += sx * fail[i] * (1.2 - i / LEGS);
      tz += sz * fail[i] * (1.2 - i / LEGS);
      if (!this.went[i] && t > this.failAt[i]) {
        this.went[i] = true;
        l.tibia.getWorldPosition(_w);
        rifleSound.fail(_w, ctx.ear, true);
      }
    });
    const ground = heightAt(this.x, this.z);
    const end = Math.max(...this.failAt) + FAIL_S;
    const twitch = t < TWITCH ? Math.sin(t * 61) * 0.08 * (1 - t / TWITCH) : 0;
    const bounce = t > end ? Math.sin((t - end) * 13) * Math.exp(-(t - end) * 5) * 0.3 : 0;
    this.y = this.y0 + (ground + DEAD_REST - this.y0) * Math.pow(sink, 1.3) + twitch + bounce;
    if (!this.crashed && t >= end) {
      this.crashed = true;
      ctx.thump(this.x, ground, this.z, 2.8, 40, 8, 4.5);
      rifleSound.slam({ x: this.x, y: ground, z: this.z }, ctx.ear, true);
      queenSound.slam({ x: this.x, y: ground, z: this.z }, ctx.ear);
    }
    // Tipped towards the legs that went first (body frame: tx sideways, tz along).
    const tip = Math.min(1, sink * 1.5) * 0.04;
    this.pitch += (-tz * tip - this.pitch) * Math.min(1, dt * 6);
    this.roll += (tx * tip - this.roll) * Math.min(1, dt * 6);
    // Before the server clears the wreck, it sinks into the sand.
    const gone = Math.max(0, (t - (BOSSES.queen.wreckS - SINK_S)) / SINK_S);
    this.root.position.y = -gone * gone * 9;
    this.body.position.set(this.x, this.y, this.z);
    this.body.rotation.set(this.pitch + (twitch ? Math.sin(t * 47) * 0.03 : 0), this.yaw + twitch * 0.2, this.roll, 'YXZ');
    // The sac comes down on its belly and splits open along its seam.
    const split = smooth((t - end - 0.1) / 0.5) * SPLIT;
    this.sacPivot.rotation.set(0.28 * sink, 0, 0, 'YXZ');
    this.sacL.rotation.set(0, -split * 0.3, split, 'YXZ');
    this.sacR.rotation.set(0, split * 0.3, -split, 'YXZ');
    this.mandL.rotation.y = -0.5 * sink;
    this.mandR.rotation.y = 0.5 * sink;
    this.body.updateMatrixWorld(true);
    for (let i = 0; i < LEGS; i++) this.pose(i, 0);
    // Eyes stutter out; the sac's slits fade to embers, its inside glows and smokes.
    const flick = t < end ? (Math.sin(t * 37) * Math.sin(t * 13) > 0.2 ? 1 : 0.15) * (1 - t / end) : 0;
    this.glow.eyes.color.setScalar(flick);
    this.glow.legs.color.setScalar(t < end ? 1 - sink : 0);
    this.glow.sac.color.setScalar(0.15 + 0.6 * (1 - sink));
    this.gutMat.color.setScalar(split > 0 ? 0.5 + 0.3 * Math.sin(t * 3.1) * Math.sin(t * 1.7) : 0);
    if (t > end) {
      this.smoke += dt * 6;
      while (this.smoke >= 1) {
        this.smoke -= 1;
        _w.set((Math.random() - 0.5) * 2, 3.5, -4 - Math.random() * 12).applyMatrix4(this.sacPivot.matrixWorld);
        if (this.root.position.y > -6) zaps.puff(_w.x, _w.y + this.root.position.y, _w.z, 3 + Math.random() * 2, 2.5);
      }
    }
  }

  minion(o: THREE.Vector3, d: THREE.Vector3, max: number): { index: number; dist: number } | null {
    return this.brood.ray(o, d, max);
  }

  hull(o: THREE.Vector3, d: THREE.Vector3, max: number): number | null {
    if (!this.root.visible) return null;
    let best: number | null = null;
    const take = (t: number | null) => {
      if (t !== null && t <= max && (best === null || t < best)) best = t;
    };
    take(sphere(o, d, _w.set(0, 0, 0.5).applyMatrix4(this.body.matrixWorld), 4.6));
    take(sphere(o, d, _w.set(0, 0, 7).applyMatrix4(this.body.matrixWorld), 2.4));
    for (const z of [-5, -10, -14.5]) take(sphere(o, d, _w.set(0, 0.4, z).applyMatrix4(this.sacFrame[0].matrixWorld), z === -10 ? 4.6 : 3.8));
    for (const l of this.legs) {
      take(capsule(o, d, l.femur.position, l.tibia.position, 0.65));
      take(capsule(o, d, l.tibia.position, l.tarsus.position, 0.5));
    }
    return best;
  }

  dispose() {
    this.scene.remove(this.root);
    this.brood.dispose();
    for (const m of [...Object.values(this.glow), this.gutMat]) m.dispose();
  }
}
