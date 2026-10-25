// Machine sites at the crashed spacecraft (shared/crash.ts; the wrecks, debris and the Blender-made ground
// dressing under each machine are drawn by src/world/crashsites.ts) and the jobs on the dismantling benches.
// Each machine (src/teardown/junk.ts) is built when you come within BUILD_R and dropped again when you are far
// away. The machine is the same object the disassembly mode works on, so a half taken-apart machine stays that
// way while you are around. The large machine of a spent crash site (crashSpent: stripped, then its frame mashed to scrap) is gone.
// How far each machine has been taken apart is the server's (server/crash.ts): every step and take arrives here
// for every machine, and a machine built later is fast-forwarded to it. Machines you carried home (small ones, and the salvage wrecks of src/world/wrecks.ts)
// are taken apart on a dismantling table (put up with the wrench), whose job is the server's too and is seen by everyone.
import * as THREE from 'three/webgpu';
import {
  CARRY_KINDS, crashTaken, CRASH_REACH, isTableId, seeded, siteSpent, sitesNear, tableById, type CrashSite, type Table,
} from '../../shared/crash.ts';
import type { BenchJob } from '../../shared/protocol.ts';
import { hasItem, type Slots } from '../../shared/items.ts';
import { junkSpec, type JunkKind } from '../../shared/salvage.ts';
import { heightAt } from '../../shared/terrain.ts';
import { viewCull } from './viewCull';
import { machineChanged, machineGround, setMachineProgress, setMachineShove } from '../../shared/machineBoxes.ts';
import { layoutOf } from '../../shared/machines.ts';
import { frameScrap } from '../../shared/machineSteps.ts';
import { attachAll, buildJunk, detailList, hideDetail, lowestOffset, pieceEmpty, restPiece, settle, type Junk } from '../teardown/junk.ts';
import type { SiteMsg } from '../net.ts';
import type { SiteLink, WorkSite } from '../teardown/teardown.ts';
import { TEXT } from '../../shared/text.ts';

/** Machines are built (a few hundred meshes) when you come this close, and dropped beyond DROP_R. */
const BUILD_R = 60;
/** Fasteners are drawn within this many metres (a little more once they are). */
const DETAIL_R = 16;
/** A machine and what lies round it (pieces on the ground) fit in this sphere; within CULL_NEAR m it is always drawn, as its
 *  shadow and the pieces around you matter more than the saving. */
const CULL_RADIUS = 8;
const CULL_NEAR = 24;
/** Objects put back per frame as a machine's detail comes in. */
const DETAIL_PER_FRAME = 24;
const DROP_R = 140;

/** Steps done and parts taken at one machine. */
type Progress = { done: Set<number>; taken: Set<number> };

interface SiteView {
  site: CrashSite;
  junk: Junk | null;
  /** The site's machine is drawn (in the scene). */
  shown: boolean;
  /** Close enough that its fasteners are drawn (seen from afar there are hundreds of meshes for nothing), and whether the
   *  disassembly was working on it last frame. */
  detail?: boolean;
  /** Where it is drawn now (it eases to the server's): rolled by `rolled` rad and shoved (sx, sz) m. */
  rolled?: number;
  sx?: number;
  sz?: number;
  wasBusy?: boolean;
  /** What is still to be put back into the scene as you come near, a few a frame. */
  queue?: THREE.Object3D[];
}

export class MachineSites {
  private views = new Map<string, SiteView>();
  /** Where each pushed machine is, from the server: its roll (rad) and how far it has been shoved from where it lay (m). */
  private rollTo = new Map<string, { a: number; x: number; z: number }>();
  private scene: THREE.Scene;
  /** The tables that have (or had) a job, by session id. */
  private benches = new Map<string, Bench>();
  /** Every large site's progress, from the server. */
  private progress = new Map<string, Progress>();
  /** Id of the site the disassembly mode is working on (src/teardown): its machine is never swapped under it. */
  busy: () => string | undefined = () => undefined;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    // the players bump into what is still on a machine (shared/machineBoxes.ts): it reads which steps are done from here
    setMachineProgress((id) => this.progress.get(id)?.done);
  }

  /** Every frame with the local player's position. */
  update(focus: THREE.Vector3) {
    for (const [id, b] of this.benches) {
      b.update();
      // Taken down (only ever free): forget it.
      if (!b.busy && !b.table) {
        b.dispose();
        this.benches.delete(id);
      }
    }
    const near = sitesNear(focus.x, focus.z, DROP_R);
    const keep = new Set<string>();
    for (const site of near) {
      keep.add(site.id);
      let v = this.views.get(site.id);
      if (!v) this.views.set(site.id, (v = { site, junk: null, shown: false }));
      const d = Math.hypot(site.x - focus.x, site.z - focus.z);
      // Carried off, or its frame scrapped: not there any more.
      const spent = siteSpent(site);
      const gone = spent || (!site.lab && junkSpec(site.kind).carry && crashTaken.has(site.id));
      if (gone && (v.shown || v.junk)) this.drop(v, spent);
      else if (!gone && d < BUILD_R && !v.shown) this.show(v);
      else if (v.shown && d > DROP_R) this.drop(v, false);
      if (v.shown && v.junk) this.detailed(v, d);
      if (v.shown && v.junk?.setRoll) this.rolling(v);
      if (v.shown && v.junk) this.cull(v, d);
    }
    for (const [id, v] of this.views) {
      if (keep.has(id)) continue;
      this.drop(v, true);
      this.views.delete(id);
    }
  }

  /** Follow the server's angle for a machine that has been pushed round, easing into it. */
  private rolling(v: SiteView) {
    const to = this.rollTo.get(v.site.id) ?? { a: 0, x: 0, z: 0 };
    const cur = v.rolled ?? 0, cx = v.sx ?? 0, cz = v.sz ?? 0;
    if (Math.abs(to.a - cur) < 1e-4 && Math.abs(to.x - cx) < 1e-3 && Math.abs(to.z - cz) < 1e-3) return;
    const k = 0.2;
    v.rolled = Math.abs(to.a - cur) < 2e-3 ? to.a : cur + (to.a - cur) * k;
    v.sx = Math.abs(to.x - cx) < 2e-3 ? to.x : cx + (to.x - cx) * k;
    v.sz = Math.abs(to.z - cz) < 2e-3 ? to.z : cz + (to.z - cz) * k;
    const root = v.junk!.root;
    root.position.set(v.site.x + v.sx, layoutOf(v.site.kind) ? machineGround(v.site, v.sx, v.sz) : heightAt(v.site.x + v.sx, v.site.z + v.sz), v.site.z + v.sz);
    v.junk!.setRoll!(v.rolled);
    if (!root.matrixAutoUpdate) settle(root); // (setRoll does this for a frozen machine; the position alone needs it too)
  }

  /** One test for the whole machine, a sphere round it: outside the view (and far enough off that its shadow cannot reach it
   *  either) its objects are not visited by the renderer at all, instead of each being frustum-tested every frame. */
  private cull(v: SiteView, d: number) {
    const root = v.junk!.root;
    if (this.busy() === v.site.id || d < CULL_NEAR) {
      root.visible = true;
      return;
    }
    root.visible = viewCull.visible(root.position.x, root.position.y + 1, root.position.z, CULL_RADIUS);
  }

  /** Its fasteners are drawn only while you are near (or working on it): the rest of the time they are hidden, and the machine
   *  is not walked over for matrices. */
  private detailed(v: SiteView, d: number) {
    const j = v.junk!;
    const busy = this.busy() === v.site.id;
    if (busy !== !!v.wasBusy) {
      v.wasBusy = busy;
      if (busy) {
        attachAll(j); // the disassembly may bring any step ready
        v.queue = [];
      } else {
        hideDetail(j);
        settle(j.root);
        v.detail = undefined;
      }
    }
    if (busy) return;
    const want = d < (v.detail ? DETAIL_R + 2 : DETAIL_R);
    if (want !== v.detail) {
      v.detail = want;
      if (want) v.queue = detailList(j);
      else {
        v.queue = [];
        hideDetail(j);
      }
    }
    for (let n = 0; v.queue && v.queue.length && n < DETAIL_PER_FRAME; n++) {
      const o = v.queue.pop()!;
      (o.userData.home as THREE.Object3D | null | undefined)?.add(o);
      o.visible = true;
    }
  }

  /** Take the machine out of the scene; `forget` also throws the built junk away. */
  private drop(v: SiteView, forget: boolean) {
    if (v.junk && v.shown) this.scene.remove(v.junk.root);
    v.shown = false;
    if (forget) v.junk = null;
  }

  private show(v: SiteView) {
    const { site } = v;
    if (!v.junk) {
      v.junk = buildJunk(site.kind, site.seed, site.level);
      v.junk.root.rotation.y = site.yaw;
      const p = this.progress.get(site.id);
      if (p) fastForward(v.junk, p.done, p.taken);
    }
    const j = v.junk;
    j.root.position.set(site.x, layoutOf(site.kind) ? machineGround(site, 0, 0) : heightAt(site.x, site.z), site.z);
    this.scene.add(j.root);
    const off = j.fixed ? null : lowestOffset(j.root);
    if (off !== null) j.root.position.y += off;
    v.shown = true;
    const at = this.rollTo.get(site.id);
    v.rolled = at?.a ?? 0;
    v.sx = at?.x ?? 0;
    v.sz = at?.z ?? 0;
    j.root.position.set(site.x + v.sx, heightAt(site.x + v.sx, site.z + v.sz), site.z + v.sz);
    j.setRoll?.(v.rolled);
    v.detail = false;
    v.queue = [];
    hideDetail(j);
    settle(j.root); // (a machine at rest is not walked over every frame)
  }

  /** Table `id`'s job (made when a job comes for it). */
  bench(id: string): Bench {
    let b = this.benches.get(id);
    if (!b) this.benches.set(id, (b = new Bench(this.scene, id)));
    return b;
  }

  /** What table `id`'s menu offers (shared/crash.ts tables). */
  tableMenu(id: string, bag: Slots | undefined): TableMenu {
    return this.benches.get(id)?.menu(bag) ?? freeMenu(bag);
  }

  /** The table with a machine on it nearest (x, z) within `r`, or null. */
  benchNear(x: number, z: number, r: number): Bench | null {
    let best: Bench | null = null, bd = r;
    for (const b of this.benches.values()) {
      const t = b.table;
      if (!t || !b.busy) continue;
      const d = Math.hypot(t.x - x, t.z - z);
      if (d < bd) (bd = d), (best = b);
    }
    return best;
  }

  /** The site's frame has been scrapped (by anyone): the machine is gone. */
  isSpent(id: string): boolean {
    const v = this.views.get(id);
    return !!v && siteSpent(v.site);
  }

  /** The lab machine nearest (x, z) within a few steps, for the debug menu's reset. */
  nearestLab(x: number, z: number): SiteView | null {
    let best: SiteView | null = null;
    let bd = 12;
    for (const v of this.views.values()) {
      if (!v.site.lab) continue;
      const d = Math.hypot(v.site.x - x, v.site.z - z);
      if (d < bd) (bd = d), (best = v);
    }
    return best;
  }

  /** The site within reach of (x, z) that can be worked on right now (not a stripped husk). */
  nearest(x: number, z: number): SiteView | null {
    let best: SiteView | null = null;
    let bd = CRASH_REACH;
    for (const v of this.views.values()) {
      if (!v.shown || !v.junk) continue;
      const d = Math.hypot(v.site.x - x, v.site.z - z);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  /** A progress message from the server (src/net.ts onSite). `active` is the id the disassembly mode is working on:
   *  that machine is left to the mode (it animates the change); every other one is brought up to date at once. */
  apply(m: SiteMsg, active: string | null) {
    if (m.t === 'bench') return this.bench(m.id).set(m.job, active === m.id);
    if (m.t === 'siteTook') return;
    if (m.t === 'siteRolls') {
      if (m.reset) {
        for (const id of this.rollTo.keys()) setMachineShove(id, 0, 0);
        this.rollTo.clear();
      }
      for (const r of m.rolls) {
        this.rollTo.set(r.id, { a: r.a, x: r.x, z: r.z });
        setMachineShove(r.id, r.x, r.z); // (the solid is where the server has it; the drawing eases to it)
      }
      return;
    }
    if (m.t === 'sites') {
      this.progress.clear();
      machineChanged();
      for (const r of m.sites) this.progress.set(r.id, { done: new Set(r.done), taken: new Set(r.taken) });
      // Rebuild what is already built (a reconnect): it may be behind or ahead.
      for (const v of this.views.values()) if (v.junk && v.site.id !== active) this.drop(v, true);
      return;
    }
    if (isTableId(m.id)) return this.benches.get(m.id)?.apply(m, active === m.id);
    if (m.t === 'siteReset') {
      this.progress.delete(m.id);
      machineChanged(m.id);
      const v = this.views.get(m.id);
      if (v?.junk && m.id !== active) this.drop(v, true);
      return;
    }
    let p = this.progress.get(m.id);
    if (!p) this.progress.set(m.id, (p = { done: new Set(), taken: new Set() }));
    const done = m.t === 'siteState' ? m.done : m.t === 'siteDone' ? [m.i] : [];
    const taken = m.t === 'siteState' ? m.taken : m.t === 'siteTake' ? [m.i] : [];
    for (const i of done) p.done.add(i);
    for (const i of taken) p.taken.add(i);
    machineChanged(m.id);
    const v = this.views.get(m.id);
    if (v?.junk && m.id !== active) {
      fastForward(v.junk, done, taken);
      settle(v.junk.root);
      if (v.detail) {
        hideDetail(v.junk);
        v.queue = detailList(v.junk);
      }
    }
  }

  /** The disassembly job for a site: shared with other players when the machine is too big to carry. */
  workSite(v: SiteView, link: SiteLink | null): WorkSite {
    const { site } = v;
    return {
      id: site.id, kind: site.kind, label: junkSpec(site.kind).label, junk: v.junk!, x: site.x, z: site.z,
      ground: heightAt, radius: 5, movable: false, link,
    };
  }
}

// ---- dismantling tables -------------------------------------------------------------------------------------

interface Job {
  kind: JunkKind;
  seed: number;
  junk: Junk;
}

/** What a table's menu offers: the machine on it (name, the scrap it is worth as it is: the server's frameScrap), or the
 *  carried machines that can be put on it. */
export type TableMenu = { job: string | null; scrap: number; kinds: { kind: JunkKind; label: string }[] };

/** Machines carried home are taken apart on a dismantling table (shared/crash.ts tables: each one put up with the
 *  wrench). The job is the server's ('bench' messages, per table): everyone sees the machine on the table and
 *  its progress, and anyone at the table can work on it. A machine on the table is scaled down to fit it, and you
 *  stand closer. The table's place comes from shared/crash.ts tableById (a placed one's from the placed list), looked
 *  up again until it is known. */
export class Bench {
  readonly id: string;
  private scene: THREE.Scene;
  private job: Job | null = null;
  /** The server's job, waiting for the table to be known (the placed list) to be built. */
  private pending: BenchJob | null = null;
  /** The table's job ended while the mode was open on it: tidy the machine away when it closes. */
  private stale: Junk | null = null;

  constructor(scene: THREE.Scene, id: string) {
    this.scene = scene;
    this.id = id;
  }

  get table(): Table | undefined {
    return tableById(this.id);
  }

  get busy() {
    return !!this.job || !!this.pending;
  }

  /** Tabletop height over the table, its floor elsewhere. */
  ground = (x: number, z: number) => {
    const t = this.table;
    if (!t) return heightAt(x, z);
    return Math.abs(x - t.x) < t.w / 2 && Math.abs(z - t.z) < t.d / 2 ? t.top : t.floor;
  };

  menu(bag: Slots | undefined): TableMenu {
    const cur = this.job;
    return cur ? { job: junkSpec(cur.kind).label, scrap: frameScrap(cur.kind, cur.seed, 1, cur.junk.slots.filter((s) => !s.taken).length), kinds: [] }
      : freeMenu(bag);
  }

  /** The table's job from the server (null: free). `active`: the mode is open on the table. */
  set(job: BenchJob | null, active: boolean) {
    const cur = this.job;
    this.pending = null;
    if (cur && (!job || job.seed !== cur.seed || job.kind !== cur.kind)) {
      // Finished (or replaced): gone from the table, after the mode closes if it is open on it.
      if (active) this.stale = cur.junk;
      else this.scene.remove(cur.junk.root);
      this.job = null;
    }
    if (!job || !(CARRY_KINDS as string[]).includes(job.kind)) return;
    const t = this.table;
    if (!t) {
      this.pending = job;
      return;
    }
    if (!this.job) {
      const kind = job.kind as JunkKind;
      const junk = buildJunk(kind, job.seed);
      // Fit the table: its shorter side.
      const size = new THREE.Box3().setFromObject(junk.root).getSize(new THREE.Vector3());
      junk.root.scale.setScalar(Math.min(1, (Math.min(t.w, t.d) * 0.95) / Math.max(size.x, size.z, 1e-3)));
      this.job = { kind, seed: job.seed, junk };
      this.place();
    }
    if (!active) fastForward(this.job.junk, job.done, job.taken);
  }

  /** Every frame: a job waiting for its table is built once the table is known. */
  update() {
    if (this.pending && this.table) this.set(this.pending, false);
  }

  /** A step or take on the table's machine; the mode animates it itself when open on the table. */
  apply(m: SiteMsg, active: boolean) {
    if (this.pending) {
      // (Not built yet: kept with the job.)
      if (m.t === 'siteDone') this.pending.done.push(m.i);
      else if (m.t === 'siteTake') this.pending.taken.push(m.i);
      return;
    }
    const j = this.job?.junk;
    if (!j || active) return;
    if (m.t === 'siteState') fastForward(j, m.done, m.taken);
    else if (m.t === 'siteDone') fastForward(j, [m.i], []);
    else if (m.t === 'siteTake') fastForward(j, [], [m.i]);
  }

  /** On the middle of the table, upright (the mode can move and turn it; nobody else sees that). */
  private place() {
    const junk = this.job?.junk, t = this.table;
    if (!junk || !t) return;
    junk.root.quaternion.identity();
    junk.root.position.set(t.x, t.top, t.z);
    if (!junk.root.parent) this.scene.add(junk.root);
    const off = lowestOffset(junk.root);
    if (off !== null) junk.root.position.y += off;
  }

  /** The job for the mode, or null if the table is free. `link` is the table's shared session; `scrap` turns the
   *  machine into scrap (false: no room in the bag). */
  site(link: SiteLink, scrap: () => boolean): WorkSite | null {
    const job = this.job, t = this.table;
    if (!job || !t) return null;
    return {
      id: this.id, kind: job.kind, label: junkSpec(job.kind).label, junk: job.junk, x: t.x, z: t.z, ground: this.ground,
      radius: 0.8, movable: true, link, stand: 2.3,
      closed: () => this.closed(),
      scrap,
    };
  }

  /** The mode closed on the table: put the machine back as everyone sees it, or away if its job is over. */
  private closed() {
    if (this.stale) {
      this.scene.remove(this.stale.root);
      this.stale = null;
    }
    this.place();
  }

  /** Gone for good (the table was taken down): its machine out of the scene. */
  dispose() {
    if (this.job) this.scene.remove(this.job.junk.root);
    if (this.stale) this.scene.remove(this.stale.root);
    this.job = this.pending = this.stale = null;
  }
}

/** A free table's menu: the carried machines in the bag. */
const freeMenu = (bag: Slots | undefined): TableMenu => ({
  job: null, scrap: 0, kinds: CARRY_KINDS.filter((k) => hasItem(bag, k)).map((kind) => ({ kind, label: junkSpec(kind).label })),
});

/** Apply the server's progress to a machine without any animation. `taken` are part indexes (Slot.index). */
function fastForward(junk: Junk, done: Iterable<number>, taken: Iterable<number>) {
  for (const i of done) {
    const s = junk.steps[i];
    if (!s || s.done) continue;
    s.done = true;
    s.progress = s.need;
    s.obj.removeFromParent();
  }
  for (const p of junk.pieces) if (!p.released && p.holds.every((h) => h.done)) p.released = true;
  for (const i of taken) {
    const s = junk.slots.find((x) => x.index === i);
    if (!s || s.taken) continue;
    s.taken = true;
    s.ring.visible = false;
    s.piece.obj.removeFromParent();
  }
  // What has come off is gone, unless it still has something in it: that lies on the ground by the machine.
  for (const p of junk.pieces) {
    if (!p.released) continue;
    if (pieceEmpty(p)) {
      if (p.inner) p.inner.gone = true;
      p.obj.removeFromParent();
    } else restPiece(p);
  }
}
