// Machine sites in the desert (shared/crash.ts; not the crashed spacecraft of shared/crashsites.ts, which have
// their own wreck models) and the disassembly table job at the base. Each site is a scorch mark,
// some twisted plates half buried in the sand and one machine (src/teardown/junk.ts) lying in the middle,
// built when you come within BUILD_R and dropped again when you are far away. The machine is the same object
// the disassembly mode works on, so a half taken-apart machine stays that way while you are around.
// Machines you carried home (small ones) are taken apart on the base's disassembly table; the job in progress is
// kept in this browser until it is finished.
import * as THREE from 'three/webgpu';
import {
  BENCH, CARRY_KINDS, crashListeners, crashTaken, CRASH_REACH, seeded, sitesNear, type CrashSite,
} from '../../shared/crash.ts';
import { hasItem, type Slots } from '../../shared/items.ts';
import { COMPONENTS, type ComponentKind } from '../../shared/salvage.ts';
import { heightAt } from '../../shared/terrain.ts';
import { buildJunk, lowestOffset, type Junk } from '../teardown/junk.ts';
import type { SiteLink, WorkSite } from '../teardown/teardown.ts';

/** Machines are built (a few hundred meshes) when you come this close, and dropped beyond DROP_R. */
const BUILD_R = 60;
const DROP_R = 140;
/** Scorch marks and wreckage are drawn out to here. */
const SHOW_R = 220;
const BENCH_KEY = 'dadajam.bench';

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
      v.junk = buildJunk(site.kind, seeded(site.seed));
      v.junk.root.rotation.y = site.yaw;
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

/** Machines you carried home are taken apart on the base's disassembly table (shared/stations.ts), alone. A
 *  machine on the table is scaled down to fit it, and you stand closer. The job in progress is kept in this
 *  browser until it is finished. */
export class Bench {
  private scene: THREE.Scene;
  private job: Job | null = null;
  private saved: { kind: ComponentKind; seed: number; done: number[]; taken: number[] } | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    try {
      this.saved = JSON.parse(localStorage.getItem(BENCH_KEY) ?? 'null');
    } catch {}
  }

  /** Tabletop height over the table, the room's floor elsewhere. */
  ground = (x: number, z: number) =>
    Math.abs(x - BENCH.x) < BENCH.w / 2 && Math.abs(z - BENCH.z) < BENCH.d / 2 ? BENCH.top : BENCH.floor;

  /** What the table offers: continue a job, or start one from a carried machine in the bag. */
  offer(bag: Slots | undefined): { label: string; kind: ComponentKind; resume: boolean } | null {
    const cur = this.job ?? this.saved;
    if (cur) return { label: `Continue the ${COMPONENTS[cur.kind].label.toLowerCase()}`, kind: cur.kind, resume: true };
    const kind = CARRY_KINDS.find((k) => hasItem(bag, k));
    return kind ? { label: `Disassemble ${COMPONENTS[kind].label.toLowerCase()}`, kind, resume: false } : null;
  }

  /** The job for the table: a new machine, or the unfinished one. */
  site(kind: ComponentKind): WorkSite {
    if (!this.job) {
      const resume = this.saved && this.saved.kind === kind ? this.saved : null;
      const seed = resume?.seed ?? (Math.random() * 4294967296) >>> 0;
      const junk = buildJunk(kind, seeded(seed));
      // Fit the table: its long side is BENCH.d.
      const size = new THREE.Box3().setFromObject(junk.root).getSize(new THREE.Vector3());
      junk.root.scale.setScalar(Math.min(1, (BENCH.d * 0.95) / Math.max(size.x, size.z, 1e-3)));
      junk.root.position.set(BENCH.x, BENCH.top, BENCH.z);
      this.scene.add(junk.root);
      const off = lowestOffset(junk.root);
      if (off !== null) junk.root.position.y += off;
      this.job = { kind, seed, junk };
      if (resume) fastForward(junk, resume.done, resume.taken);
    }
    const job = this.job;
    return {
      id: 'bench', kind, label: COMPONENTS[kind].label, junk: job.junk, x: BENCH.x, z: BENCH.z, ground: this.ground,
      radius: 0.9, movable: true, link: null, stand: 2.3,
      changed: () => this.save(),
      closed: () => this.closed(),
    };
  }

  private save() {
    const job = this.job;
    if (!job) return;
    const j = job.junk;
    const finished = j.slots.every((s) => s.taken);
    try {
      if (finished) localStorage.removeItem(BENCH_KEY);
      else {
        this.saved = {
          kind: job.kind, seed: job.seed,
          done: j.steps.flatMap((s, i) => (s.done ? [i] : [])),
          taken: j.slots.flatMap((s, i) => (s.taken ? [i] : [])),
        };
        localStorage.setItem(BENCH_KEY, JSON.stringify(this.saved));
      }
    } catch {}
    if (finished) this.saved = null;
  }

  /** Called when the disassembly mode closes on the table: tidy away the machine (an unfinished one is kept saved). */
  closed() {
    const job = this.job;
    if (!job) return;
    this.scene.remove(job.junk.root);
    this.job = null;
    this.save();
  }
}

/** Apply saved progress to a freshly built machine without any animation. */
function fastForward(junk: Junk, done: number[], taken: number[]) {
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
    const s = junk.slots[i];
    if (!s) continue;
    s.taken = true;
    s.ring.visible = false;
    s.piece.obj.removeFromParent();
  }
}
