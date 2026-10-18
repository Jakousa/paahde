// Machine sites at the crashed spacecraft (shared/crash.ts; the wrecks, debris and the Blender-made ground
// dressing under each machine are drawn by src/world/crashsites.ts) and the disassembly table job at the base.
// Each machine (src/teardown/junk.ts) is built when you come within BUILD_R and dropped again when you are far
// away. The machine is the same object the disassembly mode works on, so a half taken-apart machine stays that
// way while you are around. The large machine of a spent crash site (crashSpent: every part taken) is built as a
// stripped husk and offers nothing.
// How far each machine has been taken apart is the server's (server/crash.ts): every step and take arrives here
// for every machine, and a machine built later is fast-forwarded to it. Machines you carried home (small ones, and the salvage wrecks of src/world/wrecks.ts)
// are taken apart on the base's disassembly table, whose job is the server's too and is seen by everyone.
import * as THREE from 'three/webgpu';
import {
  BENCH, CARRY_KINDS, crashSpent, crashTaken, CRASH_REACH, seeded, sitesNear, type CrashSite,
} from '../../shared/crash.ts';
import { hasItem, type Slots } from '../../shared/items.ts';
import { COMPONENTS, junkSpec, type JunkKind } from '../../shared/salvage.ts';
import { heightAt } from '../../shared/terrain.ts';
import { buildJunk, lowestOffset, type Junk } from '../teardown/junk.ts';
import type { SiteMsg } from '../net.ts';
import type { SiteLink, WorkSite } from '../teardown/teardown.ts';
import { TEXT } from '../../shared/text.ts';

/** Machines are built (a few hundred meshes) when you come this close, and dropped beyond DROP_R. */
const BUILD_R = 60;
const DROP_R = 140;
/** Session id of the disassembly table (server/crash.ts BENCH_ID). */
export const BENCH_ID = 'bench';

/** Steps done and parts taken at one machine. */
type Progress = { done: Set<number>; taken: Set<number> };

interface SiteView {
  site: CrashSite;
  junk: Junk | null;
  /** The junk was built as a stripped husk (its crash site was spent). */
  husk: boolean;
  /** The site's machine is drawn (in the scene). */
  shown: boolean;
}

const spent = (site: CrashSite) => !COMPONENTS[site.kind].carry && crashSpent.has(site.wreck);

export class MachineSites {
  private views = new Map<string, SiteView>();
  private scene: THREE.Scene;
  readonly bench: Bench;
  /** Every large site's progress, from the server. */
  private progress = new Map<string, Progress>();
  /** Id of the site the disassembly mode is working on (src/teardown): its machine is never swapped under it. */
  busy: () => string | undefined = () => undefined;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.bench = new Bench(scene);
  }

  /** Every frame with the local player's position. */
  update(focus: THREE.Vector3) {
    const near = sitesNear(focus.x, focus.z, DROP_R);
    const keep = new Set<string>();
    for (const site of near) {
      keep.add(site.id);
      let v = this.views.get(site.id);
      if (!v) this.views.set(site.id, (v = { site, junk: null, husk: false, shown: false }));
      // Spent while we weren't working on it: rebuild as the husk.
      if (v.junk && v.husk !== spent(site) && this.busy() !== site.id) this.drop(v, true);
      const d = Math.hypot(site.x - focus.x, site.z - focus.z);
      const gone = COMPONENTS[site.kind].carry && crashTaken.has(site.id);
      if (gone && v.shown) this.drop(v, false);
      else if (!gone && d < BUILD_R && !v.shown) this.show(v);
      else if (v.shown && d > DROP_R) this.drop(v, false);
    }
    for (const [id, v] of this.views) {
      if (keep.has(id)) continue;
      this.drop(v, true);
      this.views.delete(id);
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
      v.husk = spent(site);
      if (v.husk) fastForward(v.junk, v.junk.steps.map((_, i) => i), v.junk.slots.map((s) => s.index));
      else {
        const p = this.progress.get(site.id);
        if (p) fastForward(v.junk, p.done, p.taken);
      }
    }
    const j = v.junk;
    j.root.position.set(site.x, heightAt(site.x, site.z), site.z);
    this.scene.add(j.root);
    const off = lowestOffset(j.root);
    if (off !== null) j.root.position.y += off;
    v.shown = true;
  }

  /** The site within reach of (x, z) that can be worked on right now (not a stripped husk). */
  nearest(x: number, z: number): SiteView | null {
    let best: SiteView | null = null;
    let bd = CRASH_REACH;
    for (const v of this.views.values()) {
      if (!v.shown || !v.junk || v.husk) continue;
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
    if (m.t === 'bench') return this.bench.set(m.job, active === BENCH_ID);
    if (m.t === 'siteTook') return;
    if (m.t === 'sites') {
      this.progress.clear();
      for (const r of m.sites) this.progress.set(r.id, { done: new Set(r.done), taken: new Set(r.taken) });
      // Rebuild what is already built (a reconnect): it may be behind or ahead.
      for (const v of this.views.values()) if (v.junk && v.site.id !== active) this.drop(v, true);
      return;
    }
    if (m.id === BENCH_ID) return this.bench.apply(m, active === BENCH_ID);
    if (m.t === 'siteReset') {
      this.progress.delete(m.id);
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
    const v = this.views.get(m.id);
    if (v?.junk && m.id !== active) fastForward(v.junk, done, taken);
  }

  /** The disassembly job for a site: shared with other players when the machine is too big to carry. */
  workSite(v: SiteView, link: SiteLink | null): WorkSite {
    const { site } = v;
    return {
      id: site.id, kind: site.kind, label: COMPONENTS[site.kind].label, junk: v.junk!, x: site.x, z: site.z,
      ground: heightAt, radius: 5, movable: false, link,
    };
  }
}

// ---- disassembly table -------------------------------------------------------------------------------------

interface Job {
  kind: JunkKind;
  seed: number;
  junk: Junk;
}

/** Machines carried home are taken apart on the base's disassembly table (shared/stations.ts). The job is the
 *  server's ('bench' messages): everyone sees the machine on the table and its progress, and anyone at the table
 *  can work on it. A machine on the table is scaled down to fit it, and you stand closer. */
export class Bench {
  private scene: THREE.Scene;
  private job: Job | null = null;
  /** The table's job ended while the mode was open on it: tidy the machine away when it closes. */
  private stale: Junk | null = null;
  /** We asked to put a machine on the table: start the mode when the server's job arrives. */
  private asked = 0;
  /** The job we asked for is on the table (src/main.ts starts the mode). */
  onReady?: () => void;
  /** Lights a new machine with the bunker's lamps (Base.lightIndoors). */
  indoors?: (root: THREE.Object3D) => void;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Tabletop height over the table, the room's floor elsewhere. */
  ground = (x: number, z: number) =>
    Math.abs(x - BENCH.x) < BENCH.w / 2 && Math.abs(z - BENCH.z) < BENCH.d / 2 ? BENCH.top : BENCH.floor;

  /** What the table offers: work on the machine on it, or put a carried one from the bag on it. */
  offer(bag: Slots | undefined): { label: string; kind: JunkKind; resume: boolean } | null {
    const cur = this.job;
    if (cur) return { label: TEXT.prompt.disassemble(junkSpec(cur.kind).label), kind: cur.kind, resume: true };
    const kind = CARRY_KINDS.find((k) => hasItem(bag, k));
    return kind ? { label: TEXT.prompt.putOnTable(junkSpec(kind).label), kind, resume: false } : null;
  }

  /** We sent crashUse: the server's 'bench' answer starts the mode (onReady). */
  ask() {
    this.asked = performance.now();
  }

  /** The table's job from the server (null: free). `active`: the mode is open on the table. */
  set(job: { kind: string; seed: number; done: number[]; taken: number[] } | null, active: boolean) {
    const cur = this.job;
    if (cur && (!job || job.seed !== cur.seed || job.kind !== cur.kind)) {
      // Finished (or replaced): gone from the table, after the mode closes if it is open on it.
      if (active) this.stale = cur.junk;
      else this.scene.remove(cur.junk.root);
      this.job = null;
    }
    if (!job || !(CARRY_KINDS as string[]).includes(job.kind)) return;
    if (!this.job) {
      const kind = job.kind as JunkKind;
      const junk = buildJunk(kind, job.seed);
      this.indoors?.(junk.root);
      // Fit the table: its long side is BENCH.d.
      const size = new THREE.Box3().setFromObject(junk.root).getSize(new THREE.Vector3());
      junk.root.scale.setScalar(Math.min(1, (BENCH.d * 0.95) / Math.max(size.x, size.z, 1e-3)));
      this.job = { kind, seed: job.seed, junk };
      this.place();
    }
    if (!active) fastForward(this.job.junk, job.done, job.taken);
    if (this.asked && performance.now() - this.asked < 5000) {
      this.asked = 0;
      this.onReady?.();
    }
  }

  /** A step or take on the table's machine; the mode animates it itself when open on the table. */
  apply(m: SiteMsg, active: boolean) {
    const j = this.job?.junk;
    if (!j || active) return;
    if (m.t === 'siteState') fastForward(j, m.done, m.taken);
    else if (m.t === 'siteDone') fastForward(j, [m.i], []);
    else if (m.t === 'siteTake') fastForward(j, [], [m.i]);
  }

  /** On the middle of the table, upright (the mode can move and turn it; nobody else sees that). */
  private place() {
    const junk = this.job?.junk;
    if (!junk) return;
    junk.root.quaternion.identity();
    junk.root.position.set(BENCH.x, BENCH.top, BENCH.z);
    if (!junk.root.parent) this.scene.add(junk.root);
    const off = lowestOffset(junk.root);
    if (off !== null) junk.root.position.y += off;
  }

  /** The job for the mode, or null if the table is free. `link` is the table's shared session; `scrap` turns the
   *  machine into scrap (false: no room in the bag). */
  site(link: SiteLink, scrap: () => boolean): WorkSite | null {
    const job = this.job;
    if (!job) return null;
    return {
      id: BENCH_ID, kind: job.kind, label: junkSpec(job.kind).label, junk: job.junk, x: BENCH.x, z: BENCH.z, ground: this.ground,
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
}

/** Apply the server's progress to a machine without any animation. `taken` are part indexes (Slot.index). */
function fastForward(junk: Junk, done: Iterable<number>, taken: Iterable<number>) {
  for (const i of done) {
    const s = junk.steps[i];
    if (!s || s.done) continue;
    s.done = true;
    s.progress = s.need;
    s.obj.removeFromParent();
  }
  for (const p of junk.pieces) {
    if (!p.released && p.holds.every((h) => h.done)) {
      p.released = true;
      p.obj.removeFromParent();
    }
  }
  for (const i of taken) {
    const s = junk.slots.find((x) => x.index === i);
    if (!s || s.taken) continue;
    s.taken = true;
    s.ring.visible = false;
    s.piece.obj.removeFromParent();
  }
}
