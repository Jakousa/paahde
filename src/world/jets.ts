// Fixed-wing drones (shared/jets.ts): a big twin-engined unmanned plane (public/models/jet.glb, made by
// tools/blender/machines/plane.py; a primitive stand-in until it has loaded) with the turbofan's own engines on its wings.
// Dark and unlit (no lamps, by day or night). Placed every frame from the flight list and
// the server clock, rolled into its turns. Shot, it trails smoke (more with each hit); brought down it dives in
// rolling over on a heavy trail, ploughs in nose first (onCrash) and smoulders, tail in the air. Jammed
// (shared/jammer.ts) it dives the same, rolling harder, a thin trail corkscrewing off its tail. The rifle tests shots
// against it here (raycast).
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { JET_SPAN, jetAt, jetImpact, jetPose, type Jet, type JetPose } from '../../shared/jets.ts';
import { jetCrashList } from '../../shared/jetcrash.ts';
import { breakup, BREAK_DT, ENGINES, STATE_W, type Breakup, type Fate } from '../../shared/jetbreak.ts';
import { JET_PIECES } from '../../shared/jetpieces.ts';
import { heightAt } from '../../shared/terrain.ts';
import { tyreDust } from '../tyreDust';
import { mergePart } from './bossParts';
import { zaps } from './zaps';

/** Hidden past this distance (m) from the camera. */
const SHOW_R = 5000;
/** The wrecks on the sand are drawn within this far (m). */
const WRECK_SHOW_R = 600;

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

/** The plane whole (flying); the pieces it breaks into (jet.glb's `P_<id>` nodes, shared/jetpieces.ts) are never part of it: they are drawn on their own
 *  (`Debris`) once it has come apart. */
function setBroken(o: THREE.Object3D, broken: boolean) {
  for (const [name, on] of [['Jet_Body', !broken], ['Jet_EngineR', !broken]] as const) {
    const n = o.getObjectByName(name);
    if (n) n.visible = on;
  }
  for (const d of JET_PIECES) {
    const n = o.getObjectByName(`P_${d.id}`);
    if (n) n.visible = false;
  }
}

const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion();

/** The pieces of a broken plane, one group each placed at its pivot: flying apart from the impact (shared/jetbreak.ts) or lying where they came to rest. */
class Debris {
  readonly holders: THREE.Group[] = [];
  /** An engine's husk (wrecked in the landing), shown instead of the engine from then on; by piece index. */
  private husks = new Map<number, THREE.Object3D>();
  private whole = new Map<number, THREE.Object3D>();
  bk: Breakup | null = null;
  /** The next event (a splash of sand) to play. */
  ev = 0;

  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    for (const d of JET_PIECES) {
      const holder = new THREE.Group();
      const n = model!.getObjectByName(`P_${d.id}`)?.clone();
      if (n) {
        n.position.set(0, 0, 0);
        n.visible = true;
        this.prep(n, d.id);
        holder.add(n);
        const x = model!.getObjectByName(`P_${d.id}_x`)?.clone();
        if (x) {
          x.position.set(0, 0, 0);
          x.visible = false;
          this.prep(x, d.id);
          holder.add(x);
          this.husks.set(this.holders.length, x);
          this.whole.set(this.holders.length, n);
        }
      }
      holder.scale.setScalar(JET_SPAN / MODEL_SPAN);
      holder.matrixAutoUpdate = false; // (placed by hand: see place())
      scene.add(holder);
      this.holders.push(holder);
    }
  }

  /** A piece's mesh: it casts a shadow unless it is a small one, and never walks its own matrix. */
  private prep(n: THREE.Object3D, id: string) {
    const small = id.startsWith('panel') || id.startsWith('beam');
    n.traverse((o) => {
      o.castShadow = o.castShadow && !small;
      o.receiveShadow = true;
      o.matrixAutoUpdate = false;
      o.updateMatrix();
    });
  }

  private place(h: THREE.Group) {
    h.updateMatrix();
    h.updateMatrixWorld(true);
  }

  /** Show an engine as it was, or as the husk it was wrecked into. */
  private wreck(i: number, on: boolean) {
    const x = this.husks.get(i), n = this.whole.get(i);
    if (x) x.visible = on;
    if (n) n.visible = !on;
  }

  /** Where each piece lies (x, y, z, qx, qy, qz, qw), and what became of the engines (the wrecked ones are husks; the ones that lie whole are machines, not drawn). */
  rest(pieces: number[][], fates: Fate[]) {
    this.holders.forEach((h, i) => {
      const w = pieces[i];
      const ei = ENGINES.indexOf(JET_PIECES[i].id);
      if (ei >= 0) {
        this.wreck(i, fates[ei] === 'wreck');
        h.userData.machine = fates[ei] === 'machine';
      }
      if (!w) return;
      h.position.set(w[0], w[1], w[2]);
      h.quaternion.set(w[3], w[4], w[5], w[6]);
      this.place(h);
    });
  }

  /** The pieces `t` s after the impact; `dust` is called where one scrapes along the sand fast. */
  fly(t: number, dust: (x: number, y: number, z: number, speed: number) => void) {
    const bk = this.bk!;
    const k = Math.min(bk.steps - 1, Math.max(0, t / BREAK_DT)), i0 = Math.floor(k), i1 = Math.min(bk.steps - 1, i0 + 1), f = k - i0;
    this.holders.forEach((h, i) => {
      const ei = ENGINES.indexOf(JET_PIECES[i].id);
      if (ei >= 0) this.wreck(i, bk.fates[ei] === 'wreck' && t >= bk.wrecked[ei]);
      const st = bk.states[i], a = i0 * STATE_W, b = i1 * STATE_W;
      h.position.set(st[a] + (st[b] - st[a]) * f, st[a + 1] + (st[b + 1] - st[a + 1]) * f, st[a + 2] + (st[b + 2] - st[a + 2]) * f);
      _q0.set(st[a + 3], st[a + 4], st[a + 5], st[a + 6]);
      _q1.set(st[b + 3], st[b + 4], st[b + 5], st[b + 6]);
      h.quaternion.copy(_q0).slerp(_q1, f);
      this.place(h);
      if (st[a + 7] >= 3) dust(h.position.x, h.position.y, h.position.z, 1);
    });
  }

  dispose() {
    for (const h of this.holders) this.scene.remove(h);
    this.holders.length = 0;
  }
}

function fill(g: THREE.Group) {
  g.clear();
  if (model) {
    const c = model.clone();
    setBroken(c, false);
    g.add(c);
  } else {
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
      // every node as one lit mesh (a glTF node comes in one mesh per material, and each is drawn again into each shadow cascade)
      const merged = new THREE.Group();
      for (const node of [...gltf.scene.children]) {
        if (!node.name.startsWith('Jet_') && !node.name.startsWith('P_')) continue;
        const m = mergePart(node);
        m.name = node.name;
        m.position.copy(node.position);
        merged.add(m);
      }
      model = merged;
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

type View = { obj: THREE.Object3D; hurt: number; state: number; smoke: number; deb: Debris | null };

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
  private wreckViews = new Map<number, Debris>();
  private pose: JetPose = jetPose();
  private proto: THREE.Group | null = null;
  private scene: THREE.Scene;
  /** A shot hit a jet at (x, y, z) (each one counts: the JET_HP-th brings it down). */
  onHit: (x: number, y: number, z: number) => void = () => {};
  /** A downed jet's nose went into the sand at (x, y, z), diving along (dx, dy, dz). */
  onCrash: (x: number, y: number, z: number, dx: number, dy: number, dz: number) => void = () => {};
  /** A piece of the broken plane hit the sand hard at (x, y, z), `size` m across (sand thrown up and a thud, src/guardians.ts). */
  onSplash: (x: number, y: number, z: number, size: number) => void = () => {};
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
        this.views.set(j.id, (v = { obj, hurt: j.hurt, state: p.state, smoke: 0, deb: null }));
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
      if (p.state === 2) {
        // It broke up on the sand: the plane is gone and its pieces fly on, tumble and settle.
        o.visible = false;
        this.pieces(j, v, t, dt);
        continue;
      }
      // Smoke: a thin trail once hit, thicker with each hit, a heavy one gliding down; the wreck smoulders. Jammed it
      // has no fire: a thin trail off the rolling tail (so it reads from far off), a lighter smoulder once down.
      const rate = soft ? (p.state === 2 ? 3 : p.state === 1 ? 14 + j.hurt * 10 : j.hurt * 10) : p.state === 2 ? 6 : p.state === 1 ? 40 : j.hurt * 10;
      v.smoke += dt * rate;
      if (v.smoke >= 1) _t.copy(TAIL).applyMatrix4(o.matrixWorld);
      for (; v.smoke >= 1; v.smoke--) zaps.puff(_t.x, _t.y, _t.z, p.state === 1 ? 4 : 2 + j.hurt, 0.5);
    }
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      this.scene.remove(v.obj);
      v.deb?.dispose();
      this.views.delete(id);
    }
    this.wrecks(eye, dt);
  }

  /** The broken plane `t` ms into the flight list's clock: the pieces from the simulation started at the impact, smoke off the wreck, sand thrown up where they land. */
  private pieces(j: Jet, v: View, t: number, dt: number) {
    if (!model) return;
    if (!v.deb) {
      v.deb = new Debris(this.scene);
      v.deb.bk = breakup(jetImpact(j), j.id);
      const since = Math.max(0, (t - j.down!.land) / 1000);
      while (v.deb.ev < v.deb.bk.events.length && v.deb.bk.events[v.deb.ev].t < since - 0.05) v.deb.ev++; // (came into view late: no replay)
    }
    const d = v.deb, since = Math.max(0, (t - j.down!.land) / 1000);
    d.fly(since, (x, y, z) => {
      if (Math.random() < dt * 6) tyreDust.emit(x + (Math.random() - 0.5) * 2, y + 0.3, z + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3, 1 + Math.random() * 2, (Math.random() - 0.5) * 3, 2 + Math.random() * 2);
    });
    const ev = d.bk!.events;
    while (d.ev < ev.length && ev[d.ev].t <= since) {
      const e = ev[d.ev++];
      const y = this.sandY(e.x, e.z);
      if (!e.slide) this.onSplash(e.x, y, e.z, e.r);
    }
    // the largest pieces smoulder
    if (Math.random() < dt * 5) {
      const h = d.holders[1] ?? d.holders[0];
      if (h) zaps.puff(h.position.x + (Math.random() - 0.5) * 6, h.position.y + 1, h.position.z + (Math.random() - 0.5) * 6, 3, 2.2);
    }
  }

  private sandY(x: number, z: number) {
    return heightAt(x, z);
  }

  /** The planes that came down stay where their pieces came to rest (shared/jetcrash.ts), the right engine among them gone from view: it lies on the
   *  sand as a machine; close by they smoulder. */
  private wrecks(eye: { x: number; z: number }, dt: number) {
    const list = jetCrashList();
    for (const c of list) {
      const near = Math.hypot(c.x - eye.x, c.z - eye.z) < WRECK_SHOW_R;
      let o = this.wreckViews.get(c.id);
      if (near) this.proto ??= build(); // (starts the model loading)
      if (!near || !model) {
        if (o) o.holders.forEach((h) => (h.visible = false));
        continue;
      }
      if (!o) {
        o = new Debris(this.scene);
        o.rest(c.pieces, c.fates);
        this.wreckViews.set(c.id, o);
      }
      const show = !this.views.has(c.jet);
      o.holders.forEach((h) => (h.visible = show && !h.userData.machine)); // (an engine that lies whole is a machine: not drawn here)
      if (show && Math.random() < dt * 1.2) zaps.puff(c.x + (Math.random() - 0.5) * 10, heightAt(c.x, c.z) + 2, c.z + (Math.random() - 0.5) * 10, 3, 2.2);
    }
    for (const [id, o] of this.wreckViews) {
      if (list.some((c) => c.id === id)) continue;
      o.dispose();
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
