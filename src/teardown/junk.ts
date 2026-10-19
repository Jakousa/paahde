// Crash-site components for the disassembly mode: a pump housing, a jet engine with its electrical box, a robot
// arm joint, a control cabinet, and the scrap fields' small starter machines (a winch, a coolant valve, a beacon). Each is a small machine laid out the way the real thing is, and everything that holds a part
// in is a step you can do: screws (several clicks), bolts (circle the pointer), clips, wires (shake them loose at both ends) and
// pry tabs. Fasteners follow the engineering: bolt circles on round flanges, corner screws on box lids, a row
// along a split line, set screws on a coupling hub, supply wires from a cable gland to a terminal block through
// a contactor. Steps sit on different faces, so the machine has to be turned over and around. Kept short: a
// cover has two screws, a flange two to four bolts, a starter machine takes a few moves. Changing a machine's
// steps means bumping TEARDOWN_LAYOUT (shared/crash.ts), or saved progress points at the wrong hardware.
// The real item models (public/models/items/<part>_<tier>.glb, tools/blender/items.py) are mounted inside.
// Better parts come out of fancier machines.
import * as THREE from 'three/webgpu';
import { abs, dot, positionLocal, smoothstep, uniform, vec3 } from 'three/tsl';
import { Rope } from './rope.ts';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { machineParts } from '../../shared/machine.ts';
import { layoutOf } from '../../shared/machines.ts';
import { buildModelJunk } from './glbMachine.ts';
import { junkSpec, RARITY, TIERS, type JunkKind, type PartId, type Tier } from '../../shared/salvage.ts';
import { aiControl, vehicleFrame, warpCore, waterJet } from './wrecks.ts';
import { TEXT } from '../../shared/text.ts';

/** Step labels (shared/text.ts). */
const S = TEXT.steps;

/** A material that can take a momentary sheen (the workable look, src/teardown): normally it looks as made. `sweep`: a band of
 *  light crossing the part (big parts); else the whole thing brightens and fades (small ones). `value` is set per frame:
 *  sweep position along the part (far off = none) or brightness 0..1. */
export function sheen(mat: THREE.MeshStandardNodeMaterial, sweep: boolean): { value: number } {
  const u = uniform(sweep ? -9 : 0);
  const tint = vec3(0.5, 0.82, 1.0);
  mat.emissiveNode = sweep
    ? tint.mul(smoothstep(0.3, 0.0, abs(dot(positionLocal, vec3(0.6, 0.3, 0.75)).sub(u))).mul(0.015))
    : tint.mul(u.mul(0.015));
  mat.userData.sheen = u;
  mat.userData.big = sweep;
  return u;
}

export type StepKind = 'screw' | 'bolt' | 'clip' | 'wire' | 'pry' | 'lift' | 'grind' | 'mash';
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
  /** Small indicator of what to do (makeMarker); shown when the step is ready. */
  marker: THREE.Group;
  /** An inner step: the piece (a module that has come off) it is on. */
  owner?: Piece;
  /** Seams: the line to follow with the grinder (the step's own frame), and how far along it the grinder has got (0..1 is `progress`). */
  seam?: { curve: THREE.CatmullRomCurve3; mids: THREE.Vector3[]; cut: boolean[]; marks: THREE.Mesh[] };
  /** Pulls: the thing that slides apart as it is held (a module of the machine), and how far (m) along `dir`. */
  slide?: { obj: THREE.Object3D; dir: THREE.Vector3; dist: number; offset: THREE.Vector3 };
  /** The step's own parts' materials: they take a faint enchanted shimmer while it can be worked (there with the big indicators
   *  off too). A pull or a prised shell adds its module's materials once the model has arrived. */
  shine: THREE.MeshStandardNodeMaterial[];
  /** Seams: a faint line along the seam that does the same. */
  glint?: THREE.Mesh;
  /** Height of `obj`'s origin above the ground once it has fallen (before the machine's scale). */
  floorY: number;
  mat?: THREE.MeshStandardNodeMaterial;
  /** Wires: the two ends, each shaken loose on its own (src/teardown/teardown.ts). */
  ends?: WireEnd[];
  /** Wires: the cable as a rope that moves when shaken and goes floppy once an end is off (src/teardown/rope.ts), and the
   *  two lugs on its ends. */
  rope?: Rope;
  lugs?: THREE.Mesh[];
}
/** A wire shorter than this (m) is one pull: a single shake rips the whole cable out. */
export const SHORT_WIRE = 0.55;

/** One end of a wire: its lug, how many swings of the shake it has had, and whether it has come loose. */
export interface WireEnd {
  /** The lug at that end (a short wire has one shake point, in its middle: an empty anchor there). */
  lug: THREE.Object3D;
  base: THREE.Vector3;
  swings: number;
  done: boolean;
}
/** Something that comes off by itself once every hold is done: a lid, bracket, guard, cover. */
export interface Piece {
  obj: THREE.Object3D;
  holds: Step[];
  released: boolean;
  floorY: number;
  /** Outward direction in the machine's frame; it pops that way. */
  pop: [number, number, number];
  /** Taken apart further once it has come off: it then lies on the ground by the machine and these are left to do. */
  inner?: PieceInner;
}
export interface PieceInner {
  steps: Step[];
  slots: Slot[];
  /** Where it lies (x, z in the machine's frame, on the ground), and whether it does yet. */
  rest: THREE.Vector2;
  resting: boolean;
  /** The model has arrived and `obj` is placed. */
  loaded: boolean;
  gone: boolean;
}
export interface Slot {
  part: PartId;
  tier: Tier;
  /** Which of the machine's parts this is (shared/machine.ts machineParts), the same on every client and the server. */
  index: number;
  ring: THREE.Mesh;
  /** The part model's materials, tinted with its rarity colour (emissiveIntensity pulses). */
  glow: THREE.MeshStandardMaterial[];
  taken: boolean;
  /** The part's own holder; free to take once its holds are done. */
  piece: Piece;
  /** Inside a module that comes off: that module's piece. */
  owner?: Piece;
}
export interface Junk {
  kind: JunkKind;
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
  /** Built from a model at its real size, in its resting pose (src/teardown/glbMachine.ts): never turned by hand or lifted to rest. */
  fixed?: boolean;
}
/** What a pointer hit resolves to; stored in `userData.target` on the object that owns the interaction. */
export type Target =
  | { type: 'junk'; junk: Junk }
  | { type: 'step'; step: Step }
  | { type: 'part'; slot: Slot };

/** One rolled part: its tier and its index in machineParts(). */
interface Roll {
  tier: Tier;
  index: number;
}

export const stepReady = (s: Step) => !s.done && s.after.every((a) => a.done);
export const slotOpen = (s: Slot) => !s.taken && s.piece.holds.every((h) => h.done);
/** Nothing left to do on a piece that came off: every inner step done and every inner part taken. */
export const pieceEmpty = (p: Piece) => !p.inner || (p.inner.steps.every((s) => s.done) && p.inner.slots.every((s) => s.taken));

/** Put a piece that has come off down where it lies by the machine (a saved game, or the end of a visit): it stays to be taken apart. */
export function restPiece(p: Piece) {
  const n = p.inner;
  if (!n) return;
  n.resting = true;
  if (n.loaded) p.obj.position.set(n.rest.x, p.floorY, n.rest.y);
}

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
/** Emissive strength of a part still inside the machine (a free one pulses above it, teardown.ts). */
export const PART_GLOW = 0.35;
/** Parts drawn smaller than PART_SIZE across. */
const SIZE: Partial<Record<PartId, number>> = { relay: 0.3 };
/** Height along the axis (model +y) of the parts that sit on a shaft, once scaled: where their centre is. */
const THICKNESS: Partial<Record<PartId, number>> = { bearing: 0.144, gear: 0.152, impeller: 0.175, valve: 0.5 };
const loader = new GLTFLoader();
const partCache = new Map<string, Promise<THREE.Object3D>>();

/** A part model scaled to PART_SIZE with its base centre at the origin; one clone per call. */
export async function loadPart(part: PartId, tier: Tier): Promise<THREE.Object3D> {
  const key = `${part}_${tier}`;
  let p = partCache.get(key);
  if (!p) {
    p = loader.loadAsync(`./models/items/${key}.glb`).then((gltf) => {
      const inner = gltf.scene;
      const box = new THREE.Box3().setFromObject(inner);
      const size = box.getSize(new THREE.Vector3());
      const c = box.getCenter(new THREE.Vector3());
      const s = (SIZE[part] ?? PART_SIZE) / Math.max(size.x, size.y, size.z, 1e-3);
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
export type V = [number, number, number];
const PALETTE = [
  { body: 0x7a5238, trim: 0x3b2616, accent: 0xa04a20, glow: 0x000000, metal: 0.55, rough: 0.9 }, // rusted
  { body: 0x56705e, trim: 0x2b3a30, accent: 0xe0c060, glow: 0x000000, metal: 0.5, rough: 0.7 }, // painted
  { body: 0x30415a, trim: 0xd2d5da, accent: 0xff8a2a, glow: 0xff9a3c, metal: 0.8, rough: 0.35 }, // steel + chrome
  { body: 0xe9e7e1, trim: 0x2c3038, accent: 0x3ff0ff, glow: 0x3ff0ff, metal: 0.6, rough: 0.25 }, // space
];
const UP = new THREE.Vector3(0, 1, 0);
const HIT_MAT = new THREE.MeshBasicMaterial();
const MARKER_MAT = new THREE.MeshBasicNodeMaterial({ color: 0xffb050 });
const MARKER_HOT_MAT = new THREE.MeshBasicNodeMaterial({ color: 0xffffff });
/** A wire's markers sit on the wire's own lugs, so they are drawn over whatever is in front of them. */
const MARKER_TOP_MAT = new THREE.MeshBasicNodeMaterial({ color: 0xffb050, depthTest: false });
const MARKER_TOP_HOT_MAT = new THREE.MeshBasicNodeMaterial({ color: 0xffffff, depthTest: false });

// ---- step markers ------------------------------------------------------------------------------------------
// Small, and each kind of action reads differently: beads for clicks (one per click left, they tap), a turning
// arc with an arrowhead for bolts, a ring jerking left and right between two arrowheads at each end of a wire (the shake), an arrow pulling away for pry tabs,
// arrows rising for lifts (one per player needed).

const BEAD_GEO = new THREE.SphereGeometry(0.03, 8, 6);
const ARC_GEO = new THREE.TorusGeometry(0.13, 0.014, 6, 24, Math.PI * 1.5);
const HEAD_GEO = new THREE.ConeGeometry(0.045, 0.1, 8).rotateZ(-Math.PI / 2).translate(0, -0.13, 0);
const SHAFT_GEO = new THREE.BoxGeometry(0.2, 0.014, 0.014);
const HEAD_X_GEO = new THREE.ConeGeometry(0.04, 0.08, 8);
const GRIP_RING_GEO = new THREE.TorusGeometry(0.055, 0.01, 6, 20);
const GRIP_DOT_GEO = new THREE.SphereGeometry(0.018, 8, 6);
const PRY_SHAFT_GEO = new THREE.BoxGeometry(0.014, 0.014, 0.14);
const UP_SHAFT_GEO = new THREE.BoxGeometry(0.014, 0.1, 0.014).translate(0, 0.05, 0);

function markerMesh(parent: THREE.Object3D, geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, mat: THREE.Material = MARKER_MAT) {
  const m = new THREE.Mesh(geo, mat);
  if (mat === MARKER_TOP_MAT) m.renderOrder = 10;
  m.position.set(x, y, z);
  m.raycast = () => {};
  m.userData.ignoreBounds = true;
  parent.add(m);
  return m;
}

/** The marker for one step, in the step's frame (+y is the face normal). `userData.pips` are the click beads. */
function makeMarker(kind: StepKind, need: number, players: number): THREE.Group {
  const g = new THREE.Group();
  g.userData.ignoreBounds = true;
  if (kind === 'screw' || kind === 'clip') {
    const pips: THREE.Mesh[] = [];
    for (let i = 0; i < need; i++) {
      const a = (i / need) * Math.PI * 2;
      pips.push(markerMesh(g, BEAD_GEO, need > 1 ? Math.cos(a) * 0.1 : 0, 0, need > 1 ? Math.sin(a) * 0.1 : 0));
    }
    g.userData.pips = pips;
  } else if (kind === 'bolt') {
    const turn = new THREE.Group();
    turn.rotation.x = Math.PI / 2;
    markerMesh(turn, ARC_GEO);
    markerMesh(turn, HEAD_GEO);
    g.add(turn);
    g.userData.turn = turn;
  } else if (kind === 'wire') {
    // A wire is shaken loose at both ends: on each lug, a ring that jerks left and right between two arrowheads, turned to
    // face the camera. (They sit on the lugs, set by Kit.wire.)
    const ends: THREE.Group[] = [];
    for (let i = 0; i < 2; i++) {
      const eg = new THREE.Group();
      markerMesh(eg, SHAFT_GEO, 0, 0, 0, MARKER_TOP_MAT).scale.x = 1.1;
      markerMesh(eg, HEAD_X_GEO, 0.125, 0, 0, MARKER_TOP_MAT).scale.setScalar(0.7);
      markerMesh(eg, HEAD_X_GEO, -0.125, 0, 0, MARKER_TOP_MAT).scale.setScalar(0.7);
      const ring = new THREE.Group();
      markerMesh(ring, GRIP_RING_GEO, 0, 0, 0, MARKER_TOP_MAT);
      markerMesh(ring, GRIP_DOT_GEO, 0, 0, 0, MARKER_TOP_MAT);
      eg.add(ring);
      eg.userData.ring = ring;
      g.add(eg);
      ends.push(eg);
    }
    g.userData.ends = ends;
    g.userData.top = true;
  } else if (kind === 'pry' || kind === 'mash') {
    const pull = new THREE.Group();
    markerMesh(pull, PRY_SHAFT_GEO, 0, 0, 0.07);
    markerMesh(pull, HEAD_X_GEO, 0, 0, 0.17).rotation.x = Math.PI / 2;
    g.add(pull);
    g.userData.pull = pull;
  } else {
    const up = new THREE.Group();
    for (let i = 0; i < players; i++) {
      const x = (i - (players - 1) / 2) * 0.12;
      markerMesh(up, UP_SHAFT_GEO, x, 0, 0);
      markerMesh(up, HEAD_X_GEO, x, 0.14, 0);
    }
    g.add(up);
    g.userData.up = up;
  }
  return g;
}

const _wp = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();
const _cq = new THREE.Quaternion();

/** Per frame: pulse and move the marker of `step` (time `t`), white when `lit`; `cam` is needed to turn the wire's
 *  arrow across the wire as it is seen. */
export function animateMarker(step: Step, t: number, lit: boolean, cam: THREE.Camera) {
  const m = step.marker;
  const u = m.userData;
  if (u.lit !== lit) {
    u.lit = lit;
    const hot = u.top ? MARKER_TOP_HOT_MAT : MARKER_HOT_MAT, cold = u.top ? MARKER_TOP_MAT : MARKER_MAT;
    m.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = lit ? hot : cold; });
  }
  if (step.kind === 'grind' || step.kind === 'mash') {
    // the line to follow, or the part's edge, glows; it is drawn in the step's own frame, so it is not scaled
    m.scale.setScalar(1);
    return;
  }
  m.scale.setScalar(lit ? 1.25 : 1 + 0.08 * Math.sin(t * 6));
  const tap = Math.pow(Math.max(0, Math.sin(t * 7)), 4);
  if (u.pips) {
    const left = Math.max(0, step.need - Math.floor(step.progress));
    (u.pips as THREE.Mesh[]).forEach((p, i) => {
      p.visible = i < left;
      p.scale.setScalar(1 + 0.7 * Math.pow(Math.max(0, Math.sin(t * 7 - i * 0.9)), 4));
    });
  } else if (u.turn) u.turn.rotation.z = t * 3.2;
  else if (u.pull) u.pull.position.z = tap * 0.1;
  else if (u.up) u.up.position.y = tap * 0.08;
  else if (u.ends) {
    // Each end of the wire that is still holding: the marker faces the camera, so the shake reads left-right on screen.
    m.getWorldQuaternion(_wq).invert().multiply(cam.getWorldQuaternion(_cq));
    (u.ends as THREE.Group[]).forEach((eg, i) => {
      const end = step.ends![i]; // a short wire has just the one
      eg.visible = !!end && !end.done;
      eg.quaternion.copy(_wq);
      eg.scale.setScalar(lit ? 1.1 : 1);
      (eg.userData.ring as THREE.Group).position.x = Math.sin(t * 11) * 0.03;
    });
    m.scale.setScalar(1); // the markers are placed on the lugs: scaling the group would move them off
  }
}

interface BayOpts {
  /** Pry tab on the front edge (+z). */
  pry?: boolean;
  /** Snap latch on the rear wall (-z): only reachable from behind. */
  latch?: boolean;
  /** Lid screws: 2 at opposite corners (the default), 4 at every corner, or 0 (held by the latch / pry tab alone). */
  screws?: 0 | 2 | 4;
}

/** Builds one machine: geometry, steps, covers and part mounts. The salvage wrecks' builders are in wrecks.ts. */
export class Kit {
  g = new THREE.Group();
  grade: number;
  steps: Step[] = [];
  pieces: Piece[] = [];
  slots: Slot[] = [];
  private mats: Record<MatKey, THREE.MeshStandardNodeMaterial>;
  private dmats: Partial<Record<MatKey, THREE.MeshStandardNodeMaterial>> = {};
  private queue: Record<PartId, Roll[]>;
  /** Size of the fasteners and wire terminals (1 for the machines built in code, smaller on a full-size model). */
  fs = 1;

  constructor(grade: number, rolled: Record<PartId, Roll[]>) {
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

  /** Next rolled `part`, or null when the machine holds no more of them (the mount stays empty). */
  take(part: PartId): Roll | null {
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
    after: Step[], floorY: number, mat?: THREE.MeshStandardNodeMaterial, players = 1): Step {
    // what the step is made of takes the shimmer: its own copies of the materials
    const shine: THREE.MeshStandardNodeMaterial[] = [];
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      const mt = m.isMesh ? (m.material as THREE.MeshStandardNodeMaterial) : null;
      if (!mt || !mt.emissive) return;
      if (mt === mat) return; // (a wire's own cable shows its shaking in its glow)
      m.material = mt.clone();
      sheen(m.material as THREE.MeshStandardNodeMaterial, false);
      shine.push(m.material as THREE.MeshStandardNodeMaterial);
    });
    const hit = new THREE.Mesh(hitGeo, HIT_MAT);
    hit.visible = false; // never drawn, but still hit by the pointer ray
    hit.position.y = 0.05;
    g.add(hit);
    const marker = makeMarker(kind, need, players);
    marker.position.y = kind === 'lift' ? 0.2 : 0.1;
    marker.visible = false;
    g.add(marker);
    const step: Step = { kind, label, need, players, progress: 0, done: false, after, obj: g, spin, hit, marker, shine, floorY: floorY * this.fs, mat };
    hit.userData.target = { type: 'step', step } satisfies Target;
    this.g.add(g);
    this.steps.push(step);
    return step;
  }
  private stepGroup(pos: V, nrm: V) {
    const g = new THREE.Group();
    g.position.set(...pos);
    g.quaternion.setFromUnitVectors(UP, new THREE.Vector3(...nrm).normalize());
    g.scale.setScalar(this.fs);
    const spin = new THREE.Group();
    g.add(spin);
    return { g, spin };
  }

  /** Small screw: several clicks to back it out. */
  screw(label: string, pos: V, nrm: V = [0, 1, 0], after: Step[] = [], need = 2 + (this.grade >= 2 ? 1 : 0)): Step {
    const { g, spin } = this.stepGroup(pos, nrm);
    this.mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 12), 'trim', 0, 0.02, 0, spin);
    this.mesh(new THREE.BoxGeometry(0.1, 0.02, 0.018), 'dark', 0, 0.04, 0, spin);
    this.mesh(new THREE.BoxGeometry(0.018, 0.02, 0.1), 'dark', 0, 0.04, 0, spin);
    return this.reg('screw', label, g, spin, new THREE.SphereGeometry(0.15, 8, 6), need, after, 0.02);
  }
  /** Big hex bolt or nut: turn the pointer around it. `need` is half turns. */
  bolt(label: string, pos: V, nrm: V = [0, 1, 0], after: Step[] = [], need = 3): Step {
    const { g, spin } = this.stepGroup(pos, nrm);
    this.mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.09, 6), 'trim', 0, 0.045, 0, spin);
    this.mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.018, 16), 'dark', 0, 0.009, 0, g);
    return this.reg('bolt', label, g, spin, new THREE.SphereGeometry(0.2, 8, 6), need, after, 0.05);
  }
  /** Snap latch or spring clip. */
  clip(label: string, pos: V, nrm: V = [0, 1, 0], clicks = 1, after: Step[] = []): Step {
    const { g, spin } = this.stepGroup(pos, nrm);
    this.mesh(new THREE.BoxGeometry(0.22, 0.03, 0.12), 'dark', 0, 0.015, 0, g);
    spin.position.set(-0.1, 0.03, 0);
    this.mesh(new THREE.BoxGeometry(0.2, 0.05, 0.09), this.grade >= 1 ? 'accent' : 'trim', 0.1, 0.025, 0, spin);
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
    return this.reg('lift', label, g, spin, new THREE.SphereGeometry(0.22, 8, 6), seconds, after, 0.1, undefined, players);
  }
  /** A tab to mash: press the use button on it again and again (the progress drains away between presses). */
  mash(label: string, outline: V[], after: Step[], presses: number, part: THREE.Object3D, slide: { dir: THREE.Vector3; dist: number }): Step {
    // No tab: the part itself is what is aimed at (`part`, a module's group), and its edge glows along `outline`. It lifts
    // away a little with every press.
    const p0 = new THREE.Vector3(...outline[0]);
    const g = new THREE.Group();
    g.position.copy(p0);
    const spin = new THREE.Group();
    g.add(spin);
    const curve = new THREE.CatmullRomCurve3(outline.map((p) => new THREE.Vector3(...p).sub(p0)), true);
    const step = this.reg('mash', label, g, spin, new THREE.SphereGeometry(0.05, 6, 4), presses, after, 0.02);
    step.hit.position.y = 0;
    step.marker.removeFromParent();
    const line = new THREE.Group();
    line.userData.ignoreBounds = true;
    markerMesh(line, new THREE.TubeGeometry(curve, 96, 0.012, 5, true));
    line.visible = false;
    g.add(line);
    step.marker = line;
    step.slide = { obj: part, dir: slide.dir, dist: slide.dist, offset: new THREE.Vector3() };
    part.userData.target = { type: 'step', step } satisfies Target;
    return step;
  }
  /** A seam to grind open: follow the line `pts` (the machine's frame) with the grinder. A spark runs along as it is cut. */
  grind(label: string, pts: V[], after: Step[]): Step {
    const p0 = new THREE.Vector3(...pts[0]);
    const g = new THREE.Group();
    g.position.copy(p0);
    const spin = new THREE.Group();
    g.add(spin);
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p).sub(p0)));
    const step = this.reg('grind', label, g, spin, new THREE.TubeGeometry(curve, 24, 0.1, 5), 1, after, 0.02);
    step.hit.position.y = 0;
    step.marker.removeFromParent();
    const line = new THREE.Group();
    line.userData.ignoreBounds = true;
    markerMesh(line, new THREE.TubeGeometry(curve, 32, 0.012, 5));
    line.visible = false;
    g.add(line);
    step.marker = line;
    // The seam is cut where the grinder has touched it, in any order: a mark for each stretch that has been.
    const n = Math.max(10, Math.round(curve.getLength() / 0.07));
    const mids: THREE.Vector3[] = [], marks: THREE.Mesh[] = [];
    const burnt = new THREE.MeshBasicNodeMaterial({ color: 0x1a0d06 });
    for (let i = 0; i < n; i++) {
      const a = curve.getPoint(i / n), b = curve.getPoint((i + 1) / n);
      const len = a.distanceTo(b);
      const mark = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, len * 1.15, 6), burnt);
      mark.position.copy(a).add(b).multiplyScalar(0.5);
      mark.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
      mark.visible = false;
      mark.raycast = () => {};
      mark.userData.ignoreBounds = true;
      g.add(mark);
      marks.push(mark);
      mids.push(a.clone().add(b).multiplyScalar(0.5));
    }
    step.seam = { curve, mids, cut: new Array<boolean>(n).fill(false), marks };
    const glint = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.009, 5), new THREE.MeshBasicNodeMaterial({ color: 0x8fdcff, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }));
    glint.visible = false;
    glint.raycast = () => {};
    glint.userData.ignoreBounds = true;
    g.add(glint);
    step.glint = glint;
    return step;
  }
  /** A part that pulls apart: no eye or ring, just the indicator on the part itself, and while it is held `slide.obj`
   *  parts from the machine along `dir`. `pos` is a point on its surface. */
  pull(label: string, pos: V, nrm: V, after: Step[], seconds: number, slide: { obj: THREE.Object3D; dir: THREE.Vector3; dist: number }): Step {
    const { g, spin } = this.stepGroup(pos, nrm);
    const step = this.reg('lift', label, g, spin, new THREE.SphereGeometry(0.35 / this.fs, 8, 6), seconds, after, 0.1, undefined, 1);
    step.slide = { ...slide, offset: new THREE.Vector3() };
    return step;
  }
  /** Wire from the first point to the last, a ring lug at each end: shake each end loose. */
  wire(label: string, pts: V[], key: MatKey = 'red', after: Step[] = [], r = 0.035): Step {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
    const mid = curve.getPoint(0.5);
    const short = curve.getLength() < SHORT_WIRE;
    const rel = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p).sub(mid)));
    const g = new THREE.Group();
    g.position.copy(mid);
    const mat = this.mats[key].clone();
    const tube = new THREE.Mesh(new THREE.TubeGeometry(rel, 28, r, 6), mat);
    this.add(tube, g);
    const ends: WireEnd[] = [];
    const lugs: THREE.Mesh[] = [];
    for (const t of [0, 1]) {
      const f = this.fs;
      const lug = new THREE.Mesh(new THREE.CylinderGeometry(0.06 * f, 0.06 * f, 0.025 * f, 10), this.mats.copper);
      lug.position.copy(rel.getPoint(t));
      this.add(lug, g);
      lugs.push(lug);
      if (!short) ends.push({ lug, base: lug.position.clone(), swings: 0, done: false });
      // What it is fastened to: a terminal block with a stud up through the lug, and a nut on it.
      const at = lug.position;
      const block = new THREE.Mesh(new THREE.BoxGeometry(0.16 * f, 0.05 * f, 0.16 * f), this.mats.dark);
      block.position.set(at.x, at.y - 0.045 * f, at.z);
      const stud = new THREE.Mesh(new THREE.CylinderGeometry(0.018 * f, 0.018 * f, 0.1 * f, 8), this.mats.copper);
      stud.position.set(at.x, at.y - 0.005 * f, at.z);
      const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.034 * f, 0.034 * f, 0.022 * f, 6), this.mats.copper);
      nut.position.set(at.x, at.y + 0.024 * f, at.z);
      this.add(block, g);
      this.add(stud, g);
      this.add(nut, g);
    }
    if (short) {
      // one shake, in the middle, takes the whole cable
      const anchor = new THREE.Object3D();
      g.add(anchor);
      ends.push({ lug: anchor, base: anchor.position.clone(), swings: 0, done: false });
    }
    const spin = new THREE.Group();
    g.add(spin);
    const step = this.reg('wire', label, g, spin, new THREE.TubeGeometry(rel, 12, Math.max(0.1, r * 2), 5), 1, after, 0.03, mat, 1);
    step.ends = ends;
    step.lugs = lugs;
    step.rope = new Rope(rel, tube, step.hit, r);
    // The markers sit on the lugs themselves, wherever the wire runs.
    step.marker.position.set(0, 0, 0);
    (step.marker.userData.ends as THREE.Group[]).forEach((eg, i) => eg.position.copy((ends[i] ?? ends[0]).base));
    return step;
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
  /** Screws at two opposite corners of a rectangular cover. */
  rect(label: string, c: V, nrm: V, w: number, h: number, after: Step[] = []): Step[] {
    const [u, v] = this.basis(nrm);
    return [[-1, -1], [1, 1]].map(([a, b]) => this.screw(label, this.at(c, u, v, (a * w) / 2, (b * h) / 2), nrm, after));
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

  /** Walled box open at the top on level `deckY`, closed by a lid screwed down at two opposite corners (`screws`
   *  for all four or none). Optional pry tab at the front, snap latch on the back wall. Returns the lid. */
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
    const n = o.screws ?? 2;
    const spots: [number, number][] = n === 4 ? [[-bx, -bz], [bx, -bz], [-bx, bz], [bx, bz]] : n === 2 ? [[-bx, -bz], [bx, bz]] : [];
    const holds = spots.map(([x, z]) => this.screw(S.lidScrew, [cx + x, top + 0.08, cz + z]));
    if (o.latch) holds.push(this.clip(S.rearLatch, [cx, top - h / 2, cz - d / 2 - 0.01], [0, 0, -1], 1));
    if (o.pry) holds.push(this.pry(S.lidSeam, [cx, top + 0.04, cz + d / 2], [0, 0, 1], [...holds]));
    return this.cover(group, holds, [0, 1, 0.3], 0.04);
  }

  /** A part holder at `pos`, held by `holds`. Its model loads in the background. */
  part(part: PartId, roll: Roll, pos: V, holds: Step[], rot: V = [0, 0, 0]): Slot {
    const { tier, index } = roll;
    const holder = new THREE.Group();
    holder.position.set(...pos);
    holder.rotation.set(...rot);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.27, 0.014, 6, 36).rotateX(Math.PI / 2),
      new THREE.MeshBasicNodeMaterial({ color: RARITY[tier].color }),
    );
    ring.position.y = 0.02;
    ring.visible = false;
    ring.raycast = () => {}; // a marker, never a click target
    ring.userData.ignoreBounds = true;
    holder.add(ring);
    const slot: Slot = { part, tier, index, ring, taken: false, glow: [], piece: { obj: holder, holds, released: false, floorY: 0, pop: [0, 1, 0] } };
    holder.userData.target = { type: 'part', slot } satisfies Target;
    this.g.add(holder);
    this.slots.push(slot);
    loadPart(part, tier).then(
      (m) => {
        m.traverse((o) => {
          o.castShadow = true;
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          // The part glows in its rarity colour (own material copies: the model is shared); teardown.ts pulses it.
          const own = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((x) => {
            const c = x.clone() as THREE.MeshStandardMaterial;
            if (c.emissive) {
              c.emissive.setHex(RARITY[tier].color);
              c.emissiveIntensity = PART_GLOW;
              slot.glow.push(c);
            }
            return c;
          });
          mesh.material = Array.isArray(mesh.material) ? own : own[0];
        });
        holder.add(m);
      },
      (e) => console.warn('teardown: part model failed', part, tier, e),
    );
    return slot;
  }
  /** Placement for a shaft-mounted part whose axis is `axis`, centred on `c` (its origin is at the base). */
  ax(part: PartId, c: V, axis: 'x' | 'y' | 'z'): [V, V] {
    const h = (THICKNESS[part] ?? 0.5) / 2;
    if (axis === 'x') return [[c[0] - h, c[1], c[2]], [0, 0, -Math.PI / 2]];
    if (axis === 'z') return [[c[0], c[1], c[2] - h], [Math.PI / 2, 0, 0]];
    return [[c[0], c[1] - h, c[2]], [0, 0, 0]];
  }
  /** If the machine holds another `part`: build its hardware (`holds`) and mount it. Null when the mount stays empty. */
  mount(part: PartId, place: [V, V], holds: (tier: Tier) => Step[]): Slot | null {
    const roll = this.take(part);
    if (!roll) return null;
    return this.part(part, roll, place[0], holds(roll.tier), place[1]);
  }
}

// ---- pump housing ------------------------------------------------------------------------------------------

/** End-suction centrifugal pump on a skid, motor-driven through a guarded coupling.
 *  Front (-x): suction cover held by a bolt circle (drain the casing first: the plug is underneath) over the
 *  impeller. Middle: bearing housing with a prised-on inspection lid over two bearings, a valve in the discharge.
 *  Back (+x): latched coupling guard, the motor hub's set screw, the motor on its pedestal, and its terminal box:
 *  supply through a gland, live via a contactor to the terminals, neutral. */
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
  const drain = k.bolt(S.drainPlug, [-0.75, SY - 0.2, 0.37], [0, 0, 1], [], 2);

  // suction cover: disc, suction nozzle, inlet flange
  const cov = k.group([-1.03, SY, 0]);
  k.mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.06, 32).rotateZ(Math.PI / 2), 'body', 0, 0, 0, cov);
  k.mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.4, 20).rotateZ(Math.PI / 2), 'body', -0.28, 0, 0, cov);
  k.mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 28).rotateZ(Math.PI / 2), 'trim', -0.5, 0, 0, cov);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.09, 6).rotateZ(Math.PI / 2), 'trim', -0.5, Math.cos(a) * 0.24, Math.sin(a) * 0.24, cov); // inlet flange studs
  }
  const coverBolts = k.circle(S.coverBolt, [-1.065, SY, 0], [-1, 0, 0], 0.36, 4, [drain], 'bolt', Math.PI / 4);
  k.cover(cov, coverBolts, [-1, 0.25, 0], 0.44);
  // impeller on the shaft, behind the cover, held by its nut
  k.mount('impeller', k.ax('impeller', [-0.78, SY, 0], 'x'), () => [k.bolt(S.impellerNut, [-0.96, SY, 0], [-1, 0, 0], [], 3)]);

  // discharge with the check valve between two flanges
  k.cyl(0.13, 0.12, -0.75, 1.0, 0, 'body');
  k.cyl(0.42, 0.04, -0.75, 1.06, 0, 'trim', 'y', 32);
  const valve = k.take('valve');
  if (valve) {
    const bolts = k.circle(S.valveFlangeBolt, [-0.75, 1.1, 0], [0, 1, 0], 0.34, 2, [], 'bolt', Math.PI / 4);
    k.part('valve', valve, [-0.75, 1.1, 0], bolts);
  } else k.cyl(0.12, 0.5, -0.75, 1.1, 0, 'body'); // plain spool piece
  k.cyl(0.12, 0.25, -0.75, 1.6, 0, 'body');
  k.cyl(0.28, 0.04, -0.75, 1.82, 0, 'trim', 'y', 24);

  // bearing housing: lid prised off its seam, over two bearings, each held by a retaining clip
  k.bay(0.275, 0, 0.95, 0.46, 0.15, 0.71, { screws: 0, pry: true });
  for (const x of [0.0, 0.5]) {
    k.mount('bearing', k.ax('bearing', [x, SY, 0], 'x'), () => [k.clip(S.bearingRetainer, [x, SY + 0.27, 0], [0, 1, 0], 2)]);
  }
  k.box(0.1, 0.1, 0.04, 0.275, 0.4, 0.25, g >= 1 ? 'accent' : 'dark'); // oil sight glass
  k.ring(0.06, 0.012, 0.275, 0.45, 0.28, 'copper', 'z');

  // coupling: two hubs with a spider between; the set screw on the motor hub holds the motor on
  k.cyl(0.1, 0.14, 0.9, SY, 0, 'trim', 'x');
  k.cyl(0.12, 0.12, 1.075, SY, 0, 'dark', 'x');
  k.cyl(0.1, 0.14, 1.25, SY, 0, 'trim', 'x');
  k.stud(0.9, SY + 0.1, 0, 0.04);
  const setMotor = k.screw(S.hubSetScrew, [1.25, SY + 0.1, 0]);
  const guard = k.group([1.075, SY, 0]);
  k.shell(0.22, 0.65, [0, 0, 0], 'x', 'upper', 'accent', guard);
  for (const z of [-0.25, 0.25]) k.box(0.65, 0.03, 0.08, 0, -0.01, z, 'accent', guard);
  k.cover(guard, [k.clip(S.guardLatch, [1.075, SY + 0.25, 0], [0, 1, 0])], [0, 1, 0], 0.2);

  // motor on a pedestal, its feet bolted down at the corners
  k.box(0.78, 0.22, 0.7, 1.9, 0.15, 0, 'trim');
  k.box(0.7, 0.05, 0.66, 1.9, 0.37, 0, 'body');
  // terminal box on top: gland on the +z wall, contactor on a rail, terminal block along the far wall
  k.bay(1.9, 0, 0.8, 0.5, 0.95, 0.36);
  k.box(0.7, 0.03, 0.38, 1.9, 0.95, 0, 'dark');
  k.cyl(0.06, 0.12, 1.7, 1.1, 0.3, 'trim', 'z');
  k.cable([[1.7, 1.1, 0.36], [1.7, 1.0, 0.65], [1.0, 0.18, 0.66], [-0.2, 0.18, 0.66]], 0.045);
  k.box(0.04, 0.03, 0.4, 2.1, 0.98, 0, 'trim'); // terminal block rail
  for (const z of [-0.15, 0, 0.15]) k.box(0.1, 0.1, 0.08, 2.1, 1.0, z, 'yellow');
  const G: V = [1.7, 1.1, 0.25];
  const relayTier = k.take('relay');
  const neutral = k.wire(S.neutral, [[1.72, 1.08, 0.25], [1.9, 1.04, 0.2], [2.06, 1.04, 0.0]], 'blue');
  k.cable([[1.76, 1.06, 0.25], [1.95, 1.02, 0.24], [2.1, 1.06, 0.15]], 0.035, 'green'); // earth
  const liveToMotor = k.wire(S.liveToMotor, [[1.88, 1.26, 0.1], [1.98, 1.22, -0.02], [2.1, 1.06, -0.15]], 'brown');
  if (relayTier) {
    const liveIn = k.wire(S.liveIn, [G, [1.69, 1.2, 0.18], [1.68, 1.26, 0.1]], 'brown');
    const din = k.clip(S.railClip, [1.78, 0.98, 0.21], [0, 1, 0]);
    k.part('relay', relayTier, [1.78, 0.98, 0], [din, liveIn, liveToMotor]);
  } else k.cable([[G[0], G[1], G[2]], [1.8, 1.2, 0.1], [1.88, 1.26, 0.1]], 0.035, 'brown'); // straight through
  const motorHolds = [setMotor, liveToMotor, neutral];
  const feet = [[-1, -1], [1, 1]].map(([sx, sz]) => k.bolt(S.motorFootBolt, [1.9 + sx * 0.31, 0.42, sz * 0.28], [0, 1, 0], motorHolds, 2));
  // the motor is too heavy for one person: two of you lift it off once the feet are free
  k.mount('motor', [[1.9, 0.42, 0], [0, 0, 0]], () => [...motorHolds, ...feet, k.lift(S.liftTheMotorOff, [2.17, 0.67, 0], [1, 0, 0], 2, feet)]);
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
  for (const z of [-1, 1]) split.push(...k.row(S.splitLineBolt, [-0.7, AY + 0.02, z * 0.47], [-0.1, AY + 0.02, z * 0.47], 2, [0, 1, 0]));
  // the upper casing is heavy: once the flange bolts are out, two of you lift it clear
  k.cover(top, [...split, k.lift(S.liftTheCasingOff, [-0.4, AY + 0.46, 0], [0, 1, 0], 2, split)], [0, 1, 0.1], 0.45);
  // bearings on pedestals under cap blocks, one screw each
  for (const x of [-0.75, -0.1]) {
    k.box(0.26, 0.16, 0.4, x, 0.55, 0, 'trim');
    const cap = k.group([x, AY + 0.27, 0]);
    k.mesh(new THREE.BoxGeometry(0.28, 0.06, 0.46), 'trim', 0, 0, 0, cap);
    const screws = [k.screw(S.bearingCapScrew, [x, AY + 0.3, 0.2])];
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
  const igniterLead = k.wire(S.igniterLead, [[0.4, 1.62, 0.05], [0.3, 1.45, 0.3], [0.2, 0.9, 0.7], [0.0, 0.34, 0.72]], 'black', [], 0.03);
  k.mount('coil', [[0.4, AY + 0.4 + 0.02, 0], [0, 0, 0]], () => [igniterLead, k.bolt(S.igniterBolt, [0.7, AY + 0.43, 0], [0, 1, 0], [igniterLead], 2)]);

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
  const valveLead = k.wire(S.solenoidLead, [[0.78, 0.45, 0.65], [0.4, 0.2, 0.75], [-0.4, 0.3, 0.72]], 'brown', [], 0.03);
  k.mount('valve', [[0.75, 0.14, 0.65], [0, 0, 0]], () => [valveLead, k.bolt(S.unionNut, [0.75, 0.68, 0.65], [0, 1, 0], [valveLead], 2)]);

  // accessory gearbox under the front: open towards +z, closed by a cover; starter flanged on the -z side
  const gb = [-0.45, 0.365, 0] as V;
  k.box(0.7, 0.04, 0.6, gb[0], 0.2, 0, 'trim');
  k.box(0.7, 0.04, 0.6, gb[0], 0.5, 0, 'trim');
  k.box(0.04, 0.3, 0.6, -0.8, 0.22, 0, 'trim');
  k.box(0.04, 0.3, 0.6, -0.1, 0.22, 0, 'trim');
  k.box(0.7, 0.3, 0.04, gb[0], 0.22, -0.3, 'body');
  const cover = k.group([gb[0], gb[1], 0.31]);
  k.mesh(new THREE.BoxGeometry(0.74, 0.34, 0.04), 'body', 0, 0, 0, cover);
  k.cover(cover, k.rect(S.gearboxScrew, [gb[0], gb[1], 0.33], [0, 0, 1], 0.62, 0.26), [0, 0.2, 1], 0.17);
  for (const x of [-0.6, -0.3]) {
    k.rod([x, gb[1], -0.28], [x, gb[1], 0.22], 0.03, 'copper');
    k.mount('gear', k.ax('gear', [x, gb[1], 0], 'z'), () => [k.clip(S.gearClip, [x, gb[1], 0.22], [0, 0, 1])]);
  }
  const sLead = k.wire(S.starterLead, [[-0.35, 0.58, -0.85], [-0.7, 0.16, -0.85], [-1.3, 0.16, -0.1], [-1.2, 0.16, 0.6], [-0.85, 0.3, 0.72]], 'red', [], 0.04);
  k.cable([[-0.25, 0.58, -0.85], [-0.65, 0.16, -0.8], [-1.35, 0.16, -0.1], [-1.25, 0.16, 0.6], [-0.75, 0.3, 0.72]], 0.04, 'black');
  k.cyl(0.34, 0.05, -0.3, gb[1], -0.33, 'trim', 'z');
  k.mount('motor', [[-0.3, 0.12, -0.65], [0, 0, 0]], () => [sLead, ...k.circle(S.starterFlangeBolt, [-0.3, gb[1], -0.36], [0, 0, -1], 0.27, 2, [sLead], 'bolt', Math.PI / 4)]);
  k.rod([-0.3, gb[1], -0.45], [-0.3, gb[1], -0.2], 0.04, 'copper');

  // control box beside the engine
  const cx = -0.35, cz = 1.05;
  k.bay(cx, cz, 1.58, 0.6, 0.12, 0.42);
  k.box(1.4, 0.03, 0.46, cx, 0.12, cz, 'dark');
  for (let i = 0; i < 3; i++) { // round connectors on the wall facing the engine
    const x = -0.8 + i * 0.4;
    k.cyl(0.1, 0.1, x, 0.34, 0.72, 'chip', 'z');
  }
  // contents, left to right: starter relay, ECU on standoffs, power stage with heatsink
  const connector = k.bolt(S.connectorRing, [-0.4, 0.34, 0.68], [0, 0, -1], [], 2);
  k.cable([[-0.2, 0.3, 1.0], [-0.3, 0.32, 0.9], [-0.4, 0.3, 0.8]], 0.025, 'blue'); // ribbon
  k.box(0.56, 0.04, 0.44, -0.45, 0.15, cz, 'pcb');
  k.mount('relay', [[-0.92, 0.15, cz], [0, 0, 0]], () => [
    k.clip(S.railClip, [-0.92, 0.17, cz + 0.2], [0, 1, 0]),
    k.wire(S.relayFeed, [[-0.93, 0.5, 1.0], [-0.9, 0.42, 0.9], [-0.8, 0.3, 0.78]], 'red', [], 0.04),
  ]);
  const standoffs = [[-1, -1], [1, 1]].map(([sx, sz]) => k.screw(S.ecuStandoff, [-0.45 + sx * 0.27, 0.19, cz + sz * 0.2]));
  k.mount('compute', [[-0.45, 0.2, cz], [0, 0, 0]], () => [...standoffs, connector]);
  k.box(0.4, 0.04, 0.4, 0.05, 0.15, cz, 'pcb');
  k.box(0.26, 0.05, 0.26, 0.05, 0.19, cz, 'chip');
  k.mount('heatsink', [[0.05, 0.2, cz], [0, 0, 0]], () => [k.clip(S.springClip, [0.3, 0.55, cz], [0, 1, 0])]);
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
  const coverBolts = k.circle(S.topCoverBolt, [0, 1.05, 0], [0, 1, 0], 0.42, 3, [], 'bolt', Math.PI / 6);
  k.cover(topCover, coverBolts, [0, 1, 0], 0.03);
  const gearBolt = k.bolt(S.gearRetainingBolt, [0, 0.85, 0], [0, 1, 0], [], 3);
  const clampRing = k.group([0, 0.6, 0]);
  k.mesh(new THREE.LatheGeometry([new THREE.Vector2(0.2, 0), new THREE.Vector2(0.42, 0), new THREE.Vector2(0.42, 0.04), new THREE.Vector2(0.2, 0.04), new THREE.Vector2(0.2, 0)], 32), 'trim', 0, 0, 0, clampRing);
  const clampBolts = k.circle(S.clampRingBolt, [0, 0.64, 0], [0, 1, 0], 0.34, 3, [gearBolt], 'bolt', -Math.PI / 6);
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
  k.cover(gbCover, k.rect(S.gearboxScrew, [-1.0, 0.575, 0], [-1, 0, 0], 1.0, 0.5), [-1, 0.2, 0], 0.33);
  const slots: [number, 'bearing' | 'gear'][] = [[-0.38, 'bearing'], [0, 'gear'], [0.38, 'gear']];
  for (const [z, part] of slots) {
    k.rod([-0.52, 0.575, z], [-0.95, 0.575, z], 0.03, 'copper');
    k.mount(part, k.ax(part, [-0.76 - (part === 'gear' && z > 0 ? 0.12 : 0), 0.575, z], 'x'), () => [k.clip(part === 'gear' ? S.gearClip : S.bearingClip, [-0.9, 0.575, z], [-1, 0, 0])]);
  }

  // servo motor on +x: shelf, adapter plate with four bolts, shaft into the housing; cables run to the driver bay
  k.box(0.6, 0.06, 0.52, 0.95, 0.24, 0, 'trim');
  k.box(0.06, 0.74, 0.74, 0.58, 0.18, 0, 'body');
  k.rod([0.75, 0.55, 0], [0.4, 0.55, 0], 0.045, 'copper');
  const power = k.wire(S.motorPowerCable, [[0.95, 0.82, 0.15], [0.8, 0.95, 0.5], [0.45, 0.98, 0.9], [0.3, 0.98, 1.1], [0.1, 0.96, 1.45]], 'red', [], 0.05);
  const encoder = k.wire(S.encoderCable, [[1.1, 0.7, 0.2], [0.9, 0.85, 0.6], [0.5, 0.9, 1.0], [0.3, 0.92, 1.4], [0.1, 0.92, 1.55]], 'blue', [], 0.025);
  const plate = k.circle(S.motorFlangeBolt, [0.62, 0.55, 0], [1, 0, 0], 0.38, 2, [power, encoder], 'bolt', Math.PI / 4);
  k.mount('motor', [[0.95, 0.3, 0], [0, 0, 0]], () => [power, encoder, ...plate]);

  // the link, and the driver bay on top of it
  k.cyl(0.24, 1.85, 0, 0.55, 1.375, 'body', 'z');
  k.cyl(0.32, 0.06, 0, 0.55, 2.3, 'trim', 'z');
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.stud(Math.cos(a) * 0.25, 0.55 + Math.sin(a) * 0.25, 2.34, 0.04);
  }
  k.box(0.8, 0.04, 1.5, 0, 0.78, 1.45, 'trim');
  k.bay(0, 1.45, 0.8, 1.5, 0.82, 0.36, { screws: 0, pry: true });
  k.box(0.7, 0.03, 1.3, 0, 0.82, 1.45, 'pcb');
  const dy = 0.85;
  k.box(0.26, 0.05, 0.26, 0, dy, 1.05, 'chip');
  k.mount('heatsink', [[0, dy + 0.05, 1.05], [0, 0, 0]], () => [k.clip(S.springClip, [0.3, dy + 0.4, 1.05], [0, 1, 0])]);
  const standoffs = [[-1, -1], [1, 1]].map(([sx, sz]) => k.screw(S.boardStandoff, [sx * 0.31, dy, 1.55 + sz * 0.27]));
  k.mount('compute', [[0, dy, 1.55], [0, 0, 0]], () => [...standoffs, encoder]);
  // brake relay in the bay, brake solenoid on the base, joined by one long cable
  k.box(0.8, 0.04, 0.5, -0.65, 0.12, 1.0, 'trim');
  const relayT = k.take('relay'), coilT = k.take('coil');
  const brakeFeed = relayT || coilT ? k.wire(S.brakeFeed, [[-0.2, 1.1, 1.95], [-0.5, 0.9, 1.85], [-0.7, 0.7, 1.4], [-0.65, 0.6, 1.0]], 'yellow', [], 0.03) : null;
  if (relayT && brakeFeed) {
    k.part('relay', relayT, [0, dy, 1.98], [k.clip(S.railClip, [0, dy + 0.3, 2.13], [0, 1, 0]), brakeFeed]);
  }
  if (coilT && brakeFeed) k.part('coil', coilT, [-0.65, 0.16, 1.0], [brakeFeed, k.bolt(S.solenoidBolt, [-0.35, 0.18, 1.0], [0, 1, 0], [brakeFeed], 2)]);
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
  k.bay(0, 0, 1.6, 1.5, 0.05, 0.6, { screws: 0, latch: true, pry: true });
  const Y = 0.07;
  // cable gland and the cable going off
  k.cyl(0.07, 0.12, -0.55, 0.3, -0.75, 'trim', 'z');
  k.cable([[-0.55, 0.3, -0.82], [-0.55, 0.12, -1.3], [-0.2, 0.1, -1.8]], 0.045);
  // terminal block, DIN rail
  for (const x of [-0.75, -0.62, -0.49]) k.box(0.1, 0.12, 0.12, x, Y, -0.5, 'yellow');
  k.box(0.04, 0.03, 1.2, 0, Y, -0.05, 'chip');
  k.cable([[-0.6, 0.3, -0.68], [-0.7, 0.14, -0.55], [-0.78, 0.1, -0.3]], 0.035, 'green'); // earth to its stud
  k.stud(-0.78, Y + 0.02, -0.28, 0.05);
  const mains = k.wire(S.mainsCable, [[-0.55, 0.3, -0.68], [-0.55, 0.4, -0.3], [-0.5, 0.34, 0.0]], 'brown', [], 0.045);
  const secondary = k.wire(S.transformerSecondary, [[-0.45, 0.34, 0.22], [-0.25, 0.4, 0.1], [-0.08, 0.33, -0.5]], 'red', [], 0.03);
  // transformer on the left, bolted through the back plate
  k.mount('coil', [[-0.5, Y, 0.1], [0, 0, 0]], () => [mains, secondary, k.bolt(S.transformerBolt, [-0.5, 0, 0.1], [0, -1, 0], [mains, secondary], 2)]);
  // two contactors on the rail: the first fed by the transformer, the second driven from the board
  const relay1 = k.take('relay');
  const out1 = k.wire(S.contactor1Out, [[0.08, 0.33, -0.5], [0.3, 0.4, -0.45], [0.42, 0.14, -0.45]], 'red', [], 0.03);
  if (relay1) k.part('relay', relay1, [0.0, Y, -0.4], [k.clip(S.railClip, [0.0, Y + 0.02, -0.2], [0, 1, 0]), secondary, out1]);
  const relay2 = k.take('relay');
  const extra: Step[] = [];
  if (relay2) {
    const out2 = k.wire(S.contactor2Out, [[-0.08, 0.33, 0.3], [0.2, 0.42, 0.1], [0.4, 0.14, -0.05]], 'red', [], 0.03);
    extra.push(out2);
    k.part('relay', relay2, [0.0, Y, 0.2], [k.clip(S.railClip, [0.0, Y + 0.02, 0.4], [0, 1, 0]), out2]);
  }
  // controller board and the heatsink on its regulator
  k.box(0.62, 0.04, 0.5, 0.5, Y, -0.25, 'pcb');
  const standoffs = [[-1, -1], [1, 1]].map(([sx, sz]) => k.screw(S.boardStandoff, [0.5 + sx * 0.3, Y + 0.04, -0.25 + sz * 0.22]));
  k.mount('compute', [[0.5, Y + 0.04, -0.25], [0, 0, 0]], () => [...standoffs, out1, ...extra]);
  k.box(0.4, 0.04, 0.4, 0.5, Y, 0.42, 'pcb');
  k.box(0.26, 0.05, 0.26, 0.5, Y + 0.04, 0.42, 'chip');
  k.mount('heatsink', [[0.5, Y + 0.09, 0.42], [0, 0, 0]], () => [k.clip(S.springClip, [0.78, Y + 0.45, 0.42], [0, 1, 0])]);
  // backup battery for the controller, strapped down in the free corner by the hinges
  k.mount('battery', [[-0.45, Y, 0.58], [0, 0, 0]], () => [k.clip(S.batteryStrap, [-0.45, Y + 0.28, 0.58], [0, 1, 0])]);
  if (g >= 2) k.lamps(5, -0.4, 0.65, 0.5, 0.2);
}

// ---- starter machines (scrap fields) ---------------------------------------------------------------------

/** Hand winch off a cargo hoist, on its base plate: a cable drum on a shaft between two pillow blocks, the -x block's
 *  bearing under a cap bolted down at each side. On +x, under a screwed guard: the drum gear on the shaft end (a nut)
 *  and the crank's pinion above it (a clip). */
function winch(k: Kit) {
  const g = k.grade;
  const Y = 0.55, PY = Y + 0.52;
  k.box(1.8, 0.08, 0.9, 0, 0, 0, 'trim');
  for (const [x, z] of [[-0.8, -0.36], [0.8, -0.36], [-0.8, 0.36], [0.8, 0.36]]) k.stud(x, 0.1, z, 0.05);
  // pillow blocks: the -x one split at the shaft (its cap holds the bearing), the +x one tall enough for the crank
  k.box(0.24, Y - 0.18, 0.5, -0.55, 0.08, 0, 'body');
  k.box(0.2, PY + 0.12 - 0.08, 0.4, 0.42, 0.08, 0, 'body');
  // drum with its cable, the shaft through everything
  k.rod([-0.85, Y, 0], [0.82, Y, 0], 0.045, 'copper');
  k.cyl(0.24, 0.66, -0.03, Y, 0, 'body', 'x');
  for (const x of [-0.37, 0.31]) k.cyl(0.34, 0.04, x, Y, 0, 'trim', 'x');
  for (let i = 0; i < 6; i++) k.ring(0.26, 0.024, -0.29 + i * 0.105, Y, 0, 'dark', 'x');
  k.cable([[0.0, Y - 0.25, 0.1], [0.1, 0.12, 0.55], [0.5, 0.06, 0.95], [0.9, 0.05, 1.1]], 0.024, 'dark');
  // ratchet and pawl on the -x flange
  k.cyl(0.3, 0.05, -0.42, Y, 0, 'dark', 'x', 12);
  k.box(0.05, 0.06, 0.26, -0.42, Y + 0.24, 0.12, 'yellow');
  if (g >= 2) k.ring(0.35, 0.015, 0.31, Y, 0, 'accent', 'x');

  const cap = k.group([-0.55, Y - 0.1, 0]);
  k.mesh(new THREE.BoxGeometry(0.26, 0.4, 0.5), 'trim', 0, 0.2, 0, cap);
  const capBolts = [k.bolt(S.bearingCapBolt, [-0.55, Y + 0.3, 0.18], [0, 1, 0], [], 2)];
  k.cover(cap, capBolts, [0, 1, 0], 0.13);
  k.mount('bearing', k.ax('bearing', [-0.55, Y, 0], 'x'), () => capBolts);

  // crank shaft and handle
  k.rod([0.32, PY, 0], [1.08, PY, 0], 0.035, 'copper');
  k.rod([1.08, PY, 0], [1.08, PY + 0.35, 0], 0.03, 'trim');
  k.cyl(0.05, 0.22, 1.08, PY + 0.35, 0, 'red', 'x');
  // gear guard over both gears, a latch on its outer face
  const guard = k.group([0.72, Y - 0.32, 0]);
  k.mesh(new THREE.BoxGeometry(0.34, 1.18, 0.66), 'body', 0, 0.59, 0, guard);
  k.mesh(new THREE.BoxGeometry(0.02, 0.9, 0.06), g >= 1 ? 'accent' : 'trim', 0.18, 0.59, 0, guard);
  const guardScrews = [k.clip(S.guardLatch, [0.9, Y + 0.6, 0], [1, 0, 0])];
  k.cover(guard, guardScrews, [1, 0.3, 0], 0.17);
  k.mount('gear', k.ax('gear', [0.7, Y, 0], 'x'), () => [k.bolt(S.drumGearNut, [0.84, Y, 0], [1, 0, 0], guardScrews, 2)]);
  k.mount('gear', k.ax('gear', [0.7, PY, 0], 'x'), () => [k.clip(S.pinionClip, [0.84, PY, 0], [1, 0, 0], 1, guardScrews)]);
}

/** A cut-off section of coolant line on two saddles with a solenoid valve in it: the valve body sits in the line
 *  between two flanges (four bolts each), its coil on top, fed by a lead from a junction box (screwed lid). */
function solenoidValve(k: Kit) {
  const g = k.grade;
  const Y = 0.4;
  k.box(1.7, 0.06, 0.7, 0, 0, 0, 'trim');
  for (const x of [-0.6, 0.6]) {
    k.box(0.14, Y - 0.2, 0.32, x, 0.06, 0, 'dark');
    k.cyl(0.12, 0.48, x * 1.05, Y, 0, 'body', 'x');
  }
  // the line's flanges either side of the valve
  for (const x of [-0.32, 0.32]) k.cyl(0.24, 0.05, x, Y, 0, 'trim', 'x', 24);
  const flanges = [-0.36, 0.36].map((x) => k.bolt(S.flangeBolt, [x, Y + 0.18, 0], [Math.sign(x), 0, 0], [], 2));
  if (g >= 2) for (const x of [-0.6, 0.6]) k.ring(0.125, 0.015, x, Y, 0, 'accent', 'x');
  // junction box on the bracket, a lead up to the coil
  k.box(0.36, 0.22, 0.3, 0.45, 0.06, 0.48, 'body');
  const lid = k.group([0.45, 0.3, 0.48]);
  k.mesh(new THREE.BoxGeometry(0.38, 0.03, 0.32), 'trim', 0, 0, 0, lid);
  const lidScrews = [k.screw(S.junctionBoxScrew, [0.59, 0.32, 0.48])];
  k.cover(lid, lidScrews, [0, 1, 0.3], 0.02);
  const lead = k.wire(S.coilLead, [[0.45, 0.3, 0.48], [0.4, 0.75, 0.2], [0.15, 0.85, -0.25], [0.0, Y + 0.45, -0.47]], 'brown', lidScrews, 0.03);
  const valve = k.take('valve');
  if (valve) k.part('valve', valve, [0, Y - 0.25, 0], [...flanges, lead]);
  else k.cyl(0.12, 0.5, 0, Y - 0.25, 0, 'body'); // plain spool piece
  // the coil on a shelf bracket behind the valve, bolted down at both ends
  k.box(0.4, Y + 0.24, 0.05, 0, 0.06, -0.66, 'trim');
  k.box(0.5, 0.04, 0.36, 0, Y + 0.26, -0.47, 'trim');
  k.mount('coil', [[0, Y + 0.3, -0.47], [0, 0, 0]], () => [lead, k.bolt(S.coilBolt, [0.2, Y + 0.3, -0.47], [0, 1, 0], [lead], 2)]);
}

/** A crashed distress beacon lying on its side: a drum-shaped body with the battery pack under a latched, screwed
 *  lid, and the transmitter coil in the foot of the snapped-off mast, bolted to its flange. */
function beacon(k: Kit) {
  const g = k.grade;
  k.box(1.2, 0.05, 1.3, 0, 0, 0, 'dark'); // scorched skid plate
  k.box(1.0, 0.45, 1.0, 0, 0.05, 0, 'body');
  k.box(1.04, 0.06, 0.12, 0, 0.12, -0.45, 'yellow');
  k.box(1.04, 0.06, 0.12, 0, 0.12, 0.45, 'yellow');
  // battery bay on top
  const lid = k.bay(0, -0.05, 0.9, 0.6, 0.5, 0.3, { screws: 0, latch: true });
  k.mount('battery', [[0, 0.52, -0.05], [0, 0, 0]], () => [...lid.holds, k.clip(S.batteryStrap, [0, 0.82, -0.05], [0, 1, 0], 1, lid.holds)]);
  // mast foot on +z with the transmitter coil, the mast snapped off and lying alongside
  k.cyl(0.3, 0.06, 0, 0.5, 0.52, 'trim', 'y', 24);
  const feed = k.wire(S.antennaFeed, [[0.3, 0.5, 0.25], [0.4, 0.62, 0.4], [0.2, 0.6, 0.55]], 'red', lid.holds, 0.03);
  const footBolts = k.circle(S.mastFootBolt, [0, 0.57, 0.52], [0, 1, 0], 0.24, 2, [feed]);
  k.mount('coil', [[0, 0.56, 0.52], [0, 0, 0]], () => [feed, ...footBolts]);
  k.rod([0.55, 0.06, 0.7], [0.65, 0.06, -0.8], 0.04, 'trim');
  k.cyl(0.07, 0.08, 0.56, 0.06, 0.62, 'red', 'y', 10);
  k.lamps(g >= 2 ? 3 : 2, -0.4, 0.5, 0.42, 0.12);
}

const BUILDERS: Record<JunkKind, (k: Kit) => void> = {
  pump_housing: pumpHousing,
  jet_engine: jetEngine,
  robot_arm: robotArm,
  control_cabinet: controlCabinet,
  winch,
  solenoid_valve: solenoidValve,
  beacon,
  vehicle_frame: vehicleFrame,
  water_jet: waterJet,
  warp_core: warpCore,
  ai_control: aiControl,
};
// The wrecks are built at about twice their models' size (tools/blender/salvage), so they come back to it here.
const SCALE: Record<JunkKind, number> = {
  pump_housing: 0.7, jet_engine: 0.7, robot_arm: 0.8, control_cabinet: 0.85, winch: 0.75, solenoid_valve: 0.75, beacon: 0.8,
  vehicle_frame: 0.5, water_jet: 0.8, warp_core: 0.55, ai_control: 0.62,
};
export const JUNK_KINDS = Object.keys(BUILDERS) as JunkKind[];

// ---- assembly ----------------------------------------------------------------------------------------------

/** Build a component or salvage wreck of `kind` holding the parts its `seed` rolls (shared/machine.ts) at crash-site `level`.
 *  Part models load in the background. Slots are sorted by part index, so `slots[i].index === i` whenever every rolled part
 *  is mounted. */
export function buildJunk(kind: JunkKind, seed: number, level = 1): Junk {
  if (layoutOf(kind)) return buildModelJunk(kind, seed, level);
  const spec = junkSpec(kind);
  const rolled: Record<PartId, Roll[]> = { battery: [], motor: [], heatsink: [], compute: [], uranium: [], coil: [], impeller: [], bearing: [], gear: [], valve: [], relay: [] };
  let best = 0;
  machineParts(kind, seed, level).forEach(({ part, tier }, index) => {
    rolled[part].push({ tier, index });
    best = Math.max(best, TIERS.indexOf(tier));
  });

  const kit = new Kit(best, rolled);
  BUILDERS[kind](kit);
  kit.slots.sort((a, b) => a.index - b.index);
  // Every rolled part needs a mount, or the server waits for a part nobody can take.
  for (const part of Object.keys(rolled) as PartId[]) if (rolled[part].length) console.error(`teardown: ${kind} has no mount for ${rolled[part].length} ${part}`);
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
