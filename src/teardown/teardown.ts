// Disassembly mode. Near a machine site (or at the table) the machine shows what can be worked, and everything else is
// normal play: you walk, look and use your hands as usual. The crosshair is the pointer, and the mouse itself does the
// gestures, so the view shakes while you shake a cable loose. The mode starts by itself when you come close and ends
// when you walk far enough away.
//   Use button (left mouse / E) on a step: work it (click screws and clips, circle the mouse for big bolts, shake wires
//                loose at both ends, drag pry tabs away, hold a pull). On a freed part: take it (it goes to the bag).
//   Right mouse  (the table only) turn the machine over with the mouse.
// Steps sit on every face, so a small machine has to be turned over; large machines you walk around, and none of
// their steps faces down. Big machines stay where they lie and are worked on by everyone near them through a shared
// session (SiteLink, server/crash.ts); small ones are carried home and taken apart on the disassembly table. Loose-piece
// physics is plain frame-time maths: it is only cosmetic.
import * as THREE from 'three/webgpu';
import { type JunkKind, type PartId, type Tier } from '../../shared/salvage.ts';
import { actionHeld, takeMouse, tools, ui } from '../input.ts';
import { isBound } from '../bindings.ts';
import { tdPrefs } from './prefs.ts';
import { teardownSound } from '../teardownSound.ts';
import { Rope } from './rope.ts';
import { animateMarker, lowestOffset, pieceEmpty, restPiece, PART_GLOW, slotOpen, stepReady, type Junk, type Piece, type Slot, type Step, type Target } from './junk.ts';
import { partName, rarityColor, TeardownUi } from './ui.ts';
import { playerHands } from '../water.ts';
import { uiSound } from '../uiSound.ts';
import { lower, TEXT } from '../../shared/text.ts';

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
  /** A carried machine on the table: it can be turned over (right drag). A big one stays put as it lies. Either way you
   *  walk around it. */
  movable: boolean;
  /** How far from the machine you stand to work (default STAND). */
  stand?: number;
  /** Shared with other players through the server (large sites); null when working alone. */
  link: SiteLink | null;
  /** The state changed (a step done, a part taken). */
  changed?: () => void;
  /** The mode was left (the workbench tidies its table). */
  closed?: () => void;
  /** Turn the whole machine into scrap (the table only): false if the bag has no room. */
  scrap?: () => boolean;
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
  /** A module that came off with more to take apart: it lands, stays and becomes part of the machine's scene again. */
  piece?: Piece;
}

/** A part the player clicked: hidden while the server is asked; it flies to the bag or comes back. */
interface Pending {
  slot: Slot;
  x: number;
  y: number;
}

const GRAVITY = 16;
/** The grinder cuts the stretch of a seam within this distance (m) of where it touches. */
const SEAM_REACH = 0.13;
/** The workable sheen: one goes over a part every this many seconds, and takes this long. */
const SHEEN_EVERY = 7;
const SHEEN_LEN = 1.3;
/** Seconds of holding F at the table to scrap the machine. */
const SCRAP_HOLD = 1.1;
/** How far from the machine's middle the mode starts for a big machine and stops (m); the table's stops farther out. */
const LEAVE = 8;
/** What can be worked: within this distance (m) of the eye. */
const REACH = 4.6;
/** A wire comes loose at an end after this many swings of the shake there (a swing: a stroke of at least SWING_PX that
 *  the pointer then turns back from), the pointer within SHAKE_REACH px of that end on screen. */
const SWINGS = 6;
const SWING_PX = 16;
/** Pointer travel for one decisive pry, in pixels. */
const PRY_PX = 110;
/** How far above a freed part its tag sits (machine units). */
const TAG_UP = 0.45;
/** ?debug lets one player do two-player lifts, for testing. */
const SOLO = new URLSearchParams(location.search).has('debug');

type Phase = 'idle' | 'work';

export class TeardownView {
  private ui: TeardownUi;
  private phase: Phase = 'idle';
  private site: WorkSite | null = null;
  private restY = 0;
  private loose: Loose[] = [];
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private pulse = 0;
  private announced = new Set<Slot>();
  private home = new THREE.Vector3();
  private pending = new Map<number, Pending>();
  /** Every answer to a part we took (the toast and fly-to-bag are drawn here already). */
  onTake?: (r: TakeResult) => void;

  /** What the crosshair is on. */
  private hover: Target | null = null;
  private nextAt = 0;
  /** Markers drawn highlighted this frame (the hovered step, or what blocks the hovered thing). */
  private lit = new Set<Step>();
  private wasDown = false;
  /** Seconds the interact key has been held at the table (a long hold scraps the machine). */
  private scrapHold = 0;

  /** The use button held on a step. sx / sy: smoothed mouse travel (bolts), a stroke so far (wires) or the pull so far (pry). */
  private act: { step: Step; angle: number; end: number; sx: number; sy: number; lastMove: number } | null = null;

  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLElement;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, canvas: HTMLElement) {
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.ui = new TeardownUi();
    addEventListener('keydown', (e) => {
      if (this.phase === 'idle' || e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement) return;
      if (!this.site) return;
      // At the table F leaves (a long hold scraps the machine); out in the field F does what it always does.
      if (this.site.movable && isBound('interact', e.code) && !e.repeat) this.scrapHold = 0.001;
      if (isBound('rotate', e.code)) {
        if (this.site.movable) this.resetRotation();
      }
    });
    addEventListener('keyup', (e) => {
      if (this.site?.movable && isBound('interact', e.code) && this.scrapHold > 0) {
        const held = this.scrapHold;
        this.scrapHold = 0;
        if (held < SCRAP_HOLD) this.end();
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

  /** Start: the machine shows what can be worked; nothing of the player's controls changes. */
  begin(site: WorkSite) {
    if (this.phase !== 'idle') return;
    this.site = site;
    this.phase = 'work';
    this.hover = null;
    this.wasDown = false;
    this.announced.clear();
    this.pending.clear();
    for (const s of site.junk.slots) if (slotOpen(s)) this.announced.add(s);
    this.ui.setPhase('work');
    this.ui.setScrap(!!site.scrap);
    site.link?.join();
    if (!site.junk.root.parent) this.scene.add(site.junk.root);
    this.home.set(site.x, site.ground(site.x, site.z), site.z);
    this.computeRest();
    site.junk.root.position.y = this.restY;
    this.refreshCard();
  }

  /** Scrap the machine (the table only) and leave; the server frees the table. */
  private scrap() {
    const site = this.site;
    if (!site?.scrap || this.phase !== 'work') return;
    if (!site.scrap()) {
      this.ui.message(TEXT.notice.bagFull, true);
      uiSound.full();
      return;
    }
    this.end();
  }

  /** Stop: the controls come back (the camera swings back from the table). */
  end() {
    const site = this.site;
    if (!site) return;
    this.endInteraction();
    // Nothing of the mode stays on screen: no markers, no part rings.
    for (const s of site.junk.steps) s.marker.visible = false;
    for (const s of site.junk.slots) s.ring.visible = false;
    // Takes still waiting for an answer count as given (the server has them).
    for (const [i] of this.pending) this.applyTook(i, true);
    for (const l of this.loose) {
      if (l.piece) {
        site.junk.root.attach(l.obj); // a piece with more in it stays: it lies where it fell
        l.piece.inner!.resting = true;
      } else this.scene.remove(l.obj);
    }
    this.loose = [];
    site.link?.leave();
    site.changed?.();
    site.closed?.();
    this.site = null;
    this.hover = null;
    this.phase = 'idle';
    this.ui.setPhase('off');
    tools.engaged = false;
    this.act = null;
  }

  /** Called every frame: walking far enough away from the machine ends the mode. */
  watch(me: { x: number; z: number }) {
    const site = this.site;
    if (!site || this.phase === 'idle') return;
    if (Math.hypot(site.x - me.x, site.z - me.z) > (site.stand ?? LEAVE) + (site.movable ? 4 : 0)) this.end();
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
      this.checkEmpty(slot.owner);
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
      this.checkEmpty(s.owner);
      this.ui.fly(p.x, p.y, s.part as PartId, s.tier as Tier);
      const j = site.junk;
      site.changed?.();
      this.computeRest();
    } else {
      s.piece.obj.visible = true;
      s.taken = false;
      this.ui.message(reason === 'full' ? TEXT.notice.bagFull : reason === 'taken' ? TEXT.notice.taken : TEXT.notice.failed, true);
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
    return ready.length && !ready.some((s) => this.faces(s)) ? TEXT.teardown.otherSide(ready.length) : '';
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
    if (j.fixed) {
      this.restY = this.home.y;
      return;
    }
    const off = lowestOffset(j.root);
    if (off !== null) this.restY = this.home.y + off;
  }

  /** Right mouse held at the table: the mouse turns the machine, about the vertical and about the view's right. */
  private spin(mx: number, my: number) {
    const j = this.site?.junk;
    if (!j || j.fixed || (!mx && !my)) return;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), mx * 0.008);
    const right = this.tmpA.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(right, my * 0.008));
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
  private pick(x: number, y: number, reach = Infinity): Target | null {
    if (!this.site) return null;
    this.ray(x, y);
    const h = this.raycaster.intersectObject(this.site.junk.root, true).find((i) => this.shown(i.object));
    if (h && h.distance > reach) return null;
    let hit: Target | null = null;
    for (let o: THREE.Object3D | null = h?.object ?? null; o && !hit; o = o.parent) hit = (o.userData.target as Target | undefined) ?? null;
    if (hit?.type === 'step' && hit.step.done) hit = null; // (a part aimed at as a whole stays a target after it has come off)
    if (hit?.type === 'step' || hit?.type === 'part') return hit;
    // A freed part counts when the pointer is on it or its tag, even where the machine hides it.
    const j = this.site.junk;
    for (const s of j.slots) {
      if (!slotOpen(s) || this.pendingSlot(s)) continue;
      for (const up of [0, TAG_UP * j.scale * j.root.scale.x]) {
        const p = this.screen(s.piece.obj, up);
        if (p && Math.hypot(p.x - x, p.y - y) < 34 && this.camera.position.distanceTo(s.piece.obj.getWorldPosition(this.tmpA)) < reach) return { type: 'part', slot: s };
      }
    }
    return hit;
  }

  /** Not inside a hidden group (a part waiting for the server). */
  private shown(o: THREE.Object3D) {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible && !(p as THREE.Mesh).isMesh) return false;
    return true;
  }

  private holders(s: Step): number {
    const link = this.site?.link;
    if (!link) return 1;
    return link.holders(this.site!.junk.steps.indexOf(s));
  }

  /** "Lid screw ×4, rear latch": the undone steps in `steps`, grouped. */
  private listSteps(steps: Step[]) {
    const by = new Map<string, number>();
    for (const s of steps) if (!s.done) by.set(lower(s.label), (by.get(lower(s.label)) ?? 0) + 1);
    return [...by].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l)).join(', ');
  }

  /** The tip for a target: title, the exact action, and whether it is locked (then the action says why). */
  private describe(t: Target | null): { title: string; action: string; locked?: boolean; color?: string } | null {
    if (!t) return null;
    if (t.type === 'step') {
      const s = t.step;
      const b = s.after.filter((a) => !a.done);
      if (b.length) return { title: s.label, action: TEXT.teardown.after(this.listSteps(b)), locked: true };
      switch (s.kind) {
        case 'screw': return { title: s.label, action: `×${s.need - Math.floor(s.progress)}` };
        case 'clip': return { title: s.label, action: s.need > 1 ? `×${s.need - Math.floor(s.progress)}` : '' };
        case 'bolt': return { title: s.label, action: TEXT.teardown.circle };
        case 'wire': return { title: s.label, action: TEXT.teardown.shake };
        case 'pry': return { title: s.label, action: TEXT.teardown.pry };
        case 'mash': return { title: s.label, action: TEXT.teardown.mash };
        case 'grind': return playerHands.held === 'grinder' ? { title: s.label, action: TEXT.teardown.grind } : { title: s.label, action: TEXT.teardown.needGrinder, locked: true };
        case 'lift': {
          const n = SOLO ? s.players : this.holders(s);
          return { title: s.label, action: TEXT.teardown.players(n, s.players) };
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

  /** Every frame: what the crosshair is on, the use button's press and release, and the gesture while it is held. */
  private pointer(mx: number, my: number) {
    const site = this.site!;
    const down = actionHeld('use') && !ui.inventoryOpen;
    const pressed = down && !this.wasDown;
    this.wasDown = down;
    if (!document.pointerLockElement || ui.inventoryOpen) {
      if (this.act) this.letGo();
      this.hover = null;
      tools.engaged = false;
      return;
    }
    if (site.movable && actionHeld('aim')) this.spin(mx, my);
    if (this.act) {
      const a = this.act;
      this.camera.getWorldPosition(this.tmpB);
      const far = a.step.obj.getWorldPosition(this.tmpA).distanceTo(this.tmpB) > REACH + 1.5;
      if (!down || far || a.step.done) this.letGo();
      else this.moveStep(a, mx, my);
    } else {
      this.hover = this.pick(innerWidth / 2, innerHeight / 2, REACH);
      if (pressed && this.hover) {
        const t = this.hover;
        if (t.type === 'step') {
          if (stepReady(t.step)) this.startStep(t.step);
          else this.ui.message(this.describe(t)!.action, true);
        } else if (t.type === 'part') {
          if (slotOpen(t.slot)) this.takePart(t.slot, innerWidth / 2, innerHeight / 2);
          else this.ui.message(this.describe(t)!.action, true);
        }
      }
    }
    tools.engaged = !!this.act || !!this.hover;
  }

  private startStep(s: Step) {
    if (s.kind === 'grind') {
      // nothing to start: the grinder (src/grinder.ts) cuts wherever it touches the seam
      if (playerHands.held !== 'grinder') this.ui.message(TEXT.teardown.needGrinder, true);
      return;
    }
    if (s.kind === 'mash') {
      // each press counts; the progress drains between presses (update)
      s.progress++;
      this.show(s);
      teardownSound.hit('clink', 0.7);
      if (s.progress >= s.need) this.complete(s);
      return;
    }
    let end = -1;
    if (s.kind === 'wire') {
      // the end nearest the crosshair is the one shaken; let go and grab again for the other
      const ends = s.ends!;
      let bd = Infinity;
      ends.forEach((e, i) => {
        if (e.done) return;
        const q = this.screen(e.lug);
        const d = q ? Math.hypot(q.x - innerWidth / 2, q.y - innerHeight / 2) : Infinity;
        if (d < bd) (bd = d), (end = i);
      });
      if (end < 0) end = ends.findIndex((e) => !e.done);
      if (end < 0) return;
    }
    this.act = { step: s, angle: NaN, end, sx: 0, sy: 0, lastMove: 0 };
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

  /** The mouse moved (mx, my pixels this frame) while a step is held. */
  private moveStep(a: NonNullable<TeardownView['act']>, mx: number, my: number) {
    const s = a.step;
    if (s.kind === 'bolt') {
      // turning the mouse in circles: the direction it travels in turns, half a turn of it is one of the bolt's
      a.sx = a.sx * 0.7 + mx * 0.3;
      a.sy = a.sy * 0.7 + my * 0.3;
      if (Math.hypot(a.sx, a.sy) < 2.5) return;
      const ang = Math.atan2(a.sy, a.sx);
      if (Number.isNaN(a.angle)) a.angle = ang;
      let dA = ang - a.angle;
      dA = Math.atan2(Math.sin(dA), Math.cos(dA));
      a.angle = ang;
      s.progress += Math.abs(dA) / Math.PI;
      if (dA) teardownSound.turn();
    } else if (s.kind === 'wire') {
      this.shake(s, a, mx, my);
    } else if (s.kind === 'pry') {
      a.sx += mx;
      a.sy += my;
      s.progress = Math.min(s.need, (Math.hypot(a.sx, a.sy) / PRY_PX) * s.need);
    } else return;
    this.show(s);
    if (s.progress >= s.need) {
      this.act = null;
      teardownSound.stop();
      this.complete(s);
    }
  }

  /** The use button was released (or the step is out of reach). */
  private letGo() {
    const a = this.act;
    if (!a) return;
    const s = a.step;
    if (s.kind === 'bolt') teardownSound.stop();
    if (s.kind === 'lift') this.site?.link?.hold(this.site.junk.steps.indexOf(s), s.players, false);
    // A half-pried tab or half-lifted weight falls back, and a half-shaken wire end goes still (an end that has come
    // loose stays loose); a half-turned bolt stays where it is.
    if (!s.done && s.kind === 'wire') this.stillWire(s);
    else if (!s.done && (s.kind === 'pry' || s.kind === 'lift')) {
      s.progress = 0;
      this.show(s);
    }
    this.act = null;
  }

  private ropeG = new THREE.Vector3();
  private ropeU = new THREE.Vector3();
  private ropeR = new THREE.Vector3();
  private ropeD = new THREE.Vector3();
  private ropeQ = new THREE.Quaternion();
  private ropeQ2 = new THREE.Quaternion();
  private ropePin = [new THREE.Vector3(), new THREE.Vector3()];

  /** A cable moves while it is shaken (the held end is pulled about and the rest follows) and once an end has come off it
   *  hangs from the other and swings, floppy; one that has stopped moving with both ends held is the modelled tube again. */
  private updateRope(s: Step, dt: number) {
    const r = s.rope!, ends = s.ends!, lugs = s.lugs!;
    const a = this.act;
    const held = a?.step === s && performance.now() - a.lastMove < 150;
    const short = ends.length === 1; // one pull takes the whole cable: both ends hold until then
    const attached: [boolean, boolean] = [short || !ends[0].done, short || !ends[ends.length - 1].done];
    const both = attached[0] && attached[1];
    if (!r.active) {
      if (!held && both) return;
      r.active = true;
    }
    // Weight and the camera's right, in the cable's own frame.
    s.obj.getWorldQuaternion(this.ropeQ).invert();
    const scale = s.obj.getWorldScale(this.ropeD).x || 1;
    this.ropeU.set(0, 1, 0).applyQuaternion(this.ropeQ);
    this.ropeG.set(0, -7, 0).applyQuaternion(this.ropeQ).divideScalar(scale);
    this.camera.getWorldQuaternion(this.ropeQ2);
    this.ropeR.set(1, 0, 0).applyQuaternion(this.ropeQ2).applyQuaternion(this.ropeQ).divideScalar(scale);
    // An end that has just come off is shoved away.
    for (const i of [0, 1] as const) {
      if (r.wasAttached[i] && !attached[i]) r.kick(i, this.tmpA.copy(this.ropeU).multiplyScalar(0.05 / scale));
      r.wasAttached[i] = attached[i];
    }
    const pins = [null, null] as (THREE.Vector3 | null)[];
    for (const i of [0, 1] as const) {
      if (!attached[i]) continue;
      const pin = this.ropePin[i].copy(i === 0 ? r.rest[0] : r.rest[Rope.N - 1]);
      if (held && (short || a!.end === i)) {
        pin.addScaledVector(this.ropeR, Math.sin(this.pulse * 55) * 0.03);
        pin.addScaledVector(this.ropeU, Math.abs(Math.sin(this.pulse * 40)) * 0.012);
      }
      pins[i] = pin;
    }
    // Held at both ends it is stiff and light; with one end off it is limp and its weight takes it.
    r.step(dt, pins[0], pins[1], this.ropeG.multiplyScalar(both ? 0.15 : 1), both ? 120 : 1.5);
    r.rebuild();
    // The lugs ride the ends: pulled about with a held end, hanging from a loose one.
    for (const i of [0, 1] as const) {
      const idx = i === 0 ? 0 : Rope.N - 1;
      lugs[i].position.copy(r.pts[idx]);
      if (attached[i]) lugs[i].quaternion.identity();
      else lugs[i].quaternion.setFromUnitVectors(this.ropeU.set(0, 1, 0), this.ropeD.copy(r.pts[idx]).sub(r.pts[i === 0 ? 1 : Rope.N - 2]).normalize());
    }
    // Still, with both ends holding: back to the tube as modelled.
    if (!held && both && r.calm > 40) {
      r.reset();
      lugs.forEach((l, i) => {
        l.position.copy(i === 0 ? r.rest[0] : r.rest[Rope.N - 1]);
        l.quaternion.identity();
      });
    }
  }

  /** The mouse moved while a wire is held: shake the end that was grabbed. A swing is a stroke the mouse turns back from. */
  private shake(s: Step, a: NonNullable<TeardownView['act']>, mx: number, my: number) {
    const end = s.ends![a.end];
    if (!end || end.done) {
      // that end is loose: the other, if any, is grabbed by letting go and pressing again
      return;
    }
    if (Math.hypot(mx, my) < 1) return;
    a.lastMove = performance.now();
    if (a.sx * mx + a.sy * my < 0) {
      // turned back: it counts if the stroke before was long enough
      if (Math.hypot(a.sx, a.sy) >= SWING_PX) {
        end.swings++;
        if (end.swings >= SWINGS) {
          end.done = true;
          teardownSound.hit('clink', 0.8);
        } else teardownSound.hit('tink', 0.5);
      }
      a.sx = mx;
      a.sy = my;
    } else {
      a.sx += mx;
      a.sy += my;
    }
    this.wireProgress(s);
  }

  /** A wire's progress is how loose its two ends are, together. */
  private wireProgress(s: Step) {
    const sum = s.ends!.reduce((n, end) => n + (end.done ? 1 : end.swings / SWINGS), 0);
    s.progress = (sum / s.ends!.length) * s.need;
  }

  /** The wire is let go of: an end that was part-way stops, and a loose one stays loose. */
  private stillWire(s: Step) {
    for (const end of s.ends!) if (!end.done) end.swings = 0;
    this.wireProgress(s);
    this.show(s);
  }

  private endInteraction() {
    const a = this.act;
    if (a?.step.kind === 'wire' && !a.step.done) this.stillWire(a.step);
    if (a?.step.kind === 'lift') this.site?.link?.hold(this.site.junk.steps.indexOf(a.step), a.step.players, false);
    teardownSound.stop();
    this.act = null;
    tools.engaged = false;
  }

  // ---- tearing down ----------------------------------------------------------------------------------------

  /** A step whose part moves as it goes (a pull, a prised shell): put it `f` of the way along its slide. */
  private slide(s: Step, f: number) {
    const sl = s.slide;
    if (!sl) return;
    sl.obj.position.addScaledVector(sl.offset, -1);
    sl.offset.copy(sl.dir).multiplyScalar(Math.min(f, 1) * sl.dist);
    sl.obj.position.add(sl.offset);
  }

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
      case 'mash':
        this.slide(s, f); // the part lifts away a little with every press
        break;
      case 'lift':
        s.spin.position.y = Math.min(f, 1) * 0.12;
        this.slide(s, f); // the module parts from the machine as it is pulled
        break;
      case 'wire':
        if (s.mat) {
          s.mat.emissive.setHex(0xff7a20);
          s.mat.emissiveIntensity = Math.min(f, 1) * 3;
        }
        break;
    }
  }

  private release(obj: THREE.Object3D, floorY: number, life: number, vel: THREE.Vector3, spin: THREE.Vector3, piece?: Piece): Loose {
    this.scene.attach(obj); // keeps the world transform
    const l: Loose = { obj, vel, spin, floorY: floorY * (this.site?.junk.scale ?? 1) * (this.site?.junk.root.scale.x ?? 1), life, piece };
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
    this.checkEmpty(s.owner, how === 'silent');
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
    const more = !pieceEmpty(p); // something left in it: it stays, lying on the ground
    if (silent) {
      if (more) restPiece(p);
      else p.obj.removeFromParent();
      return;
    }
    const r = () => (Math.random() - 0.5) * 2;
    const n = new THREE.Vector3(...p.pop).normalize().applyQuaternion(this.site!.junk.root.quaternion);
    const vel = n.multiplyScalar(2).add(new THREE.Vector3(r(), 2.8, r()));
    this.release(p.obj, p.floorY, more ? Infinity : 12, vel, new THREE.Vector3(r() * 2, r() * 2, r() * 2), more ? p : undefined);
  }

  /** A piece that came off and has been emptied (every inner step done, every inner part taken) is cleared away. */
  private checkEmpty(p: Piece | undefined, silent = false) {
    const n = p?.inner;
    if (!p || !n || n.gone || !p.released || !pieceEmpty(p)) return;
    n.gone = true;
    const l = this.loose.find((x) => x.piece === p);
    if (l) l.piece = undefined; // still in the air: it just shrinks away
    if (silent) p.obj.removeFromParent();
    else if (l) l.life = Math.min(l.life, 0.5);
    else this.release(p.obj, p.floorY, 0.5, new THREE.Vector3(), new THREE.Vector3());
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
    const [mx, my] = takeMouse();
    this.pointer(mx, my);
    if (site.movable && this.scrapHold > 0) {
      // F held at the table: a long hold scraps the machine
      this.scrapHold += dt;
      if (this.scrapHold >= SCRAP_HOLD) {
        this.scrapHold = 0;
        this.scrap();
        return;
      }
    }
    const working = true;

    // Mashing: the progress drains away between presses.
    for (const s of j.steps) {
      if (s.kind !== 'mash' || s.done || s.progress <= 0) continue;
      s.progress = Math.max(0, s.progress - dt * 1.6);
      this.show(s);
    }
    this.grind();

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

    // Stay put on the ground (the workbench or the sand) after a turn.
    const y = j.root.position.y;
    j.root.position.y = y + (this.restY - y) * Math.min(1, dt * 9);

    // Highlight: the step under the pointer, or what is in the way of the thing under the pointer.
    const focus: Target | null = this.act ? { type: 'step', step: this.act.step } : this.hover;
    this.lit.clear();
    if (focus?.type === 'step') {
      const b = focus.step.after.filter((x) => !x.done);
      for (const s of b.length ? b : [focus.step]) this.lit.add(s);
    } else if (focus?.type === 'part' && !slotOpen(focus.slot)) for (const s of focus.slot.piece.holds) if (!s.done) this.lit.add(s);
    for (const s of j.steps) {
      const lit = this.lit.has(s);
      const ready = !s.done && stepReady(s);
      // a step still waiting on another is not there yet: it cannot be seen or aimed at, so it never gets in the way
      if (!s.done) s.obj.visible = ready;
      // the big indicator (a setting) on every ready step, or just on what the crosshair is on; the glint is always there
      s.marker.visible = !s.done && tdPrefs.markers && (ready || lit);
      if (s.marker.visible) animateMarker(s, this.pulse, lit, this.camera);
      // The enchanted look: they look as made, and now and then a sheen goes over them (a band of light across a big part, a
      // brief brightening of a small one), each on its own beat. Not while the big indicators are on them.
      const calm = ready && !s.marker.visible;
      const beat = SHEEN_EVERY * (0.5 + 0.5 * Math.sin(s.obj.position.x * 12.9 + s.obj.position.z * 78.2 + s.obj.position.y * 37.7 + 1)); // 0..SHEEN_EVERY
      const q = ((this.pulse + beat) % SHEEN_EVERY) / SHEEN_LEN; // 0..1 during the sheen
      for (const m of s.shine) {
        const u = m.userData.sheen as { value: number } | undefined;
        if (!u) continue;
        const big = !!m.userData.big;
        u.value = !calm || q > 1 ? (big ? -9 : 0) : big ? -1.6 + 3.2 * q : Math.sin(q * Math.PI) ** 2;
      }
      if (s.glint) {
        s.glint.visible = calm && q <= 1;
        (s.glint.material as THREE.MeshBasicNodeMaterial).opacity = 0.025 * Math.sin(Math.min(1, Math.max(0, q)) * Math.PI);
      }
    }
    // Cables that are being shaken, or have an end off, move.
    for (const s of j.steps) if (s.rope && !s.done) this.updateRope(s, dt);
    const hoverSlot = focus?.type === 'part' ? focus.slot : null;
    for (const s of j.slots) {
      const open = slotOpen(s);
      s.ring.visible = working && open;
      s.ring.scale.setScalar((s === hoverSlot ? 1.18 : 1) + 0.08 * Math.sin(this.pulse * 5));
      // Parts glow a little all the time, and pulse once they are free to take.
      const glow = open ? PART_GLOW + 0.3 + 0.2 * Math.sin(this.pulse * 3) + (s === hoverSlot ? 0.35 : 0) : PART_GLOW;
      for (const m of s.glow) m.emissiveIntensity = glow;
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
      if (l.piece && o.position.y <= floor + 0.001 && l.vel.lengthSq() < 0.5) {
        // landed: it stays where it lies, in the machine's scene, to be taken apart further
        o.position.y = floor;
        site.junk.root.attach(o);
        l.piece.inner!.resting = true;
        this.loose.splice(i, 1);
        continue;
      }
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

  /** Where the grinder touches (src/grinder.ts) cuts the seams there that can be cut now, anywhere along them and in any order;
   *  a seam is open once nearly all of it has been touched. */
  private grind() {
    const at = playerHands.grindAt;
    if (!at || playerHands.held !== 'grinder') return;
    const p = this.tmpA.set(at.x, at.y, at.z);
    for (const s of this.site!.junk.steps) {
      if (s.kind !== 'grind' || s.done || !stepReady(s)) continue;
      const seam = s.seam!;
      const local = s.obj.worldToLocal(this.tmpB.copy(p));
      let fresh = false;
      for (let i = 0; i < seam.cut.length; i++) {
        if (seam.cut[i] || seam.mids[i].distanceTo(local) > SEAM_REACH) continue;
        seam.cut[i] = true;
        seam.marks[i].visible = true;
        fresh = true;
      }
      if (!fresh) continue;
      s.progress = seam.cut.filter(Boolean).length / seam.cut.length;
      if (s.progress >= 0.92) {
        s.progress = s.need;
        for (const m of seam.marks) m.visible = true;
        this.complete(s);
      }
    }
  }

  /** The tip, progress ring, part tags and the "next" line. */
  private updateUi(dt: number) {
    const site = this.site!;
    const j = site.junk;
    // Tip by the crosshair: what it is on (or the step being worked, for a pull).
    const a = this.act;
    const t = a ? { type: 'step' as const, step: a.step } : this.hover;
    const d = !a || a.step.kind === 'lift' ? this.describe(t) : null;
    this.ui.tip(d && { ...d, x: innerWidth / 2 + 6, y: innerHeight / 2 + 10 });

    // Ring: around the step being worked at the crosshair, or a hovered one that is part-way done (a half-turned bolt).
    const rs = a?.step ?? (t?.type === 'step' && t.step.progress > 0 && !t.step.done ? t.step : null);
    if (rs && a) this.ui.ring({ x: innerWidth / 2, y: innerHeight / 2, f: rs.progress / rs.need });
    else if (rs && rs.kind !== 'wire') {
      const p = this.screen(rs.obj);
      this.ui.ring(p && { ...p, f: rs.progress / rs.need });
    } else this.ui.ring(null);

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
