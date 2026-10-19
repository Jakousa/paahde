// Fixed-wing drones (shared/jets.ts): a big twin-engined unmanned plane (public/models/jet.glb, made by
// tools/blender/machines/plane.py; a primitive stand-in until it has loaded) with the turbofan's own engines on its wings.
// Dark and unlit (no lamps, by day or night). Placed every frame from the flight list and
// the server clock, rolled into its turns. Shot, it trails smoke (more with each hit); brought down it dives in
// rolling over on a heavy trail, ploughs in nose first (onCrash) and smoulders, tail in the air. Jammed
// (shared/jammer.ts) it dives the same, rolling harder, a thin trail corkscrewing off its tail. The rifle tests shots
// against it here (raycast).
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { JET_SPAN, jetAt, jetPose, type Jet, type JetPose } from '../../shared/jets.ts';
import { jetCrashList } from '../../shared/jetcrash.ts';
import { zaps } from './zaps';

/** Hidden past this distance (m) from the camera. */
const SHOW_R = 5000;
/** The wrecks on the sand are drawn within this far (m). */
const WRECK_SHOW_R = 900;

/** A flat trapezoid in the XZ plane (thickness `t`, along -Y..+Y), from x = 0 (root chord `root`, its leading edge
 *  at z = 0) to x = `len` (tip chord `tip`, leading edge swept back `sweep`). */
function panel(len: number, root: number, tip: number, sweep: number, t: number) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(len, -sweep);
  s.lineTo(len, -sweep - tip);
  s.lineTo(0, -root);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false });
  g.translate(0, 0, -t / 2);
  g.rotateX(Math.PI / 2); // shape y → -z: the trailing edge points backwards (-Z), forward is +Z
  return g;
}

/** The stand-in built from primitives, shown until jet.glb has loaded (and if it fails). */
function primitive(): THREE.Group {
  // Double sided: the left wing and fin are the right ones mirrored (negative scale).
  const hull = new THREE.MeshStandardNodeMaterial({ color: 0x3a332d, roughness: 0.55, metalness: 0.5, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardNodeMaterial({ color: 0x15110f, roughness: 0.4, metalness: 0.7, side: THREE.DoubleSide });
  const dome = new THREE.MeshStandardNodeMaterial({ color: 0x0c0b0b, roughness: 0.15, metalness: 0.2 });
  const g = new THREE.Group();

  // Fuselage: a lathe along +Z, nose at +5.6, tail at -5.4, thickest just behind the nose.
  const prof: [number, number][] = [[0, -5.4], [0.32, -5.3], [0.42, -4.6], [0.55, -2], [0.68, 0.8], [0.72, 2.6], [0.62, 4.2], [0.42, 5.1], [0.12, 5.55], [0, 5.6]];
  const body = new THREE.LatheGeometry(prof.map(([r, z]) => new THREE.Vector2(r, z)), 20);
  body.rotateX(Math.PI / 2);
  g.add(new THREE.Mesh(body, hull));
  // A sensor dome under the nose.
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.32, 14, 10), dome);
  ball.position.set(0, -0.6, 3.9);
  g.add(ball);
  // Intake hump over the back, ending in the nozzle at the tail.
  const hump = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.48, 4.6, 16), hull);
  hump.rotation.x = Math.PI / 2;
  hump.scale.set(1, 1, 0.7);
  hump.position.set(0, 0.58, -2.4);
  g.add(hump);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.07, 8, 18), dark);
  lip.position.set(0, 0.58, -0.1);
  lip.scale.set(1, 0.7, 1);
  g.add(lip);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 1.1, 16, 1, true), dark);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.set(0, 0.5, -5.1);
  g.add(nozzle);

  // Wings: straight, long and thin, a little dihedral.
  for (const side of [1, -1]) {
    const w = new THREE.Mesh(panel(8.6, 1.9, 0.75, 0.35, 0.16), hull);
    w.position.set(side * 0.4, 0.15, 0.9);
    w.scale.x = side;
    w.rotation.z = side * 0.04;
    g.add(w);
    // V tail: two fins canted 40° out from vertical.
    const f = new THREE.Mesh(panel(2.4, 1.3, 0.6, 0.6, 0.1), hull);
    f.position.set(0, 0.2, -4.0);
    f.rotation.z = side * (Math.PI / 2 - 0.7);
    f.scale.x = side;
    g.add(f);
  }
  return g;
}

/** The span jet.glb is modelled for (m). */
const MODEL_SPAN = 32;
/** jet.glb's scene (metres, nose +Z, the left engine's exit at its `Tail` empty), once loaded. */
let model: THREE.Object3D | null = null;
/** Planes made while it was still loading: they get the model when it comes in. */
const pending = new Set<THREE.Group>();

/** The prototype: its clones (one per jet in view) note themselves while the model is still loading. */
class JetProto extends THREE.Group {
  clone(recursive?: boolean): this {
    const c = super.clone(recursive);
    if (!model) pending.add(c);
    return c;
  }
}

function fill(g: THREE.Group) {
  g.clear();
  if (model) g.add(model.clone());
  else {
    const p = primitive();
    p.scale.setScalar(JET_SPAN / 18); // (the stand-in is an 18 m plane)
    g.add(p);
  }
}

function build(): THREE.Group {
  const g = new JetProto();
  g.scale.setScalar(JET_SPAN / MODEL_SPAN);
  fill(g);
  pending.add(g);
  new GLTFLoader().loadAsync('./models/jet.glb').then(
    (gltf) => {
      if (!gltf.scene.getObjectByName('Jet_Body')) throw new Error('jet.glb has no Jet_Body');
      model = gltf.scene;
      for (const p of pending) fill(p);
      pending.clear();
    },
    (e) => {
      pending.clear();
      console.warn('jets: model failed, using primitives', e);
    },
  );
  return g;
}

type View = { obj: THREE.Object3D; hurt: number; state: number; smoke: number };

/** Hit boxes in the body frame (half sizes and centre, before JET_SPAN scaling): the fuselage, the wings. */
const BOXES = [
  { h: new THREE.Vector3(1.9, 2.0, 15.4), c: new THREE.Vector3(0, 0, 0) },
  { h: new THREE.Vector3(16.5, 0.9, 3.8), c: new THREE.Vector3(0, 0.4, -0.4) },
];
/** The left engine's exit, where the smoke streams from (body frame; jet.glb's `Tail` empty). */
const TAIL = new THREE.Vector3(-5.6, -2.05, 0.2);
const _inv = new THREE.Matrix4(), _o = new THREE.Vector3(), _d = new THREE.Vector3(), _t = new THREE.Vector3();

export class Jets {
  private views = new Map<number, View>();
  private wreckViews = new Map<number, THREE.Object3D>();
  private pose: JetPose = jetPose();
  private proto: THREE.Group | null = null;
  private scene: THREE.Scene;
  /** A shot hit a jet at (x, y, z) (each one counts: the JET_HP-th brings it down). */
  onHit: (x: number, y: number, z: number) => void = () => {};
  /** A downed jet's nose went into the sand at (x, y, z), diving along (dx, dy, dz). */
  onCrash: (x: number, y: number, z: number, dx: number, dy: number, dz: number) => void = () => {};
  /** The jet our jammer is on and how far its lock has built (0..1), or null (src/jammer.ts). */
  jamming: { id: number; level: number } | null = null;

  /** The jets still flying, where they're drawn (the jammer's targets). */
  *flying(): Generator<{ id: number; x: number; y: number; z: number }> {
    for (const [id, v] of this.views) if (v.state === 0) yield { id, x: v.obj.position.x, y: v.obj.position.y, z: v.obj.position.z };
  }

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Every frame: the flights and the server time (ms); `eye` the camera. */
  update(jets: Jet[], t: number, eye: { x: number; z: number }, dt: number) {
    const seen = new Set<number>();
    for (const j of jets) {
      const p = this.pose;
      if (!jetAt(j, t, p) || Math.hypot(p.x - eye.x, p.z - eye.z) > SHOW_R) continue;
      seen.add(j.id);
      let v = this.views.get(j.id);
      if (!v) {
        this.proto ??= build();
        const obj = this.proto.clone();
        obj.rotation.order = 'YXZ';
        this.scene.add(obj);
        // Came into view already hit or down: don't replay it.
        this.views.set(j.id, (v = { obj, hurt: j.hurt, state: p.state, smoke: 0 }));
      }
      const o = v.obj;
      o.position.set(p.x, p.y, p.z);
      // Nose up is -X here (it faces +Z). Bank is + turning towards +yaw (to the left, facing +Z): the left wing (+X)
      // goes down.
      // Being jammed by us (src/jammer.ts): it twitches, more as the lock builds.
      const jam = this.jamming?.id === j.id && p.state === 0 ? this.jamming.level : 0;
      const tw = performance.now() / 1000;
      o.rotation.set(-p.pitch + jam * 0.05 * Math.sin(tw * 9.1), p.yaw, -p.bank + jam * 0.12 * Math.sin(tw * 6.3 + 1));
      o.updateMatrixWorld();
      if (j.hurt > v.hurt) this.onHit(p.x, p.y, p.z);
      v.hurt = j.hurt;
      const soft = !!j.down?.soft;
      if (p.state === 2 && v.state === 1) {
        _t.set(0, 0, 1).transformDirection(o.matrixWorld);
        this.onCrash(p.x + _t.x * 12, p.y + _t.y * 12, p.z + _t.z * 12, _t.x, _t.y, _t.z);
      }
      v.state = p.state;
      // Smoke: a thin trail once hit, thicker with each hit, a heavy one gliding down; the wreck smoulders. Jammed it
      // has no fire: a thin trail off the rolling tail (so it reads from far off), a lighter smoulder once down.
      const rate = soft ? (p.state === 2 ? 3 : p.state === 1 ? 14 + j.hurt * 10 : j.hurt * 10) : p.state === 2 ? 6 : p.state === 1 ? 40 : j.hurt * 10;
      v.smoke += dt * rate;
      if (v.smoke >= 1) _t.copy(TAIL).applyMatrix4(o.matrixWorld);
      for (; v.smoke >= 1; v.smoke--) {
        if (p.state === 2) zaps.puff(p.x + (Math.random() - 0.5) * 12, p.y + 0.5, p.z + (Math.random() - 0.5) * 12, 3, 2.2);
        else zaps.puff(_t.x, _t.y, _t.z, p.state === 1 ? 4 : 2 + j.hurt, 0.5);
      }
    }
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      this.scene.remove(v.obj);
      this.views.delete(id);
    }
    this.wrecks(eye, dt);
  }

  /** The planes that came down stay where they lay (shared/jetcrash.ts), the right engine gone from the wing (it lies on the sand as
   *  a machine); close by they smoulder. */
  private wrecks(eye: { x: number; z: number }, dt: number) {
    const list = jetCrashList();
    for (const c of list) {
      const near = Math.hypot(c.x - eye.x, c.z - eye.z) < WRECK_SHOW_R;
      let o = this.wreckViews.get(c.id);
      if (near) this.proto ??= build(); // (starts the model loading)
      if (!near || !model) {
        if (o) o.visible = false;
        continue;
      }
      if (!o) {
        o = model.clone();
        const eng = o.getObjectByName('Jet_EngineR');
        if (eng) eng.visible = false;
        o.rotation.order = 'YXZ';
        o.position.set(c.x, c.y, c.z);
        o.rotation.set(-c.pitch, c.yaw, -c.bank);
        o.scale.setScalar(JET_SPAN / MODEL_SPAN);
        this.scene.add(o);
        this.wreckViews.set(c.id, o);
      }
      o.visible = !this.views.has(c.jet);
      if (o.visible && Math.random() < dt * 1.2) zaps.puff(c.x + (Math.random() - 0.5) * 10, c.y + 2, c.z + (Math.random() - 0.5) * 10, 3, 2.2);
    }
    for (const [id, o] of this.wreckViews) {
      if (list.some((c) => c.id === id)) continue;
      this.scene.remove(o);
      this.wreckViews.delete(id);
    }
  }

  /** The first flying (or gliding) jet the shot from `o` along unit `d` strikes within `max` m, and how far. */
  raycast(o: THREE.Vector3, d: THREE.Vector3, max: number): { jet: number; dist: number } | null {
    let best: { jet: number; dist: number } | null = null;
    for (const [id, v] of this.views) {
      if (v.state !== 0) continue;
      // Into the body frame, the direction scaled with it: o + d·t there is _o + _d·t, so t stays in world metres.
      _inv.copy(v.obj.matrixWorld).invert();
      _o.copy(o).applyMatrix4(_inv);
      _d.copy(o).add(d).applyMatrix4(_inv).sub(_o);
      for (const b of BOXES) {
        let lo = 0, hi = max;
        for (const ax of ['x', 'y', 'z'] as const) {
          const a = (b.c[ax] - b.h[ax] - _o[ax]) / _d[ax], c = (b.c[ax] + b.h[ax] - _o[ax]) / _d[ax];
          lo = Math.max(lo, Math.min(a, c));
          hi = Math.min(hi, Math.max(a, c));
        }
        if (lo <= hi && (!best || lo < best.dist)) best = { jet: id, dist: lo };
      }
    }
    return best;
  }
}
