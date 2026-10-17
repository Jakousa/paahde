// Machine sites in the desert (shared/crash.ts; not the crashed spacecraft of shared/crashsites.ts, which have
// their own wreck models) and the disassembly table job at the base. Each site is a scorch mark,
// some twisted plates half buried in the sand and one machine (src/teardown/junk.ts) lying in the middle,
// built when you come within BUILD_R and dropped again when you are far away. The machine is the same object
// the disassembly mode works on, so a half taken-apart machine stays that way while you are around.
// How far each machine has been taken apart is the server's (server/crash.ts): every step and take arrives here
// for every machine, and a machine built later is fast-forwarded to it. Machines you carried home (small ones)
// are taken apart on the base's disassembly table, whose job is the server's too and is seen by everyone.
import * as THREE from 'three/webgpu';
import {
  BENCH, CARRY_KINDS, crashListeners, crashTaken, CRASH_REACH, seeded, sitesNear, type CrashSite,
} from '../../shared/crash.ts';
import { hasItem, type Slots } from '../../shared/items.ts';
import { COMPONENTS, type ComponentKind } from '../../shared/salvage.ts';
import { heightAt } from '../../shared/terrain.ts';
import { buildJunk, lowestOffset, type Junk } from '../teardown/junk.ts';
import type { SiteMsg } from '../net.ts';
import type { SiteLink, WorkSite } from '../teardown/teardown.ts';

/** Machines are built (a few hundred meshes) when you come this close, and dropped beyond DROP_R. */
const BUILD_R = 60;
const DROP_R = 140;
/** Scorch marks and wreckage are drawn out to here. */
const SHOW_R = 220;
/** Session id of the disassembly table (server/crash.ts BENCH_ID). */
export const BENCH_ID = 'bench';

/** Steps done and parts taken at one machine. */
type Progress = { done: Set<number>; taken: Set<number> };

interface SiteView {
  site: CrashSite;
  junk: Junk | null;
  /** Scorch and wreckage, at the site. */
  decor: THREE.Group;
  /** The site's machine is drawn (in the scene). */
  shown: boolean;
}

const scorchMat = new THREE.MeshBasicNodeMaterial({ color: 0x120a06, transparent: true, opacity: 0.55, depthWrite: false });
const plateMats = [0x4a3426, 0x5c4a3a, 0x3a2c22].map((c) => new THREE.MeshStandardNodeMaterial({ color: c, metalness: 0.6, roughness: 0.85 }));

function wreckage(site: CrashSite, y: number): THREE.Group {
  const r = seeded(site.seed ^ 0x5bd1e995);
  const g = new THREE.Group();
  g.position.set(site.x, y, site.z);
  const scorch = new THREE.Mesh(new THREE.CircleGeometry(3.6, 28).rotateX(-Math.PI / 2), scorchMat);
  scorch.position.y = 0.04;
  g.add(scorch);
  // The skid mark the machine ploughed on its way in.
  const trench = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.08, 9), new THREE.MeshStandardNodeMaterial({ color: 0x2a1a10, roughness: 1 }));
  trench.position.set(Math.sin(site.yaw) * -6, 0.02, Math.cos(site.yaw) * -6);
  trench.rotation.y = site.yaw;
  g.add(trench);
  const n = 6 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2, d = 2.4 + r() * 4.5;
    const w = 0.4 + r() * 1.0, l = 0.5 + r() * 1.1, t = 0.04 + r() * 0.08;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(w, t, l), plateMats[i % plateMats.length]);
    plate.position.set(Math.cos(a) * d, t * 0.5 + r() * 0.1, Math.sin(a) * d);
    plate.rotation.set((r() - 0.5) * 0.7, r() * Math.PI * 2, (r() - 0.5) * 0.7);
    plate.castShadow = true;
    plate.receiveShadow = true;
    g.add(plate);
    if (r() < 0.35) {
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.8 + r() * 1.2, 6), plateMats[0]);
      strut.position.set(Math.cos(a + 0.4) * (d + 0.5), 0.15, Math.sin(a + 0.4) * (d + 0.5));
      strut.rotation.set(Math.PI / 2 - r() * 0.5, r() * 3, 0);
      strut.castShadow = true;
      g.add(strut);
    }
  }
  return g;
}

export class MachineSites {
  private views = new Map<string, SiteView>();
  private scene: THREE.Scene;
  private dirty = true;
  readonly bench: Bench;
  /** Every large site's progress, from the server. */
  private progress = new Map<string, Progress>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.bench = new Bench(scene);
    crashListeners.push(() => (this.dirty = true));
  }

  /** Every frame with the local player's position. */
  update(focus: THREE.Vector3) {
    const near = sitesNear(focus.x, focus.z, SHOW_R);
    const keep = new Set<string>();
    for (const site of near) {
      keep.add(site.id);
      let v = this.views.get(site.id);
      if (!v) {
        const y = heightAt(site.x, site.z);
        const decor = wreckage(site, y);
        this.scene.add(decor);
        v = { site, junk: null, decor, shown: false };
        this.views.set(site.id, v);
      }
      const d = Math.hypot(site.x - focus.x, site.z - focus.z);
      const gone = COMPONENTS[site.kind].carry && crashTaken.has(site.id);
      if (gone && v.shown && v.junk) {
        this.scene.remove(v.junk.root);
        v.shown = false;
      } else if (!gone && d < BUILD_R && !v.shown) this.show(v);
      else if (v.shown && d > DROP_R && v.junk) {
        this.scene.remove(v.junk.root);
        v.shown = false;
      }
    }
    for (const [id, v] of this.views) {
      if (keep.has(id)) continue;
      this.scene.remove(v.decor);
      if (v.junk && v.shown) this.scene.remove(v.junk.root);
      this.views.delete(id);
    }
    this.dirty = false;
  }

  private show(v: SiteView) {
    const { site } = v;
    if (!v.junk) {
      v.junk = buildJunk(site.kind, site.seed);
      v.junk.root.rotation.y = site.yaw;
      const p = this.progress.get(site.id);
      if (p) fastForward(v.junk, p.done, p.taken);
    }
    const j = v.junk;
    j.root.position.set(site.x, heightAt(site.x, site.z), site.z);
    this.scene.add(j.root);
    const off = lowestOffset(j.root);
    if (off !== null) j.root.position.y += off;
    v.shown = true;
  }

  /** The site within reach of (x, z) that can be worked on right now. */
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
    if (m.t === 'bench') return this.bench.set(m.job, active === BENCH_ID);
    if (m.t === 'siteTook') return;
    if (m.t === 'sites') {
      this.progress.clear();
      for (const r of m.sites) this.progress.set(r.id, { done: new Set(r.done), taken: new Set(r.taken) });
      // Rebuild what is already built (a reconnect): it may be behind or ahead.
      for (const v of this.views.values()) if (v.junk && v.site.id !== active) this.drop(v);
      return;
    }
    if (m.id === BENCH_ID) return this.bench.apply(m, active === BENCH_ID);
    if (m.t === 'siteReset') {
      this.progress.delete(m.id);
      const v = this.views.get(m.id);
      if (v?.junk && m.id !== active) this.drop(v);
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

  /** Forget a site's built machine; it is built again (whole, then fast-forwarded) when next shown. */
  private drop(v: SiteView) {
    if (v.junk) this.scene.remove(v.junk.root);
    v.junk = null;
    v.shown = false;
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
  kind: ComponentKind;
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

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Tabletop height over the table, the room's floor elsewhere. */
  ground = (x: number, z: number) =>
    Math.abs(x - BENCH.x) < BENCH.w / 2 && Math.abs(z - BENCH.z) < BENCH.d / 2 ? BENCH.top : BENCH.floor;

  /** What the table offers: work on the machine on it, or put a carried one from the bag on it. */
  offer(bag: Slots | undefined): { label: string; kind: ComponentKind; resume: boolean } | null {
    const cur = this.job;
    if (cur) return { label: `Disassemble the ${COMPONENTS[cur.kind].label.toLowerCase()}`, kind: cur.kind, resume: true };
    const kind = CARRY_KINDS.find((k) => hasItem(bag, k));
    return kind ? { label: `Put the ${COMPONENTS[kind].label.toLowerCase()} on the table`, kind, resume: false } : null;
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
      const kind = job.kind as ComponentKind;
      const junk = buildJunk(kind, job.seed);
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

  /** The job for the mode, or null if the table is free. `link` is the table's shared session. */
  site(link: SiteLink): WorkSite | null {
    const job = this.job;
    if (!job) return null;
    return {
      id: BENCH_ID, kind: job.kind, label: COMPONENTS[job.kind].label, junk: job.junk, x: BENCH.x, z: BENCH.z, ground: this.ground,
      radius: 0.9, movable: true, link, stand: 2.3,
      closed: () => this.closed(),
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
