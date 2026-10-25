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
import { abs, cameraPosition, dot, positionWorld, smoothstep, uniform, vec3 } from 'three/tsl';
import { Rope } from './rope.ts';
import { hardware } from './hardware.ts';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { machineParts } from '../../shared/machine.ts';
import { layoutOf } from '../../shared/machines.ts';
import { buildModelJunk } from './glbMachine.ts';
import { junkSpec, RARITY, TIERS, type JunkKind, type PartId, type Tier } from '../../shared/salvage.ts';
import { BUILDERS } from '../../shared/machineBuilders.ts';
import { TEXT } from '../../shared/text.ts';

/** Step labels (shared/text.ts). */
const S = TEXT.steps;

/** The workable sheen (src/teardown): a band of light that runs across the world now and then and lights whatever can be worked
 *  where it passes, along a fixed direction, measured from the eye. A part that can be worked wears the "shiny" copy of its
 *  material (`shinyOf`) and goes back to the plain one when it cannot. One copy per material, all sharing the one uniform
 *  `sheenAt` (metres along the band's way from the eye, far off = none): materials with a node of their own per step were a
 *  shader build each, and hundreds of those in a few frames were the long frames when machines came into view. */
const sheenAt = uniform(-99);
export const setSheen = (metres: number) => {
  sheenAt.value = metres;
};
const shiny = new Map<THREE.Material, THREE.MeshStandardNodeMaterial>();
export function shinyOf(base: THREE.MeshStandardNodeMaterial): THREE.MeshStandardNodeMaterial {
  let m = shiny.get(base);
  if (!m) {
    m = base.clone();
    m.emissiveNode = vec3(0.5, 0.82, 1.0).mul(smoothstep(0.7, 0.0, abs(dot(positionWorld.sub(cameraPosition), vec3(0.7, 0, 0.7)).sub(sheenAt))).mul(0.015));
    shiny.set(base, m);
  }
  return m;
}
/** A mesh of a step (or of the part it frees) that takes the sheen: its plain material, and whether it wears the shiny one now. */
export interface Shine {
  mesh: THREE.Mesh;
  plain: THREE.MeshStandardNodeMaterial;
  on: boolean;
}

/** Bring every world matrix under `root` up to date once, then stop three.js rebuilding the matrix of each of its (hundreds of)
 *  objects every frame (scene.updateMatrixWorld does that for any object with matrixAutoUpdate): a machine that is not
 *  being worked on does not move. The disassembly wakes it while it works (`wake`); call `settle` again after anything under
 *  it was moved. */
export function settle(root: THREE.Object3D) {
  root.traverse((o) => { o.matrixAutoUpdate = true; });
  root.updateMatrixWorld(true);
  root.traverse((o) => { o.matrixAutoUpdate = false; });
}

export function wake(root: THREE.Object3D) {
  root.traverse((o) => { o.matrixAutoUpdate = true; });
}

/** A machine seen from afar has no use for its fasteners and parts: they are taken out of the scene graph altogether (hidden
 *  objects are still walked every frame, and cost a draw once shown), remembering where they hang (`userData.home`). */
export function hideDetail(junk: { steps: Step[]; slots: Slot[] }) {
  for (const s of junk.steps) {
    if (s.done) continue;
    s.obj.userData.home ??= s.obj.parent;
    s.obj.removeFromParent();
  }
  for (const sl of junk.slots) {
    if (sl.taken) continue;
    const o = sl.piece.obj;
    o.userData.home ??= o.parent;
    o.removeFromParent();
  }
}

/** What goes back into the scene when you come near: the steps that can be worked and the parts, to be added a few a frame
 *  (a hundred new objects in one frame is a long frame: each needs its pipeline and bindings made). */
export function detailList(junk: { steps: Step[]; slots: Slot[] }): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const s of junk.steps) if (!s.done) out.push(s.obj);
  for (const sl of junk.slots) if (!sl.taken) out.push(sl.piece.obj);
  return out;
}

/** Back in the scene at once (the disassembly starts: any step can come ready). */
export function attachAll(junk: { steps: Step[]; slots: Slot[] }) {
  for (const s of junk.steps) if (!s.done) (s.obj.userData.home as THREE.Object3D | null | undefined)?.add(s.obj);
  for (const sl of junk.slots) if (!sl.taken) (sl.piece.obj.userData.home as THREE.Object3D | null | undefined)?.add(sl.piece.obj);
}

export type StepKind = 'screw' | 'bolt' | 'clip' | 'wire' | 'pry' | 'lift' | 'grind' | 'mash';
export interface Step {
  kind: StepKind;
  label: string;
  /** Screws and clips: clicks. Bolts: half turns of the pointer around them. Wires and pry tabs: 1 = one decisive stroke.
   *  Lifts: seconds you must keep it up. */
  need: number;
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
  shine: Shine[];
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
  lugs?: THREE.Object3D[];
  /** Hardware that moves its own way as the step goes (a pin slides out, a clamp's T-bolt unwinds), instead of the kind's turn. */
  act?: (f: number) => void;
}
/** A wire shorter than this (m) is one pull: a single shake rips the whole cable out. */
export const SHORT_WIRE = 0.55;
/** Seconds of holding the use button on the lifting eye of something heavy (the pump motor, the jet engine's upper casing):
 *  one person heaves it off alone, slowly; letting go drops it back. */
const HEAVY_LIFT_S = 4;

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
  /** The module it is (shared/machines.ts), for its name. */
  id?: string;
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
  /** Where it lies once it has come off: the machine's root (not the part that rolls). */
  home?: THREE.Object3D;
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
  /** Rolled about its own axis by this many radians (pushed round: server/crash.ts push); the pieces lying round it stay put. */
  setRoll?: (a: number) => void;
}
/** What a pointer hit resolves to; stored in `userData.target` on the object that owns the interaction. */
export type Target =
  | { type: 'junk'; junk: Junk }
  | { type: 'step'; step: Step }
  | { type: 'part'; slot: Slot }
  /** The bare frame of a machine with nothing left on it: mashed to scrap. */
  | { type: 'frame' };

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
  n.home?.add(p.obj); // (the machine rolls when pushed; what lies round it does not)
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
const SIZE: Partial<Record<PartId, number>> = { relay: 0.3, fanrotor: 3.93, comprotor: 1.5, turbinerotor: 1.8, turbinedisc: 1.43, fuelmanifold: 1.6 };
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

type MatKey = 'body' | 'trim' | 'accent' | 'glow' | 'dark' | 'red' | 'blue' | 'yellow' | 'copper' | 'pcb' | 'chip' | 'brown' | 'black' | 'green'
  // The crashed pod's own paint (tools/blender/pod.py), whatever the parts inside: what's torn out of it.
  | 'hull' | 'hullGrey' | 'orange';
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
function makeMarker(kind: StepKind, need: number): THREE.Group {
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
    markerMesh(up, UP_SHAFT_GEO, 0, 0, 0);
    markerMesh(up, HEAD_X_GEO, 0, 0.14, 0);
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
  if (u.line) {
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

/** A cable's plugs and sockets are drawn at this fraction of the hardware kit's size: small, clean connectors on thick cable. */
const PLUG_SCALE = 0.62;

const KIT_MATS: Partial<Record<number, Record<MatKey, THREE.MeshStandardNodeMaterial>>> = {};

/** The materials of one grade, made once and shared by every machine of it: each new material is a shader build the first time
 *  it is drawn, and a machine made its fourteen again every time it was built (long frames as machines came into range). */
function kitMaterials(grade: number): Record<MatKey, THREE.MeshStandardNodeMaterial> {
  const hit = KIT_MATS[grade];
  if (hit) return hit;
  const p = PALETTE[grade];
  const mat = (color: number, metalness: number, roughness: number, glow = 0) =>
    new THREE.MeshStandardNodeMaterial({ color, metalness, roughness, emissive: glow ? color : 0x000000, emissiveIntensity: glow });
  return (KIT_MATS[grade] = {
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
    hull: mat(0xe4dfd3, 0.15, 0.6),
    hullGrey: mat(0xaeaba3, 0.3, 0.6),
    orange: mat(0xd2622a, 0.1, 0.55),
  });
}

/** Builds one machine: geometry, steps, covers and part mounts. The salvage wrecks' builders are in wrecks.ts. */
export class Kit {
  readonly shapes = THREE;
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
    this.mats = kitMaterials(grade);
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
    after: Step[], floorY: number, mat?: THREE.MeshStandardNodeMaterial): Step {
    // fasteners are small: no shadow pass for them (the draws were a large part of the frame with many machines in view)
    g.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
    });
    // what the step is made of takes the sheen
    const shine: Shine[] = [];
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      const mt = m.isMesh ? (m.material as THREE.MeshStandardNodeMaterial) : null;
      if (!mt || !mt.emissive) return;
      if (mt === mat) return; // (a wire's own cable shows its shaking in its glow)
      shine.push({ mesh: m, plain: mt, on: false });
    });
    const hit = new THREE.Mesh(hitGeo, HIT_MAT);
    hit.visible = false; // never drawn, but still hit by the pointer ray
    hit.position.y = 0.05;
    g.add(hit);
    const marker = makeMarker(kind, need);
    marker.position.y = kind === 'lift' ? 0.2 : 0.1;
    marker.visible = false;
    g.add(marker);
    const step: Step = { kind, label, need, progress: 0, done: false, after, obj: g, spin, hit, marker, shine, floorY: floorY * this.fs, mat };
    hit.userData.target = g.userData.target = { type: 'step', step } satisfies Target;
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
  /** Lifting eye on something heavy: hold the use button on it for `seconds` while it comes up (let go and it drops back). */
  lift(label: string, pos: V, nrm: V, after: Step[] = [], seconds = 1.6): Step {
    const { g, spin } = this.stepGroup(pos, nrm);
    this.mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.05, 12), 'dark', 0, 0.025, 0, g);
    this.mesh(new THREE.TorusGeometry(0.11, 0.028, 8, 20), 'yellow', 0, 0.15, 0, spin);
    return this.reg('lift', label, g, spin, new THREE.SphereGeometry(0.22, 8, 6), seconds, after, 0.1);
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
    line.userData.line = true;
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
    line.userData.line = true;
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
  /** A part that pulls apart: an arrow on the part itself showing the way it comes out, and you press the use button on the arrow
   *  (or the part) again and again, `presses` times, like a prised shell: `slide.obj` parts from the machine along `dir` with every
   *  press and drifts back if you stop. `pos` is a point on its surface. */
  pull(label: string, pos: V, nrm: V, after: Step[], presses: number, slide: { obj: THREE.Object3D; dir: THREE.Vector3; dist: number }): Step {
    const { g, spin } = this.stepGroup(pos, nrm);
    const step = this.reg('lift', label, g, spin, new THREE.SphereGeometry(0.35 / this.fs, 8, 6), presses, after, 0.1);
    step.kind = 'mash'; // (the arrow marker was made for a lift; what it asks for is the mash)
    step.slide = { ...slide, offset: new THREE.Vector3() };
    slide.obj.userData.target = { type: 'step', step } satisfies Target;
    return step;
  }
  /** Wire from the first point to the last, a ring lug at each end: shake each end loose. */
  wire(label: string, pts: V[], key: MatKey = 'red', after: Step[] = [], r = 0.035, plug?: { strands: number }): Step {
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
    const lugs: THREE.Object3D[] = [];
    for (const t of [0, 1]) {
      const f = this.fs;
      // (a cable of a model-built machine ends in a connector plug from the hardware kit, which lies along the cable as it leaves)
      const lug: THREE.Object3D = plug ? new THREE.Group() : new THREE.Mesh(new THREE.CylinderGeometry(0.06 * f, 0.06 * f, 0.025 * f, 10), this.mats.copper);
      lug.position.copy(rel.getPoint(t));
      if (plug) {
        const inward = rel.getTangent(t).multiplyScalar(t === 0 ? 1 : -1);
        lug.userData.base = new THREE.Quaternion().setFromUnitVectors(UP, inward);
        lug.quaternion.copy(lug.userData.base);
      }
      this.add(lug, g);
      lugs.push(lug);
      if (!short) ends.push({ lug, base: lug.position.clone(), swings: 0, done: false });
      if (plug) continue;
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
    const step = this.reg('wire', label, g, spin, new THREE.TubeGeometry(rel, 12, Math.max(0.1, r * 2), 5), 1, after, 0.03, mat);
    step.ends = ends;
    step.lugs = lugs;
    step.rope = new Rope(rel, tube, step.hit, r);
    if (plug) this.dressWire(step, g, lugs, rel, plug.strands, r);
    // The markers sit on the lugs themselves, wherever the wire runs.
    step.marker.position.set(0, 0, 0);
    (step.marker.userData.ends as THREE.Group[]).forEach((eg, i) => eg.position.copy((ends[i] ?? ends[0]).base));
    return step;
  }

  /** The plugs on the ends of a cable and the sockets they sit in, once the hardware kit is in; with several strands, the cable
   *  fans into its wires at each plug. */
  private dressWire(step: Step, g: THREE.Group, lugs: THREE.Object3D[], rel: THREE.CatmullRomCurve3, strands: number, r: number) {
    const k = PLUG_SCALE / this.fs;
    const colours: MatKey[] = ['red', 'black', 'yellow', 'blue', 'green', 'brown'];
    hardware().then((hw) => {
      const plug = hw.get('Plug'), socket = hw.get('Socket');
      lugs.forEach((lug, i) => {
        if (plug) {
          const o = plug.obj.clone(true);
          o.scale.setScalar(k);
          lug.add(o);
          o.traverse((m) => {
            const mesh = m as THREE.Mesh;
            if (mesh.isMesh) step.shine.push({ mesh, plain: mesh.material as THREE.MeshStandardNodeMaterial, on: false });
          });
        }
        if (socket) {
          const s = socket.obj.clone(true);
          s.scale.setScalar(k);
          s.position.copy(lug.position);
          s.quaternion.copy(lug.userData.base as THREE.Quaternion);
          g.add(s);
        }
        // the strands leave the plug's backshell and run together into the cable
        if (strands > 1) {
          const along = new THREE.Vector3(0, 1, 0);
          for (let n = 0; n < strands; n++) {
            const a = (n / strands) * Math.PI * 2;
            const spread = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.016 * k);
            const wire = new THREE.CatmullRomCurve3([
              along.clone().multiplyScalar(0.098 * k).add(spread.clone().multiplyScalar(0.5)),
              along.clone().multiplyScalar(0.14 * k).add(spread),
              along.clone().multiplyScalar(0.2 * k).add(spread.clone().multiplyScalar(0.3)),
              along.clone().multiplyScalar(0.26 * k),
            ]);
            const m = new THREE.Mesh(new THREE.TubeGeometry(wire, 8, Math.max(0.006, r * 0.35), 5), this.mats[colours[n % colours.length]]);
            m.castShadow = false;
            lug.add(m);
          }
        }
      });
    });
  }

  /** A step of a model-built machine (src/teardown/glbMachine.ts) with its hardware from the kit: `kind` decides what the player
   *  does (as screw, bolt, clip), `hw` what it looks like (bolt, screw, latch, clamp, pin, fitting), `variant` clean (A) or worn (B). */
  hardwareStep(kind: 'screw' | 'bolt' | 'clip', hw: 'bolt' | 'screw' | 'latch' | 'clamp' | 'pin' | 'fitting', variant: 'A' | 'B', label: string, pos: V,
    nrm: V, after: Step[], need: number): Step {
    const { g, spin } = this.stepGroup(pos, nrm);
    const step = kind === 'bolt' ? this.reg('bolt', label, g, spin, new THREE.SphereGeometry(0.2, 8, 6), need, after, 0.14) // (it comes out whole, shank and all: it lands on the end of that)
      : kind === 'screw' ? this.reg('screw', label, g, spin, new THREE.SphereGeometry(0.15, 8, 6), need, after, 0.09)
        : this.reg('clip', label, g, spin, new THREE.BoxGeometry(0.34, 0.2, 0.26), need, after, 0.04);
    const base = { bolt: 'Bolt', screw: 'Screw', latch: 'Latch', clamp: 'Clamp', pin: 'Pin', fitting: 'Fitting' }[hw] + variant;
    if (hw === 'latch') {
      // (its lever is hinged at its own pivot: the spin group sits there, and the show() of a clip raises it)
    } else if (hw === 'clamp') {
      step.act = (f) => {
        spin.rotation.y = Math.min(f, 1) * 7;
        spin.position.y = Math.min(f, 1) * 0.05;
      };
    } else if (hw === 'pin') {
      step.act = (f) => (spin.position.y = Math.min(f, 1) * 0.1);
    }
    const k = 1 / this.fs;
    hardware().then((parts) => {
      const seat = parts.get(base), mover = parts.get(base + '_Spin');
      const add = (to: THREE.Object3D, o: THREE.Object3D) => {
        o.scale.setScalar(k);
        to.add(o);
        o.traverse((m) => {
          const mesh = m as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = false; // (hardware this small throws no shadow)
          step.shine.push({ mesh, plain: mesh.material as THREE.MeshStandardNodeMaterial, on: false });
        });
      };
      if (seat) add(g, seat.obj.clone(true));
      if (mover) {
        const o = mover.obj.clone(true);
        if (hw === 'latch') spin.position.copy(mover.at).multiplyScalar(k); // the lever's hinge
        else o.position.copy(mover.at).multiplyScalar(k);
        add(spin, o);
      }
    });
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

// The wrecks are built at about twice their models' size (tools/blender/salvage), so they come back to it here.
const SCALE: Record<JunkKind, number> = {
  pump_housing: 0.7, jet_engine: 0.7, robot_arm: 0.8, control_cabinet: 0.85, winch: 0.75, solenoid_valve: 0.75, beacon: 0.8,
  pod_console: 0.6, pod_powerbox: 0.6,
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
  const rolled: Record<PartId, Roll[]> = { battery: [], motor: [], heatsink: [], compute: [], uranium: [], coil: [], impeller: [], bearing: [], gear: [], valve: [], relay: [], fanrotor: [], comprotor: [], turbinerotor: [], turbinedisc: [], fuelmanifold: [] };
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
