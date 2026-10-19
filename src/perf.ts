// Performance monitor and benchmark (docs/perf.md). Three jobs:
//   1. Per-frame timing for the stats graphs (src/statsGraph.ts): CPU (the time our frame callback runs, the whole of it,
//      render submission included), the submit part of that, and GPU (WebGPU timestamp queries: the render passes together,
//      shadow cascades and post included). Which of the two is the larger tells what the frame is bound by.
//   2. User Timing marks and measures, which Chrome's Performance panel and traces show as a "dadajam" track (CPU and GPU
//      per frame, startup milestones), so a recorded trace carries these numbers with it.
//   3. A benchmark run, `?perf=<seconds>` (or `?perf=startup`): the startup timeline (milestones, long tasks), then, once
//      the game is playable, a scripted walk for that many seconds, then a JSON result: downloaded, and left in
//      `window.__perfResult` for tools/perf.ts, which drives Chrome and records a trace of the same stretch.
// Timing is only collected while stats are shown or a run is on: the GPU queries are only set up then (the renderer is made
// with `trackTimestamp` at start, so a reload is needed after turning stats on for GPU times).
import { slots } from './bindings';
import * as THREE from 'three/webgpu';
import { graphics, setGraphics } from './graphics';

const params = new URLSearchParams(location.search);
const perfParam = params.get('perf');
/** A benchmark run was asked for in the address. */
export const PERF_RUN = perfParam !== null;
/** Seconds of gameplay to record; 0 = startup only. */
const RUN_S = perfParam === 'startup' ? 0 : Math.max(1, Number(perfParam) || 30);
/** Seconds after the game is playable before recording starts (shaders, streaming and the camera settle). */
const SETTLE_S = 3;

type Phase = 'off' | 'waiting' | 'settling' | 'recording' | 'done';

interface Stat {
  mean: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

function stat(a: number[]): Stat | null {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  const r = (v: number) => Math.round(v * 100) / 100;
  return { mean: r(s.reduce((x, y) => x + y, 0) / s.length), p50: r(at(0.5)), p90: r(at(0.9)), p99: r(at(0.99)), max: r(s[s.length - 1]) };
}

type Devtools = { dataType: 'track-entry' | 'marker'; track?: string; trackGroup?: string; color?: string; properties?: [string, string][] };

function measure(name: string, start: number, end: number, devtools: Devtools) {
  try {
    performance.measure(name, { start, end, detail: { devtools } });
  } catch {}
}

class Perf {
  /** Collect timing now (stats on, or a run). Set by main.ts each frame from the Esc menu's switch. */
  collect = PERF_RUN;
  /** GPU timestamps are tracked (the renderer was made with them, and the browser has them). */
  gpuTracked = false;
  /** The last finished frame's numbers (ms). gpu is null until the first query resolves, or when untracked. */
  last = { cpu: 0, submit: 0, gpu: null as number | null };

  private t0 = 0;
  private submitT = 0;
  private lastStart = 0;
  private gpuPending = false;
  private gpu: number | null = null;
  private frames = 0;
  private phase: Phase = PERF_RUN ? 'waiting' : 'off';
  private phaseT = 0;
  private marks: Record<string, number> = {};
  private longTasks = { count: 0, ms: 0, before: 0 };
  private rec = { gap: [] as number[], cpu: [] as number[], submit: [] as number[], gpu: [] as number[], draws: [] as number[], tris: [] as number[], ratio: [] as number[] };
  private held = new Set<string>();
  private env: Record<string, unknown> = {};
  /** The scene, for the census of what is drawn (set by main.ts). */
  scene: THREE.Object3D | null = null;
  /** Called when a run ends (main.ts looks at the horizon, for the pictures tools/perf.ts takes). */
  onDone: (() => void) | null = null;
  /** The shadow cascades' cameras (set by main.ts), to count what each one draws. */
  cascades: (() => THREE.Camera[]) | null = null;

  constructor() {
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            this.longTasks.count++;
            this.longTasks.ms += e.duration;
          }
        }).observe({ type: 'longtask', buffered: true });
      } catch {}
    }
    (window as unknown as { __setGraphics: unknown }).__setGraphics = setGraphics; // (tools/perf.ts --ab changes an option mid-run)
    this.publish();
  }

  /** A point on the startup timeline (ms since the page started), also a marker in the trace. Only the first call of a name counts. */
  milestone(name: string) {
    if (name in this.marks) return;
    const now = performance.now();
    this.marks[name] = Math.round(now);
    measure(name, now, now, { dataType: 'marker', color: 'secondary' });
    performance.mark(`dadajam:${name}`);
  }

  /** What the run reports about this machine and build (backend, GPU, build, settings). */
  describe(env: Record<string, unknown>) {
    this.env = env;
  }

  frameStart() {
    const now = performance.now();
    this.t0 = now;
    this.gap = now - this.lastStart;
    this.lastStart = now;
  }
  private gap = 0;

  submitStart() {
    this.submitT = performance.now();
  }

  /** After `post.render()`: reads the GPU time of the passes drawn so far (one query round at a time). */
  submitEnd(renderer: { resolveTimestampsAsync(type?: never): Promise<number | undefined> } | null) {
    this.last.submit = performance.now() - this.submitT;
    if (!this.gpuTracked || !renderer || this.gpuPending) return;
    this.gpuPending = true;
    renderer.resolveTimestampsAsync('render' as never).then(
      (ms) => {
        this.gpuPending = false;
        if (typeof ms === 'number' && ms > 0) this.gpu = ms;
      },
      () => (this.gpuPending = false),
    );
  }

  /** End of a drawn frame. `playable`: the world is shown and nothing covers it. `drive`: turn the view by this many radians. */
  frameEnd(draws: number, trisK: number, ratio: number, playable: boolean, dt: number, turn: (rad: number) => void) {
    const end = performance.now();
    const cpu = end - this.t0;
    this.last.cpu = cpu;
    this.last.gpu = this.gpu;
    if (this.collect) {
      measure('cpu', this.t0, end, { dataType: 'track-entry', track: 'Frame', trackGroup: 'dadajam', color: 'tertiary', properties: [['submit ms', this.last.submit.toFixed(1)], ['draws', String(draws)]] });
      if (this.gpu !== null) measure('gpu', Math.max(0, end - this.gpu), end, { dataType: 'track-entry', track: 'GPU (summed passes, resolved late)', trackGroup: 'dadajam', color: 'error' });
      if (++this.frames % 300 === 0) {
        performance.clearMeasures();
        performance.clearMarks();
      }
    }
    if (this.phase !== 'off' && this.phase !== 'done') this.run(playable, dt, { cpu, draws, trisK, ratio }, turn);
  }

  private run(playable: boolean, dt: number, f: { cpu: number; draws: number; trisK: number; ratio: number }, turn: (rad: number) => void) {
    if (this.phase === 'waiting') {
      if (!playable) return;
      this.milestone('playable');
      this.longTasks.before = this.longTasks.ms;
      if (RUN_S === 0) return this.finish();
      this.phase = 'settling';
      this.phaseT = 0;
      this.publish();
      return;
    }
    this.phaseT += dt;
    if (this.phase === 'settling') {
      if (this.phaseT >= SETTLE_S) {
        this.phase = 'recording';
        this.phaseT = 0;
        this.milestone('recording-start');
        this.publish();
      }
      return;
    }
    // recording: walk forward, in a slow turn, sprinting every other ten seconds
    const t = this.phaseT;
    this.key('forward', true);
    this.key('sprint', t % 20 >= 10);
    turn(0.35 * dt);
    const r = this.rec;
    r.gap.push(this.gap);
    r.cpu.push(f.cpu);
    r.submit.push(this.last.submit);
    if (this.gpu !== null) r.gpu.push(this.gpu);
    r.draws.push(f.draws);
    r.tris.push(f.trisK);
    r.ratio.push(f.ratio);
    if (t >= RUN_S) this.finish();
  }

  /** Press or release the key bound to an action, as the keyboard would. */
  private key(action: 'forward' | 'sprint', down: boolean) {
    const code = slots(action)[0];
    if (!code || this.held.has(code) === down) return;
    if (down) this.held.add(code);
    else this.held.delete(code);
    dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));
  }

  private finish() {
    this.key('forward', false);
    this.key('sprint', false);
    this.phase = 'done';
    this.onDone?.();
    this.milestone('run-end');
    const r = this.rec;
    const fps = r.gap.length ? Math.round(10000 / (r.gap.reduce((x, y) => x + y, 0) / r.gap.length)) / 10 : null;
    const worst = [...r.gap].sort((a, b) => b - a).slice(0, Math.max(1, Math.ceil(r.gap.length * 0.01)));
    const result = {
      version: 1,
      when: new Date().toISOString(),
      build: typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : '',
      url: location.href,
      env: { ...this.env, dpr: devicePixelRatio, screen: `${screen.width}x${screen.height}`, window: `${innerWidth}x${innerHeight}`, ua: navigator.userAgent },
      graphics: { ...graphics },
      census: this.census(),
      startup: { milestonesMs: this.marks, longTasks: { count: this.longTasks.count, totalMs: Math.round(this.longTasks.ms), beforePlayableMs: Math.round(this.longTasks.before) } },
      gameplay: RUN_S === 0 ? null : {
        seconds: RUN_S,
        frames: r.gap.length,
        fps,
        lows1pctFps: worst.length ? Math.round(10000 / (worst.reduce((x, y) => x + y, 0) / worst.length)) / 10 : null,
        gapMs: stat(r.gap),
        cpuMs: stat(r.cpu),
        submitMs: stat(r.submit),
        gpuMs: stat(r.gpu),
        draws: stat(r.draws),
        trianglesK: stat(r.tris),
        renderScale: stat(r.ratio),
        framesOver20ms: r.gap.filter((g) => g > 20).length,
        framesOver50ms: r.gap.filter((g) => g > 50).length,
        bound: r.gpu.length ? (stat(r.cpu)!.p50 >= stat(r.gpu)!.p50 ? 'cpu' : 'gpu') : 'unknown (no gpu timestamps)',
      },
    };
    (window as unknown as { __perfResult: unknown }).__perfResult = result;
    console.log('PERF_RESULT', JSON.stringify(result));
    this.publish();
    if (params.get('perfdl') !== '0') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
      a.download = `dadajam-perf-${result.build || 'dev'}-${Date.now()}.json`;
      a.click();
    }
  }

  /** What the scene holds to draw: meshes and triangles that cast shadows (each is drawn again in every cascade it reaches),
   *  by the top-level object they hang under, and by size (world radius, m). Says where draw calls could be saved. */
  private census() {
    if (!this.scene) return null;
    const scene = this.scene;
    const roots = new Map<string, { meshes: number; tris: number; instanced: number }>();
    const kinds = new Map<string, { meshes: number; geometries: Set<string>; instances: number }>();
    const sizes = { 'lt0.5': 0, 'lt1': 0, 'lt2': 0, 'lt5': 0, 'lt20': 0, 'ge20': 0 };
    let meshes = 0, tris = 0, all = 0, shadowless = 0;
    const v = new THREE.Vector3();
    const rootOf = (o: THREE.Object3D) => {
      let t = o;
      while (t.parent && t.parent !== scene) t = t.parent;
      return `${t.type}${t.name ? ':' + t.name : ''}`;
    };
    scene.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      all++;
      if (!m.castShadow) return void shadowless++;
      const g = m.geometry;
      const t = g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
      meshes++;
      tris += t;
      const key = rootOf(o);
      const e = roots.get(key) ?? { meshes: 0, tris: 0, instanced: 0 };
      e.meshes++;
      e.tris += t;
      if ((m as THREE.InstancedMesh).isInstancedMesh) e.instanced++;
      roots.set(key, e);
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      const kind = `${(m as THREE.InstancedMesh).isInstancedMesh ? 'instanced ' : ''}${m.name || mat?.name || m.type}${g.name ? ' / ' + g.name : ''}`;
      const ke = kinds.get(kind) ?? { meshes: 0, geometries: new Set<string>(), instances: 0 };
      ke.meshes++;
      ke.geometries.add(g.uuid);
      ke.instances += (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
      kinds.set(kind, ke);
      g.boundingSphere ?? g.computeBoundingSphere();
      m.matrixWorld.decompose(v, new THREE.Quaternion(), new THREE.Vector3());
      const sc = new THREE.Vector3().setFromMatrixScale(m.matrixWorld);
      const rad = (g.boundingSphere?.radius ?? 0) * Math.max(sc.x, sc.y, sc.z);
      const k = rad < 0.5 ? 'lt0.5' : rad < 1 ? 'lt1' : rad < 2 ? 'lt2' : rad < 5 ? 'lt5' : rad < 20 ? 'lt20' : 'ge20';
      sizes[k]++;
    });
    const byRoot = [...roots].sort((a, b) => b[1].meshes - a[1].meshes).slice(0, 20).map(([root, e]) => ({ root, ...e, tris: Math.round(e.tris) }));
    const byKind = [...kinds].sort((a, b) => b[1].meshes - a[1].meshes).slice(0, 25).map(([kind, e]) => ({ kind, meshes: e.meshes, geometries: e.geometries.size, instances: e.instances }));
    // what each cascade's shadow pass would draw: casters whose layers match its camera and that are in its box (or never culled)
    const cascadeDraws = (this.cascades?.() ?? []).map((cam) => {
      const fr = new THREE.Frustum();
      cam.updateMatrixWorld();
      fr.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
      const byKind = new Map<string, number>();
      let n = 0;
      scene.traverseVisible((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.castShadow || !m.layers.test(cam.layers)) return;
        if (m.frustumCulled && !fr.intersectsObject(m)) return;
        if ((m as THREE.InstancedMesh).isInstancedMesh && (m as THREE.InstancedMesh).count === 0) return;
        n++;
        const mat = Array.isArray(m.material) ? m.material[0] : m.material;
        const k = `${(m as THREE.InstancedMesh).isInstancedMesh ? 'instanced ' : ''}${m.frustumCulled ? '' : 'unculled '}${rootOf(o)} ${mat?.name ?? ''}`;
        byKind.set(k, (byKind.get(k) ?? 0) + 1);
      });
      return { draws: n, top: [...byKind].sort((a, b) => b[1] - a[1]).slice(0, 6) };
    });
    return { cascadeDraws, byKind, visibleMeshes: all, shadowCasters: meshes, shadowlessMeshes: shadowless, casterTriangles: Math.round(tris), byRoot, casterRadiusM: sizes };
  }

  /** The run's state for tools/perf.ts (and a glance at the console): `window.__perfState`. */
  private publish() {
    (window as unknown as { __perfState: unknown }).__perfState = { phase: this.phase, run: PERF_RUN };
  }

  /** A small line while a run is on, so the screen says what is happening. */
  get status(): string {
    if (this.phase === 'off' || this.phase === 'done') return this.phase === 'done' ? 'perf run done' : '';
    if (this.phase === 'recording') return `perf run ${Math.round(this.phaseT)}/${RUN_S} s`;
    return `perf run: ${this.phase}`;
  }
}

export const perf = new Perf();
