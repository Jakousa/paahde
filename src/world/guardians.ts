// The walkers (shared/guardians.ts): giant three- and four-legged guardians and the player-sized crawlers, one
// rig at different scales (KINDS). The server says where each body is
// and which way it faces; the legs are procedural, here, on every client:
//
// - Guardians' feet are the server's (server/guardians.ts stepFeet, sent in 'bots'), so players collide with the same
//   planted feet everywhere (shared/sim.ts collideLegs): when the server moves a foot, it swings there from where it
//   is, in the time the server gives. Crawlers' gait is worked out here, by the same rules:
// - Every foot has a rest spot on the ground (REST_R out along its hip socket, turned with the body, led ahead by
//   the body's velocity). A planted foot stays exactly where it landed until its rest spot has drifted STEP_DIST
//   away (or the body has stopped and it's a little off: it settles).
// - A foot comes down on top of whatever is there: sand, rock, a wreck or scrap (shared/guardians.ts footTop).
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
// - Weak points (shared/rifle.ts): red glowing lenses on the knees (guardians) or flanks (crawlers), pulsing. The
//   local rifle tests its shots against them as drawn here (raycast); a shot one shatters (glass, sparks, a flinch) and
//   keeps smoking. With all of them broken the walker dies: it twitches, then its legs give out one after another in
//   jerky servo steps, feet skidding out, and the body sinks in stages to the sand, tipping towards the legs that went
//   first, and slams down; its eye flickers out and it smokes, then sinks into the sand before the server clears it.
//
// Models: public/models/guardian.glb (tools/blender/guardians.py), one separate node per part with its origin
// at its joint; boxes stand in until it has loaded.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  ANKLE, BODY_H, CRAWLER, FEMUR, footTop, GUN_MOUNT, GUN_PIVOT, KINDS, MUZZLE, REST_R, SETTLE, SOCKETS, STEP_DIST, STEP_MAX, STEP_MIN, TIBIA,
} from '../../shared/guardians.ts';
import { heightAt, normalAt } from '../../shared/terrain.ts';
import { HIT_PAD, weakPoints, WRECK_S, WRECK_SINK, type WeakPoint } from '../../shared/rifle.ts';
import type { GuardianFrame } from './botFrames.ts';
import { zaps } from './zaps.ts';

/** Drawn within this distance (m), by kind. Lengths and times below are for scale 1; a walker of scale s uses
 *  lengths × s and times × √s (dynamic similarity: small legs swing quicker). */
const SHOW_R = [2000, 260];
/** The lift (m) for a step of length d: LIFT + LIFT_K·d. (Step distance and swing times: shared/guardians.ts.) */
const LIFT = 1.6, LIFT_K = 0.22;
/** Body spring: stiffness, damping, and the dip when a foot lands (m/s). */
const SPRING_K = 9, SPRING_C = 4.5, LAND_DIP = 0.9;
/** Body tilt limit (radians). */
const MAX_TILT = 0.2;

export type Footfall = { x: number; y: number; z: number; /** 0..1 how hard */ weight: number; /** KINDS index */ kind: number; /** the walker */ id: number };
/** Something happened to a walker at (x, y, z): a weak point shattered, a leg gave out while dying, it hit the sand. */
export type WalkerEvent = { what: 'break' | 'fail' | 'slam'; x: number; y: number; z: number; kind: number };
/** What a shot struck: a weak point (`walker`, `index`), or just a walker's metal (index -1). */
export type ShotHit = { walker: number; index: number; dist: number; point: THREE.Vector3; normal: THREE.Vector3 };

/** Dying (seconds × √scale): twitching for TWITCH, then a leg gives out every LEG_GAP (± a little), each in FAIL_S. */
const TWITCH = 0.7, LEG_GAP = 0.55, FAIL_S = 0.75;
/** Dead, the body's centre rests this high (× scale) over the sand (the hull's belly on it), feet skidded out by
 *  SPLAY × REST_R, tipped by up to TIP rad towards the legs that went first. */
const BODY_REST = 2.5, SPLAY = 0.85, TIP = 0.22;
/** Smoke puffs per second from a broken weak point, and from a wreck's body. */
const SMOKE_RATE = 7, WRECK_SMOKE = 5;

/** A servo giving up: three quick jerks with holds between, 0..1. */
function jerky(x: number) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const n = 3, k = Math.floor(x * n), f = Math.min(1, ((x * n - k) / 0.35));
  return (k + f * f * (3 - 2 * f)) / n;
}

const lensGeo = new THREE.SphereGeometry(1, 16, 12);
const rimGeo = new THREE.TorusGeometry(1.02, 0.22, 6, 16);
const lensMat = new THREE.MeshStandardNodeMaterial({ color: 0x500000, roughness: 0.2, metalness: 0.1, emissive: 0xff0800, emissiveIntensity: 2.4 });
const brokenMat = new THREE.MeshStandardNodeMaterial({ color: 0x140c0a, roughness: 0.9, metalness: 0.3 });
const rimMat = new THREE.MeshStandardNodeMaterial({ color: 0x2a2624, roughness: 0.5, metalness: 0.8 });
type Target = { wp: WeakPoint; lens: THREE.Mesh; group: THREE.Group; broken: boolean; smoke: number };

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
  /** Swinging from (its y on the ground), to (the server's spot, guardians); the sole's height without the lift. */
  from: THREE.Vector3;
  to: THREE.Vector3;
  ground: number;
  /** Swing progress 0..1, or -1 planted. */
  t: number;
  dur: number;
  hip: THREE.Object3D; femur: THREE.Object3D; tibia: THREE.Object3D; footObj: THREE.Object3D;
};

const _v = new THREE.Vector3(), _h = new THREE.Vector3(), _a = new THREE.Vector3(), _k = new THREE.Vector3();
const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3();
const _z = new THREE.Vector3(), _n = { x: 0, y: 1, z: 0 }, _m = new THREE.Matrix4(), _r = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const _w = new THREE.Vector3(), _o = new THREE.Vector3();

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

/** Distance along unit ray (o, d) to sphere (c, r), or null if it misses (0 if o is inside). */
function sphere(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, r: number): number | null {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z, cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : cc < 0 ? 0 : null;
}

const _ca = new THREE.Vector3(), _cb = new THREE.Vector3();
/** Distance along unit ray (o, d) to the capsule a–b of radius r (where it passes closest, stepped back), or null. */
function capsule(o: THREE.Vector3, d: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number): number | null {
  // Closest points between the ray and the segment.
  const u = _ca.subVectors(b, a), w = _cb.subVectors(o, a);
  const uu = u.dot(u), ud = u.dot(d), uw = u.dot(w), dw = d.dot(w);
  const den = uu - ud * ud;
  let sc = den > 1e-6 ? (uw - ud * dw) / den : 0;
  sc = Math.max(0, Math.min(1, sc));
  const tc = Math.max(0, sc * ud - dw);
  const px = a.x + u.x * sc - (o.x + d.x * tc), py = a.y + u.y * sc - (o.y + d.y * tc), pz = a.z + u.z * sc - (o.z + d.z * tc);
  const miss = Math.hypot(px, py, pz);
  if (miss > r) return null;
  return Math.max(0, tc - Math.sqrt(r * r - miss * miss));
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
  readonly id: number;
  targets: Target[] = [];
  /** Broken weak points as drawn (server mask, plus local shots not confirmed yet: bit → when). */
  private shown = 0;
  private predicted = new Map<number, number>();
  private flinch = 0;
  private flinchX = 0;
  private flinchZ = 0;
  /** Dying: seconds since death (-1 alive), the body's height then, when each leg gives out, what has played. */
  dead = -1;
  private y0 = 0;
  private failAt: number[] = [];
  private went: boolean[] = [];
  private slammed = false;
  private wreckSmoke = 0;
  onEvent: (e: WalkerEvent) => void = () => {};

  constructor(f: GuardianFrame, scene: THREE.Scene, p: Record<Part, THREE.Object3D>, onFootfall: (f: Footfall) => void) {
    this.id = f.id;
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
        sx, sz, ox: sx / l, oz: sz / l, group: f.legs === 4 ? i % 2 : i, foot: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), ground: 0, t: -1, dur: 1,
        hip: instance(p.hip), femur: instance(p.femur), tibia: instance(p.tibia), footObj: instance(p.foot),
      };
      for (const o of [leg.hip, leg.femur, leg.tibia, leg.footObj]) o.scale.setScalar(this.s);
      this.rest(leg, 0, leg.foot);
      if (f.feet && f.feet[i * 4] !== undefined) leg.foot.set(f.feet[i * 4], f.feet[i * 4 + 1], f.feet[i * 4 + 2]);
      leg.to.copy(leg.foot);
      leg.ground = leg.foot.y;
      this.root.add(leg.hip, leg.femur, leg.tibia, leg.footObj);
      this.legs.push(leg);
    });
    // Weak points: a red lens in a dark rim, on its knee or belly (guardians) or the body (crawlers).
    for (const wp of weakPoints(f.kind, f.legs)) {
      const group = new THREE.Group();
      const lens = new THREE.Mesh(lensGeo, lensMat);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      group.add(lens, rim);
      group.position.set(wp.x, wp.y, wp.z);
      group.scale.setScalar(wp.r);
      // The rim stands across the lens, facing out of the knee or the flank.
      if (wp.on === 'body') rim.rotation.y = Math.PI / 2;
      else rim.rotation.x = Math.PI / 2;
      (wp.on === 'tibia' ? this.legs[wp.leg].tibia : this.body).add(group);
      this.targets.push({ wp, lens, group, broken: false, smoke: Math.random() });
    }
    if (this.noShadows) this.root.traverse((o) => (o.castShadow = false));
    scene.add(this.root);
    this.setBroken(f.broken, true);
  }

  /** Weak point `i` shot here and now (the server hears of it; if it never agrees, the lens comes back). */
  breakLocal(i: number) {
    this.predicted.set(i, performance.now());
    this.setBroken(this.shown | (1 << i), false);
  }

  /** Show weak points by mask; newly broken ones shatter (unless `quiet`: already broken when it came into view). */
  private setBroken(mask: number, quiet: boolean) {
    this.targets.forEach((t, i) => {
      const b = (mask & (1 << i)) !== 0;
      if (b === t.broken) return;
      t.broken = b;
      t.lens.material = b ? brokenMat : lensMat;
      t.lens.scale.setScalar(b ? 0.7 : 1);
      if (!b || quiet) return;
      t.group.getWorldPosition(_w);
      _o.subVectors(_w, _v.set(this.x, this.y, this.z)).normalize();
      zaps.shatter(_w.x, _w.y, _w.z, _o.x, _o.y, _o.z, t.wp.r * this.s);
      this.onEvent({ what: 'break', x: _w.x, y: _w.y, z: _w.z, kind: this.kind });
      // Flinch away from the hit, and the hurt leg buckles a moment.
      this.flinch = 1;
      this.flinchX = _o.x;
      this.flinchZ = _o.z;
      this.vy -= 2.5 * this.ts;
    });
    this.shown = mask;
  }

  /** Server mask plus unconfirmed local breaks (dropped after a second and a half if the server never agrees). */
  private syncBroken(server: number) {
    let mask = server;
    const now = performance.now();
    for (const [i, at] of this.predicted) {
      if (server & (1 << i) || now - at > 1500) this.predicted.delete(i);
      else mask |= 1 << i;
    }
    if (mask !== this.shown) this.setBroken(mask, false);
  }

  /** Smoke and the odd spark out of broken weak points (and the body of a wreck). */
  private smoulder(dt: number) {
    for (const t of this.targets) {
      if (!t.broken) continue;
      t.smoke += dt * SMOKE_RATE;
      if (t.smoke < 1) continue;
      t.smoke -= 1;
      t.group.getWorldPosition(_w);
      zaps.puff(_w.x, _w.y, _w.z, Math.max(0.4, t.wp.r * this.s * 1.4), 1.2 + this.s);
      if (Math.random() < 0.08) zaps.burst(_w.x, _w.y, _w.z, 0, 1, 0, 4, this.s);
    }
    if (this.dead < 0) return;
    this.wreckSmoke += dt * WRECK_SMOKE;
    while (this.wreckSmoke >= 1) {
      this.wreckSmoke -= 1;
      const a = Math.random() * Math.PI * 2, r = Math.random() * 2.5 * this.s;
      zaps.puff(this.x + Math.cos(a) * r, this.y + 2 * this.s, this.z + Math.sin(a) * r, 1.8 * this.s + 0.6, 1.5 + this.s);
    }
  }

  /** Where the shot from `o` along unit `d` first strikes this walker, within `max` m (weak points padded). */
  raycast(o: THREE.Vector3, d: THREE.Vector3, max: number): ShotHit | null {
    let best: ShotHit | null = null;
    const pad = HIT_PAD[this.kind];
    // A weak point just behind the metal the ray clips first (they sit in it) still counts: the lens wins within `lee`.
    let lee = 0;
    const take = (dist: number, index: number, cx: number, cy: number, cz: number) => {
      if (dist < 0 || dist > max) return;
      if (best && (index < 0 ? dist >= best.dist - (best.index >= 0 ? lee : 0) : best.index >= 0 ? dist >= best.dist : dist > best.dist + lee)) return;
      const point = o.clone().addScaledVector(d, dist);
      best = { walker: this.id, index, dist, point, normal: point.clone().sub(_v.set(cx, cy, cz)).normalize() };
    };
    this.targets.forEach((t, i) => {
      if (t.broken) return;
      t.group.getWorldPosition(_w);
      const r = t.wp.r * this.s;
      lee = Math.max(lee, 3 * r * pad);
      // Hits the padded sphere: lands on the drawn one's surface (or its nearest point).
      const along = sphere(o, d, _w, r * pad);
      if (along !== null) take(Math.max(0, sphere(o, d, _w, r) ?? along), i, _w.x, _w.y, _w.z);
    });
    // The hull and the legs: metal (sparks, no harm).
    const hull = sphere(o, d, _w.set(this.x, this.y + 0.8 * this.s, this.z), 3.6 * this.s);
    if (hull !== null) take(hull, -1, this.x, this.y + 0.8 * this.s, this.z);
    for (const leg of this.legs) {
      for (const [a, b, r] of [[leg.femur, leg.tibia, 1], [leg.tibia, leg.footObj, 0.7]] as const) {
        const hit = capsule(o, d, a.position, _k.copy(b.position).addScaledVector(UP, b === leg.footObj ? ANKLE * this.s : 0), r * this.s);
        if (hit !== null) {
          _p.copy(o).addScaledVector(d, hit);
          const t = Math.max(0, Math.min(1, _a.subVectors(_p, a.position).dot(_r.subVectors(_k, a.position)) / _r.lengthSq()));
          _a.copy(a.position).addScaledVector(_r, t);
          take(hit, -1, _a.x, _a.y, _a.z);
        }
      }
    }
    return best;
  }

  /** Leg's rest spot on the ground, led `lead` seconds ahead along the body's velocity, into `out`. */
  private rest(leg: Leg, lead: number, out: THREE.Vector3) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const lx = leg.ox * REST_R * this.s, lz = leg.oz * REST_R * this.s;
    out.x = this.x + lx * c + lz * s + this.vx * lead;
    out.z = this.z - lx * s + lz * c + this.vz * lead;
    out.y = footTop(out.x, out.z, this.s);
    return out;
  }

  update(f: GuardianFrame, dt: number) {
    if (dt <= 0) return;
    this.syncBroken(f.broken);
    this.smoulder(dt);
    if (f.dead > 0) return this.die(f, dt);
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
      this.legs.forEach((leg, i) => {
        leg.t = -1;
        this.rest(leg, 0, leg.foot);
        if (f.feet && f.feet[i * 4] !== undefined) leg.foot.set(f.feet[i * 4], f.feet[i * 4 + 1], f.feet[i * 4 + 2]);
        leg.to.copy(leg.foot);
        leg.ground = leg.foot.y;
      });
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

    const n = this.legs.length;
    if (f.feet) this.followFeet(f.feet, dt);
    else this.gait(footSpeed, dt);

    // Body: over the feet's average ground, tilted to their plane, on a spring.
    let gy = 0, sp = 0, sr = 0, pp = 0, rr = 0;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    for (const leg of this.legs) gy += leg.ground;
    gy /= n;
    for (const leg of this.legs) {
      const fy = leg.ground - gy;
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

    // A flinch: jolted away from a shot, settling back.
    this.flinch = Math.max(0, this.flinch - dt * 2.5 / T);
    const jolt = Math.sin(this.flinch * Math.PI) * 0.12 * this.flinch;
    const fz = this.flinchX * s + this.flinchZ * c, fx = this.flinchX * c - this.flinchZ * s;
    this.body.position.set(this.x + this.flinchX * jolt * 2 * S, this.y, this.z + this.flinchZ * jolt * 2 * S);
    this.body.rotation.set(this.pitch - fz * jolt, this.yaw, this.roll + fx * jolt, 'YXZ');
    this.body.updateMatrixWorld();
    for (const leg of this.legs) this.pose(leg, dt);

    // The eye: hotter and pulsing while it hunts.
    this.glow += ((this.hunt ? 1 : 0) - this.glow) * (1 - Math.exp(-dt * 2));
    const pulse = this.glow * (0.6 + 0.4 * Math.sin(performance.now() / 120));
    for (const e of this.eyes) e.emissiveIntensity = (e.userData.base as number) * (1 + 3 * pulse);
    this.aimGun(f, dt);
  }

  /** Crawlers: their own gait (see the top of the file). */
  private gait(footSpeed: number, dt: number) {
    // Gait: how many feet may swing at once, and how long a swing takes so they keep up (Froude speed: speed/√s).
    const n = this.legs.length, S = this.s, T = this.ts;
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
      leg.ground = leg.foot.y;
      leg.foot.y += Math.sin(Math.PI * Math.pow(leg.t, 0.8)) * (LIFT * S + LIFT_K * span);
      if (leg.t >= 1) {
        leg.t = -1;
        leg.foot.copy(_p);
        leg.ground = _p.y;
        this.vy -= LAND_DIP * T * Math.min(1, span / (STEP_DIST * S) + 0.3);
        this.onFootfall({ x: _p.x, y: _p.y, z: _p.z, weight: Math.min(1, 0.4 + span / (STEP_DIST * S)), kind: this.kind, id: this.id });
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
  }

  /** Guardians: the feet go where the server puts them, each new spot a swing from where the foot is, landing in
   *  the time the server has left for it (`feet`: x, y, z, s left per leg). */
  private followFeet(feet: number[], dt: number) {
    const S = this.s, T = this.ts;
    this.legs.forEach((leg, i) => {
      const x = feet[i * 4], y = feet[i * 4 + 1], z = feet[i * 4 + 2], left = feet[i * 4 + 3];
      if (x === undefined) return;
      if (Math.hypot(x - leg.to.x, z - leg.to.z) > 0.05 || Math.abs(y - leg.to.y) > 0.05) {
        leg.to.set(x, y, z);
        if (Math.hypot(x - leg.foot.x, z - leg.foot.z) > 40 * S) {
          // Far off (it came into view mid-stride): just put it there.
          leg.foot.copy(leg.to);
          leg.ground = y;
          leg.t = -1;
          return;
        }
        leg.from.set(leg.foot.x, leg.ground, leg.foot.z);
        leg.t = 0;
        leg.dur = Math.max(0.3 * T, left > 0 ? left : 0.6 * T);
      }
      if (leg.t < 0) return;
      leg.t = Math.min(1, leg.t + dt / leg.dur);
      const e = leg.t * leg.t * (3 - 2 * leg.t);
      const span = Math.hypot(leg.to.x - leg.from.x, leg.to.z - leg.from.z);
      leg.foot.lerpVectors(leg.from, leg.to, e);
      leg.ground = leg.foot.y;
      // Up and over whatever is in the way: a step onto a wreck lifts higher.
      const climb = Math.max(0, leg.to.y - leg.from.y);
      leg.foot.y += Math.sin(Math.PI * Math.pow(leg.t, 0.8)) * (LIFT * S + LIFT_K * span + climb);
      if (leg.t >= 1) {
        leg.t = -1;
        leg.foot.copy(leg.to);
        leg.ground = leg.to.y;
        this.vy -= LAND_DIP * T * Math.min(1, span / (STEP_DIST * S) + 0.3);
        this.onFootfall({ x: leg.to.x, y: leg.to.y, z: leg.to.z, weight: Math.min(1, 0.4 + span / (STEP_DIST * S)), kind: this.kind, id: this.id });
      }
    });
  }

  /**
   * Dead: twitches, then the legs give out one by one in servo jerks (feet skidding out), the body sinking in stages
   * towards the sand and tipping towards the legs that failed first, and a slam at the end. A function of the time
   * since death, so a wreck that comes into view lies as it fell.
   */
  private die(f: GuardianFrame, dt: number) {
    const S = this.s, T = this.ts;
    if (this.dead < 0) {
      // Late (came into view dead, or a long frame): start as far in as the server says.
      this.dead = f.dead;
      this.y0 = f.dead < 0.5 ? this.y : heightAt(this.x, this.z) + BODY_H * S;
      for (const leg of this.legs) leg.t = -1;
      // The legs give out in a shuffled order.
      const order = this.legs.map((_, i) => i).sort(() => Math.random() - 0.5);
      this.failAt = this.legs.map((_, i) => (TWITCH + order.indexOf(i) * LEG_GAP + Math.random() * 0.2) * T);
      this.went = this.failAt.map((a) => a <= this.dead);
      this.slammed = this.dead > Math.max(...this.failAt) + FAIL_S * T + 0.3;
    } else this.dead += dt;
    const t = this.dead;
    const fail = this.failAt.map((a) => jerky((t - a) / (FAIL_S * T)));
    const n = this.legs.length;
    const sink = fail.reduce((a, b) => a + b, 0) / n;
    // Feet skid out as their legs go, and stay put on the sand.
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    let tx = 0, tz = 0;
    this.legs.forEach((leg, i) => {
      this.rest(leg, 0, _p);
      const out = 1 + SPLAY * fail[i];
      leg.foot.set(this.x + (_p.x - this.x) * out, 0, this.z + (_p.z - this.z) * out);
      leg.foot.y = leg.ground = footTop(leg.foot.x, leg.foot.z, S);
      tx += leg.ox * fail[i] * (1.2 - i / n);
      tz += leg.oz * fail[i] * (1.2 - i / n);
      if (!this.went[i] && t > this.failAt[i]) {
        // This leg just went: a clunk at its knee.
        this.went[i] = true;
        leg.tibia.getWorldPosition(_w);
        this.onEvent({ what: 'fail', x: _w.x, y: _w.y, z: _w.z, kind: this.kind });
      }
    });
    const ground = heightAt(this.x, this.z);
    const rest = ground + BODY_REST * S;
    const end = Math.max(...this.failAt) + FAIL_S * T;
    // Twitching first (servos fighting), a little shudder as each stage drops; after the slam a short bounce.
    const twitch = t < TWITCH * T ? Math.sin(t * 61) * 0.06 * S * (1 - t / (TWITCH * T)) : 0;
    const bounce = t > end ? Math.sin((t - end) * 14) * Math.exp(-(t - end) * 5) * 0.2 * S : 0;
    this.y = this.y0 + (rest - this.y0) * Math.pow(sink, 1.3) + twitch + bounce;
    if (!this.slammed && t >= end) {
      this.slammed = true;
      this.onEvent({ what: 'slam', x: this.x, y: ground, z: this.z, kind: this.kind });
    }
    // Tipped towards the legs that went first (their side drops), in the body frame.
    const lz = tx * s + tz * c, lx = tx * c - tz * s;
    const tip = Math.min(1, sink * 1.5) * TIP;
    this.pitch += (-lz * tip - this.pitch) * Math.min(1, dt * 6);
    this.roll += (lx * tip - this.roll) * Math.min(1, dt * 6);
    const jx = twitch ? Math.sin(t * 47) * 0.03 : 0;
    this.body.position.set(this.x, this.y, this.z);
    this.body.rotation.set(this.pitch + jx, this.yaw + twitch * 0.2, this.roll, 'YXZ');
    this.body.updateMatrixWorld();
    for (const leg of this.legs) this.pose(leg, dt);
    // The eye stutters and goes out; the gun sags.
    const flick = t < end ? (Math.sin(t * 37) * Math.sin(t * 13) > 0.2 ? 1 : 0.15) * (1 - t / end) : 0;
    for (const e of this.eyes) e.emissiveIntensity = (e.userData.base as number) * flick;
    for (const g of this.glows) g.emissiveIntensity = 0;
    this.gunPitch += (1.3 - this.gunPitch) * Math.min(1, dt * 1.5);
    // Before the server clears the wreck, it sinks into the sand.
    const gone = Math.max(0, (t - (WRECK_S[this.kind] - WRECK_SINK)) / WRECK_SINK);
    this.root.position.y = -gone * gone * (BODY_REST + 4) * S;
    this.turret.rotation.set(0, this.gunYaw, 0);
    this.gun.rotation.set(this.gunPitch, 0, 0);
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
    // On sand or rock, along its slope; on a wreck or scrap, level.
    if (leg.ground > heightAt(leg.foot.x, leg.foot.z) + 0.2) _n.x = _n.z = 0, _n.y = 1;
    else normalAt(leg.foot.x, leg.foot.z, _n);
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
    this.targets.length = 0;
    for (const e of [...this.eyes, ...this.glows]) e.dispose();
  }
}

export class Guardians {
  private walkers = new Map<number, Walker>();
  /** Every foot that lands (src/guardianSound.ts, dust, shake). */
  onFootfall: (f: Footfall) => void = () => {};
  /** Weak points shattering, legs giving out, wrecks hitting the sand (src/guardians.ts: sound, dust). */
  onEvent: (e: WalkerEvent) => void = () => {};

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
        w.onEvent = (e) => this.onEvent(e);
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
    // Weak points breathe, all together.
    lensMat.emissiveIntensity = 2.2 + 0.9 * Math.sin(performance.now() / 260);
    for (const [id, w] of this.walkers) {
      if (seen.has(id)) continue;
      w.dispose();
      this.walkers.delete(id);
    }
  }

  /** The first thing on any drawn walker the shot from `o` along unit `d` strikes within `max` m. */
  raycast(o: THREE.Vector3, d: THREE.Vector3, max: number): ShotHit | null {
    let best: ShotHit | null = null;
    for (const w of this.walkers.values()) {
      // Cheap reject: the ray passes nowhere near it.
      _v.set(w.x, w.y, w.z).sub(o);
      const along = _v.dot(d);
      if (along < -20 * w.s || along > max + 30 * w.s || _v.addScaledVector(d, -along).length() > (REST_R + FEMUR) * w.s * 1.3) continue;
      const hit = w.raycast(o, d, best?.dist ?? max);
      if (hit && (!best || hit.dist < best.dist)) best = hit;
    }
    return best;
  }

  /** Weak point `i` of walker `id` shot by us: shatter it now. */
  breakLocal(id: number, i: number) {
    this.walkers.get(id)?.breakLocal(i);
  }

  /** Guardian `id` fired: its gun recoils; its muzzle (world) into `out`, or null if it isn't drawn. */
  fire(id: number, out: THREE.Vector3): THREE.Vector3 | null {
    return this.walkers.get(id)?.fire(out) ?? null;
  }

  /** Bodies, for sound and the locator: position, height, whether it hunts you. */
  *bodies(): Generator<{ x: number; y: number; z: number; hunt: number; speed: number; kind: number }> {
    for (const w of this.walkers.values()) yield { x: w.x, y: w.y, z: w.z, hunt: w.dead >= 0 ? 0 : w.hunt, speed: w.dead >= 0 ? 0 : Math.hypot(w.vx, w.vz), kind: w.kind };
  }

  private fallback?: Record<Part, THREE.Object3D>;
}
