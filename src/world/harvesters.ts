// The harvesters (shared/harvester.ts): public/models/harvester.glb (made by tools/blender/harvester.py; a block
// stand-in until it has loaded), placed every frame from the route, the pace and the server clock. Its treads run round
// their loops (an instanced track shoe), the cutter drum in its maw turns and throws up sand (a storm of it when it
// charges), the exhausts on its back smoke and the slot in its stern spills sifted sand. The three intake cores in
// its throat glow, flicker as they're hit and go dark once shot out, pouring smoke; with the last it seizes, burning
// (onDeath), a huge plume of smoke towering off its back for as long as the wreck lies there. The rifle tests shots against it (raycast).
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  CORE_HALF, CORE_HP, CORES, HALF_W, harvesterAt, harvesterPose, HULL_TOP, SHOW_R, SPEED, STERN, TRACK, TRACK_W,
  WHEELBASE, type Harvester, type HarvesterPose,
} from '../../shared/harvester.ts';
import { tyreDust } from '../tyreDust';
import { zaps } from './zaps';

/** The track loops (keep in step with tools/blender/harvester.py): end wheels LOOP_HALF either side of the unit's
 *  centre, LOOP_R round, axles at LOOP_Y; LINKS shoes a loop. */
const LOOP_HALF = 4.6;
const LOOP_R = 2.4;
const LOOP_Y = 2.6;
const LINKS = 40;
const LOOP = 4 * LOOP_HALF + 2 * Math.PI * LOOP_R;
const UNITS: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
/** The drum (local axle) and its radius; the exhausts on its back and the stern slot (tools/blender/harvester.py). */
const DRUM = new THREE.Vector3(0, 2.6, 24.6);
const DRUM_R = 2.4;
const EXHAUSTS: [number, number, number][] = [[-6.5, 19.1, -19.5], [-3.5, 19.1, -19.5], [3.5, 19.1, -19.5], [6.5, 19.1, -19.5]];
const CHUTE = new THREE.Vector3(0, 6.2, -25.6);
/** Effects (dust, smoke) only within this far (m) of the camera; a wreck's plume within PLUME_R. */
const FX_R = 800;
const PLUME_R = 3000;
/** A burning wreck's plume off its back: puffs a second, their size (m), rise (m/s) and life (s): a column ~100 m
 *  tall, spreading as it climbs and leaning with the wind (src/world/zaps.ts smoke). */
const PLUME_RATE = 6;
const PLUME_SIZE = 9;
const PLUME_RISE = 16;
const PLUME_LIFE = 24;
const PLUME_AT = new THREE.Vector3(0, 19.5, -6);
const CORE_GLOW = 16;

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

type Parts = { hull: THREE.Object3D; drum: THREE.Object3D; cores: THREE.Object3D[]; lamps: THREE.Object3D; link: THREE.Mesh };

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
        hull: get('Harvester_Hull'), drum: get('Harvester_Drum'), cores: CORES.map((_, i) => get(`Harvester_Core${i}`)),
        lamps: get('Harvester_Lamps'), link: get('Harvester_Link') as THREE.Mesh,
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
  hull.add(box(24.4, HULL_TOP - 5.6, 46.7, 0, (HULL_TOP + 5.6) / 2, -2.05), box(24.4, 8.1, 8.8, 0, 4.6, 23.4));
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(DRUM_R, DRUM_R, 19, 10).rotateZ(Math.PI / 2), iron);
  drum.position.copy(DRUM);
  const cores = CORES.map((c) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(CORE_HALF, CORE_HALF, 0.3, 6).rotateX(Math.PI / 2),
      new THREE.MeshStandardNodeMaterial({ color: 0, emissive: 0xffc070, emissiveIntensity: CORE_GLOW }));
    m.position.set(c.x, c.y, c.z);
    return m;
  });
  const link = new THREE.Mesh(new THREE.BoxGeometry(TRACK_W, 0.3, 0.76), iron);
  return { hull, drum, cores, lamps: new THREE.Group(), link };
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(1, 1, 1);
const _v = new THREE.Vector3(), _lp = { y: 0, z: 0, a: 0 };

class View {
  readonly root = new THREE.Group();
  /** Core hits and state last frame (to spot changes); speed now (m/s). */
  cores: number[];
  state = -1;
  v = 0;
  /** Effect accumulators. */
  dust = 0;
  smoke = 0;
  plume = 0;
  private parts: Parts | null = null;
  private links: THREE.InstancedMesh | null = null;
  private coreMats: THREE.MeshStandardMaterial[] = [];

  constructor(h: Harvester) {
    this.cores = [...h.cores];
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
    this.build({ hull: p.hull.clone(), drum: p.drum.clone(), cores: p.cores.map((c) => c.clone()), lamps: p.lamps.clone(), link: p.link });
  }

  private build(p: Parts) {
    this.root.clear();
    this.links?.dispose();
    // Its own core materials: they go dark one by one.
    this.coreMats = p.cores.map((o) => {
      let mat: THREE.MeshStandardMaterial | null = null;
      o.traverse((c) => {
        const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!m || Array.isArray(m) || !m.emissive) return;
        mat ??= m.clone();
        (c as THREE.Mesh).material = mat;
      });
      return mat ?? new THREE.MeshStandardMaterial();
    });
    this.links = new THREE.InstancedMesh(p.link.geometry, p.link.material, LINKS * UNITS.length);
    this.links.frustumCulled = false;
    this.root.add(p.hull, p.drum, ...p.cores, p.lamps, this.links);
    this.parts = p;
  }

  /** Lays the shoes round the loops, `s` m come (the bottom runs stay put on the sand). */
  private treads(s: number) {
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

  pose(h: Harvester, p: HarvesterPose, t: number) {
    const o = this.root;
    o.position.set(p.x, p.y, p.z);
    o.rotation.set(-p.pitch, p.yaw, p.roll);
    o.updateMatrixWorld();
    this.v = p.v;
    if (!this.parts) return;
    this.treads(p.s);
    // The drum turns faster than it rolls, and faster still at a charge.
    this.parts.drum.rotation.x = (p.s / DRUM_R) * 1.6;
    this.coreMats.forEach((m, i) => {
      const hurt = h.cores[i];
      // Hit: it sputters, worse with each hit; out (or a wreck), dark.
      const flicker = hurt > 0 ? 0.55 + 0.45 * Math.sin(t * (0.02 + hurt * 0.011) + i * 2) : 1;
      m.emissiveIntensity = hurt >= CORE_HP || p.state ? 0 : CORE_GLOW * flicker;
    });
  }

  dispose() {
    this.links?.dispose();
    for (const m of this.coreMats) m.dispose();
  }
}

/** Hit boxes in the local frame (half sizes, centre): the hull, the hood over the maw, its cheeks, the drum, the
 *  throat behind it. */
const BOXES: { h: THREE.Vector3; c: THREE.Vector3 }[] = [
  { h: new THREE.Vector3(HALF_W, (HULL_TOP - 1.6) / 2, (21.3 - STERN) / 2), c: new THREE.Vector3(0, (HULL_TOP + 1.6) / 2, (21.3 + STERN) / 2) },
  { h: new THREE.Vector3(12.2, 2.0, 3.2), c: new THREE.Vector3(0, 13.2, 24.4) },
  { h: new THREE.Vector3(1.0, 5.45, 4.4), c: new THREE.Vector3(11.2, 6.05, 23.4) },
  { h: new THREE.Vector3(1.0, 5.45, 4.4), c: new THREE.Vector3(-11.2, 6.05, 23.4) },
  { h: new THREE.Vector3(9.8, DRUM_R, DRUM_R), c: DRUM.clone() },
  { h: new THREE.Vector3(10.2, 5.4, 0.4), c: new THREE.Vector3(0, 6.0, 21.3) },
];
/** The cores' boxes (a little generous, the housing round each lens counts), standing proud of the throat so they're
 *  hit before it. */
const CORE_BOXES = CORES.map((c) => ({ h: new THREE.Vector3(CORE_HALF + 0.3, CORE_HALF + 0.3, 0.6), c: new THREE.Vector3(c.x, c.y, c.z - 0.3) }));

const _inv = new THREE.Matrix4(), _o = new THREE.Vector3(), _d = new THREE.Vector3(), _n = new THREE.Vector3();

/** Where local ray o + d·t enters box b (t within [0, max]), or -1; the face's normal into `n`. */
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
  /** A shot hit a live core at (x, y, z). */
  onHit: (x: number, y: number, z: number) => void = () => {};
  /** A core was shot out at (x, y, z), its maw facing (dx, dz). */
  onCoreOut: (x: number, y: number, z: number, dx: number, dz: number) => void = () => {};
  /** It seized and caught fire at (x, y, z). */
  onDeath: (x: number, y: number, z: number) => void = () => {};

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Every frame: the harvesters out, the server time (ms), the camera. */
  update(list: Harvester[], t: number, eye: { x: number; z: number }, dt: number) {
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
      v.pose(h, p, t);
      // What changed since last frame: hits, cores out, its death (not replayed when it comes into view so).
      for (let i = 0; i < CORES.length; i++) {
        if (h.cores[i] <= v.cores[i]) continue;
        const c = CORES[i];
        _v.set(c.x, c.y, c.z + 0.4).applyMatrix4(v.root.matrixWorld);
        if (h.cores[i] >= CORE_HP) this.onCoreOut(_v.x, _v.y, _v.z, Math.sin(p.yaw), Math.cos(p.yaw));
        else this.onHit(_v.x, _v.y, _v.z);
      }
      v.cores = [...h.cores];
      if (p.state === 1 && v.state === 0) this.onDeath(p.x, p.y + 10, p.z);
      v.state = p.state;
      const far = Math.hypot(p.x - eye.x, p.z - eye.z);
      if (far < FX_R) this.effects(h, v, p, dt);
      if (p.state === 1 && far < PLUME_R) this.plume(v, dt);
    }
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      this.scene.remove(v.root);
      v.dispose();
      this.views.delete(id);
    }
  }

  /** Dust off the drum (thrown hard at a charge), sand pouring from the stern, smoke from the exhausts and the dead
   *  cores; a wreck burns. */
  private effects(h: Harvester, v: View, p: HarvesterPose, dt: number) {
    // Faster, more dust and smoke (but not without end: it charges at ten times its crawl).
    const m = v.root.matrixWorld, fast = Math.min(4, Math.max(1, p.v / SPEED));
    v.dust += dt * (p.state ? 0 : 16 * fast);
    for (; v.dust >= 1; v.dust--) {
      _v.set((Math.random() - 0.5) * 18, DRUM.y - 1.2, DRUM.z + 1.4).applyMatrix4(m);
      const up = 1.5 + Math.random() * 2.5 * fast;
      tyreDust.emit(_v.x, _v.y, _v.z, (Math.random() - 0.5) * 2 * fast, up, (Math.random() - 0.5) * 2 * fast, 2 + Math.random() * 1.6 * fast);
      _v.copy(CHUTE).applyMatrix4(m);
      tyreDust.emit(_v.x + (Math.random() - 0.5) * 7, _v.y, _v.z + (Math.random() - 0.5), 0, -1.5 - Math.random(), 0, 0.9 + Math.random() * 0.8, 1.6);
    }
    v.smoke += dt * (p.state ? 10 : 2.5 * fast + h.cores.filter((n) => n >= CORE_HP).length * 2);
    for (; v.smoke >= 1; v.smoke--) {
      const s = EXHAUSTS[Math.floor(Math.random() * EXHAUSTS.length)];
      _v.set(s[0], s[1], s[2]).applyMatrix4(m);
      zaps.puff(_v.x, _v.y, _v.z, p.state ? 4 : 1.6 * Math.min(2, fast), p.state ? 3 : 2.5);
      // Shot-out cores (all of them on a wreck) pour smoke out of the maw.
      const dead = CORES.filter((_, i) => p.state || h.cores[i] >= CORE_HP);
      if (dead.length) {
        const c = dead[Math.floor(Math.random() * dead.length)];
        _v.set(c.x, c.y, c.z + 1).applyMatrix4(m);
        zaps.puff(_v.x, _v.y, _v.z, p.state ? 3 : 1.8, 2);
      }
    }
  }

  /** The wreck's plume: big, long-lived puffs off the middle of its back, seen from far off. */
  private plume(v: View, dt: number) {
    v.plume += dt * PLUME_RATE;
    for (; v.plume >= 1; v.plume--) {
      _v.set(PLUME_AT.x + (Math.random() - 0.5) * 10, PLUME_AT.y, PLUME_AT.z + (Math.random() - 0.5) * 18).applyMatrix4(v.root.matrixWorld);
      zaps.plume(_v.x, _v.y, _v.z, PLUME_SIZE * (0.7 + Math.random() * 0.6), PLUME_RISE, PLUME_LIFE);
    }
  }

  /** Bodies, for sound and the shake: where each one is, crawling or not, its speed (m/s) and cores left. */
  *bodies(): Generator<{ id: number; x: number; y: number; z: number; alive: boolean; v: number; cores: number }> {
    for (const [id, v] of this.views) {
      const p = v.root.position;
      yield { id, x: p.x, y: p.y + 8, z: p.z, alive: v.state === 0, v: v.v, cores: v.cores.filter((n) => n < CORE_HP).length };
    }
  }

  /** The first harvester the shot from `o` along unit `d` strikes within `max` m: which, the core (-1 its armour), how
   *  far, and the surface's normal (world). Wrecks still stop shots. */
  raycast(o: THREE.Vector3, d: THREE.Vector3, max: number): { harvester: number; index: number; dist: number; normal: THREE.Vector3 } | null {
    let best: { harvester: number; index: number; dist: number; normal: THREE.Vector3 } | null = null;
    for (const [id, v] of this.views) {
      _inv.copy(v.root.matrixWorld).invert();
      _o.copy(o).applyMatrix4(_inv);
      _d.copy(o).add(d).applyMatrix4(_inv).sub(_o);
      const lim = best ? best.dist : max;
      let hit = -1, idx = -1;
      const normal = new THREE.Vector3();
      CORE_BOXES.forEach((b, i) => {
        const t = enter(b, _o, _d, lim, _n);
        if (t < 0 || (hit >= 0 && t >= hit) || v.cores[i] >= CORE_HP || v.state !== 0) return;
        hit = t;
        idx = i;
        normal.copy(_n);
      });
      // Its armour (and the drum in front of the cores), unless the shot reached a core first.
      for (const b of BOXES) {
        const t = enter(b, _o, _d, hit >= 0 ? hit - 0.2 : lim, _n);
        if (t < 0 || (hit >= 0 && t >= hit - 0.2)) continue;
        hit = t;
        idx = -1;
        normal.copy(_n);
      }
      if (hit >= 0 && (!best || hit < best.dist)) best = { harvester: id, index: idx, dist: hit, normal: normal.transformDirection(v.root.matrixWorld) };
    }
    return best;
  }
}
