// Disassembly mode. At a machine site you press F: the character walks up to a set distance, the normal controls
// give way to the disassembly ones, and the machine in front of you comes apart right there in the world.
//   Left mouse   interact: click screws and clips, circle the pointer around big bolts, swipe across wires to cut
//                them, drag pry tabs away, hold a lifting eye (heavy things need two players holding together).
//   Right mouse  drag: carry a freed part to the tray; with a carried (small) machine, move it about the bench.
//   Middle mouse drag: look around (a small machine on the table is turned over instead, also with the arrow keys).
//   W / S / A / D: step closer, further, and around. Walk too far and the mode ends.
// Steps sit on every face, so a small machine has to be turned over and around. Large machines are too heavy to
// turn or move: you walk around them instead, and none of their steps faces down. They stay where they
// lie and are worked on by everyone near them through a shared session (SiteLink, server/crash.ts); small ones
// are carried home and taken apart alone on the disassembly table. Loose-piece physics is plain frame-time maths: it is
// only cosmetic, nothing here moves players (the walk-up goes through the normal input path).
// A part goes in your backpack the moment you pull it free (WorkSite.take: the server checks it against the
// machine's roll, shared/parts.ts); with the backpack full it stays in the machine, and a part the server refuses
// goes back in (applyRefused).
import * as THREE from 'three/webgpu';
import { BACK, FORWARD, LEFT, RIGHT } from '../../shared/sim.ts';
import { PART_LABELS, partItem } from '../../shared/parts.ts';
import { RARITY, type ComponentKind } from '../../shared/salvage.ts';
import { keyHeld, tools, ui } from '../input.ts';
import { lowestOffset, slotOpen, stepReady, type Junk, type Piece, type Slot, type Step, type Target } from './junk.ts';
import { TeardownUi } from './ui.ts';

/** Something to work on: a machine at a crash site, or a carried one on the workbench. */
export interface WorkSite {
  id: string;
  kind: ComponentKind;
  label: string;
  junk: Junk;
  /** Where the machine lies on the ground (its centre). */
  x: number;
  z: number;
  /** Ground height at (x, z): terrain, or the table top for the workbench. */
  ground: (x: number, z: number) => number;
  /** Loose pieces and the machine stay within this distance of (x, z). */
  radius: number;
  /** A carried machine can be dragged around; a big one stays put (it can still be turned over). */
  movable: boolean;
  /** How far from the machine you stand to work (default STAND). */
  stand?: number;
  /** Shared with other players through the server (large sites); null when working alone. */
  link: SiteLink | null;
  /** Part slot i (item `kind`) was pulled free: into the backpack (src/net.ts). False if it is full. */
  take: (i: number, kind: string) => boolean;
  /** The state changed (a step done, a part taken): the workbench saves its job. */
  changed?: () => void;
  /** The mode was left (the workbench tidies its table). */
  closed?: () => void;
}

/** The disassembly table job's connection to the server (src/net.ts): steps done, parts taken, the machine empty. */
export interface BenchLink {
  done(i: number): void;
  take(i: number, kind: string): boolean;
  clear(): void;
}

/** The connection to the server's shared session for a large site (src/net.ts). */
export interface SiteLink {
  join(): void;
  leave(): void;
  /** A step was done here (it is also done for everyone else). */
  done(i: number): void;
  /** Part slot i (item `kind`) taken: first one wins. False (nothing sent) if the backpack is full. */
  take(i: number, kind: string): boolean;
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
  /** Seconds until it shrinks away (debris); null for parts, which stay until collected. */
  life: number | null;
  held: boolean;
  slot?: Slot;
}

const GRAVITY = 16;
const PART_HOVER = 0.7;
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
const VERB: Record<Step['kind'], string> = {
  screw: 'click to unscrew',
  bolt: 'circle the pointer around it',
  clip: 'click to unclip',
  wire: 'swipe across it to cut',
  pry: 'drag it away to pry',
  lift: 'hold the mouse button',
};
/** ?debug lets one player do two-player lifts, for testing. */
const SOLO = new URLSearchParams(location.search).has('debug');

type Phase = 'idle' | 'walk' | 'work';

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
  /** Where each detached part sat in the machine, to put it back if the server refuses the take. */
  private homes = new Map<Slot, { parent: THREE.Object3D; pos: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3 }>();

  /** Left-button interaction with a step. */
  private act: { step: Step; x0: number; y0: number; angle: number; cx: number; cy: number; dist: number } | null = null;
  private drag:
    | { kind: 'junk'; offset: THREE.Vector3 }
    | { kind: 'rotate'; x: number; y: number }
    | { kind: 'look'; x: number; y: number }
    | { kind: 'part'; loose: Loose }
    | null = null;
  private button = -1;

  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene;
    this.camera = camera;
    this.ui = new TeardownUi(() => this.end());
    const o = this.ui.overlay;
    o.addEventListener('pointerdown', (e) => this.onDown(e));
    o.addEventListener('pointermove', (e) => this.onMove(e));
    o.addEventListener('pointerup', (e) => this.onUp(e));
    o.addEventListener('pointercancel', (e) => this.onUp(e));
    // Middle button would start the browser's autoscroll.
    o.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    o.addEventListener('auxclick', (e) => e.preventDefault());
    o.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    addEventListener('keydown', (e) => {
      if (this.phase === 'idle' || e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement) return;
      if (e.code === 'Escape') this.end();
      if (this.phase !== 'work' || !this.site) return;
      if (e.code === 'KeyR') {
        if (this.site.movable) this.resetRotation();
        else this.lookYaw = this.lookPitch = 0;
      }
      if (!this.site.movable) return;
      const k = 0.18;
      if (e.code === 'ArrowLeft') this.spinJunk(-k, 0);
      if (e.code === 'ArrowRight') this.spinJunk(k, 0);
      if (e.code === 'ArrowUp') this.spinJunk(0, -k);
      if (e.code === 'ArrowDown') this.spinJunk(0, k);
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
    this.announced.clear();
    this.homes.clear();
    this.ui.clearTray();
    for (const s of site.junk.slots) if (slotOpen(s)) this.announced.add(s);
    tools.frozen = true;
    if (document.pointerLockElement) ui.debugFreed = true; // freed on purpose: don't open the Esc menu (src/menu.ts)
    document.exitPointerLock();
    this.ui.setPhase('walk', site.label, site.movable);
    site.link?.join();
    if (!site.junk.root.parent) this.scene.add(site.junk.root);
    this.home.set(site.x, site.ground(site.x, site.z), site.z);
    this.computeRest();
    site.junk.root.position.y = this.restY;
    this.refreshCard();
  }

  /** Stop: whatever lies loose goes in the tray, the controls come back. */
  end() {
    const site = this.site;
    if (!site) return;
    this.endInteraction();
    // Nothing of the mode stays on screen: no markers, no part rings.
    for (const s of site.junk.steps) s.marker.visible = false;
    for (const s of site.junk.slots) s.ring.visible = false;
    for (const l of [...this.loose]) {
      if (l.slot) this.collect(l, false);
      else this.scene.remove(l.obj);
    }
    this.loose = [];
    site.link?.leave();
    site.changed?.();
    site.closed?.();
    this.site = null;
    this.phase = 'idle';
    tools.frozen = false;
    this.ui.setPhase('off', '');
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
    this.look = look;
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
    const eased = 1 - Math.exp(-dt * 7);
    look.yaw += wrap(Math.atan2(-dx, -dz) + this.lookYaw - look.yaw) * eased;
    const eye = this.camera.position;
    const wantPitch = Math.atan2(this.home.y + 0.5 - eye.y, Math.max(d, 0.5));
    look.pitch += (wantPitch + this.lookPitch - look.pitch) * eased;
    if (this.phase === 'work') {
      // W / S step closer and further, A / D around (the arrow keys too, except where they turn a small machine).
      const arrows = !site.movable;
      const left = keyHeld('KeyA') || (arrows && keyHeld('ArrowLeft'));
      const right = keyHeld('KeyD') || (arrows && keyHeld('ArrowRight'));
      const fwd = keyHeld('KeyW') || (arrows && keyHeld('ArrowUp'));
      const back = keyHeld('KeyS') || (arrows && keyHeld('ArrowDown'));
      let bits = 0;
      if (left) bits |= LEFT;
      if (right) bits |= RIGHT;
      if (fwd && d > MIN_DIST) bits |= FORWARD;
      else if (back) bits |= BACK;
      if (fwd || back) this.workDist = d;
      else if (bits && Math.abs(this.lookYaw) < 0.3) bits |= d > this.workDist + 0.25 ? FORWARD : d < this.workDist - 0.25 ? BACK : 0; // keep the circle
      const far = d > leave - 1.2;
      if (far && !this.farWarned) this.ui.setHint('Step back any further and you leave the disassembly');
      this.farWarned = far;
      return bits;
    }
    this.walkFor += dt;
    if ((d <= stand + 0.15 && d >= stand - 0.5) || this.walkFor > WALK_TIMEOUT) {
      this.phase = 'work';
      this.workDist = d;
      this.ui.setPhase('work', site.label, site.movable);
      this.ui.setHint(`${site.label}: ${RARITY[site.junk.tier].name}. ${this.firstHint()}`);
      return 0;
    }
    return d > stand + 0.15 ? FORWARD : BACK;
  }

  private firstHint() {
    const j = this.site?.junk;
    const s = j?.steps.find((x) => stepReady(x));
    return s ? `Start with the ${s.label.toLowerCase()}s.` : 'Look for what is left.';
  }

  // ---- remote events (large sites) -------------------------------------------------------------------------

  /** Another player (or the server's snapshot, with `silent`) did step i. */
  applyDone(i: number, silent = false) {
    const s = this.site?.junk.steps[i];
    if (s && !s.done) this.finish(s, silent ? 'silent' : 'remote');
  }
  /** Part slot i was taken by `mine` or someone else. */
  applyTake(i: number, mine: boolean) {
    const slot = this.site?.junk.slots[i];
    if (!slot) return;
    if (mine && slot.taken) return;
    const l = this.looseOf(slot);
    if (l && !mine) {
      // I was carrying it, but they were first.
      if (this.drag?.kind === 'part' && this.drag.loose === l) this.drag = null;
      this.scene.remove(l.obj);
      this.loose.splice(this.loose.indexOf(l), 1);
      this.ui.setHint('Someone else got that part first');
    }
    if (!slot.taken) {
      slot.taken = true;
      slot.ring.visible = false;
      slot.piece.obj.removeFromParent();
    }
    this.refreshCard();
  }

  /** The server refused part slot i (full: no room in the backpack): it goes back where it was in the machine. */
  applyRefused(i: number, full: boolean) {
    const site = this.site;
    const slot = site?.junk.slots[i];
    const home = slot && this.homes.get(slot);
    if (!site || !slot || !slot.taken || !home) return;
    const l = this.looseOf(slot);
    if (l) {
      if (this.drag?.kind === 'part' && this.drag.loose === l) {
        this.drag = null;
        this.ui.trayHot(false);
      }
      this.loose.splice(this.loose.indexOf(l), 1);
    } else this.ui.removeItem(slot.part, slot.tier); // already dropped in the tray
    const o = slot.piece.obj;
    home.parent.add(o);
    o.position.copy(home.pos);
    o.quaternion.copy(home.quat);
    o.scale.copy(home.scale);
    this.homes.delete(slot);
    slot.taken = false;
    this.announced.add(slot);
    this.computeRest();
    this.refreshCard();
    site.changed?.();
    const name = PART_LABELS[slot.part].toLowerCase();
    this.ui.setHint(full ? `Backpack full: the ${name} stays in the machine. Make room (Tab) and take it again` : `Could not take the ${name}`);
  }

  // ---- machine ---------------------------------------------------------------------------------------------

  private refreshCard() {
    const j = this.site?.junk;
    if (!j) return;
    const left = j.steps.filter((s) => !s.done).length;
    this.ui.setCard(this.site!.label, j.tier, j.slots.filter((s) => !s.taken).length, j.slots.length, left, !!this.site!.link);
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
      q.premultiply(new THREE.Quaternion().setFromAxisAngle(right, pitch));
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

  private ray(e: PointerEvent) {
    this.ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  /** What is under the pointer: only the nearest surface counts, so lids and plates hide what is under them. */
  private pick(e: PointerEvent): Target | null {
    this.ray(e);
    const roots: THREE.Object3D[] = this.loose.map((l) => l.obj);
    if (this.site) roots.push(this.site.junk.root);
    const h = this.raycaster.intersectObjects(roots, true)[0];
    for (let o: THREE.Object3D | null = h?.object ?? null; o; o = o.parent) {
      const t = o.userData.target as Target | undefined;
      if (t) return t;
    }
    return null;
  }

  /** Where the pointer ray crosses the horizontal plane at `y`. */
  private onPlane(e: PointerEvent, y: number): THREE.Vector3 | null {
    this.ray(e);
    this.plane.constant = -y;
    return this.raycaster.ray.intersectPlane(this.plane, this.hit) ? this.hit : null;
  }

  private looseOf(slot: Slot) {
    return this.loose.find((l) => l.slot === slot);
  }

  private holders(s: Step): number {
    const link = this.site?.link;
    if (!link) return 1;
    return link.holders(this.site!.junk.steps.indexOf(s));
  }

  private describe(t: Target | null): string {
    if (!t) return '';
    switch (t.type) {
      case 'step': {
        const s = t.step;
        const b = s.after.find((a) => !a.done);
        if (b) return `${s.label}: blocked, finish "${b.label}" first`;
        if (s.kind === 'lift') return `${s.label}: ${VERB.lift}, ${s.players} players at once (${this.holders(s)}/${s.players})`;
        const n = s.kind === 'screw' || s.kind === 'clip' ? ` (${s.progress}/${s.need})` : '';
        return `${s.label}: ${VERB[s.kind]}${n}`;
      }
      case 'part': {
        const s = t.slot;
        const r = RARITY[s.tier];
        if (slotOpen(s) || this.looseOf(s)) return `${r.name} ${PART_LABELS[s.part].toLowerCase()}: right-drag it to the tray`;
        return `Still held by ${s.piece.holds.filter((h) => !h.done).length} things`;
      }
      default: return this.site?.movable ? 'Right-drag to move · middle-drag to rotate' : 'Too heavy to move or turn · walk around it, middle-drag to look around';
    }
  }

  private onDown(e: PointerEvent) {
    if (this.phase !== 'work' || !this.site) return;
    if ((e.target as HTMLElement).closest('.panel')) return;
    if (this.drag || this.act) return;
    this.ui.overlay.setPointerCapture(e.pointerId);
    this.button = e.button;
    if (e.button === 1) {
      if (!this.site.movable) {
        this.drag = { kind: 'look', x: e.clientX, y: e.clientY };
        this.ui.overlay.style.cursor = 'move';
        return;
      }
      this.drag = { kind: 'rotate', x: e.clientX, y: e.clientY };
      this.ui.overlay.style.cursor = 'move';
      return;
    }
    const target = this.pick(e);
    if (e.button === 2) {
      if (target?.type === 'part') {
        const s = target.slot;
        const loose = this.looseOf(s) ?? (slotOpen(s) ? this.detachPart(s) : null);
        if (loose) {
          loose.held = true;
          loose.vel.set(0, 0, 0);
          this.drag = { kind: 'part', loose };
          this.moveHeld(e);
          return;
        }
      }
      if (target && this.site.movable) {
        const j = this.site.junk;
        const p = this.onPlane(e, j.root.position.y);
        if (p) this.drag = { kind: 'junk', offset: j.root.position.clone().sub(p).setY(0) };
      }
      return;
    }
    if (e.button === 0 && target?.type === 'step') this.startStep(target.step, e);
  }

  private startStep(s: Step, e: PointerEvent) {
    if (!stepReady(s)) {
      this.ui.setHint(this.describe({ type: 'step', step: s }));
      return;
    }
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
      else this.ui.setHint(this.describe({ type: 'step', step: s }));
    }
  }

  private onMove(e: PointerEvent) {
    if (this.phase !== 'work' || !this.site) return;
    const d = this.drag;
    if (d?.kind === 'rotate') {
      this.spinJunk((e.clientX - d.x) * 0.01, (e.clientY - d.y) * 0.01);
      d.x = e.clientX;
      d.y = e.clientY;
      return;
    }
    if (d?.kind === 'look') {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      this.lookYaw = THREE.MathUtils.clamp(this.lookYaw - dx * LOOK_SENS, -1.6, 1.6);
      this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - dy * LOOK_SENS, -1.0, 1.0);
      if (this.look) {
        this.look.yaw -= dx * LOOK_SENS; // at once, the easing follows
        this.look.pitch = THREE.MathUtils.clamp(this.look.pitch - dy * LOOK_SENS, -1.45, 1.45);
      }
      return;
    }
    if (d?.kind === 'part') {
      this.moveHeld(e);
      this.ui.trayHot(this.overTray(e));
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
    const target = this.pick(e);
    this.ui.setHint(this.describe(target));
    const ready = target?.type === 'step' && stepReady(target.step);
    const free = target?.type === 'part' && (slotOpen(target.slot) || !!this.looseOf(target.slot));
    this.ui.overlay.style.cursor = ready ? 'pointer' : free ? 'grab' : 'default';
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
    } else if (s.kind === 'wire') {
      // Only strokes that actually cross the wire count.
      const t = this.pick(e);
      if (t?.type === 'step' && t.step === s) a.dist += Math.hypot(e.movementX, e.movementY);
      s.progress = Math.min(s.need, (a.dist / CUT_PX) * s.need);
    } else if (s.kind === 'pry') {
      s.progress = Math.min(s.need, (Math.hypot(e.clientX - a.x0, e.clientY - a.y0) / PRY_PX) * s.need);
    } else return;
    this.show(s);
    if (s.progress >= s.need) {
      this.act = null;
      this.complete(s);
    }
  }

  private onUp(e: PointerEvent) {
    if (this.ui.overlay.hasPointerCapture(e.pointerId)) this.ui.overlay.releasePointerCapture(e.pointerId);
    if (e.button !== this.button) return;
    this.button = -1;
    const d = this.drag;
    if (d) {
      if (d.kind === 'part') {
        if (this.overTray(e)) this.collect(d.loose, true);
        else d.loose.held = false;
      }
      this.drag = null;
      this.ui.trayHot(false);
      this.ui.overlay.style.cursor = 'default';
    }
    const a = this.act;
    if (a) {
      const s = a.step;
      if (s.kind === 'lift') this.site?.link?.hold(this.site.junk.steps.indexOf(s), s.players, false);
      // A half-cut wire, half-pried tab or half-lifted weight falls back; a half-turned bolt stays where it is.
      if (!s.done && (s.kind === 'wire' || s.kind === 'pry' || s.kind === 'lift')) {
        s.progress = 0;
        this.show(s);
      }
      this.act = null;
    }
  }

  private endInteraction() {
    if (this.drag?.kind === 'part') this.drag.loose.held = false;
    const a = this.act;
    if (a?.step.kind === 'lift') this.site?.link?.hold(this.site.junk.steps.indexOf(a.step), a.step.players, false);
    this.drag = null;
    this.act = null;
    this.button = -1;
    this.ui.trayHot(false);
  }

  private overTray(e: PointerEvent) {
    const r = this.ui.trayRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  private moveHeld(e: PointerEvent) {
    if (this.drag?.kind !== 'part' || !this.site) return;
    const p = this.onPlane(e, this.home.y + PART_HOVER);
    if (!p) return;
    const r = this.site.radius;
    this.drag.loose.obj.position.set(
      THREE.MathUtils.clamp(p.x, this.home.x - r, this.home.x + r),
      this.home.y + PART_HOVER,
      THREE.MathUtils.clamp(p.z, this.home.z - r, this.home.z + r),
    );
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

  private release(obj: THREE.Object3D, floorY: number, life: number | null, vel: THREE.Vector3, spin: THREE.Vector3, slot?: Slot): Loose {
    this.scene.attach(obj); // keeps the world transform
    const l: Loose = { obj, vel, spin, floorY: floorY * (this.site?.junk.scale ?? 1) * (this.site?.junk.root.scale.x ?? 1), life, held: false, slot };
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
    if (how === 'silent') s.obj.removeFromParent();
    else {
      const r = () => (Math.random() - 0.5) * 2;
      // The finished fastener pops off along its own normal.
      const n = new THREE.Vector3(0, 1, 0).applyQuaternion(s.obj.getWorldQuaternion(new THREE.Quaternion()));
      const vel = n.multiplyScalar(s.kind === 'wire' ? 0.5 : 1.8).add(new THREE.Vector3(r() * 0.6, 2.2, r() * 0.6));
      this.release(s.obj, s.floorY, 8, vel, new THREE.Vector3(r() * 10, r() * 10, r() * 10));
    }
    const j = this.site!.junk;
    for (const p of j.pieces) if (!p.released && p.holds.every((h) => h.done)) this.releasePiece(p, how === 'silent');
    this.computeRest();
    this.refreshCard();
    this.site!.changed?.();
    if (how === 'silent') return;
    const fresh = j.slots.filter((x) => slotOpen(x) && !this.announced.has(x));
    for (const x of fresh) this.announced.add(x);
    this.ui.setHint(fresh.length ? `${RARITY[fresh[0].tier].name} ${PART_LABELS[fresh[0].part].toLowerCase()} is free: right-drag it to the tray` : `${s.label} off`);
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

  /** Pull a freed part out: it goes in the backpack now (null, and it stays put, if the backpack is full). */
  private detachPart(s: Slot): Loose | null {
    const site = this.site!;
    if (!site.take(site.junk.slots.indexOf(s), partItem(s.part, s.tier))) {
      this.ui.setHint(`Backpack full: make room (Tab) to take the ${PART_LABELS[s.part].toLowerCase()}`);
      return null;
    }
    s.taken = true;
    s.ring.visible = false;
    const o = s.piece.obj;
    if (o.parent) this.homes.set(s, { parent: o.parent, pos: o.position.clone(), quat: o.quaternion.clone(), scale: o.scale.clone() });
    this.refreshCard();
    this.computeRest();
    site.changed?.();
    return this.release(s.piece.obj, 0, null, new THREE.Vector3(), new THREE.Vector3(), s);
  }

  /** Put a loose part in the tray. */
  private collect(l: Loose, say: boolean) {
    const s = l.slot!;
    this.scene.remove(l.obj);
    const k = this.loose.indexOf(l);
    if (k >= 0) this.loose.splice(k, 1);
    this.ui.addItem(s.part, s.tier);
    if (!say) return;
    const j = this.site?.junk;
    this.ui.setHint(j && j.slots.every((x) => x.taken && !this.looseOf(x)) ? 'All parts taken.' : `${RARITY[s.tier].name} ${PART_LABELS[s.part].toLowerCase()} is in your backpack`);
  }

  // ---- per frame -------------------------------------------------------------------------------------------

  update(dt: number) {
    const site = this.site;
    if (!site || this.phase === 'idle') return;
    this.pulse += dt;
    const j = site.junk;

    // Lifts: progress only while enough players hold it.
    const a = this.act;
    if (a?.step.kind === 'lift' && !a.step.done) {
      const s = a.step;
      const n = SOLO ? s.players : this.holders(s);
      if (s.progress < s.need) {
        s.progress = n >= s.players ? Math.min(s.need, s.progress + dt) : Math.max(0, s.progress - dt * 2);
        this.show(s);
        this.ui.setHint(n >= s.players ? `${s.label}: lifting…` : `${s.label}: needs ${s.players} players holding together (${n}/${s.players})`);
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
    const wob = 1 + 0.18 * Math.sin(this.pulse * 6);
    const working = this.phase === 'work'; // markers and rings only once you are at the machine
    for (const s of j.steps) {
      s.marker.visible = working && stepReady(s);
      s.marker.scale.setScalar(wob);
    }
    for (const s of j.slots) {
      s.ring.visible = working && slotOpen(s);
      s.ring.scale.setScalar(1 + 0.08 * Math.sin(this.pulse * 5));
    }

    for (let i = this.loose.length - 1; i >= 0; i--) {
      const l = this.loose[i];
      if (l.held) continue;
      const o = l.obj;
      if (l.life !== null) {
        l.life -= dt;
        if (l.life < 0.5) o.scale.setScalar(Math.max(l.life / 0.5, 0.001));
        if (l.life <= 0) {
          this.scene.remove(o);
          this.loose.splice(i, 1);
          continue;
        }
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
}
