// Crash-site components for the disassembly mode: a pump housing, a jet engine with its electrical box and a
// robot arm joint. Each is a small machine laid out the way the real thing is, and everything that holds a part
// in is a step you can do: screws (several clicks), bolts (circle the pointer), clips, wires (swipe to cut) and
// pry tabs. Fasteners follow the engineering: bolt circles on round flanges, corner screws on box lids, a row
// along a split line, set screws on a coupling hub, supply wires from a cable gland to a terminal block through
// a contactor. Steps sit on different faces, so the machine has to be turned over and around.
// The real item models (public/models/items/<part>_<tier>.glb) and the code-built mechanical parts
// (parts.ts) are mounted inside. Better parts come out of fancier machines.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { COMPONENTS, RARITY, TIERS, type ComponentKind, type PartId, type Tier } from '../../shared/salvage.ts';
import { EXTRA_PARTS, makeExtraPart, THICKNESS } from './parts.ts';

export type StepKind = 'screw' | 'bolt' | 'clip' | 'wire' | 'pry' | 'lift';
export interface Step {
  kind: StepKind;
  label: string;
  /** Screws and clips: clicks. Bolts: half turns of the pointer around them. Wires and pry tabs: 1 = one decisive stroke.
   *  Lifts: seconds the holders must keep it up. */
  need: number;
  /** Players who must do this at the same moment (lifts: hold the mouse button together). */
  players: number;
  progress: number;
  done: boolean;
  /** Steps that must be done first (shown as blocked until then). */
  after: Step[];
  /** The visual; its +y is the step's outward normal. Becomes loose debris when done. */
  obj: THREE.Group;
  /** The part of `obj` that turns / tilts with progress. */
  spin: THREE.Object3D;
  hit: THREE.Mesh;
  marker: THREE.Mesh;
  /** Height of `obj`'s origin above the ground once it has fallen (before the machine's scale). */
  floorY: number;
  mat?: THREE.MeshStandardNodeMaterial;
}
/** Something that comes off by itself once every hold is done: a lid, bracket, guard, cover. */
export interface Piece {
  obj: THREE.Object3D;
  holds: Step[];
  released: boolean;
  floorY: number;
  /** Outward direction in the machine's frame; it pops that way. */
  pop: [number, number, number];
}
export interface Slot {
  part: PartId;
  tier: Tier;
  ring: THREE.Mesh;
  taken: boolean;
  /** The part's own holder; free to take once its holds are done. */
  piece: Piece;
}
export interface Junk {
  kind: ComponentKind;
  label: string;
  /** The best part inside: the machine's rarity. */
  tier: Tier;
  /** Pivot at the visual centre, so rotating spins it about its middle. */
  root: THREE.Group;
  /** World scale of the content (floor heights are in content units). */
  scale: number;
  steps: Step[];
  pieces: Piece[];
  slots: Slot[];
}
/** What a pointer hit resolves to; stored in `userData.target` on the object that owns the interaction. */
export type Target =
  | { type: 'junk'; junk: Junk }
  | { type: 'step'; step: Step }
  | { type: 'part'; slot: Slot };

export const stepReady = (s: Step) => !s.done && s.after.every((a) => a.done);
export const slotOpen = (s: Slot) => !s.taken && s.piece.holds.every((h) => h.done);

/** Distance from `root`'s origin down to the lowest drawn point: where to put it so it rests on the ground. */
export function lowestOffset(root: THREE.Object3D): number | null {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const b = new THREE.Box3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible || m.userData.ignoreBounds) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    box.union(b.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld));
  });
  return box.isEmpty() ? null : root.position.y - box.min.y;
}

// ---- part models -------------------------------------------------------------------------------------------

const PART_SIZE = 0.5;
const loader = new GLTFLoader();
const partCache = new Map<string, Promise<THREE.Object3D>>();

/** A part model scaled to PART_SIZE with its base centre at the origin; one clone per call. */
export async function loadPart(part: PartId, tier: Tier): Promise<THREE.Object3D> {
  if (EXTRA_PARTS.includes(part)) return makeExtraPart(part, tier);
  const key = `${part}_${tier}`;
  let p = partCache.get(key);
  if (!p) {
    p = loader.loadAsync(`./models/items/${key}.glb`).then((gltf) => {
      const inner = gltf.scene;
      const box = new THREE.Box3().setFromObject(inner);
      const size = box.getSize(new THREE.Vector3());
      const c = box.getCenter(new THREE.Vector3());
      const s = PART_SIZE / Math.max(size.x, size.y, size.z, 1e-3);
      inner.scale.setScalar(s);
      inner.position.set(-c.x * s, -box.min.y * s, -c.z * s);
      inner.traverse((o) => { o.castShadow = true; });
      const wrap = new THREE.Group();
      wrap.add(inner);
      return wrap;
    });
    partCache.set(key, p);
  }
  return (await p).clone(true);
}

// ---- kit ---------------------------------------------------------------------------------------------------

type MatKey = 'body' | 'trim' | 'accent' | 'glow' | 'dark' | 'red' | 'blue' | 'yellow' | 'copper' | 'pcb' | 'chip' | 'brown' | 'black' | 'green';
type V = [number, number, number];
const PALETTE = [
  { body: 0x7a5238, trim: 0x3b2616, accent: 0xa04a20, glow: 0x000000, metal: 0.55, rough: 0.9 }, // rusted
  { body: 0x56705e, trim: 0x2b3a30, accent: 0xe0c060, glow: 0x000000, metal: 0.5, rough: 0.7 }, // painted
  { body: 0x30415a, trim: 0xd2d5da, accent: 0xff8a2a, glow: 0xff9a3c, metal: 0.8, rough: 0.35 }, // steel + chrome
  { body: 0xe9e7e1, trim: 0x2c3038, accent: 0x3ff0ff, glow: 0x3ff0ff, metal: 0.6, rough: 0.25 }, // space
];
const UP = new THREE.Vector3(0, 1, 0);
const HIT_MAT = new THREE.MeshBasicMaterial();
const MARKER_MAT = new THREE.MeshBasicNodeMaterial({ color: 0xffb050 });
const MARKER_GEO = new THREE.TorusGeometry(0.19, 0.018, 6, 28).rotateX(Math.PI / 2);
const WIRE_MARKER_GEO = new THREE.SphereGeometry(0.07, 10, 8);

interface BayOpts {
  /** Pry tab on the front edge (+z). */
  pry?: boolean;
  /** Snap latch on the rear wall (-z): only reachable from behind. */
  latch?: boolean;
  /** Extra screws at the middle of the two long edges. */
  mids?: boolean;
}

class Kit {
  g = new THREE.Group();
  grade: number;
  steps: Step[] = [];
  pieces: Piece[] = [];
  slots: Slot[] = [];
  private mats: Record<MatKey, THREE.MeshStandardNodeMaterial>;
  private dmats: Partial<Record<MatKey, THREE.MeshStandardNodeMaterial>> = {};
  private queue: Record<PartId, Tier[]>;

  constructor(grade: number, rolled: Record<PartId, Tier[]>) {
    this.grade = grade;
    this.queue = rolled;
    const p = PALETTE[grade];
    const mat = (color: number, metalness: number, roughness: number, glow = 0) =>
      new THREE.MeshStandardNodeMaterial({ color, metalness, roughness, emissive: glow ? color : 0x000000, emissiveIntensity: glow });
    this.mats = {
      body: mat(p.body, p.metal, p.rough),
      trim: mat(p.trim, grade === 2 ? 1 : 0.7, grade === 2 ? 0.2 : 0.6),
      accent: mat(p.accent, 0.4, 0.5),
      glow: grade >= 2 ? mat(p.glow, 0, 0.3, grade === 3 ? 4 : 1.5) : mat(p.accent, 0.3, 0.8),
      dark: mat(0x15100d, 0.3, 0.8),
      red: mat(0xb02a20, 0, 0.6),
      blue: mat(0x2858b8, 0, 0.6),
      yellow: mat(0xd8a820, 0, 0.6),
      copper: mat(0xc87a44, 1, 0.3),
      pcb: mat(0x1f5a36, 0.2, 0.55),
      chip: mat(0x14181c, 0.4, 0.4),
      brown: mat(0x6b3f1e, 0, 0.6),
      black: mat(0x0c0c0e, 0, 0.5),
      green: mat(0x7da228, 0, 0.6),
    };
  }

  /** Next rolled tier of `part`, or null when the machine holds no more of them (the mount stays empty). */
  take(part: PartId): Tier | null {
    return this.queue[part].shift() ?? null;
  }

  // -- geometry ---------------------------------------------------------------------------------------------
  add<T extends THREE.Object3D>(o: T, parent: THREE.Object3D = this.g): T {
    o.traverse((c) => { c.castShadow = true; c.receiveShadow = true; });
    parent.add(o);
    return o;
  }
  group(pos: V, rot: V = [0, 0, 0]): THREE.Group {
    const g = new THREE.Group();
    g.position.set(...pos);
    g.rotation.set(...rot);
    this.g.add(g);
    return g;
  }
  mesh(geo: THREE.BufferGeometry, key: MatKey, x: number, y: number, z: number, parent?: THREE.Object3D) {
    const m = new THREE.Mesh(geo, this.mats[key]);
    m.position.set(x, y, z);
    return this.add(m, parent);
  }
  /** Box with its base at y. */
  box(w: number, h: number, d: number, x: number, y: number, z: number, key: MatKey = 'body', parent?: THREE.Object3D) {
    return this.mesh(new THREE.BoxGeometry(w, h, d), key, x, y + h / 2, z, parent);
  }
  /** Cylinder with its base at y, standing up ('y') or lying along x / z (then y is the axis height). */
  cyl(r: number, h: number, x: number, y: number, z: number, key: MatKey = 'body', axis: 'x' | 'y' | 'z' = 'y', seg = 24, parent?: THREE.Object3D) {
    const geo = new THREE.CylinderGeometry(r, r, h, seg);
    if (axis === 'x') geo.rotateZ(Math.PI / 2);
    if (axis === 'z') geo.rotateX(Math.PI / 2);
    return this.mesh(geo, key, x, axis === 'y' ? y + h / 2 : y, z, parent);
  }
  ring(r: number, tube: number, x: number, y: number, z: number, key: MatKey, axis: 'x' | 'y' | 'z' = 'y', parent?: THREE.Object3D) {
    const geo = new THREE.TorusGeometry(r, tube, 10, 36);
    if (axis === 'y') geo.rotateX(Math.PI / 2);
    if (axis === 'x') geo.rotateY(Math.PI / 2);
    return this.mesh(geo, key, x, y, z, parent);
  }
  /** Open-ended cylinder shell (drawn both sides): a casing you can see into once the top half is off. */
  shell(r: number, len: number, c: V, axis: 'x' | 'y', half: 'full' | 'upper' | 'lower', key: MatKey, parent?: THREE.Object3D) {
    const [ts, tl] = half === 'full' ? [0, Math.PI * 2] : half === 'upper' ? [Math.PI, Math.PI] : [0, Math.PI];
    const geo = new THREE.CylinderGeometry(r, r, len, 36, 1, true, ts, tl);
    if (axis === 'x') geo.rotateZ(-Math.PI / 2);
    let m = this.dmats[key];
    if (!m) {
      m = this.mats[key].clone();
      m.side = THREE.DoubleSide;
      this.dmats[key] = m;
    }
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(...c);
    return this.add(mesh, parent);
  }
  /** Cylinder between two points. */
  rod(a: V, b: V, r: number, key: MatKey = 'trim') {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
    const m = this.mesh(new THREE.CylinderGeometry(r, r, va.distanceTo(vb), 12), key, 0, 0, 0);
    m.position.copy(va).add(vb).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(UP, vb.clone().sub(va).normalize());
    return m;
  }
  /** Loose decorative cable. */
  cable(pts: V[], r = 0.03, key: MatKey = 'dark') {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
    return this.mesh(new THREE.TubeGeometry(curve, 24, r, 6), key, 0, 0, 0);
  }
  /** A bolt head that does nothing (the other end of a through-bolt, a flange stud). */
  stud(x: number, y: number, z: number, r = 0.05) {
    return this.mesh(new THREE.CylinderGeometry(r, r, r * 0.8, 6), 'trim', x, y, z);
  }
  lamps(n: number, x0: number, y: number, z: number, dx: number) {
    for (let i = 0; i < n; i++) this.box(0.07, 0.04, 0.07, x0 + i * dx, y, z, i % 2 ? 'accent' : 'glow');
  }

  // -- steps ------------------------------------------------------------------------------------------------
  private reg(kind: StepKind, label: string, g: THREE.Group, spin: THREE.Object3D, hitGeo: THREE.BufferGeometry, need: number,
    after: Step[], floorY: number, mat?: THREE.MeshStandardNodeMaterial, markerGeo: THREE.BufferGeometry = MARKER_GEO): Step {
    const hit = new THREE.Mesh(hitGeo, HIT_MAT);
    hit.visible = false; // never drawn, but still hit by the pointer ray
    hit.position.y = 0.05;
    g.add(hit);
    const marker = new THREE.Mesh(markerGeo, MARKER_MAT);
    marker.position.y = 0.06;
    marker.visible = false;
    marker.raycast = () => {};
    marker.userData.ignoreBounds = true;
    g.add(marker);
    const step: Step = { kind, label, need, players: 1, progress: 0, done: false, after, obj: g, spin, hit, marker, floorY, mat };
    hit.userData.target = { type: 'step', step } satisfies Target;
    this.g.add(g);
    this.steps.push(step);
    return step;
  }
  private stepGroup(pos: V, nrm: V) {
    const g = new THREE.Group();
    g.position.set(...pos);
    g.quaternion.setFromUnitVectors(UP, new THREE.Vector3(...nrm).normalize());
    const spin = new THREE.Group();
    g.add(spin);
    return { g, spin };
  }

  /** Small screw: several clicks to back it out. */
  screw(label: string, pos: V, nrm: V = [0, 1, 0], after: Step[] = [], need = 3 + (this.grade >= 2 ? 1 : 0)): Step {
    const { g, spin } = this.stepGroup(pos, nrm);
    this.mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 12), 'trim', 0, 0.02, 0, spin);
    this.mesh(new THREE.BoxGeometry(0.1, 0.02, 0.018), 'dark', 0, 0.04, 0, spin);
    this.mesh(new THREE.BoxGeometry(0.018, 0.02, 0.1), 'dark', 0, 0.04, 0, spin);
    return this.reg('screw', label, g, spin, new THREE.SphereGeometry(0.15, 8, 6), need, after, 0.02);
  }
  /** Big hex bolt or nut: turn the pointer around it. `need` is half turns. */
  bolt(label: string, pos: V, nrm: V = [0, 1, 0], after: Step[] = [], need = 4): Step {
    const { g, spin } = this.stepGroup(pos, nrm);
    this.mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.09, 6), 'trim', 0, 0.045, 0, spin);
    this.mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.02, 16), 'dark', 0, 0.01, 0, g);
    return this.reg('bolt', label, g, spin, new THREE.SphereGeometry(0.2, 8, 6), need, after, 0.05);
  }
  /** Snap latch or spring clip. */
  clip(label: string, pos: V, nrm: V = [0, 1, 0], clicks = 1, after: Step[] = []): Step {
    const { g, spin } = this.stepGroup(pos, nrm);
    this.mesh(new THREE.BoxGeometry(0.22, 0.03, 0.12), 'dark', 0, 0.015, 0, g);
    spin.position.set(-0.1, 0.03, 0);
    this.mesh(new THREE.BoxGeometry(0.2, 0.05, 0.09), 'yellow', 0.1, 0.025, 0, spin);
    return this.reg('clip', label, g, spin, new THREE.BoxGeometry(0.34, 0.2, 0.26), clicks, after, 0.04);
  }
  /** Pry tab: drag it away from the seam. */
  pry(label: string, pos: V, nrm: V, after: Step[] = []): Step {
    const { g, spin } = this.stepGroup(pos, nrm);
    this.mesh(new THREE.BoxGeometry(0.3, 0.04, 0.2), 'accent', 0, 0.02, 0, g);
    spin.position.set(0, 0.04, 0);
    this.mesh(new THREE.BoxGeometry(0.28, 0.03, 0.26), 'trim', 0, 0.015, 0.13, spin);
    return this.reg('pry', label, g, spin, new THREE.BoxGeometry(0.4, 0.25, 0.4), 1, after, 0.04);
  }
  /** Lifting eye on something too heavy for one person: `players` of you must hold the mouse button on it together. */
  lift(label: string, pos: V, nrm: V, players: number, after: Step[] = [], seconds = 1.6): Step {
    const { g, spin } = this.stepGroup(pos, nrm);
    this.mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.05, 12), 'dark', 0, 0.025, 0, g);
    this.mesh(new THREE.TorusGeometry(0.11, 0.028, 8, 20), 'yellow', 0, 0.15, 0, spin);
    const s = this.reg('lift', label, g, spin, new THREE.SphereGeometry(0.22, 8, 6), seconds, after, 0.1);
    s.players = players;
    return s;
  }
  /** Wire from the first point to the last, a ring lug at each end: swipe across it to cut. */
  wire(label: string, pts: V[], key: MatKey = 'red', after: Step[] = [], r = 0.035): Step {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
    const mid = curve.getPoint(0.5);
    const rel = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p).sub(mid)));
    const g = new THREE.Group();
    g.position.copy(mid);
    const mat = this.mats[key].clone();
    this.add(new THREE.Mesh(new THREE.TubeGeometry(rel, 28, r, 6), mat), g);
    for (const t of [0, 1]) {
      const lug = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.025, 10), this.mats.copper);
      lug.position.copy(rel.getPoint(t));
      this.add(lug, g);
    }
    const spin = new THREE.Group();
    g.add(spin);
    return this.reg('wire', label, g, spin, new THREE.TubeGeometry(rel, 12, Math.max(0.1, r * 2), 5), 1, after, 0.03, mat, WIRE_MARKER_GEO);
  }

  private basis(nrm: V): [THREE.Vector3, THREE.Vector3] {
    const n = new THREE.Vector3(...nrm).normalize();
    const u = Math.abs(n.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0).cross(n).normalize();
    return [u, n.clone().cross(u)];
  }
  private at(c: V, u: THREE.Vector3, v: THREE.Vector3, a: number, b: number): V {
    return [c[0] + u.x * a + v.x * b, c[1] + u.y * a + v.y * b, c[2] + u.z * a + v.z * b];
  }
  /** Bolt circle on a round flange: `n` bolts at radius `r` around `c`, facing `nrm`. */
  circle(label: string, c: V, nrm: V, r: number, n: number, after: Step[] = [], kind: 'bolt' | 'screw' = 'bolt', phase = 0): Step[] {
    const [u, v] = this.basis(nrm);
    const out: Step[] = [];
    for (let i = 0; i < n; i++) {
      const a = phase + (i / n) * Math.PI * 2;
      const p = this.at(c, u, v, Math.cos(a) * r, Math.sin(a) * r);
      out.push(kind === 'bolt' ? this.bolt(label, p, nrm, after, 2) : this.screw(label, p, nrm, after, 2));
    }
    return out;
  }
  /** Screws along the two long edges of a rectangular cover: corners, plus the middle when `nW` is 3. */
  rect(label: string, c: V, nrm: V, w: number, h: number, nW = 2, after: Step[] = []): Step[] {
    const [u, v] = this.basis(nrm);
    const out: Step[] = [];
    for (const b of [-h / 2, h / 2]) for (let i = 0; i < nW; i++) out.push(this.screw(label, this.at(c, u, v, -w / 2 + (i * w) / (nW - 1), b), nrm, after));
    return out;
  }
  /** Evenly spaced bolts from one point to another (a split-line flange). */
  row(label: string, a: V, b: V, n: number, nrm: V, after: Step[] = [], need = 2): Step[] {
    const out: Step[] = [];
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      out.push(this.bolt(label, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], nrm, after, need));
    }
    return out;
  }

  // -- pieces -----------------------------------------------------------------------------------------------
  /** Make `obj` a cover that falls away when all of `holds` are done. */
  cover(obj: THREE.Object3D, holds: Step[], pop: V = [0, 1, 0], floorY = 0.05): Piece {
    const p: Piece = { obj, holds, released: false, floorY, pop };
    this.pieces.push(p);
    return p;
  }

  /** Walled box open at the top on level `deckY`, closed by a lid that is screwed down at the corners (and the
   *  middle of the long edges with `mids`). Optional pry tab at the front, snap latch on the back wall. Returns the lid. */
  bay(cx: number, cz: number, w: number, d: number, deckY: number, h: number, o: BayOpts = {}): Piece {
    const t = 0.06;
    this.box(w, h, t, cx, deckY, cz - d / 2 + t / 2, 'trim');
    this.box(w, h, t, cx, deckY, cz + d / 2 - t / 2, 'trim');
    this.box(t, h, d - 2 * t, cx - w / 2 + t / 2, deckY, cz, 'trim');
    this.box(t, h, d - 2 * t, cx + w / 2 - t / 2, deckY, cz, 'trim');
    const top = deckY + h;
    const group = this.group([cx, top + 0.04, cz]);
    const plate = this.mesh(new THREE.BoxGeometry(w, 0.08, d), 'body', 0, 0, 0, group);
    plate.material = (plate.material as THREE.MeshStandardNodeMaterial).clone();
    this.box(w - 0.2, 0.02, 0.06, 0, 0.04, 0, this.grade >= 1 ? 'accent' : 'trim', group);
    if (this.grade >= 3) this.box(w - 0.4, 0.02, 0.03, 0, 0.05, d / 4, 'glow', group);
    const bx = w / 2 - 0.1, bz = d / 2 - 0.1;
    const spots: [number, number][] = [[-bx, -bz], [bx, -bz], [-bx, bz], [bx, bz]];
    if (o.mids) spots.push(w >= d ? [0, -bz] : [-bx, 0], w >= d ? [0, bz] : [bx, 0]);
    const holds = spots.map(([x, z]) => this.screw('Lid screw', [cx + x, top + 0.08, cz + z]));
    if (o.latch) holds.push(this.clip('Rear latch', [cx, top - h / 2, cz - d / 2 - 0.01], [0, 0, -1], 1));
    if (o.pry) holds.push(this.pry('Lid seam', [cx, top + 0.04, cz + d / 2], [0, 0, 1], [...holds]));
    return this.cover(group, holds, [0, 1, 0.3], 0.04);
  }

  /** A part holder at `pos`, held by `holds`. Its model loads in the background. */
  part(part: PartId, tier: Tier, pos: V, holds: Step[], rot: V = [0, 0, 0]): Slot {
    const holder = new THREE.Group();
    holder.position.set(...pos);
    holder.rotation.set(...rot);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.34, 0.02, 6, 36).rotateX(Math.PI / 2),
      new THREE.MeshBasicNodeMaterial({ color: RARITY[tier].color }),
    );
    ring.position.y = 0.02;
    ring.visible = false;
    ring.raycast = () => {}; // a marker, never a click target
    ring.userData.ignoreBounds = true;
    holder.add(ring);
    const slot: Slot = { part, tier, ring, taken: false, piece: { obj: holder, holds, released: false, floorY: 0, pop: [0, 1, 0] } };
    holder.userData.target = { type: 'part', slot } satisfies Target;
    this.g.add(holder);
    this.slots.push(slot);
    loadPart(part, tier).then(
      (m) => { m.traverse((o) => { o.castShadow = true; }); holder.add(m); },
      (e) => console.warn('teardown: part model failed', part, tier, e),
    );
    return slot;
  }
  /** Placement for a code-built part whose axis is `axis`, centred on `c` (its origin is at the base). */
  ax(part: PartId, c: V, axis: 'x' | 'y' | 'z'): [V, V] {
    const h = (THICKNESS[part] ?? 0.5) / 2;
    if (axis === 'x') return [[c[0] - h, c[1], c[2]], [0, 0, -Math.PI / 2]];
    if (axis === 'z') return [[c[0], c[1], c[2] - h], [Math.PI / 2, 0, 0]];
    return [[c[0], c[1] - h, c[2]], [0, 0, 0]];
  }
  /** If the machine holds another `part`: build its hardware (`holds`) and mount it. Null when the mount stays empty. */
  mount(part: PartId, place: [V, V], holds: (tier: Tier) => Step[]): Slot | null {
    const tier = this.take(part);
    if (!tier) return null;
    return this.part(part, tier, place[0], holds(tier), place[1]);
  }
}

// ---- pump housing ------------------------------------------------------------------------------------------

/** End-suction centrifugal pump on a skid, motor-driven through a guarded coupling.
 *  Front (-x): suction cover held by a bolt circle (drain the casing first: the plug is underneath) over the
 *  impeller. Middle: bearing housing with an inspection lid over two bearings, a valve in the discharge.
 *  Back (+x): coupling guard, coupling hubs with set screws, the motor on its pedestal, and its terminal box:
 *  supply through a gland, live via a contactor to the terminals, neutral, earth. */
function pumpHousing(k: Kit) {
  const g = k.grade;
  const SY = 0.62; // shaft height
  k.box(3.7, 0.15, 0.95, 0.3, 0, 0, 'trim');
  for (const [x, z] of [[-1.4, -0.38], [-1.4, 0.38], [2.0, -0.38], [2.0, 0.38]]) k.stud(x, 0.17, z, 0.06);
  k.rod([-0.95, SY, 0], [1.75, SY, 0], 0.045, 'copper');

  // volute casing with a back wall; discharge goes straight up from the top
  k.shell(0.42, 0.5, [-0.75, SY, 0], 'x', 'full', 'body');
  k.cyl(0.42, 0.04, -0.5, SY, 0, 'body', 'x');
  k.box(0.5, 0.14, 0.5, -0.75, 0.15, 0, 'trim'); // foot
  if (g >= 2) k.ring(0.43, 0.025, -0.52, SY, 0, 'accent', 'x');
  if (g >= 3) k.ring(0.43, 0.02, -0.98, SY, 0, 'glow', 'x');
  // On the casing's flank, low down: the big machines can't be turned over, so every step faces somewhere you can walk to.
  const drain = k.bolt('Drain plug', [-0.75, SY - 0.2, 0.37], [0, 0, 1], [], 2);

  // suction cover: disc, suction nozzle, inlet flange
  const cov = k.group([-1.03, SY, 0]);
  k.mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.06, 32).rotateZ(Math.PI / 2), 'body', 0, 0, 0, cov);
  k.mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.4, 20).rotateZ(Math.PI / 2), 'body', -0.28, 0, 0, cov);
  k.mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 28).rotateZ(Math.PI / 2), 'trim', -0.5, 0, 0, cov);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.09, 6).rotateZ(Math.PI / 2), 'trim', -0.5, Math.cos(a) * 0.24, Math.sin(a) * 0.24, cov); // inlet flange studs
  }
  const coverBolts = k.circle('Cover bolt', [-1.065, SY, 0], [-1, 0, 0], 0.36, 8, [drain]);
  k.cover(cov, coverBolts, [-1, 0.25, 0], 0.44);
  // impeller on the shaft, behind the cover, held by its nut
  k.mount('impeller', k.ax('impeller', [-0.78, SY, 0], 'x'), () => [k.bolt('Impeller nut', [-0.96, SY, 0], [-1, 0, 0], [], 3)]);

  // discharge with the check valve between two flanges
  k.cyl(0.13, 0.12, -0.75, 1.0, 0, 'body');
  k.cyl(0.42, 0.04, -0.75, 1.06, 0, 'trim', 'y', 32);
  const valve = k.take('valve');
  if (valve) {
    const bolts = k.circle('Valve flange bolt', [-0.75, 1.1, 0], [0, 1, 0], 0.34, 4, [], 'bolt', Math.PI / 4);
    k.part('valve', valve, [-0.75, 1.1, 0], bolts);
  } else k.cyl(0.12, 0.5, -0.75, 1.1, 0, 'body'); // plain spool piece
  k.cyl(0.12, 0.25, -0.75, 1.6, 0, 'body');
  k.cyl(0.28, 0.04, -0.75, 1.82, 0, 'trim', 'y', 24);

  // bearing housing: lid over two bearings, each held by a retaining clip
  const bhLid = k.bay(0.275, 0, 0.95, 0.46, 0.15, 0.71, { mids: true });
  void bhLid;
  for (const x of [0.0, 0.5]) {
    k.mount('bearing', k.ax('bearing', [x, SY, 0], 'x'), () => [k.clip('Bearing retainer', [x, SY + 0.27, 0], [0, 1, 0], 2)]);
  }
  k.box(0.1, 0.1, 0.04, 0.275, 0.4, 0.25, g >= 1 ? 'accent' : 'dark'); // oil sight glass
  k.ring(0.06, 0.012, 0.275, 0.45, 0.28, 'copper', 'z');

  // coupling: two hubs with a spider between; the set screw on the motor hub holds the motor on
  k.cyl(0.1, 0.14, 0.9, SY, 0, 'trim', 'x');
  k.cyl(0.12, 0.12, 1.075, SY, 0, 'dark', 'x');
  k.cyl(0.1, 0.14, 1.25, SY, 0, 'trim', 'x');
  k.stud(0.9, SY + 0.1, 0, 0.04);
  const setMotor = k.screw('Hub set screw', [1.25, SY + 0.1, 0]);
  const guard = k.group([1.075, SY, 0]);
  k.shell(0.22, 0.65, [0, 0, 0], 'x', 'upper', 'accent', guard);
  for (const z of [-0.25, 0.25]) k.box(0.65, 0.03, 0.08, 0, -0.01, z, 'accent', guard);
  k.cover(guard, k.rect('Guard screw', [1.075, SY + 0.03, 0], [0, 1, 0], 0.5, 0.5, 2), [0, 1, 0], 0.2);

  // motor on a pedestal, its feet bolted down at the corners
  k.box(0.78, 0.22, 0.7, 1.9, 0.15, 0, 'trim');
  k.box(0.7, 0.05, 0.66, 1.9, 0.37, 0, 'body');
  // terminal box on top: gland on the +z wall, contactor on a rail, terminal block along the far wall
  const tbLid = k.bay(1.9, 0, 0.8, 0.5, 0.95, 0.36);
  void tbLid;
  k.box(0.7, 0.03, 0.38, 1.9, 0.95, 0, 'dark');
  k.cyl(0.06, 0.12, 1.7, 1.1, 0.3, 'trim', 'z');
  k.cable([[1.7, 1.1, 0.36], [1.7, 1.0, 0.65], [1.0, 0.18, 0.66], [-0.2, 0.18, 0.66]], 0.045);
  k.box(0.04, 0.03, 0.4, 2.1, 0.98, 0, 'trim'); // terminal block rail
  for (const z of [-0.15, 0, 0.15]) k.box(0.1, 0.1, 0.08, 2.1, 1.0, z, 'yellow');
  const G: V = [1.7, 1.1, 0.25];
  const relayTier = k.take('relay');
  const neutral = k.wire('Neutral', [[1.72, 1.08, 0.25], [1.9, 1.04, 0.2], [2.06, 1.04, 0.0]], 'blue');
  const earth = k.wire('Earth wire', [[1.76, 1.06, 0.25], [1.95, 1.02, 0.24], [2.1, 1.06, 0.15]], 'green');
  const earthScrew = k.screw('Earth screw', [2.05, 0.98, 0.22]);
  const liveToMotor = k.wire('Live to motor', [[1.88, 1.26, 0.1], [1.98, 1.22, -0.02], [2.1, 1.06, -0.15]], 'brown');
  if (relayTier) {
    const liveIn = k.wire('Live in', [G, [1.69, 1.2, 0.18], [1.68, 1.26, 0.1]], 'brown');
    const coilFeed = k.wire('Coil feed', [[1.74, 1.12, 0.25], [1.6, 1.2, 0.1], [1.68, 1.26, -0.1]], 'brown', [], 0.025);
    const coilReturn = k.wire('Coil return', [[1.88, 1.26, -0.1], [2.0, 1.15, -0.05], [2.08, 1.06, 0.0]], 'blue', [], 0.025);
    const din = k.clip('Rail clip', [1.78, 0.98, 0.21], [0, 1, 0]);
    k.part('relay', relayTier, [1.78, 0.98, 0], [din, liveIn, liveToMotor, coilFeed, coilReturn]);
  } else k.cable([[G[0], G[1], G[2]], [1.8, 1.2, 0.1], [1.88, 1.26, 0.1]], 0.035, 'brown'); // straight through
  const motorHolds = [setMotor, liveToMotor, neutral, earth, earthScrew];
  const feet = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => k.bolt('Motor foot bolt', [1.9 + sx * 0.31, 0.42, sz * 0.28], [0, 1, 0], motorHolds, 2)));
  // the motor is too heavy for one person: two of you lift it off once the feet are free
  k.mount('motor', [[1.9, 0.42, 0], [0, 0, 0]], () => [...motorHolds, ...feet, k.lift('Lift the motor off', [2.17, 0.67, 0], [1, 0, 0], 2, feet)]);
  if (g >= 3) k.lamps(4, 1.65, 0.45, 0.4, 0.2);
}

// ---- jet engine --------------------------------------------------------------------------------------------

/** Small turbojet on a stand. Compressor casing split along the horizontal: a row of bolts down each side
 *  (the far side needs a turn), over two bearings in pillow blocks. Accessory gearbox under the front with a side
 *  cover over two gears and the starter motor flanged to its back. Fuel valve on the combustor feed line,
 *  igniter coil on the combustor. Beside it the control box: ECU on standoffs, a heatsink on its power stage, the
 *  starter relay; harness cables run from three round connectors on its wall out to the starter, valve and igniter. */
function jetEngine(k: Kit) {
  const g = k.grade;
  const AY = 0.95;
  k.box(3.3, 0.12, 2.4, 0.2, 0, 0.3, 'trim');
  for (const x of [-1.05, 0.45, 1.1]) {
    k.box(0.2, 0.43, 0.7, x, 0.12, 0, 'body');
    k.ring(0.43, 0.025, x, AY, 0, 'trim', 'x');
  }
  k.rod([-1.1, AY, 0], [1.4, AY, 0], 0.06, 'copper');

  // intake and nose cone
  k.shell(0.46, 0.45, [-1.12, AY, 0], 'x', 'full', 'trim');
  k.mesh(new THREE.ConeGeometry(0.17, 0.45, 20).rotateZ(Math.PI / 2), 'accent', -1.3, AY, 0);
  for (let i = 0; i < 10; i++) {
    const b = k.box(0.03, 0.34, 0.1, -1.05, 0, 0, 'dark');
    b.position.set(-1.05, AY, 0);
    b.geometry.translate(0, 0.22, 0);
    b.rotation.x = (i / 10) * Math.PI * 2;
  }

  // compressor casing: lower half is the body, the upper half comes off
  k.shell(0.42, 1.0, [-0.4, AY, 0], 'x', 'lower', 'body');
  for (const z of [-1, 1]) k.box(1.0, 0.04, 0.1, -0.4, AY - 0.02, z * 0.47, 'body');
  for (let i = 0; i < 5; i++) k.cyl(0.3 - i * 0.02, 0.03, -0.8 + i * 0.17, AY, 0, 'dark', 'x'); // rotor discs
  const top = k.group([-0.4, AY, 0]);
  k.shell(0.42, 1.0, [0, 0, 0], 'x', 'upper', 'body', top);
  for (const z of [-1, 1]) k.box(1.0, 0.04, 0.1, 0, 0, z * 0.47, 'body', top);
  const split: Step[] = [];
  for (const z of [-1, 1]) split.push(...k.row('Split-line bolt', [-0.75, AY + 0.02, z * 0.47], [0, AY + 0.02, z * 0.47], 4, [0, 1, 0]));
  // the upper casing is heavy: once the flange bolts are out, two of you lift it clear
  k.cover(top, [...split, k.lift('Lift the casing off', [-0.4, AY + 0.46, 0], [0, 1, 0], 2, split)], [0, 1, 0.1], 0.45);
  // bearings on pedestals under cap blocks, two bolts each
  for (const x of [-0.75, -0.1]) {
    k.box(0.26, 0.16, 0.4, x, 0.55, 0, 'trim');
    const cap = k.group([x, AY + 0.27, 0]);
    k.mesh(new THREE.BoxGeometry(0.28, 0.06, 0.46), 'trim', 0, 0, 0, cap);
    const screws = [-0.2, 0.2].map((z) => k.screw('Bearing cap screw', [x, AY + 0.3, z]));
    k.cover(cap, screws, [0, 1, 0], 0.03);
    k.mount('bearing', k.ax('bearing', [x, AY, 0], 'x'), () => screws);
  }

  // combustor with manifold, injectors, and the igniter coil on its top
  k.cyl(0.4, 0.65, 0.42, AY, 0, 'body', 'x');
  k.ring(0.41, 0.03, 0.55, AY, 0, 'copper', 'x');
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.rod([0.55, AY + Math.cos(a) * 0.41, Math.sin(a) * 0.41], [0.55, AY + Math.cos(a) * 0.5, Math.sin(a) * 0.5], 0.025, 'copper');
  }
  k.box(0.74, 0.04, 0.44, 0.4, AY + 0.4 - 0.02, 0, 'trim');
  const igniterLead = k.wire('Igniter lead', [[0.4, 1.62, 0.05], [0.3, 1.45, 0.3], [0.2, 0.9, 0.7], [0.0, 0.34, 0.72]], 'black', [], 0.03);
  k.mount('coil', [[0.4, AY + 0.4 + 0.02, 0], [0, 0, 0]], () => [igniterLead, ...[0.1, 0.7].map((x) => k.bolt('Igniter bolt', [x, AY + 0.43, 0], [0, 1, 0], [igniterLead], 2))]);

  // turbine and nozzle
  k.cyl(0.36, 0.55, 1.03, AY, 0, 'body', 'x');
  k.mesh(new THREE.CylinderGeometry(0.34, 0.24, 0.45, 28).rotateZ(Math.PI / 2), 'trim', 1.55, AY, 0);
  if (g >= 2) k.ring(0.37, 0.02, 0.76, AY, 0, 'accent', 'x');
  if (g >= 3) k.ring(0.25, 0.02, 1.78, AY, 0, 'glow', 'x');

  // fuel valve on the feed line to the manifold; union nut above and below
  const fuelLine: V[] = [[0.75, 1.0, 0.65], [0.55, 1.0, 0.43]];
  k.rod(fuelLine[0], fuelLine[1], 0.03, 'copper');
  k.rod([0.75, 0.64, 0.65], [0.75, 1.0, 0.65], 0.03, 'copper');
  k.rod([0.75, 0.14, 0.65], [1.4, 0.14, 0.65], 0.03, 'copper');
  const valveLead = k.wire('Solenoid lead', [[0.78, 0.45, 0.65], [0.4, 0.2, 0.75], [-0.4, 0.3, 0.72]], 'brown', [], 0.03);
  k.mount('valve', [[0.75, 0.14, 0.65], [0, 0, 0]], () => [valveLead, k.bolt('Union nut', [0.75, 0.68, 0.65], [0, 1, 0], [valveLead], 2), k.bolt('Union nut', [1.05, 0.17, 0.65], [0, 1, 0], [valveLead], 2)]);

  // accessory gearbox under the front: open towards +z, closed by a cover; starter flanged on the -z side
  const gb = [-0.45, 0.365, 0] as V;
  k.box(0.7, 0.04, 0.6, gb[0], 0.2, 0, 'trim');
  k.box(0.7, 0.04, 0.6, gb[0], 0.5, 0, 'trim');
  k.box(0.04, 0.3, 0.6, -0.8, 0.22, 0, 'trim');
  k.box(0.04, 0.3, 0.6, -0.1, 0.22, 0, 'trim');
  k.box(0.7, 0.3, 0.04, gb[0], 0.22, -0.3, 'body');
  const cover = k.group([gb[0], gb[1], 0.31]);
  k.mesh(new THREE.BoxGeometry(0.74, 0.34, 0.04), 'body', 0, 0, 0, cover);
  k.cover(cover, k.rect('Gearbox screw', [gb[0], gb[1], 0.33], [0, 0, 1], 0.62, 0.26, 3), [0, 0.2, 1], 0.17);
  for (const x of [-0.6, -0.3]) {
    k.rod([x, gb[1], -0.28], [x, gb[1], 0.22], 0.03, 'copper');
    k.mount('gear', k.ax('gear', [x, gb[1], 0], 'z'), () => [k.clip('Gear clip', [x, gb[1], 0.22], [0, 0, 1], 2)]);
  }
  const sLead = k.wire('Starter lead +', [[-0.35, 0.58, -0.85], [-0.7, 0.16, -0.85], [-1.3, 0.16, -0.1], [-1.2, 0.16, 0.6], [-0.85, 0.3, 0.72]], 'red', [], 0.04);
  const sLead2 = k.wire('Starter lead -', [[-0.25, 0.58, -0.85], [-0.65, 0.16, -0.8], [-1.35, 0.16, -0.1], [-1.25, 0.16, 0.6], [-0.75, 0.3, 0.72]], 'black', [], 0.04);
  k.cyl(0.34, 0.05, -0.3, gb[1], -0.33, 'trim', 'z');
  k.mount('motor', [[-0.3, 0.12, -0.65], [0, 0, 0]], () => [sLead, sLead2, ...k.circle('Starter flange bolt', [-0.3, gb[1], -0.36], [0, 0, -1], 0.27, 4, [sLead, sLead2], 'bolt', Math.PI / 4)]);
  k.rod([-0.3, gb[1], -0.45], [-0.3, gb[1], -0.2], 0.04, 'copper');

  // control box beside the engine
  const cx = -0.35, cz = 1.05;
  k.bay(cx, cz, 1.58, 0.6, 0.12, 0.42, { mids: true });
  k.box(1.4, 0.03, 0.46, cx, 0.12, cz, 'dark');
  for (let i = 0; i < 3; i++) { // round connectors on the wall facing the engine
    const x = -0.8 + i * 0.4;
    k.cyl(0.1, 0.1, x, 0.34, 0.72, 'chip', 'z');
  }
  // contents, left to right: starter relay, ECU on standoffs, power stage with heatsink
  const connectors = [0, 1, 2].map((i) => k.bolt('Connector ring', [-0.8 + i * 0.4, 0.34, 0.68], [0, 0, -1], [], 2));
  void connectors;
  const ribbon = k.wire('Ribbon cable', [[-0.2, 0.3, 1.0], [-0.3, 0.32, 0.9], [-0.4, 0.3, 0.8]], 'blue', [], 0.025);
  k.box(0.56, 0.04, 0.44, -0.45, 0.15, cz, 'pcb');
  k.mount('relay', [[-0.92, 0.15, cz], [0, 0, 0]], () => [
    k.clip('Rail clip', [-0.92, 0.17, cz + 0.2], [0, 1, 0]),
    k.wire('Relay feed', [[-0.93, 0.5, 1.0], [-0.9, 0.42, 0.9], [-0.8, 0.3, 0.78]], 'red', [], 0.04),
    k.wire('Relay coil wire', [[-0.88, 0.45, 1.0], [-0.7, 0.5, 1.02], [-0.5, 0.36, 1.0]], 'brown', [], 0.025),
  ]);
  const standoffs = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => k.screw('ECU standoff', [-0.45 + sx * 0.27, 0.19, cz + sz * 0.2])));
  k.mount('compute', [[-0.45, 0.2, cz], [0, 0, 0]], () => [...standoffs, ribbon, ...connectors]);
  k.box(0.4, 0.04, 0.4, 0.05, 0.15, cz, 'pcb');
  k.box(0.26, 0.05, 0.26, 0.05, 0.19, cz, 'chip');
  k.mount('heatsink', [[0.05, 0.2, cz], [0, 0, 0]], () => [k.clip('Spring clip', [-0.2, 0.55, cz], [0, 1, 0]), k.clip('Spring clip', [0.3, 0.55, cz], [0, 1, 0])]);
  if (g >= 2) k.lamps(6, -1.0, 0.12, 1.37, 0.2);
}

// ---- robot arm joint ---------------------------------------------------------------------------------------

/** One joint of a robot arm. A vertical housing: a round top cover on a bolt circle over the output gear, held
 *  by its centre bolt, over a clamp ring (a smaller bolt circle) over the slewing bearing. A side gearbox
 *  on -x with a screwed cover over the idler gears. The servo motor on +x, flanged with four bolts, its power and
 *  encoder cables running along the link into the driver bay on the link: a lid over the controller board, the
 *  driver heatsink and a brake relay; the brake solenoid sits on the base, fed by a long cable. */
function robotArm(k: Kit) {
  const g = k.grade;
  k.box(1.9, 0.12, 2.25, 0, 0, 0.375, 'trim');
  for (const [x, z] of [[-0.8, -0.65], [0.8, -0.65], [-0.8, 1.4], [0.8, 1.4]]) k.stud(x, 0.14, z, 0.07);

  // housing, with a top cover on a bolt circle; stack inside: bearing, clamp ring, output gear
  k.shell(0.55, 0.88, [0, 0.56, 0], 'y', 'full', 'body');
  k.cyl(0.55, 0.04, 0, 0.12, 0, 'dark', 'y', 32);
  k.ring(0.55, 0.04, 0, 1.0, 0, 'trim', 'y');
  k.cyl(0.57, 0.06, 0, 0.3, 0, 'trim', 'y', 32);
  if (g >= 2) k.ring(0.57, 0.02, 0, 0.7, 0, 'accent', 'y');
  if (g >= 3) k.ring(0.57, 0.015, 0, 0.5, 0, 'glow', 'y');
  const topCover = k.group([0, 1.0, 0]);
  k.mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.05, 36), 'body', 0, 0.025, 0, topCover);
  k.mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.03, 20), 'trim', 0, 0.065, 0, topCover);
  const coverBolts = k.circle('Top cover bolt', [0, 1.05, 0], [0, 1, 0], 0.42, 8);
  k.cover(topCover, coverBolts, [0, 1, 0], 0.03);
  const gearBolt = k.bolt('Gear retaining bolt', [0, 0.85, 0], [0, 1, 0], [], 3);
  const clampRing = k.group([0, 0.6, 0]);
  k.mesh(new THREE.LatheGeometry([new THREE.Vector2(0.2, 0), new THREE.Vector2(0.42, 0), new THREE.Vector2(0.42, 0.04), new THREE.Vector2(0.2, 0.04), new THREE.Vector2(0.2, 0)], 32), 'trim', 0, 0, 0, clampRing);
  const clampBolts = k.circle('Clamp ring bolt', [0, 0.64, 0], [0, 1, 0], 0.34, 6, [gearBolt]);
  k.cover(clampRing, clampBolts, [0, 1, 0], 0.03);
  k.rod([0, 0.15, 0], [0, 0.9, 0], 0.05, 'copper');
  k.mount('gear', k.ax('gear', [0, 0.76, 0], 'y'), () => [gearBolt]);
  k.mount('bearing', k.ax('bearing', [0, 0.45, 0], 'y'), () => clampBolts);

  // side gearbox on -x: bearing and two idler gears on parallel shafts, closed by a screwed plate
  k.box(0.04, 0.65, 1.2, -0.52, 0.25, 0, 'trim');
  k.box(0.46, 0.04, 1.2, -0.75, 0.25, 0, 'trim');
  k.box(0.46, 0.04, 1.2, -0.75, 0.86, 0, 'trim');
  for (const z of [-0.6, 0.6]) k.box(0.46, 0.65, 0.04, -0.75, 0.25, z, 'body');
  const gbCover = k.group([-0.98, 0.575, 0]);
  k.mesh(new THREE.BoxGeometry(0.04, 0.65, 1.2), 'body', 0, 0, 0, gbCover);
  k.cover(gbCover, k.rect('Gearbox screw', [-1.0, 0.575, 0], [-1, 0, 0], 1.0, 0.5, 3), [-1, 0.2, 0], 0.33);
  const slots: [number, 'bearing' | 'gear'][] = [[-0.38, 'bearing'], [0, 'gear'], [0.38, 'gear']];
  for (const [z, part] of slots) {
    k.rod([-0.52, 0.575, z], [-0.95, 0.575, z], 0.03, 'copper');
    k.mount(part, k.ax(part, [-0.76 - (part === 'gear' && z > 0 ? 0.12 : 0), 0.575, z], 'x'), () => [k.clip(part === 'gear' ? 'Gear clip' : 'Bearing clip', [-0.9, 0.575, z], [-1, 0, 0], 2)]);
  }

  // servo motor on +x: shelf, adapter plate with four bolts, shaft into the housing; cables run to the driver bay
  k.box(0.6, 0.06, 0.52, 0.95, 0.24, 0, 'trim');
  k.box(0.06, 0.74, 0.74, 0.58, 0.18, 0, 'body');
  k.rod([0.75, 0.55, 0], [0.4, 0.55, 0], 0.045, 'copper');
  const power = k.wire('Motor power cable', [[0.95, 0.82, 0.15], [0.8, 0.95, 0.5], [0.45, 0.98, 0.9], [0.3, 0.98, 1.1], [0.1, 0.96, 1.45]], 'red', [], 0.05);
  const encoder = k.wire('Encoder cable', [[1.1, 0.7, 0.2], [0.9, 0.85, 0.6], [0.5, 0.9, 1.0], [0.3, 0.92, 1.4], [0.1, 0.92, 1.55]], 'blue', [], 0.025);
  const plate = k.circle('Motor flange bolt', [0.62, 0.55, 0], [1, 0, 0], 0.38, 4, [power, encoder], 'bolt', Math.PI / 4);
  k.mount('motor', [[0.95, 0.3, 0], [0, 0, 0]], () => [power, encoder, ...plate]);

  // the link, and the driver bay on top of it
  k.cyl(0.24, 1.85, 0, 0.55, 1.375, 'body', 'z');
  k.cyl(0.32, 0.06, 0, 0.55, 2.3, 'trim', 'z');
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.stud(Math.cos(a) * 0.25, 0.55 + Math.sin(a) * 0.25, 2.34, 0.04);
  }
  k.box(0.8, 0.04, 1.5, 0, 0.78, 1.45, 'trim');
  k.bay(0, 1.45, 0.8, 1.5, 0.82, 0.36, { mids: true });
  k.box(0.7, 0.03, 1.3, 0, 0.82, 1.45, 'pcb');
  const dy = 0.85;
  k.box(0.26, 0.05, 0.26, 0, dy, 1.05, 'chip');
  k.mount('heatsink', [[0, dy + 0.05, 1.05], [0, 0, 0]], () => [k.clip('Spring clip', [-0.3, dy + 0.4, 1.05], [0, 1, 0]), k.clip('Spring clip', [0.3, dy + 0.4, 1.05], [0, 1, 0])]);
  const standoffs = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => k.screw('Board standoff', [sx * 0.31, dy, 1.55 + sz * 0.27])));
  k.mount('compute', [[0, dy, 1.55], [0, 0, 0]], () => [...standoffs, encoder]);
  // brake relay in the bay, brake solenoid on the base, joined by one long cable
  k.box(0.8, 0.04, 0.5, -0.65, 0.12, 1.0, 'trim');
  const relayT = k.take('relay'), coilT = k.take('coil');
  const brakeFeed = relayT || coilT ? k.wire('Brake feed', [[-0.2, 1.1, 1.95], [-0.5, 0.9, 1.85], [-0.7, 0.7, 1.4], [-0.65, 0.6, 1.0]], 'yellow', [], 0.03) : null;
  if (relayT && brakeFeed) {
    const coilWire = k.wire('Brake coil wire', [[0.1, 1.1, 1.9], [0.0, 1.05, 1.75], [0.0, 1.0, 1.6]], 'brown', [], 0.025);
    k.part('relay', relayT, [0, dy, 1.98], [k.clip('Rail clip', [0, dy + 0.3, 2.13], [0, 1, 0]), brakeFeed, coilWire]);
  }
  if (coilT && brakeFeed) k.part('coil', coilT, [-0.65, 0.16, 1.0], [brakeFeed, ...[-0.95, -0.35].map((x) => k.bolt('Solenoid bolt', [x, 0.18, 1.0], [0, 1, 0], [brakeFeed], 2))]);
  if (g >= 2) k.lamps(4, -0.3, 0.82, 0.72, 0.2);
}

// ---- control cabinet ---------------------------------------------------------------------------------------

/** A small control cabinet, lying with its door up. Mains come in through a gland on the -z wall to a terminal
 *  block (earth to a stud), live and neutral go to the transformer's primary, its secondary feeds the first
 *  contactor on the DIN rail, the contactors switch the controller board. The door has screws, a pry tab
 *  and a latch on the back wall; the transformer is bolted through the back plate. */
function controlCabinet(k: Kit) {
  const g = k.grade;
  k.box(1.6, 0.05, 1.5, 0, 0, 0, 'trim'); // back plate
  k.box(1.4, 0.02, 1.3, 0, 0.05, 0, 'dark'); // mounting plate
  for (const z of [-0.6, 0.6]) k.cyl(0.04, 0.3, -0.83, 0.25, z, 'trim', 'y'); // hinge knuckles
  k.bay(0, 0, 1.6, 1.5, 0.05, 0.6, { mids: true, latch: true, pry: true });
  const Y = 0.07;
  // cable gland and the cable going off
  k.cyl(0.07, 0.12, -0.55, 0.3, -0.75, 'trim', 'z');
  k.cable([[-0.55, 0.3, -0.82], [-0.55, 0.12, -1.3], [-0.2, 0.1, -1.8]], 0.045);
  // terminal block, DIN rail
  for (const x of [-0.75, -0.62, -0.49]) k.box(0.1, 0.12, 0.12, x, Y, -0.5, 'yellow');
  k.box(0.04, 0.03, 1.2, 0, Y, -0.05, 'chip');
  const pe = k.wire('Earth wire', [[-0.6, 0.3, -0.68], [-0.7, 0.14, -0.55], [-0.78, 0.1, -0.3]], 'green');
  const peScrew = k.screw('Earth stud nut', [-0.78, Y + 0.02, -0.28]);
  const mainsL = k.wire('Mains live', [[-0.58, 0.3, -0.68], [-0.62, 0.38, -0.3], [-0.58, 0.34, 0.0]], 'brown');
  const mainsN = k.wire('Mains neutral', [[-0.52, 0.3, -0.68], [-0.45, 0.4, -0.3], [-0.44, 0.34, 0.0]], 'blue');
  const secondary = k.wire('Transformer secondary', [[-0.45, 0.34, 0.22], [-0.25, 0.4, 0.1], [-0.08, 0.33, -0.5]], 'red', [], 0.03);
  // transformer on the left, bolted through the back plate
  k.mount('coil', [[-0.5, Y, 0.1], [0, 0, 0]], () => [pe, peScrew, mainsL, mainsN, secondary,
    ...[-0.8, -0.2].map((x) => k.bolt('Transformer bolt', [x, 0, 0.1], [0, -1, 0], [mainsL, mainsN, secondary], 2))]);
  // two contactors on the rail: the first fed by the transformer, the second driven from the board
  const relay1 = k.take('relay');
  const out1 = k.wire('Contactor 1 out', [[0.08, 0.33, -0.5], [0.3, 0.4, -0.45], [0.42, 0.14, -0.45]], 'red', [], 0.03);
  if (relay1) k.part('relay', relay1, [0.0, Y, -0.4], [k.clip('Rail clip', [0.0, Y + 0.02, -0.2], [0, 1, 0]), secondary, out1]);
  const relay2 = k.take('relay');
  const extra: Step[] = [];
  if (relay2) {
    const coil2 = k.wire('Contactor 2 coil', [[0.08, 0.33, 0.1], [0.3, 0.4, 0.0], [0.45, 0.14, -0.1]], 'brown', [], 0.025);
    const out2 = k.wire('Contactor 2 out', [[-0.08, 0.33, 0.3], [0.2, 0.42, 0.1], [0.4, 0.14, -0.05]], 'red', [], 0.03);
    extra.push(coil2, out2);
    k.part('relay', relay2, [0.0, Y, 0.2], [k.clip('Rail clip', [0.0, Y + 0.02, 0.4], [0, 1, 0]), coil2, out2]);
  }
  // controller board and the heatsink on its regulator
  k.box(0.62, 0.04, 0.5, 0.5, Y, -0.25, 'pcb');
  const standoffs = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => k.screw('Board standoff', [0.5 + sx * 0.3, Y + 0.04, -0.25 + sz * 0.22])));
  k.mount('compute', [[0.5, Y + 0.04, -0.25], [0, 0, 0]], () => [...standoffs, out1, ...extra]);
  k.box(0.4, 0.04, 0.4, 0.5, Y, 0.42, 'pcb');
  k.box(0.26, 0.05, 0.26, 0.5, Y + 0.04, 0.42, 'chip');
  k.mount('heatsink', [[0.5, Y + 0.09, 0.42], [0, 0, 0]], () => [k.clip('Spring clip', [0.22, Y + 0.45, 0.42], [0, 1, 0]), k.clip('Spring clip', [0.78, Y + 0.45, 0.42], [0, 1, 0])]);
  if (g >= 2) k.lamps(5, -0.4, 0.65, 0.5, 0.2);
}

const BUILDERS: Record<ComponentKind, (k: Kit) => void> = {
  pump_housing: pumpHousing,
  jet_engine: jetEngine,
  robot_arm: robotArm,
  control_cabinet: controlCabinet,
};
const SCALE: Record<ComponentKind, number> = { pump_housing: 0.7, jet_engine: 0.7, robot_arm: 0.8, control_cabinet: 0.85 };
export const JUNK_KINDS = Object.keys(BUILDERS) as ComponentKind[];

// ---- assembly ----------------------------------------------------------------------------------------------

function pickTier(weights: Record<Tier, number>, rand: () => number): Tier {
  let sum = 0;
  for (const t of TIERS) sum += weights[t];
  let r = rand() * sum;
  for (const t of TIERS) if ((r -= weights[t]) < 0) return t;
  return 'scrap';
}

/** Roll what is inside a component of `kind` with `rand`, then build it. Part models load in the background. */
export function buildJunk(kind: ComponentKind, rand: () => number): Junk {
  const spec = COMPONENTS[kind];
  const rolled: Record<PartId, Tier[]> = { battery: [], motor: [], heatsink: [], compute: [], antimatter: [], coil: [], impeller: [], bearing: [], gear: [], valve: [], relay: [] };
  let best = 0;
  for (const y of spec.yields) {
    const n = y.min + Math.floor(rand() * (y.max - y.min + 1));
    for (let i = 0; i < n; i++) {
      const t = pickTier(spec.tierWeights, rand);
      rolled[y.part].push(t);
      best = Math.max(best, TIERS.indexOf(t));
    }
  }

  const kit = new Kit(best, rolled);
  BUILDERS[kind](kit);
  const root = new THREE.Group();
  const scale = SCALE[kind];
  const box = new THREE.Box3().setFromObject(kit.g);
  const centre = box.getCenter(new THREE.Vector3());
  kit.g.scale.setScalar(scale);
  kit.g.position.copy(centre).multiplyScalar(-scale);
  root.add(kit.g);

  const junk: Junk = { kind, label: spec.label, tier: TIERS[best], root, scale, steps: kit.steps, pieces: kit.pieces, slots: kit.slots };
  root.userData.target = { type: 'junk', junk } satisfies Target;
  return junk;
}
