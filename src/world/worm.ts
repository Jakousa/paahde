// The worm (shared/worm.ts) as drawn: the head with its three jaws and the grinder spinning in its throat, the body
// segments laid where the server put them (one instanced mesh per material, so the two-hundred-metre body is a handful of
// draw calls), and the spike of a tail. Weak points ride on the backs of six segments (shared/worm.ts POINT_SEGS).
//
// What sells it: sand sprays up wherever the body passes through the surface; swimming shallow, the sand over its
// head boils along in a wake and the ground trembles; before it bursts out the sand there shivers ('tell'); the burst
// and the plunge throw up fountains of sand ('breach', 'plunge'); the jaws gape while it's out, and while it charges
// half out of the sand ('lunge': a roar, the ground shaking). Dead, whatever was out
// of the sand falls and slams down onto it, segment after segment, and lies there; the wreck sinks before it's cleared.
// Hidden while we're underground (the base, a shelter): it swims under them.
//
// Model: public/models/worm.glb (tools/blender/worm.py); plain shapes stand in until it has loaded.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOSSES, type BossSnap } from '../../shared/bosses.ts';
import { WRECK_SINK } from '../../shared/rifle.ts';
import { indoors } from '../../shared/shelters.ts';
import { heightAt } from '../../shared/terrain.ts';
import { HEAD_R, MODE_AIR, MODE_HUNT, MODE_LUNGE, MODE_RISE, POINT_R, POINT_SEGS, RADIUS, SEG_LEN, SEGS, segScale, TELL } from '../../shared/worm.ts';
import { weakPoint, type BossCtx, type BossFxMsg, type BossView } from './bossParts';
import { tyreDust } from '../tyreDust';
import { rifleSound } from '../rifleSound';
import { wormSound } from '../wormSound';

/** Jaws open this far (rad) while it's out of the sand; open and close at this rate (per s). */
const JAW_OPEN = 1.05, JAW_RATE = 3;
/** Grinder spin (rad/s): idle, hunting. */
const SPIN = [0.6, 4];
/** Dead: segments fall at this gravity (m/s²), each DROP_GAP s after the one before, and rest this deep in the sand
 *  (× radius). */
const DROP_G = 22, DROP_GAP = 0.035, REST = 0.35;
/** Sand thrown up per second where a segment crosses the surface (at full speed), and by the wake over its head. */
const SPRAY_RATE = 10, WAKE_RATE = 14;
/** A 'tell' shivers the sand in a ring this wide (m) until it bursts out (the message says when) and TELL_AFTER s on. */
const TELL_R = 7, TELL_AFTER = 0.3;

type Model = { seg: THREE.Object3D; head: THREE.Object3D; grinder: THREE.Object3D; jaw: THREE.Object3D; tail: THREE.Object3D };
let model: Model | null = null;
let loading: Promise<void> | null = null;

function load(): Promise<void> {
  loading ??= new GLTFLoader().loadAsync('./models/worm.glb').then(
    (gltf) => {
      const get = (n: string) => {
        const o = gltf.scene.getObjectByName(n);
        if (!o) throw new Error(`worm.glb has no ${n}`);
        o.parent?.remove(o);
        o.position.set(0, 0, 0);
        o.quaternion.identity();
        return o;
      };
      model = { seg: get('Worm_Segment'), head: get('Worm_Head'), grinder: get('Worm_Grinder'), jaw: get('Worm_Jaw'), tail: get('Worm_Tail') };
    },
    (e) => console.warn('worm: model failed, using stand-ins', e),
  ) as Promise<void>;
  return loading;
}

/** A part as geometries to instance: the lit materials merged with their colours as vertex colours, the glowing ones
 *  likewise, unlit. */
function flatten(o: THREE.Object3D): { lit: THREE.BufferGeometry | null; glow: THREE.BufferGeometry | null } {
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
  return { lit: lit.length ? mergeGeometries(lit) : null, glow: glow.length ? mergeGeometries(glow) : null };
}

const litMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.5 });
const glowMat = new THREE.MeshBasicNodeMaterial({ vertexColors: true });

/** Stand-ins with the model's origins. */
function standIns(): Model {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x3a302a, roughness: 0.7, metalness: 0.5 });
  const cyl = (r: number, l: number) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, l, 12).rotateX(Math.PI / 2), m);
  const jaw = new THREE.Mesh(new THREE.ConeGeometry(1.6, 4.4, 6).rotateX(Math.PI / 2).translate(0, -2.5, 2.2), m);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(1.6, 7, 10).rotateX(-Math.PI / 2).translate(0, 0, -3.5), m);
  return { seg: cyl(RADIUS, SEG_LEN), head: cyl(HEAD_R, 5), grinder: new THREE.Group(), jaw, tail };
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _f = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _basis = new THREE.Matrix4();

/** The rotation putting +Z along unit f with +Y as near world up as it goes, into `q`. */
function orient(f: THREE.Vector3, q: THREE.Quaternion) {
  _x.crossVectors(_up, f);
  if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0);
  _x.normalize();
  _y.crossVectors(f, _x);
  _basis.makeBasis(_x, _y, f);
  q.setFromRotationMatrix(_basis);
}

export class WormView implements BossView {
  readonly points: THREE.Object3D[] = [];
  readonly snapS = false;
  private scene: THREE.Scene;
  private root = new THREE.Group();
  private built: 'model' | 'stand-in' | null = null;
  private segMeshes: THREE.InstancedMesh[] = [];
  private head = new THREE.Group();
  private grinder: THREE.Object3D | null = null;
  private jaws: THREE.Object3D[] = [];
  private tail: THREE.Object3D | null = null;
  /** Where the body is drawn this frame: head, then each segment (x, y, z), and the last frame's. */
  private pos = new Float32Array((SEGS + 1) * 3);
  private last = new Float32Array((SEGS + 1) * 3);
  private hasLast = false;
  private jaw = 0;
  private spin = 0;
  private spray = new Float32Array(SEGS + 1);
  private wake = 0;
  private tells: { x: number; y: number; z: number; t: number; len: number }[] = [];
  private landed = new Uint8Array(SEGS + 1);
  private bounds = new THREE.Box3();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    for (let i = 0; i < POINT_SEGS.length; i++) {
      const p = weakPoint(POINT_R);
      this.root.add(p);
      this.points.push(p);
    }
    scene.add(this.root);
    this.build(standIns(), 'stand-in');
    void load().then(() => model && this.build(model, 'model'));
  }

  private build(m: Model, what: 'model' | 'stand-in') {
    if (this.built === 'model') return;
    for (const im of this.segMeshes) this.root.remove(im);
    this.root.remove(this.head);
    if (this.tail) this.root.remove(this.tail);
    const flat = flatten(m.seg);
    this.segMeshes = [];
    for (const [g, mat] of [[flat.lit, litMat], [flat.glow, glowMat]] as const) {
      if (!g) continue;
      const im = new THREE.InstancedMesh(g, mat, SEGS);
      im.castShadow = mat === litMat;
      im.frustumCulled = false; // its bounds are the one segment's; the instances are spread over 100 m
      this.segMeshes.push(im);
      this.root.add(im);
    }
    this.head = new THREE.Group();
    this.head.add(m.head.clone());
    this.grinder = m.grinder.clone();
    this.head.add(this.grinder);
    this.jaws = [0, 1, 2].map((k) => {
      // Turned about the axis to its place on the rim, then hinged about its own X.
      const holder = new THREE.Group();
      holder.rotation.z = (k * 2 * Math.PI) / 3;
      const hinge = new THREE.Group();
      hinge.position.set(0, 4.3, 2.0);
      hinge.add(m.jaw.clone());
      holder.add(hinge);
      this.head.add(holder);
      return hinge;
    });
    this.tail = m.tail.clone();
    for (const o of [this.head, this.tail]) o.traverse((c) => (c.castShadow = true));
    this.root.add(this.head, this.tail);
    this.built = what;
  }

  update(s: BossSnap, ctx: BossCtx) {
    // Under a roof (the base, a shelter) it's out of sight: it would show through the sand from below.
    const e = ctx.ear;
    this.root.visible = !indoors(e.x, e.y, e.z);
    const mode = s.s[0] ?? 0;
    const dead = s.dead;
    const p = this.pos;
    p[0] = s.x;
    p[1] = s.y;
    p[2] = s.z;
    for (let i = 0; i < SEGS; i++) {
      p[3 + i * 3] = s.x + (s.s[1 + i * 3] ?? 0);
      p[4 + i * 3] = s.y + (s.s[2 + i * 3] ?? 0);
      p[5 + i * 3] = s.z + (s.s[3 + i * 3] ?? -(i + 1) * SEG_LEN);
    }
    if (dead > 0) this.fall(dead, ctx);

    // Head: facing away from the first segment; jaws open while it's out; the grinder spins.
    _f.set(p[0] - p[3], p[1] - p[4], p[2] - p[5]).normalize();
    orient(_f, _q);
    this.head.position.set(p[0], p[1], p[2]);
    this.head.quaternion.copy(_q);
    const out = mode === MODE_RISE || mode === MODE_AIR || mode === MODE_LUNGE;
    this.jaw += Math.max(-JAW_RATE * ctx.dt, Math.min(JAW_RATE * ctx.dt, (dead > 0 ? 0.4 : out ? 1 : 0) - this.jaw));
    for (const j of this.jaws) j.rotation.x = -JAW_OPEN * this.jaw;
    if (dead <= 0) this.spin += ctx.dt * (mode >= MODE_HUNT ? SPIN[1] : SPIN[0]);
    if (this.grinder) this.grinder.rotation.z = this.spin;

    // Segments: each facing the one before it, thinning towards the tail; out of the sand only.
    this.bounds.makeEmpty();
    for (let i = 0; i < SEGS; i++) {
      const a = i * 3, b = (i + 1) * 3, c = Math.min(SEGS, i + 2) * 3;
      _f.set(p[a] - p[c], p[a + 1] - p[c + 1], p[a + 2] - p[c + 2]);
      if (_f.lengthSq() < 1e-6) _f.set(0, 0, 1);
      orient(_f.normalize(), _q);
      const sc = segScale(i), r = RADIUS * sc;
      _p.set(p[b], p[b + 1], p[b + 2]);
      const buried = _p.y + r * 1.4 < heightAt(_p.x, _p.z);
      _s.set(buried ? 0 : sc, buried ? 0 : sc, buried ? 0 : 1);
      _m.compose(_p, _q, _s);
      for (const im of this.segMeshes) im.setMatrixAt(i, _m);
      if (!buried) this.bounds.expandByPoint(_p);
      if (i === SEGS - 1 && this.tail) {
        this.tail.position.copy(_p).addScaledVector(_f, -SEG_LEN * 0.45 * sc);
        this.tail.quaternion.copy(_q);
        this.tail.scale.setScalar(sc);
      }
      // A weak point on its back.
      const k = POINT_SEGS.indexOf(i);
      if (k >= 0) {
        const wp = this.points[k];
        _y.set(0, 4.35 * sc, 0).applyQuaternion(_q);
        wp.position.copy(_p).add(_y);
        // The lens faces out of its back: its +Z along the segment's up.
        wp.quaternion.copy(_q).multiply(new THREE.Quaternion().setFromAxisAngle(_x.set(1, 0, 0), -Math.PI / 2));
        wp.scale.setScalar(POINT_R * sc);
      }
    }
    for (const im of this.segMeshes) {
      im.instanceMatrix.needsUpdate = true;
    }
    this.bounds.expandByPoint(this.head.position).expandByScalar(RADIUS + 1);

    this.sand(s, mode, dead, ctx);
    this.last.set(p);
    this.hasLast = true;
  }

  /** Dead: what was out of the sand falls onto it, one segment after another from the head, and lies there; the
   *  wreck sinks at the end. */
  private fall(dead: number, ctx: BossCtx) {
    const p = this.pos, sink = Math.max(0, dead - (BOSSES.worm.wreckS - WRECK_SINK)) / WRECK_SINK;
    for (let i = 0; i <= SEGS; i++) {
      const a = i * 3, r = i === 0 ? HEAD_R : RADIUS * segScale(i - 1);
      const g = heightAt(p[a], p[a + 2]), rest = g + r * (1 - REST) - sink * r * 2.2;
      if (p[a + 1] + r < g) continue; // buried: stays
      const t = Math.max(0, dead - i * DROP_GAP);
      const y = Math.max(rest, p[a + 1] - 0.5 * DROP_G * t * t);
      if (y <= rest && !this.landed[i]) {
        this.landed[i] = 1;
        if (p[a + 1] - rest > 2 && i % 4 === 0) {
          rifleSound.slam({ x: p[a], y: rest, z: p[a + 2] }, ctx.ear, true);
          ctx.thump(p[a], rest - r, p[a + 2], 1.4, 10, 5, 2.5);
        }
      }
      p[a + 1] = Math.min(p[a + 1], y);
    }
  }

  /** Sand where it passes through the surface, the wake and tremble over its head, the sound. */
  private sand(s: BossSnap, mode: number, dead: number, ctx: BossCtx) {
    const p = this.pos, l = this.last, dt = ctx.dt, e = ctx.ear;
    const g0 = heightAt(p[0], p[2]), depth = g0 - p[1];
    let speed = 0;
    if (this.hasLast && dt > 0) speed = Math.hypot(p[0] - l[0], p[1] - l[1], p[2] - l[2]) / dt;
    const near = Math.hypot(p[0] - e.x, p[2] - e.z);
    if (dead <= 0 && near < 900) {
      for (let i = 0; i <= SEGS; i++) {
        const a = i * 3, r = i === 0 ? HEAD_R : RADIUS * segScale(i - 1), g = heightAt(p[a], p[a + 2]), d = p[a + 1] - g;
        if (Math.abs(d) > r || !this.hasLast) continue;
        const v = Math.hypot(p[a] - l[a], p[a + 1] - l[a + 1], p[a + 2] - l[a + 2]) / Math.max(dt, 1e-3);
        this.spray[i] += dt * SPRAY_RATE * Math.min(1, v / 10) * (r / RADIUS);
        while (this.spray[i] >= 1) {
          this.spray[i] -= 1;
          const ang = Math.random() * Math.PI * 2, rr = r * (0.6 + Math.random() * 0.5);
          tyreDust.emit(p[a] + Math.cos(ang) * rr, g + 0.3, p[a + 2] + Math.sin(ang) * rr, Math.cos(ang) * 3, 2 + Math.random() * 5, Math.sin(ang) * 3, 2.2 + r * 0.4);
        }
      }
      // The wake: swimming shallow, the sand over its head boils; close by, the ground trembles.
      if (depth > 0 && depth < 14 && speed > 3) {
        this.wake += dt * WAKE_RATE * (1 - depth / 14);
        while (this.wake >= 1) {
          this.wake -= 1;
          const ang = Math.random() * Math.PI * 2, rr = Math.random() * 4;
          tyreDust.emit(p[0] + Math.cos(ang) * rr, g0 + 0.2, p[2] + Math.sin(ang) * rr, Math.cos(ang) * 1.5, 0.8 + Math.random() * 2, Math.sin(ang) * 1.5, 1.8);
        }
      }
      if (depth > -HEAD_R && near < 60) ctx.shake(0.06 * (1 - near / 60) * Math.min(1, speed / 12));
    }
    // The tell: the sand shivering in a ring where it's about to burst out.
    this.tells = this.tells.filter((t) => (t.t += dt) < t.len);
    for (const t of this.tells) {
      for (let k = 0; k < 3; k++) {
        const ang = Math.random() * Math.PI * 2, rr = Math.random() * TELL_R;
        tyreDust.emit(t.x + Math.cos(ang) * rr, t.y + 0.1, t.z + Math.sin(ang) * rr, 0, 0.5 + Math.random() * (1 + 3 * t.t), 0, 0.8 + t.t);
      }
      if (Math.hypot(t.x - e.x, t.z - e.z) < 40) ctx.shake(0.05 + 0.12 * Math.min(1, t.t / t.len));
    }
    // The rumble from the sand over its head: louder shallow, fast and out.
    const level = dead > 0 ? 0 : Math.max(0, Math.min(1, (1 - Math.max(0, depth) / 25) * Math.min(1, speed / 14) + (mode >= MODE_HUNT ? 0.15 : 0)));
    wormSound.update(dead > 0 ? [] : [{ id: s.id, x: p[0], y: Math.max(p[1], g0), z: p[2], level }], e);
  }

  fx(m: BossFxMsg, ctx: BossCtx) {
    if (m.e === 'tell') {
      const len = (m.a?.[0] ?? TELL) + TELL_AFTER;
      this.tells.push({ x: m.x, y: m.y, z: m.z, t: 0, len });
      wormSound.tell(m, ctx.ear, len);
    } else if (m.e === 'lunge') {
      wormSound.tell(m, ctx.ear, 0.7);
      if (Math.hypot(m.x - ctx.ear.x, m.z - ctx.ear.z) < 60) ctx.shake(0.25);
    } else if (m.e === 'breach' || m.e === 'plunge') {
      const up = m.e === 'breach';
      // A fountain of sand thrown along its way, and a ring of it out across the sand.
      const [vx = 0, vy = 0, vz = 0] = m.a ?? [];
      for (let i = 0; i < (up ? 60 : 36); i++) {
        const ang = Math.random() * Math.PI * 2, rr = Math.random() * HEAD_R * 1.3, k = 0.2 + Math.random() * 0.4;
        tyreDust.emit(m.x + Math.cos(ang) * rr, m.y + 0.5, m.z + Math.sin(ang) * rr,
          vx * k + Math.cos(ang) * 5, Math.abs(vy) * k * (up ? 1 : 0.5) + 3 + Math.random() * 6, vz * k + Math.sin(ang) * 5, 3 + Math.random() * 3);
      }
      ctx.thump(m.x, m.y, m.z, up ? 3.2 : 2.4, up ? 40 : 28, up ? 10 : 7, 4);
      (up ? wormSound.breach : wormSound.plunge).call(wormSound, m, ctx.ear);
    }
  }

  hull(o: THREE.Vector3, d: THREE.Vector3, max: number): number | null {
    // Only the head and the segments out of the sand; spheres are near enough for sparks.
    const ray = new THREE.Ray(o, d);
    if (!ray.intersectsBox(this.bounds)) return null;
    let best: number | null = null;
    const p = this.pos, sph = new THREE.Sphere(), hit = new THREE.Vector3();
    for (let i = 0; i <= SEGS; i++) {
      const a = i * 3, r = i === 0 ? HEAD_R : RADIUS * segScale(i - 1);
      sph.center.set(p[a], p[a + 1], p[a + 2]);
      if (sph.center.y + r < heightAt(sph.center.x, sph.center.z)) continue;
      sph.radius = r;
      if (!ray.intersectSphere(sph, hit)) continue;
      const dist = hit.distanceTo(o);
      if (dist <= max && (best === null || dist < best)) best = dist;
    }
    return best;
  }

  dispose() {
    this.scene.remove(this.root);
    wormSound.update([], this.scene.position);
  }
}
