// Building a material's shader (and its shadow-pass twin) takes tens to hundreds of ms of main-thread time, and the very
// first frame needs all of them: 1.5-2 s in one go, in which the page can't take a click. three's compileAsync does not
// build the same ones the real render asks for, so instead the loading screen draws real frames, a few materials at a
// time: everything drawn is hidden but one object per distinct material and geometry layout, and the batch grows while
// frames stay quick. Each round is one real render (shadows, post passes and all), so what it builds is exactly what
// the first visible frame would have built. Done, everything is put back.
import * as THREE from 'three/webgpu';
import { perf } from './perf.ts';

type Drawn = THREE.Object3D & { material?: THREE.Material | THREE.Material[]; geometry?: THREE.BufferGeometry };

/** Round time (draw + GPU) to aim for: grow the batch below FAST_MS, shrink it above SLOW_MS. */
const FAST_MS = 60;
const SLOW_MS = 200;
/** Rest between rounds so the game on the loading screen gets drawn. */
const PAUSE_MS = 30;

export class Warmup {
  private queue: THREE.Object3D[] = [];
  private every: { o: THREE.Object3D; visible: boolean; culled: boolean }[] = [];
  private ancestors = new Map<THREE.Object3D, boolean>();
  private started = false;
  private done = false;
  private batch = 1;
  private total = 0;

  private roots: THREE.Object3D[];
  private render: () => void;
  private backend: unknown;
  /** Pipelines being compiled in the background (WebGPU), awaited each round. */
  private pending: Promise<void>[] = [];
  private unpatch: (() => void) | null = null;
  private labels: string[] = [];

  constructor(roots: THREE.Object3D[], render: () => void, backend: unknown) {
    this.roots = roots;
    this.render = render;
    this.backend = backend;
  }

  /** While warming, pipelines are created with createRenderPipelineAsync (three does that when it is given a list of
   *  promises, as compileAsync does): the GPU compiles them on background threads, not on the thread that also puts
   *  the loading screen on the display, which one big sync compile froze for seconds. Anything drawn before its
   *  pipeline is ready is skipped. */
  private patch() {
    const b = this.backend as { isWebGPUBackend?: boolean; createRenderPipeline: (...a: unknown[]) => void; draw: (...a: unknown[]) => void; get: (o: unknown) => { pipeline?: unknown; error?: boolean } };
    if (!b.isWebGPUBackend || this.unpatch) return;
    const create = b.createRenderPipeline;
    const draw = b.draw;
    b.createRenderPipeline = (renderObject: unknown, promises: unknown) => create.call(b, renderObject, promises ?? this.pending);
    b.draw = (renderObject: unknown, info: unknown) => {
      const data = b.get((renderObject as { pipeline: unknown }).pipeline);
      if (data.pipeline === undefined && data.error !== true) return;
      draw.call(b, renderObject, info);
    };
    this.unpatch = () => {
      delete (b as Partial<typeof b>).createRenderPipeline;
      delete (b as Partial<typeof b>).draw;
    };
  }

  /** Draws the next few materials, one batch per round, and waits for the GPU between rounds (`settle`). The GPU compiles
   *  the pipelines in its own process, on the thread that also puts the loading screen on the display, so one big
   *  batch freezes that too; waiting for the GPU to finish a batch before sending the next lets the screen update in
   *  between and gives the batch size the real time it cost, not just the page's share. */
  async run(settle: () => Promise<void>): Promise<void> {
    for (;;) {
      const t0 = performance.now();
      if (this.draw()) return;
      await settle();
      await Promise.all(this.pending.splice(0));
      const ms = performance.now() - t0;
      perf.event('shader-warmup', this.labels.join(', ').slice(0, 240), ms, t0);
      if (ms > 500) console.info(`[warmup] slow round ${Math.round(ms)} ms:`, this.labels.join(', '));
      this.batch = ms < FAST_MS ? this.batch * 2 : ms > SLOW_MS ? Math.max(1, this.batch >> 1) : this.batch;
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
  }

  /** One real render with the next batch showing. True once everything is built (and put back). */
  private draw(): boolean {
    if (this.done) return true;
    if (!this.started) this.collect();
    if (!this.queue.length) return this.finish();
    this.patch();
    const stage = this.queue.splice(0, this.batch);
    this.labels = stage.map((o) => {
      const m = (o as Drawn).material;
      const mat = Array.isArray(m) ? m[0] : m;
      return `${o.name || o.type}/${mat?.name || mat?.type}`;
    });
    for (const [o, visible] of this.ancestors) o.visible = visible;
    for (const e of this.every) e.o.visible = false;
    for (const o of stage) {
      o.visible = true;
      o.frustumCulled = false; // built even when it is behind the camera
      for (let p = o.parent; p; p = p.parent) if (this.ancestors.has(p)) p.visible = true;
    }
    this.render();
    return false;
  }

  /** How much of it is built, 0..1 (for the loading bar). */
  get progress(): number {
    return this.done ? 1 : this.total ? 1 - this.queue.length / this.total : 0;
  }

  /** Put everything back as it was (also if the loading screen gives up waiting). */
  finish(): boolean {
    if (this.started && !this.done) {
      for (const e of this.every) {
        e.o.visible = e.visible;
        e.o.frustumCulled = e.culled;
      }
      for (const [o, visible] of this.ancestors) o.visible = visible;
    }
    this.done = true;
    // The wrappers stay until the last background compile is in, or a frame could draw a pipeline that isn't there.
    if (this.unpatch) {
      const off = this.unpatch;
      this.unpatch = null;
      Promise.all(this.pending.splice(0)).then(off, off);
    }
    return true;
  }

  private collect() {
    this.started = true;
    const seen = new Map<string, THREE.Object3D>();
    const all = new Set<THREE.Object3D>();
    const collect = (o: THREE.Object3D) => {
      const d = o as Drawn;
      if (!d.material || !d.geometry || all.has(o)) return;
      all.add(o);
      const mats = Array.isArray(d.material) ? d.material : [d.material];
      const attrs = Object.keys(d.geometry.attributes).sort().join();
      const inst = (o as THREE.InstancedMesh).isInstancedMesh ? o.uuid : '';
      const bones = (o as THREE.SkinnedMesh).skeleton ? (o as THREE.SkinnedMesh).skeleton.bones.length : 0;
      const key = `${mats.map((m) => m.uuid).join()}|${attrs}|${inst}|${bones}|${o.receiveShadow}|${o.castShadow}`;
      if (!seen.has(key)) seen.set(key, o);
    };
    for (const root of this.roots) {
      root.traverseVisible(collect);
      // Opt in only small, known subtrees. Walking every hidden actor variant would make startup unbounded.
      root.traverse((o) => {
        if (!o.userData.prewarmHidden) return;
        o.traverse(collect);
        for (let p: THREE.Object3D | null = o; p; p = p.parent) this.ancestors.set(p, p.visible);
        o.traverse((child) => this.ancestors.set(child, child.visible));
      });
    }
    this.queue = [...seen.values()];
    this.total = this.queue.length;
    this.every = [...all].map((o) => ({ o, visible: o.visible, culled: o.frustumCulled }));
  }
}
