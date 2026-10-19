// The harvesters (shared/harvester.ts): public/models/harvester.glb (made by tools/blender/harvester.py; a block
// stand-in until it has loaded), placed every frame from the route and the server clock. Its treads run round their
// loops (an instanced track shoe), the cutter drum in its maw turns and throws up sand, the stacks smoke and the stern
// chute spills sifted sand. Its slit eye glows amber, red when it has turned on someone; then the turret on its tower
// swings round to them (`aimAt`) and its barrels kick when it fires (fire). Each heat vent glows until shot out, then
// smokes; with the last one it seizes, burning (onDeath), the eye dead. The rifle tests shots against it (raycast).
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  BARREL, BOW, EYE, HALF_W, harvesterAt, harvesterPose, HULL_TOP, SHOW_R, TOWER_TOP, TRACK, TRACK_W, TURRET,
  VENT_HALF, VENT_HP, VENTS, WHEELBASE, type Harvester, type HarvesterPose,
} from '../../shared/harvester.ts';
import { tyreDust } from '../tyreDust';
import { zaps } from './zaps';

/** The track loops (keep in step with tools/blender/harvester.py): end wheels LOOP_HALF either side of the unit's
 *  centre, LOOP_R round, axles at LOOP_Y; LINKS shoes a loop. */
const LOOP_HALF = 3.2;
const LOOP_R = 1.8;
const LOOP_Y = 1.98;
const LINKS = 30;
const LOOP = 4 * LOOP_HALF + 2 * Math.PI * LOOP_R;
const UNITS: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
/** The drum (local axle) and its radius; the stacks' tops and the chute's end (tools/blender/harvester.py). */
const DRUM = new THREE.Vector3(0, 1.9, 16.2);
const DRUM_R = 1.6;
const STACKS: [number, number, number][] = [[-5.4, 21, -13], [-5.4, 21, -10.6], [-5.4, 21, -8.2]];
const CHUTE = new THREE.Vector3(2.5, 5.0, -18.2);
/** Effects (dust, smoke) only within this far (m) of the camera. */
const FX_R = 700;
/** The turret turns this fast (rad/s); the barrels kick back this far (m) and recover. */
const TURN = 0.9;
const KICK = 0.9;

const EYE_CALM = new THREE.Color(0xffb040);
const EYE_HUNT = new THREE.Color(0xff2a10);
const VENT_ON = new THREE.Color(0xff5a10);

/** The track shoe's way round a loop d m from the bottom run's rear end, forward: (y, z) of its centre and its turn
 *  about X (0 on the top run, grouser up; π on the bottom, grouser down). */
function loopAt(d: number, out: { y: number; z: number; a: number }) {
  const L = 2 * LOOP_HALF, A = Math.PI * LOOP_R;
  d = ((d % LOOP) + LOOP) % LOOP;
  if (d < L) return Object.assign(out, { y: LOOP_Y - LOOP_R, z: -LOOP_HALF + d, a: Math.PI });
  d -= L;
  if (d < A) {
    const t = d / LOOP_R;
    return Object.assign(out, { y: LOOP_Y - LOOP_R * Math.cos(t), z: LOOP_HALF + LOOP_R * Math.sin(t), a: Math.PI - t });
  }
  d -= A;
  if (d < L) return Object.assign(out, { y: LOOP_Y + LOOP_R, z: LOOP_HALF - d, a: 0 });
  d -= L;
  const t = d / LOOP_R;
  return Object.assign(out, { y: LOOP_Y + LOOP_R * Math.cos(t), z: -LOOP_HALF - LOOP_R * Math.sin(t), a: -t });
}

type Parts = { hull: THREE.Object3D; drum: THREE.Object3D; turret: THREE.Object3D; guns: THREE.Object3D; eye: THREE.Object3D; vents: THREE.Object3D[]; link: THREE.Mesh };

/** harvester.glb's parts, once loaded. */
let model: Parts | null = null;
let loading = false;
const waiting = new Set<View>();

function load() {
  if (loading) return;
  loading = true;
  new GLTFLoader().loadAsync('./models/harvester.glb').then(
    (gltf) => {
      const get = (n: string) => {
        const o = gltf.scene.getObjectByName(n);
        if (!o) throw new Error(`harvester.glb has no ${n}`);
        return o;
      };
      model = {
        hull: get('Harvester_Hull'), drum: get('Harvester_Drum'), turret: get('Harvester_Turret'), guns: get('Harvester_Guns'),
        eye: get('Harvester_Eye'), vents: VENTS.map((_, i) => get(`Harvester_Vent${i}`)), link: get('Harvester_Link') as THREE.Mesh,
      };
      for (const v of waiting) v.fill();
      waiting.clear();
    },
    (e) => {
      waiting.clear();
      console.warn('harvesters: model failed, using blocks', e);
    },
  );
}

const iron = new THREE.MeshStandardNodeMaterial({ color: 0x2a2420, roughness: 0.62, metalness: 0.6 });
/** Stand-in parts from blocks, until the model is in (and if it fails). */
function blocks(): Parts {
  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), iron);
    m.position.set(x, y, z);
    return m;
  };
  const hull = new THREE.Group();
  hull.add(box(15, 6.2, 30, 0, 7.9, -0.5), box(7.6, 6.4, 13, 0, 14.2, -4.5));
  for (const [sx, sz] of UNITS) hull.add(box(TRACK_W + 0.5, 4.2, 10.4, sx * (TRACK / 2), 2.4, sz * (WHEELBASE / 2)));
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(DRUM_R, DRUM_R, 11, 10).rotateZ(Math.PI / 2), iron);
  drum.position.copy(DRUM);
  const turret = box(4, 1.6, 5, TURRET.x, TURRET.y, TURRET.z);
  const guns = new THREE.Group();
  guns.position.set(TURRET.x, TURRET.y, TURRET.z);
  guns.add(box(0.4, 0.4, BARREL, 0.6, 0, BARREL / 2), box(0.4, 0.4, BARREL, -0.6, 0, BARREL / 2));
  const glow = (c: number) => new THREE.MeshStandardNodeMaterial({ color: 0, emissive: c, emissiveIntensity: 4 });
  const eye = new THREE.Mesh(new THREE.BoxGeometry(5, 0.3, 0.12), glow(0xffb040));
  eye.position.set(EYE.x, EYE.y, EYE.z);
  const vents = VENTS.map((v) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, VENT_HALF.y * 2, VENT_HALF.z * 2), glow(0xff5a10));
    m.position.set(v.x, v.y, v.z);
    return m;
  });
  const link = new THREE.Mesh(new THREE.BoxGeometry(TRACK_W, 0.3, 0.72), iron);
  return { hull, drum, turret, guns, eye, vents, link };
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(1, 1, 1);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _lp = { y: 0, z: 0, a: 0 };

class View {
  readonly root = new THREE.Group();
  /** Turret yaw and gun pitch (rad, local), barrel kick (m). */
  yaw = 0;
  pitch = 0;
  kick = 0;
  /** Vent hits and state last frame (to spot changes). */
  vents: number[];
  state = -1;
  prey = 0;
  /** Effect accumulators. */
  dust = 0;
  smoke = 0;
  private parts: Parts | null = null;
  private links: THREE.InstancedMesh | null = null;
  private eyeMat: THREE.MeshStandardMaterial | null = null;
  private ventMats: THREE.MeshStandardMaterial[] = [];

  constructor(h: Harvester) {
    this.vents = [...h.vents];
    this.root.rotation.order = 'YXZ';
    if (model) this.fill();
    else {
      this.build(blocks());
      waiting.add(this);
      load();
    }
  }

  fill() {
    if (!model) return;
    const p = model;
    this.build({
      hull: p.hull.clone(), drum: p.drum.clone(), turret: p.turret.clone(), guns: p.guns.clone(), eye: p.eye.clone(),
      vents: p.vents.map((v) => v.clone()), link: p.link,
    });
  }

  private build(p: Parts) {
    this.root.clear();
    this.links?.dispose();
    // Its own eye and vent materials (the glowing ones in each part): they glow and go dark one by one.
    const own = (o: THREE.Object3D) => {
      let mat: THREE.MeshStandardMaterial | null = null;
      o.traverse((c) => {
        const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!m || Array.isArray(m) || !m.emissive || m.emissive.getHex() === 0) return;
        mat ??= m.clone();
        (c as THREE.Mesh).material = mat;
      });
      return (mat ?? new THREE.MeshStandardMaterial()) as THREE.MeshStandardMaterial;
    };
    this.eyeMat = own(p.eye);
    this.ventMats = p.vents.map(own);
    p.turret.add(p.guns);
    p.guns.position.set(0, 0, 0);
    this.links = new THREE.InstancedMesh(p.link.geometry, p.link.material, LINKS * UNITS.length);
    this.links.frustumCulled = false;
    this.root.add(p.hull, p.drum, p.turret, p.eye, ...p.vents, this.links);
    this.parts = p;
  }

  /** Lays the shoes round the loops, `s` m come (the bottom runs stay put on the sand). */
  treads(s: number) {
    if (!this.links) return;
    const pitch = LOOP / LINKS;
    let i = 0;
    for (const [sx, sz] of UNITS) {
      for (let k = 0; k < LINKS; k++) {
        loopAt(k * pitch - s, _lp);
        _q.setFromEuler(_e.set(_lp.a, 0, 0));
        _m.compose(_v.set(sx * (TRACK / 2), _lp.y, sz * (WHEELBASE / 2) + _lp.z), _q, _s);
        this.links.setMatrixAt(i++, _m);
      }
    }
    this.links.instanceMatrix.needsUpdate = true;
  }

  pose(h: Harvester, p: HarvesterPose, aim: THREE.Vector3 | null, dt: number, t: number) {
    const o = this.root;
    o.position.set(p.x, p.y, p.z);
    o.rotation.set(-p.pitch, p.yaw, p.roll);
    o.updateMatrixWorld();
    const parts = this.parts;
    if (!parts) return;
    this.treads(p.s);
    parts.drum.rotation.x = p.s / DRUM_R * 1.6;
    // The turret: onto its prey, else sweeping slowly; dead, it hangs where it stopped.
    if (p.state === 0) {
      let wantYaw = Math.sin(t * 0.00011 + h.id) * 1.2, wantPitch = -0.05;
      if (aim) {
        _w.copy(aim);
        o.worldToLocal(_w).sub(_v.set(TURRET.x, TURRET.y, TURRET.z));
        wantYaw = Math.atan2(_w.x, _w.z);
        wantPitch = Math.atan2(_w.y, Math.hypot(_w.x, _w.z));
      }
      const dy = Math.atan2(Math.sin(wantYaw - this.yaw), Math.cos(wantYaw - this.yaw));
      this.yaw += Math.sign(dy) * Math.min(Math.abs(dy), TURN * dt);
      this.pitch += (Math.max(-0.35, Math.min(0.5, wantPitch)) - this.pitch) * (1 - Math.exp(-dt * 3));
    } else this.pitch += (-0.25 - this.pitch) * (1 - Math.exp(-dt * 0.8));
    parts.turret.rotation.y = this.yaw;
    parts.guns.rotation.x = -this.pitch;
    this.kick *= Math.exp(-dt * 4);
    parts.guns.position.z = -this.kick;
    // The eye: amber, red and pulsing when it hunts, dead once it's a wreck.
    if (this.eyeMat) {
      const hunting = h.prey !== 0 && p.state === 0;
      this.eyeMat.emissive.copy(hunting ? EYE_HUNT : EYE_CALM);
      this.eyeMat.emissiveIntensity = p.state ? 0 : hunting ? 9 + 4 * Math.sin(t * 0.012) : 6;
    }
    this.ventMats.forEach((m, i) => {
      const hurt = h.vents[i];
      m.emissive.copy(VENT_ON);
      // Hit: it sputters, worse with each hit; out, dark.
      const flicker = hurt > 0 ? 0.6 + 0.4 * Math.sin(t * (0.02 + hurt * 0.013) + i) : 1;
      m.emissiveIntensity = hurt >= VENT_HP || p.state ? 0 : 3.5 * flicker;
    });
  }

  /** Muzzle between the barrels, world. */
  muzzle(out: THREE.Vector3) {
    if (!this.parts) return out.set(TURRET.x, TURRET.y, TURRET.z).applyMatrix4(this.root.matrixWorld);
    this.parts.guns.updateWorldMatrix(true, false);
    return out.set(0, 0, BARREL).applyMatrix4(this.parts.guns.matrixWorld);
  }

  dispose() {
    this.links?.dispose();
    for (const m of this.ventMats) m.dispose();
    this.eyeMat?.dispose();
  }
}

/** Hit boxes in the local frame (half sizes, centre): the hull, the tower, the track units, the maw. */
const BOXES: { h: THREE.Vector3; c: THREE.Vector3 }[] = [
  { h: new THREE.Vector3(7.6, (HULL_TOP - 4.6) / 2, 15.4), c: new THREE.Vector3(0, (HULL_TOP + 4.6) / 2, -0.2) },
  { h: new THREE.Vector3(3.9, (TOWER_TOP - HULL_TOP + 1) / 2, 6.6), c: new THREE.Vector3(0, (TOWER_TOP + HULL_TOP - 1) / 2, -4.5) },
  { h: new THREE.Vector3(2.2, 2.4, 2.6), c: new THREE.Vector3(TURRET.x, TURRET.y - 0.4, TURRET.z) },
  { h: new THREE.Vector3(HALF_W, 2.6, 3.3), c: new THREE.Vector3(0, 3.2, BOW - 3.3) },
  ...UNITS.map(([sx, sz]) => ({ h: new THREE.Vector3(2.1, 2.5, 5.3), c: new THREE.Vector3(sx * (TRACK / 2), 2.5, sz * (WHEELBASE / 2)) })),
];
/** The vents' boxes, a little proud of the hull so they're hit before it. */
const VENT_BOXES = VENTS.map((v) => ({ h: new THREE.Vector3(0.45, VENT_HALF.y, VENT_HALF.z), c: new THREE.Vector3(v.x, v.y, v.z) }));

const _inv = new THREE.Matrix4(), _o = new THREE.Vector3(), _d = new THREE.Vector3(), _n = new THREE.Vector3();

/** Where local ray o + d·t enters box b (t within [0, max]), or -1. */
function enter(b: { h: THREE.Vector3; c: THREE.Vector3 }, o: THREE.Vector3, d: THREE.Vector3, max: number, n: THREE.Vector3): number {
  let lo = 0, hi = max;
  let axis: 'x' | 'y' | 'z' = 'x', sign = 1;
  for (const ax of ['x', 'y', 'z'] as const) {
    const a = (b.c[ax] - b.h[ax] - o[ax]) / d[ax], c = (b.c[ax] + b.h[ax] - o[ax]) / d[ax];
    const near = Math.min(a, c);
    if (near > lo) {
      lo = near;
      axis = ax;
      sign = a < c ? -1 : 1;
    }
    hi = Math.min(hi, Math.max(a, c));
  }
  if (lo > hi) return -1;
  n.set(0, 0, 0)[axis] = sign;
  return lo;
}

export class Harvesters {
  private views = new Map<number, View>();
  private pose: HarvesterPose = harvesterPose();
  private scene: THREE.Scene;
  /** A shot hit its armour (sparks only) or a vent (index), at (x, y, z). */
  onHit: (x: number, y: number, z: number, vent: boolean) => void = () => {};
  /** A vent was shot out at (x, y, z). */
  onVentOut: (x: number, y: number, z: number) => void = () => {};
  /** It seized and caught fire at (x, y, z). */
  onDeath: (x: number, y: number, z: number) => void = () => {};

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Every frame: the harvesters out, the server time (ms), the camera, where each one's prey is (null: none here). */
  update(list: Harvester[], t: number, eye: { x: number; z: number }, dt: number, preyAt: (id: number) => THREE.Vector3 | null) {
    const seen = new Set<number>();
    for (const h of list) {
      const p = this.pose;
      if (!harvesterAt(h, t, p) || Math.hypot(p.x - eye.x, p.z - eye.z) > SHOW_R) continue;
      seen.add(h.id);
      let v = this.views.get(h.id);
      if (!v) {
        v = new View(h);
        v.state = p.state;
        this.scene.add(v.root);
        this.views.set(h.id, v);
      }
      v.pose(h, p, h.prey ? preyAt(h.prey) : null, dt, t);
      // What changed since last frame: hits, vents out, its death (not replayed when it comes into view so).
      for (let i = 0; i < VENTS.length; i++) {
        if (h.vents[i] <= v.vents[i]) continue;
        const c = VENTS[i];
        _v.set(c.x, c.y, c.z).applyMatrix4(v.root.matrixWorld);
        if (h.vents[i] >= VENT_HP) this.onVentOut(_v.x, _v.y, _v.z);
        else this.onHit(_v.x, _v.y, _v.z, true);
      }
      v.vents = [...h.vents];
      if (p.state === 1 && v.state === 0) this.onDeath(p.x, p.y + 8, p.z);
      v.state = p.state;
      if (Math.hypot(p.x - eye.x, p.z - eye.z) < FX_R) this.effects(h, v, p, dt);
    }
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      this.scene.remove(v.root);
      v.dispose();
      this.views.delete(id);
    }
  }

  /** Dust off the drum, sand pouring from the chute, smoke from the stacks and dead vents; a wreck burns. */
  private effects(h: Harvester, v: View, p: HarvesterPose, dt: number) {
    const m = v.root.matrixWorld;
    v.dust += dt * (p.state ? 0 : 14);
    for (; v.dust >= 1; v.dust--) {
      _v.set((Math.random() - 0.5) * 11, DRUM.y - 0.6, DRUM.z + 0.8).applyMatrix4(m);
      tyreDust.emit(_v.x, _v.y, _v.z, (Math.random() - 0.5) * 2, 1.5 + Math.random() * 2.5, (Math.random() - 0.5) * 2, 1.6 + Math.random() * 1.4);
      _v.copy(CHUTE).applyMatrix4(m);
      tyreDust.emit(_v.x + (Math.random() - 0.5), _v.y, _v.z + (Math.random() - 0.5), 0, -1.5 - Math.random(), 0, 0.9 + Math.random() * 0.8, 1.6);
    }
    const out = h.vents.filter((n) => n >= VENT_HP).length;
    v.smoke += dt * (p.state ? 10 : 2.5 + out * 2);
    for (; v.smoke >= 1; v.smoke--) {
      const s = STACKS[Math.floor(Math.random() * STACKS.length)];
      _v.set(s[0], s[1], s[2]).applyMatrix4(m);
      zaps.puff(_v.x, _v.y, _v.z, p.state ? 4 : 1.6, p.state ? 3 : 2.5);
      // Shot-out vents (all of them on a wreck) pour smoke.
      const dead = VENTS.filter((_, i) => p.state || h.vents[i] >= VENT_HP);
      if (dead.length) {
        const c = dead[Math.floor(Math.random() * dead.length)];
        _v.set(c.x + Math.sign(c.x) * 0.8, c.y, c.z).applyMatrix4(m);
        zaps.puff(_v.x, _v.y, _v.z, p.state ? 3 : 1.8, 2);
      }
    }
  }

  /** The turret of harvester `id` fired: its barrels kick; where its muzzle is (null: not drawn). */
  fire(id: number, out: THREE.Vector3): THREE.Vector3 | null {
    const v = this.views.get(id);
    if (!v) return null;
    v.kick = KICK;
    return v.muzzle(out);
  }

  /** Bodies, for sound: where each one is, whether it crawls, whether it has turned on `me`. */
  *bodies(me: number): Generator<{ id: number; x: number; y: number; z: number; alive: boolean; hunting: boolean; vents: number; prey: number }> {
    for (const [id, v] of this.views) {
      const p = v.root.position;
      yield { id, x: p.x, y: p.y + 6, z: p.z, alive: v.state === 0, hunting: v.prey === me, vents: v.vents.filter((n) => n < VENT_HP).length, prey: v.prey };
    }
  }

  /** Note who each one hunts (for bodies()). */
  setPrey(list: Harvester[]) {
    for (const h of list) {
      const v = this.views.get(h.id);
      if (v) v.prey = h.prey;
    }
  }

  /** The first harvester the shot from `o` along unit `d` strikes within `max` m: which, the vent (-1 its armour),
   *  how far, and the surface's normal (world). Wrecks still stop shots. */
  raycast(o: THREE.Vector3, d: THREE.Vector3, max: number): { harvester: number; index: number; dist: number; normal: THREE.Vector3 } | null {
    let best: { harvester: number; index: number; dist: number; normal: THREE.Vector3 } | null = null;
    for (const [id, v] of this.views) {
      _inv.copy(v.root.matrixWorld).invert();
      _o.copy(o).applyMatrix4(_inv);
      _d.copy(o).add(d).applyMatrix4(_inv).sub(_o);
      const lim = best ? best.dist : max;
      let hit = -1, idx = -1;
      const normal = new THREE.Vector3();
      VENT_BOXES.forEach((b, i) => {
        const t = enter(b, _o, _d, lim, _n);
        if (t < 0 || (hit >= 0 && t >= hit) || v.vents[i] >= VENT_HP || v.state !== 0) return;
        hit = t;
        idx = i;
        normal.copy(_n);
      });
      // Its armour, unless the shot reached a vent first (they stand a little proud of it).
      for (const b of BOXES) {
        const t = enter(b, _o, _d, hit >= 0 ? hit - 0.3 : lim, _n);
        if (t < 0 || (hit >= 0 && t >= hit - 0.3)) continue;
        hit = t;
        idx = -1;
        normal.copy(_n);
      }
      if (hit >= 0 && (!best || hit < best.dist)) best = { harvester: id, index: idx, dist: hit, normal: normal.transformDirection(v.root.matrixWorld) };
    }
    return best;
  }
}
