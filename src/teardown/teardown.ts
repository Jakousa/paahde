// Disassembly mode. At a machine site you press F: the character walks up to a set distance, the normal controls
// give way to the disassembly ones, and the machine in front of you comes apart right there in the world.
//   Left mouse   on a step: work it (click screws and clips, circle the pointer around big bolts, swipe across
//                wires to cut them, drag pry tabs away, hold a lifting eye: heavy things need two players holding
//                together). On a freed part: take it (it goes to the bag). Anywhere else: drag to turn the machine
//                over (on the table) or to look around (at a large machine).
//   Middle mouse drag: the same turn / look. Right mouse drag: move a machine about the table.
//   On the table: W A S D / arrows turn the machine, the wheel zooms. At a large machine: W / S step closer and
//   further, A / D walk around it; walk too far and the mode ends.
// Steps sit on every face, so a small machine has to be turned over and around. Large machines are too heavy to
// turn or move: you walk around them instead, and none of their steps faces down. They stay where they
// lie and are worked on by everyone near them through a shared session (SiteLink, server/crash.ts); small ones
// are carried home and taken apart on the disassembly table, seen from a fixed camera above it. Loose-piece
// physics is plain frame-time maths: it is only cosmetic, nothing here moves players (the walk-up goes through
// the normal input path).
import * as THREE from 'three/webgpu';
import { BACK, FORWARD, LEFT, RIGHT } from '../../shared/sim.ts';
import { type JunkKind, type PartId, type Tier } from '../../shared/salvage.ts';
import { capture, keyHeld, takePickup, tools, ui } from '../input.ts';
import { teardownSound } from '../teardownSound.ts';
import { lowestOffset, slotOpen, stepReady, type Junk, type Piece, type Slot, type Step, type Target } from './junk.ts';
import { partName, rarityColor, TeardownUi } from './ui.ts';
import { uiSound } from '../uiSound.ts';

/** Something to work on: a machine at a crash site, or a carried one on the workbench. */
export interface WorkSite {
  id: string;
  kind: JunkKind;
  label: string;
  junk: Junk;
  /** Where the machine lies on the ground (its centre). */
  x: number;
  z: number;
  /** Ground height at (x, z): terrain, or the table top for the workbench. */
  ground: (x: number, z: number) => number;
  /** Loose pieces and the machine stay within this distance of (x, z). */
  radius: number;
  /** A carried machine on the table: it can be dragged around and turned over, and is seen from a fixed camera
   *  above the table. A big one stays put and you walk around it. */
  movable: boolean;
  /** How far from the machine you stand to work (default STAND). */
  stand?: number;
  /** Shared with other players through the server (large sites); null when working alone. */
  link: SiteLink | null;
  /** The state changed (a step done, a part taken). */
  changed?: () => void;
  /** The mode was left (the workbench tidies its table). */
  closed?: () => void;
}

/** The server's answer to taking a part (SiteLink.take): ok, its item is in the bag; or refused ('full': the bag
 *  has no room, so the part stays on the machine; 'taken': someone else got it first). */
export interface TakeResult {
  part: PartId;
  tier: Tier;
  ok: boolean;
  reason?: 'full' | 'taken';
}

/** The connection to the server's shared session for a large site or the table (src/net.ts). */
export interface SiteLink {
  join(): void;
  leave(): void;
  /** A step was done here (it is also done for everyone else). */
  done(i: number): void;
  take(i: number): void;
  /** Holding a lifting eye on step i (or letting go). */
  hold(i: number, players: number, on: boolean): void;
  /** How many players hold step i right now, me included. */
  holders(i: number): number;
}

interface Loose {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  /** Height of the object's origin above the ground when it lies there. */
  floorY: number;
  /** Seconds until it shrinks away. */
  life: number;
}

/** A part the player clicked: hidden while the server is asked; it flies to the bag or comes back. */
interface Pending {
  slot: Slot;
  x: number;
  y: number;
}

const GRAVITY = 16;
/** Distance from the machine at which you work. */
const STAND = 3.2;
const WALK_TIMEOUT = 6;
/** Closest you can step to a machine (m); further than STAND + LEAVE_MARGIN ends the mode. */
const MIN_DIST = 1.3;
const LEAVE_MARGIN = 3.5;
/** Radians per pixel of a look-around drag. */
const LOOK_SENS = 0.003;
/** Pointer travel for one decisive wire cut / pry, in pixels. */
const CUT_PX = 90;
const PRY_PX = 110;
/** Pointer travel (px) before a left press on the machine becomes a turn instead of a click. */
const DRAG_PX = 4;
/** The table camera: offset from the machine towards where you stand, and up (m), before the zoom. */
const OVER_BACK = 1.15;
const OVER_UP = 1.75;
const ZOOM_MIN = 0.55;
const ZOOM_MAX = 1.6;
/** Seconds to swing the camera onto the table and back. */
const CAM_BLEND = 0.7;
/** How far above a freed part its tag sits (machine units). */
const TAG_UP = 0.45;
/** Turning a machine on the table with the keys, radians a second. */
const KEY_TURN = 2.2;
/** ?debug lets one player do two-player lifts, for testing. */
const SOLO = new URLSearchParams(location.search).has('debug');

type Phase = 'idle' | 'walk' | 'work';

const HOVER_MAT = new THREE.MeshBasicNodeMaterial({ color: 0xffffff });

export class TeardownView {
  private ui: TeardownUi;
  private phase: Phase = 'idle';
  private site: WorkSite | null = null;
  private walkFor = 0;
  private restY = 0;
  private lift = 0;
  private loose: Loose[] = [];
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private hit = new THREE.Vector3();
  private pulse = 0;
  private announced = new Set<Slot>();
  private home = new THREE.Vector3();
  /** The camera's yaw / pitch (src/camera.ts), seen from drive(); middle-drag turns it directly. */
  private look: { yaw: number; pitch: number } | null = null;
  /** How far you have looked away from the machine, added to the easing target so the view stays there. */
  private lookYaw = 0;
  private lookPitch = 0;
  /** The distance to hold while strafing. */
  private workDist = 0;
  private farWarned = false;
  private pending = new Map<number, Pending>();
  /** Every answer to a part we took (the toast and fly-to-bag are drawn here already). */
  onTake?: (r: TakeResult) => void;

  /** What is under the pointer, and where the pointer is (client px; NaN when off the overlay). */
  private hover: Target | null = null;
  private px = NaN;
  private py = NaN;
  private nextAt = 0;
  /** Markers drawn highlighted this frame (the hovered step, or what blocks the hovered thing). */
  private lit = new Set<Step>();
  private markerMat: THREE.Material | null = null;

  /** The table camera: 0 = the normal view, 1 = fixed above the table; eased both ways. */
  private camK = 0;
  private overhead = false;
  private zoom = 1;
  /** Horizontal direction from the machine towards the player, set as the walk-up starts. */
  private side = new THREE.Vector3(-1, 0, 0);
  private sideSet = false;
  private camPos = new THREE.Vector3();
  private camQuat = new THREE.Quaternion();
  private camM = new THREE.Matrix4();
  private fromPos = new THREE.Vector3();
  private fromQuat = new THREE.Quaternion();

  /** Left-button interaction with a step. */
  private act: { step: Step; x0: number; y0: number; angle: number; cx: number; cy: number; dist: number } | null = null;
  private drag:
    | { kind: 'junk'; offset: THREE.Vector3 }
    | { kind: 'rotate'; x: number; y: number; moved: boolean }
    | { kind: 'look'; x: number; y: number; moved: boolean }
    | null = null;
  private button = -1;

  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLElement;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, canvas: HTMLElement) {
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.ui = new TeardownUi(() => this.end());
    const o = this.ui.overlay;
    o.addEventListener('pointerdown', (e) => this.onDown(e));
    o.addEventListener('pointermove', (e) => this.onMove(e));
    o.addEventListener('pointerup', (e) => this.onUp(e));
    o.addEventListener('pointercancel', (e) => this.onUp(e));
    o.addEventListener('pointerleave', () => (this.px = this.py = NaN));
    o.addEventListener('contextmenu', (e) => e.preventDefault());
    // Middle button would start the browser's autoscroll.
    o.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    o.addEventListener('auxclick', (e) => e.preventDefault());
    o.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.overhead && this.phase === 'work') this.zoom = THREE.MathUtils.clamp(this.zoom * Math.exp(e.deltaY * 0.0012), ZOOM_MIN, ZOOM_MAX);
    }, { passive: false });
    addEventListener('keydown', (e) => {
      if (this.phase === 'idle' || e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement) return;
      // F leaves (as it came in), straight back into the game; Esc too, leaving the mouse free.
      if (e.code === 'KeyF' && !e.repeat) {
        takePickup(); // the same press doesn't start it again
        this.end();
        capture(this.canvas);
        return;
      }
      if (e.code === 'Escape') {
        e.stopImmediatePropagation(); // Esc here only leaves: never also the Esc menu (src/menu.ts)
        this.end();
        return;
      }
      if (this.phase !== 'work' || !this.site) return;
      if (e.code === 'KeyR') {
        if (this.site.movable) {
          this.resetRotation();
          this.zoom = 1;
        } else this.lookYaw = this.lookPitch = 0;
      }
    });
  }

  get active() {
    return this.phase !== 'idle';
  }
  /** The site being worked on, or null. */
  get current() {
    return this.site;
  }

  // ---- entering and leaving --------------------------------------------------------------------------------

  /** Start: the character walks up to the machine, then the disassembly controls take over. */
  begin(site: WorkSite) {
    if (this.phase !== 'idle') return;
    this.site = site;
    this.phase = 'walk';
    this.walkFor = 0;
    this.lookYaw = this.lookPitch = 0;
    this.farWarned = false;
    this.overhead = site.movable;
    this.sideSet = false;
    this.zoom = 1;
    this.hover = null;
    this.announced.clear();
    this.pending.clear();
    for (const s of site.junk.slots) if (slotOpen(s)) this.announced.add(s);
    this.markerMat ??= site.junk.steps[0]?.marker.material as THREE.Material ?? null;
    tools.frozen = true;
    if (document.pointerLockElement) ui.debugFreed = true; // freed on purpose: don't open the Esc menu (src/menu.ts)
    document.exitPointerLock();
    this.ui.setPhase('walk');
    site.link?.join();
    if (!site.junk.root.parent) this.scene.add(site.junk.root);
    this.home.set(site.x, site.ground(site.x, site.z), site.z);
    this.computeRest();
    site.junk.root.position.y = this.restY;
    this.refreshCard();
  }

  /** Stop: the controls come back (the camera swings back from the table). */
  end() {
    const site = this.site;
    if (!site) return;
    this.endInteraction();
    // Nothing of the mode stays on screen: no markers, no part rings.
    for (const s of site.junk.steps) {
      s.marker.visible = false;
      if (this.markerMat) s.marker.material = this.markerMat;
    }
    for (const s of site.junk.slots) s.ring.visible = false;
    // Takes still waiting for an answer count as given (the server has them).
    for (const [i] of this.pending) this.applyTook(i, true);
    for (const l of this.loose) this.scene.remove(l.obj);
    this.loose = [];
    site.link?.leave();
    site.changed?.();
    site.closed?.();
    this.site = null;
    this.hover = null;
    this.phase = 'idle';
    tools.frozen = false;
    this.ui.setPhase('off');
  }

  /** Called every frame before the input is read. Walks the character to the machine, eases the view onto it,
   *  and returns the input bits to use instead of the keyboard (0 when working). */
  drive(look: { yaw: number; pitch: number }, me: { x: number; z: number }, dt: number): number {
    const site = this.site;
    if (!site || this.phase === 'idle') return 0;
    const dx = site.x - me.x, dz = site.z - me.z;
    const d = Math.hypot(dx, dz);
    const stand = site.stand ?? STAND;
    const leave = stand + LEAVE_MARGIN;
    if (d > leave) {
      this.end(); // walked away, died or teleported
      return 0;
    }
    if (!this.sideSet) {
      this.sideSet = true;
      if (d > 0.2) this.side.set(-dx / d, 0, -dz / d);
    }
    this.look = look;
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
    const eased = 1 - Math.exp(-dt * 7);
    look.yaw += wrap(Math.atan2(-dx, -dz) + this.lookYaw - look.yaw) * eased;
    const eye = this.camera.position;
    const wantPitch = Math.atan2(this.home.y + 0.5 - eye.y, Math.max(d, 0.5));
    look.pitch += (wantPitch + this.lookPitch - look.pitch) * eased;
    if (this.phase === 'work') {
      // At the table the keys turn the machine (update()); you stay where you are.
      if (site.movable) return 0;
      // W / S step closer and further, A / D around (the arrow keys too).
      const left = keyHeld('KeyA') || keyHeld('ArrowLeft');
      const right = keyHeld('KeyD') || keyHeld('ArrowRight');
      const fwd = keyHeld('KeyW') || keyHeld('ArrowUp');
      const back = keyHeld('KeyS') || keyHeld('ArrowDown');
      let bits = 0;
      if (left) bits |= LEFT;
      if (right) bits |= RIGHT;
      if (fwd && d > MIN_DIST) bits |= FORWARD;
      else if (back) bits |= BACK;
      if (fwd || back) this.workDist = d;
      else if (bits && Math.abs(this.lookYaw) < 0.3) bits |= d > this.workDist + 0.25 ? FORWARD : d < this.workDist - 0.25 ? BACK : 0; // keep the circle
      const far = d > leave - 1.2;
      if (far && !this.farWarned) this.ui.message('Too far', true);
      this.farWarned = far;
      return bits;
    }
    this.walkFor += dt;
    if ((d <= stand + 0.15 && d >= stand - 0.5) || this.walkFor > WALK_TIMEOUT) {
      this.phase = 'work';
      this.workDist = d;
      this.ui.setPhase('work');
      this.refreshCard();
      this.nextAt = 0;
      return 0;
    }
    return d > stand + 0.15 ? FORWARD : BACK;
  }

  /** Called every frame after the game camera is placed: at the table, swing it to a fixed view above the
   *  machine (and back again after leaving). The pointer rays use the same camera, so clicks follow it. */
  placeCamera(dt: number) {
    const want = this.overhead && this.phase !== 'idle' ? 1 : 0;
    this.camK = want > this.camK ? Math.min(1, this.camK + dt / CAM_BLEND) : Math.max(0, this.camK - dt / CAM_BLEND);
    if (this.camK <= 0) return;
    if (want) {
      // Above the machine, from the side you stand on, looking down at it (three-quarter, so sides still read).
      const z = this.zoom;
      const target = this.hit.copy(this.home).setY(this.home.y + 0.12).addScaledVector(this.side, 0.08);
      this.camPos.copy(this.home).addScaledVector(this.side, OVER_BACK * z).setY(this.home.y + OVER_UP * z);
      this.camM.lookAt(this.camPos, target, THREE.Object3D.DEFAULT_UP);
      this.camQuat.setFromRotationMatrix(this.camM);
    }
    const k = this.camK * this.camK * (3 - 2 * this.camK);
    const cam = this.camera;
    this.fromPos.copy(cam.position);
    this.fromQuat.copy(cam.quaternion);
    cam.position.lerpVectors(this.fromPos, this.camPos, k);
    cam.quaternion.slerpQuaternions(this.fromQuat, this.camQuat, k);
    cam.updateMatrixWorld();
  }

  // ---- remote events (large sites) -------------------------------------------------------------------------

  /** Another player (or the server's snapshot, with `silent`) did step i. */
  applyDone(i: number, silent = false) {
    const s = this.site?.junk.steps[i];
    if (s && !s.done) this.finish(s, silent ? 'silent' : 'remote');
  }
  /** Part i (Slot.index) was taken by `mine` or someone else. */
  applyTake(i: number, mine: boolean) {
    const slot = this.site?.junk.slots.find((s) => s.index === i);
    if (!slot) return;
    if (this.pending.has(i)) {
      this.applyTook(i, mine, mine ? undefined : 'taken');
      if (mine) return;
    }
    if (!slot.taken) {
      slot.taken = true;
      slot.ring.visible = false;
      slot.piece.obj.removeFromParent();
    }
    this.refreshCard();
  }

  // ---- taking parts ----------------------------------------------------------------------------------------

  /** Left click on a freed part: it is hidden at once (it stays in its holder) and the take goes out; applyTook()
   *  finishes it: it flies to the bag, or shows again with the reason. This and applyTook() are the whole take path. */
  private takePart(slot: Slot, x: number, y: number) {
    const site = this.site!;
    const i = slot.index;
    if (i < 0 || this.pending.has(i)) return;
    slot.taken = true;
    slot.ring.visible = false;
    slot.piece.obj.visible = false;
    this.pending.set(i, { slot, x, y });
    this.hover = null;
    if (site.link) site.link.take(i);
    else this.applyTook(i, true); // working alone: nobody to ask
  }

  /** The server answered our take of part i: given (it flies to the bag), or refused, and then it shows again
   *  on the machine to take later. */
  applyTook(i: number, ok: boolean, reason?: 'full' | 'taken') {
    const p = this.pending.get(i);
    const site = this.site;
    if (!p || !site) return;
    this.pending.delete(i);
    const s = p.slot;
    this.onTake?.({ part: s.part as PartId, tier: s.tier as Tier, ok, reason });
    if (ok) {
      s.piece.obj.removeFromParent();
      s.piece.obj.visible = true;
      this.ui.fly(p.x, p.y, s.part as PartId, s.tier as Tier);
      const j = site.junk;
      site.changed?.();
      this.computeRest();
    } else {
      s.piece.obj.visible = true;
      s.taken = false;
      this.ui.message(reason === 'full' ? 'Bag full' : reason === 'taken' ? 'Taken' : 'Failed', true);
      if (reason === 'full') uiSound.full();
    }
    this.refreshCard();
  }

  // ---- machine ---------------------------------------------------------------------------------------------

  private refreshCard() {
    const site = this.site;
    const j = site?.junk;
    if (!site || !j) return;
    this.ui.setProgress({
      label: site.label, tier: j.tier, stepsDone: j.steps.filter((s) => s.done).length, steps: j.steps.length,
      partsTaken: j.slots.filter((s) => s.taken).length, parts: j.slots.length, shared: !!site.link && !site.movable,
    });
    this.nextAt = 0;
  }

  /** Only when nothing is left on the side you look at: how many steps wait on another side. */
  private nextHint(): string {
    const j = this.site!.junk;
    if (j.slots.some((s) => slotOpen(s) && !this.pendingSlot(s))) return '';
    const ready = j.steps.filter(stepReady);
    return ready.length && !ready.some((s) => this.faces(s)) ? `${ready.length} on another side` : '';
  }

  private pendingSlot(s: Slot) {
    for (const p of this.pending.values()) if (p.slot === s) return true;
    return false;
  }

  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  /** The step's face points at the camera. */
  private faces(s: Step) {
    const p = s.obj.getWorldPosition(this.tmpA);
    const n = this.tmpB.set(0, 1, 0).applyQuaternion(s.obj.getWorldQuaternion(this.tmpQ));
    if (s.kind === 'wire') return true; // wires run every way
    return n.dot(p.sub(this.camera.position).negate()) > 0;
  }

  /** Height at which the machine rests on the ground in its current orientation. */
  private computeRest() {
    const j = this.site?.junk;
    if (!j) return;
    const off = lowestOffset(j.root);
    if (off !== null) this.restY = this.home.y + off;
  }

  private spinJunk(yaw: number, pitch: number) {
    const j = this.site?.junk;
    if (!j) return;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    if (pitch) {
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      right.y = 0;
      if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
      q.premultiply(new THREE.Quaternion().setFromAxisAngle(right.normalize(), pitch));
    }
    j.root.quaternion.premultiply(q);
    this.computeRest();
  }

  private resetRotation() {
    const j = this.site?.junk;
    if (!j) return;
    j.root.quaternion.identity();
    this.computeRest();
  }

  // ---- pointer ---------------------------------------------------------------------------------------------

  private ray(x: number, y: number) {
    this.ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  /** What is under the pointer: only the nearest surface counts, so lids and plates hide what is under them. */
  private pick(x: number, y: number): Target | null {
    if (!this.site) return null;
    this.ray(x, y);
    const h = this.raycaster.intersectObject(this.site.junk.root, true).find((i) => this.shown(i.object));
    let hit: Target | null = null;
    for (let o: THREE.Object3D | null = h?.object ?? null; o && !hit; o = o.parent) hit = (o.userData.target as Target | undefined) ?? null;
    if (hit?.type === 'step' || hit?.type === 'part') return hit;
    // A freed part counts when the pointer is on it or its tag, even where the machine hides it.
    const j = this.site.junk;
    for (const s of j.slots) {
      if (!slotOpen(s) || this.pendingSlot(s)) continue;
      for (const up of [0, TAG_UP * j.scale * j.root.scale.x]) {
        const p = this.screen(s.piece.obj, up);
        if (p && Math.hypot(p.x - x, p.y - y) < 34) return { type: 'part', slot: s };
      }
    }
    return hit;
  }

  /** Not inside a hidden group (a part waiting for the server). */
  private shown(o: THREE.Object3D) {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible && !(p as THREE.Mesh).isMesh) return false;
    return true;
  }

  /** Where the pointer ray crosses the horizontal plane at `y`. */
  private onPlane(e: PointerEvent, y: number): THREE.Vector3 | null {
    this.ray(e.clientX, e.clientY);
    this.plane.constant = -y;
    return this.raycaster.ray.intersectPlane(this.plane, this.hit) ? this.hit : null;
  }

  private holders(s: Step): number {
    const link = this.site?.link;
    if (!link) return 1;
    return link.holders(this.site!.junk.steps.indexOf(s));
  }

  /** "Lid screw ×4, rear latch": the undone steps in `steps`, grouped. */
  private listSteps(steps: Step[]) {
    const by = new Map<string, number>();
    for (const s of steps) if (!s.done) by.set(s.label.toLowerCase(), (by.get(s.label.toLowerCase()) ?? 0) + 1);
    return [...by].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l)).join(', ');
  }

  /** The tip for a target: title, the exact action, and whether it is locked (then the action says why). */
  private describe(t: Target | null): { title: string; action: string; locked?: boolean; color?: string } | null {
    if (!t) return null;
    if (t.type === 'step') {
      const s = t.step;
      const b = s.after.filter((a) => !a.done);
      if (b.length) return { title: s.label, action: `after ${this.listSteps(b)}`, locked: true };
      switch (s.kind) {
        case 'screw': return { title: s.label, action: `×${s.need - Math.floor(s.progress)}` };
        case 'clip': return { title: s.label, action: s.need > 1 ? `×${s.need - Math.floor(s.progress)}` : '' };
        case 'bolt': return { title: s.label, action: 'circle' };
        case 'wire': return { title: s.label, action: 'swipe' };
        case 'pry': return { title: s.label, action: 'pry' };
        case 'lift': {
          const n = SOLO ? s.players : this.holders(s);
          return { title: s.label, action: `${n}/${s.players} players` };
        }
      }
    }
    if (t.type === 'part') {
      const s = t.slot;
      const title = partName(s.part as PartId, s.tier as Tier);
      const color = rarityColor(s.tier as Tier);
      if (slotOpen(s)) return { title, color, action: '' };
      return { title, color, action: this.listSteps(s.piece.holds), locked: true };
    }
    return null;
  }

  private onDown(e: PointerEvent) {
    if (this.phase !== 'work' || !this.site) return;
    if ((e.target as HTMLElement).closest('.panel')) return;
    if (this.drag || this.act) return;
    this.ui.overlay.setPointerCapture(e.pointerId);
    this.button = e.button;
    this.px = e.clientX;
    this.py = e.clientY;
    const turn = () => {
      this.drag = this.site!.movable ? { kind: 'rotate', x: e.clientX, y: e.clientY, moved: false } : { kind: 'look', x: e.clientX, y: e.clientY, moved: false };
    };
    if (e.button === 1) return turn();
    const target = this.pick(e.clientX, e.clientY);
    if (e.button === 2) {
      if (target && this.site.movable) {
        const j = this.site.junk;
        const p = this.onPlane(e, j.root.position.y);
        if (p) this.drag = { kind: 'junk', offset: j.root.position.clone().sub(p).setY(0) };
        this.ui.overlay.style.cursor = 'grabbing';
      }
      return;
    }
    if (e.button !== 0) return;
    if (target?.type === 'step') {
      if (stepReady(target.step)) this.startStep(target.step, e);
      else this.ui.message(this.describe(target)!.action, true);
      return;
    }
    if (target?.type === 'part') {
      if (slotOpen(target.slot)) this.takePart(target.slot, e.clientX, e.clientY);
      else this.ui.message(this.describe(target)!.action, true);
      return;
    }
    turn();
  }

  private startStep(s: Step, e: PointerEvent) {
    const v = new THREE.Vector3();
    s.obj.getWorldPosition(v).project(this.camera);
    const cx = ((v.x + 1) / 2) * innerWidth;
    const cy = ((1 - v.y) / 2) * innerHeight;
    this.act = { step: s, x0: e.clientX, y0: e.clientY, angle: Math.atan2(e.clientY - cy, e.clientX - cx), cx, cy, dist: 0 };
    if (s.kind === 'lift') {
      this.site!.link?.hold(this.site!.junk.steps.indexOf(s), s.players, true);
      return;
    }
    if (s.kind === 'screw' || s.kind === 'clip') {
      s.progress++;
      this.show(s);
      if (s.progress >= s.need) this.complete(s);
      else teardownSound.hit(s.kind === 'screw' ? 'tink' : 'clink', 0.8);
    }
  }

  private onMove(e: PointerEvent) {
    this.px = e.clientX;
    this.py = e.clientY;
    if (this.phase !== 'work' || !this.site) return;
    const d = this.drag;
    if (d?.kind === 'rotate' || d?.kind === 'look') {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
      d.moved = true;
      d.x = e.clientX;
      d.y = e.clientY;
      this.ui.overlay.style.cursor = 'grabbing';
      if (d.kind === 'rotate') {
        this.spinJunk(dx * 0.01, dy * 0.01);
        return;
      }
      this.lookYaw = THREE.MathUtils.clamp(this.lookYaw - dx * LOOK_SENS, -1.6, 1.6);
      this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - dy * LOOK_SENS, -1.0, 1.0);
      if (this.look) {
        this.look.yaw -= dx * LOOK_SENS; // at once, the easing follows
        this.look.pitch = THREE.MathUtils.clamp(this.look.pitch - dy * LOOK_SENS, -1.45, 1.45);
      }
      return;
    }
    if (d?.kind === 'junk') {
      const j = this.site.junk;
      const p = this.onPlane(e, j.root.position.y);
      if (p) {
        const nx = p.x + d.offset.x, nz = p.z + d.offset.z;
        const dx = nx - this.home.x, dz = nz - this.home.z;
        const k = Math.min(1, (this.site.radius * 0.5) / Math.max(Math.hypot(dx, dz), 1e-6));
        j.root.position.x = this.home.x + dx * k;
        j.root.position.z = this.home.z + dz * k;
      }
      return;
    }
    if (this.act) {
      this.moveStep(this.act, e);
      return;
    }
    this.hover = this.pick(e.clientX, e.clientY);
  }

  private moveStep(a: NonNullable<TeardownView['act']>, e: PointerEvent) {
    const s = a.step;
    if (s.kind === 'bolt') {
      if (Math.hypot(e.clientX - a.cx, e.clientY - a.cy) < 14) return;
      const ang = Math.atan2(e.clientY - a.cy, e.clientX - a.cx);
      let dA = ang - a.angle;
      dA = Math.atan2(Math.sin(dA), Math.cos(dA));
      a.angle = ang;
      s.progress += Math.abs(dA) / Math.PI;
      if (dA) teardownSound.turn();
    } else if (s.kind === 'wire') {
      // Only strokes that actually cross the wire count.
      const t = this.pick(e.clientX, e.clientY);
      if (t?.type === 'step' && t.step === s) a.dist += Math.hypot(e.movementX, e.movementY);
      s.progress = Math.min(s.need, (a.dist / CUT_PX) * s.need);
    } else if (s.kind === 'pry') {
      s.progress = Math.min(s.need, (Math.hypot(e.clientX - a.x0, e.clientY - a.y0) / PRY_PX) * s.need);
    } else return;
    this.show(s);
    if (s.progress >= s.need) {
      this.act = null;
      teardownSound.stop();
      this.complete(s);
    }
  }

  private onUp(e: PointerEvent) {
    if (this.ui.overlay.hasPointerCapture(e.pointerId)) this.ui.overlay.releasePointerCapture(e.pointerId);
    if (e.button !== this.button) return;
    this.button = -1;
    if (this.drag) {
      this.drag = null;
      this.ui.overlay.style.cursor = '';
    }
    const a = this.act;
    if (a) {
      const s = a.step;
      if (s.kind === 'bolt') teardownSound.stop();
      if (s.kind === 'lift') this.site?.link?.hold(this.site.junk.steps.indexOf(s), s.players, false);
      // A half-cut wire, half-pried tab or half-lifted weight falls back; a half-turned bolt stays where it is.
      if (!s.done && (s.kind === 'wire' || s.kind === 'pry' || s.kind === 'lift')) {
        s.progress = 0;
        this.show(s);
      }
      this.act = null;
    }
    if (this.site) this.hover = this.pick(e.clientX, e.clientY);
  }

  private endInteraction() {
    const a = this.act;
    if (a?.step.kind === 'lift') this.site?.link?.hold(this.site.junk.steps.indexOf(a.step), a.step.players, false);
    teardownSound.stop();
    this.drag = null;
    this.act = null;
    this.button = -1;
    this.ui.overlay.style.cursor = '';
  }

  // ---- tearing down ----------------------------------------------------------------------------------------

  /** Show how far a step has got. */
  private show(s: Step) {
    const f = s.progress / s.need;
    switch (s.kind) {
      case 'screw':
        s.spin.rotation.y = s.progress * 2.4;
        s.spin.position.y = Math.min(f, 1) * 0.07;
        break;
      case 'bolt':
        s.spin.rotation.y = s.progress * Math.PI;
        s.spin.position.y = Math.min(f, 1) * 0.08;
        break;
      case 'clip':
        s.spin.rotation.z = Math.min(f, 1) * 1.3;
        break;
      case 'pry':
        s.spin.rotation.x = -Math.min(f, 1) * 0.9;
        break;
      case 'lift':
        s.spin.position.y = Math.min(f, 1) * 0.12;
        break;
      case 'wire':
        if (s.mat) {
          s.mat.emissive.setHex(0xff7a20);
          s.mat.emissiveIntensity = Math.min(f, 1) * 3;
        }
        break;
    }
  }

  private release(obj: THREE.Object3D, floorY: number, life: number, vel: THREE.Vector3, spin: THREE.Vector3): Loose {
    this.scene.attach(obj); // keeps the world transform
    const l: Loose = { obj, vel, spin, floorY: floorY * (this.site?.junk.scale ?? 1) * (this.site?.junk.root.scale.x ?? 1), life };
    this.loose.push(l);
    return l;
  }

  /** The player finished a step: tell the others, and apply it here (lifts wait for the server to agree). */
  private complete(s: Step) {
    const site = this.site!;
    const i = site.junk.steps.indexOf(s);
    if (s.kind === 'lift') {
      // The server checks that enough players held it; its answer (applyDone) does the rest.
      s.progress = s.need;
      site.link?.done(i);
      if (!site.link || SOLO) this.finish(s, 'local');
      return;
    }
    this.finish(s, 'local');
    site.link?.done(i);
  }

  private finish(s: Step, how: 'local' | 'remote' | 'silent') {
    s.done = true;
    s.progress = s.need;
    s.hit.removeFromParent();
    s.marker.visible = false;
    if (this.act?.step === s) this.act = null;
    if (this.hover?.type === 'step' && this.hover.step === s) this.hover = null;
    if (how === 'silent') s.obj.removeFromParent();
    else {
      const r = () => (Math.random() - 0.5) * 2;
      // The finished fastener pops off along its own normal.
      const n = new THREE.Vector3(0, 1, 0).applyQuaternion(s.obj.getWorldQuaternion(new THREE.Quaternion()));
      const vel = n.multiplyScalar(s.kind === 'wire' ? 0.5 : 1.8).add(new THREE.Vector3(r() * 0.6, 2.2, r() * 0.6));
      this.release(s.obj, s.floorY, 8, vel, new THREE.Vector3(r() * 10, r() * 10, r() * 10));
    }
    const j = this.site!.junk;
    const freed = j.pieces.filter((p) => !p.released && p.holds.every((h) => h.done));
    for (const p of freed) this.releasePiece(p, how === 'silent');
    if (how !== 'silent') {
      // The fastener comes off; a cover it was holding drops off with a clang.
      const level = how === 'remote' ? 0.6 : 1;
      teardownSound.hit(s.kind === 'pry' || s.kind === 'wire' ? 'soft' : 'clink', level);
      if (freed.length || s.kind === 'lift') teardownSound.hit('clang', level);
    }
    this.computeRest();
    this.refreshCard();
    this.site!.changed?.();
    if (how === 'silent') return;
    const fresh = j.slots.filter((x) => slotOpen(x) && !this.announced.has(x));
    for (const x of fresh) this.announced.add(x);
  }

  private releasePiece(p: Piece, silent: boolean) {
    p.released = true;
    if (silent) {
      p.obj.removeFromParent();
      return;
    }
    const r = () => (Math.random() - 0.5) * 2;
    const n = new THREE.Vector3(...p.pop).normalize().applyQuaternion(this.site!.junk.root.quaternion);
    const vel = n.multiplyScalar(2).add(new THREE.Vector3(r(), 2.8, r()));
    this.release(p.obj, p.floorY, 12, vel, new THREE.Vector3(r() * 2, r() * 2, r() * 2));
  }

  // ---- per frame -------------------------------------------------------------------------------------------

  private screen(o: THREE.Object3D, up = 0): { x: number; y: number } | null {
    const v = o.getWorldPosition(this.tmpA);
    v.y += up;
    v.project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
  }

  update(dt: number) {
    const site = this.site;
    if (!site || this.phase === 'idle') return;
    this.pulse += dt;
    const j = site.junk;
    const working = this.phase === 'work'; // markers, rings and tips only once you are at the machine

    // On the table the keys turn the machine.
    if (working && site.movable) {
      const h = (a: string, b: string) => (keyHeld(a) || keyHeld(b) ? 1 : 0);
      const yaw = h('KeyD', 'ArrowRight') - h('KeyA', 'ArrowLeft');
      const pitch = h('KeyS', 'ArrowDown') - h('KeyW', 'ArrowUp');
      if (yaw || pitch) this.spinJunk(yaw * KEY_TURN * dt, pitch * KEY_TURN * dt);
    }

    // Lifts: progress only while enough players hold it.
    const a = this.act;
    if (a?.step.kind === 'lift' && !a.step.done) {
      const s = a.step;
      const n = SOLO ? s.players : this.holders(s);
      if (s.progress < s.need) {
        s.progress = n >= s.players ? Math.min(s.need, s.progress + dt) : Math.max(0, s.progress - dt * 2);
        this.show(s);
        if (s.progress >= s.need) {
          this.act = null;
          this.complete(s);
        }
      }
    }

    // Stay put on the ground (the workbench or the sand), easing down after a turn or a lift.
    const held = this.drag?.kind === 'junk';
    this.lift += ((held ? 0.35 : 0) - this.lift) * Math.min(1, dt * 12);
    const y = j.root.position.y;
    j.root.position.y = y + (this.restY + this.lift - y) * Math.min(1, dt * (held ? 14 : 9));

    // Highlight: the step under the pointer, or what is in the way of the thing under the pointer.
    const focus: Target | null = this.act ? { type: 'step', step: this.act.step } : this.drag ? null : this.hover;
    this.lit.clear();
    if (focus?.type === 'step') {
      const b = focus.step.after.filter((x) => !x.done);
      for (const s of b.length ? b : [focus.step]) this.lit.add(s);
    } else if (focus?.type === 'part' && !slotOpen(focus.slot)) for (const s of focus.slot.piece.holds) if (!s.done) this.lit.add(s);
    const wob = 1 + 0.12 * Math.sin(this.pulse * 6);
    for (const s of j.steps) {
      const lit = this.lit.has(s);
      s.marker.visible = working && !s.done && (stepReady(s) || lit);
      s.marker.scale.setScalar(lit ? 1.15 + 0.1 * Math.sin(this.pulse * 10) : wob * 0.7);
      if (this.markerMat) s.marker.material = lit ? HOVER_MAT : this.markerMat;
    }
    const hoverSlot = focus?.type === 'part' ? focus.slot : null;
    for (const s of j.slots) {
      s.ring.visible = working && slotOpen(s);
      s.ring.scale.setScalar((s === hoverSlot ? 1.18 : 1) + 0.08 * Math.sin(this.pulse * 5));
    }

    if (working) this.updateUi(dt);

    for (let i = this.loose.length - 1; i >= 0; i--) {
      const l = this.loose[i];
      const o = l.obj;
      l.life -= dt;
      if (l.life < 0.5) o.scale.setScalar(Math.max(l.life / 0.5, 0.001));
      if (l.life <= 0) {
        this.scene.remove(o);
        this.loose.splice(i, 1);
        continue;
      }
      l.vel.y -= GRAVITY * dt;
      o.position.addScaledVector(l.vel, dt);
      o.rotation.x += l.spin.x * dt;
      o.rotation.y += l.spin.y * dt;
      o.rotation.z += l.spin.z * dt;
      const floor = site.ground(o.position.x, o.position.z) + l.floorY;
      if (o.position.y <= floor) {
        o.position.y = floor;
        l.vel.y = l.vel.y < -1 ? -l.vel.y * 0.3 : 0;
        const k = Math.exp(-dt * 8);
        l.vel.x *= k;
        l.vel.z *= k;
        l.spin.multiplyScalar(Math.exp(-dt * 10));
        const lay = 1 - Math.exp(-dt * 10); // settle upright
        o.rotation.x -= o.rotation.x * lay;
        o.rotation.z -= o.rotation.z * lay;
      }
      const dx = o.position.x - this.home.x, dz = o.position.z - this.home.z;
      const dd = Math.hypot(dx, dz);
      if (dd > site.radius) {
        o.position.x = this.home.x + (dx / dd) * site.radius;
        o.position.z = this.home.z + (dz / dd) * site.radius;
      }
    }
  }

  /** The tip, progress ring, part tags and the "next" line. */
  private updateUi(dt: number) {
    const site = this.site!;
    const j = site.junk;
    // Tip: what the pointer is on (or the step being worked).
    const a = this.act;
    const t = a ? { type: 'step' as const, step: a.step } : this.drag ? null : this.hover;
    const d = Number.isFinite(this.px) && (!a || a.step.kind === 'lift') ? this.describe(t) : null;
    this.ui.tip(d && { ...d, x: this.px, y: this.py });
    const cursor = this.drag ? 'grabbing' : !t ? (this.hover ? 'grab' : '') : d?.locked ? 'not-allowed' : 'pointer';
    if (this.ui.overlay.style.cursor !== cursor) this.ui.overlay.style.cursor = cursor;

    // Ring: around the step being worked, or a hovered one that is part-way done (a half-turned bolt).
    const rs = a?.step ?? (t?.type === 'step' && t.step.progress > 0 && !t.step.done ? t.step : null);
    if (rs && rs.kind !== 'wire') {
      const p = a && rs.kind === 'bolt' ? { x: a.cx, y: a.cy } : this.screen(rs.obj);
      this.ui.ring(p && { ...p, f: rs.progress / rs.need, guide: rs.kind === 'bolt' });
    } else if (a?.step.kind === 'wire') this.ui.ring({ x: this.px, y: this.py, f: a.step.progress / a.step.need });
    else this.ui.ring(null);

    // Tags over the freed parts.
    const tags: { x: number; y: number; text: string; color: string }[] = [];
    for (const s of j.slots) {
      if (!slotOpen(s)) continue;
      const p = this.screen(s.piece.obj, TAG_UP * j.scale * j.root.scale.x);
      if (p) tags.push({ ...p, text: partName(s.part as PartId, s.tier as Tier), color: rarityColor(s.tier as Tier) });
    }
    this.ui.tags(tags);

    this.nextAt -= dt;
    if (this.nextAt <= 0) {
      this.nextAt = 0.25;
      this.ui.setNext(this.nextHint());
    }
  }
}
