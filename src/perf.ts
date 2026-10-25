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
/** `&proute=spin`: stand and turn a full circle (for comparing rendering: the same views every run); otherwise walk. */
const SPIN = params.get('proute') === 'spin';
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
  /** GPU time per render pass (render context id), from the timestamp queries while recording: total ms and the frames it was drawn in. */
  private passes = new Map<string, { ms: number; n: number; max: number }>();
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
  /** Moves the world's clock to a time of day (main.ts), for `&ptod=` (tools/perf.ts --tod). */
  setTod: ((tod: number) => void) | null = null;
  /** Where the player is, whether they are down or dead, and how hot they are (main.ts). Dying is part of the data, not noise: see `events` and `valid` in the result. */
  player: (() => { x: number; z: number; down: boolean; heat: number }) | null = null;
  private startPos: { x: number; z: number } | null = null;
  private lastPos: { x: number; z: number } | null = null;
  private travelled = 0;
  private wasDown = false;
  /** Frames left after a respawn that are not counted (the player was just put back at the bedroll or the pod; the view and streaming reset). */
  private afterRespawn = 0;
  private framesExcluded = 0;
  /** Deaths and respawns during the walk, in order. */
  private events: { type: 'died' | 'respawned'; atS: number; x: number; z: number; heat: number }[] = [];
  /** A death ends the run (default: its numbers would be a ragdoll's, then the respawn's); `&pdeath=continue` keeps going and leaves those frames out. */
  private endOnDeath = params.get('pdeath') !== 'continue';
  private invalid: string[] = [];
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
        if (this.phase === 'recording') this.countPasses(renderer);
      },
      () => (this.gpuPending = false),
    );
  }

  /** Adds the passes of the last resolved queries (three keeps `r:<call>:<context id>:f<frame>` -> ms) to the per-context totals. */
  private countPasses(renderer: unknown) {
    const pool = (renderer as { backend?: { timestampQueryPool?: { render?: { timestamps?: Map<string, number> } } } }).backend?.timestampQueryPool?.render;
    if (!pool?.timestamps) return;
    for (const [uid, ms] of pool.timestamps) {
      const ctx = uid.split(':')[2];
      const e = this.passes.get(ctx) ?? { ms: 0, n: 0, max: 0 };
      e.ms += ms;
      e.n++;
      e.max = Math.max(e.max, ms);
      this.passes.set(ctx, e);
    }
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
      if (params.has('ptod')) this.setTod?.(Number(params.get('ptod')));
      this.longTasks.before = this.longTasks.ms;
      if (RUN_S === 0) return this.finish();
      this.phase = 'settling';
      this.phaseT = 0;
      if (params.has('pyaw')) turn(Number(params.get('pyaw'))); // (turn round to face open ground: `&pyaw=3.14`)
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
    // recording: walk forward, in a very wide turn (a circle of ~100 m at a walk), sprinting every other ten seconds
    const t = this.phaseT;
    const me = this.player?.();
    if (me) {
      this.startPos ??= { x: me.x, z: me.z };
      if (me.down !== this.wasDown) {
        // dying and getting up again are events in the data and markers in the trace, not something to puzzle out from the numbers
        const type = me.down ? 'died' : 'respawned';
        this.events.push({ type, atS: Math.round(t * 10) / 10, x: Math.round(me.x), z: Math.round(me.z), heat: Math.round(me.heat * 100) / 100 });
        const now = performance.now();
        measure(`player ${type}`, now, now, { dataType: 'marker', color: 'error' });
        performance.mark(`dadajam:player-${type}`);
        this.wasDown = me.down;
        if (me.down) this.invalid.push(`the player died at ${this.events[this.events.length - 1].atS} s (${this.endOnDeath ? 'run ended' : 'frames while down and for a second after left out'})`);
        else this.afterRespawn = 60;
        this.lastPos = null; // (a respawn is a teleport, not walking)
        if (me.down && this.endOnDeath) return this.finish();
      }
      if (this.lastPos && !me.down) this.travelled += Math.hypot(me.x - this.lastPos.x, me.z - this.lastPos.z);
      this.lastPos = { x: me.x, z: me.z };
      if (me.down || this.afterRespawn > 0) {
        this.afterRespawn = Math.max(0, this.afterRespawn - 1);
        this.framesExcluded++;
        if (t >= RUN_S) this.finish();
        return;
      }
    }
    if (SPIN) {
      // the spin: stand still and turn one full circle over the run, so every run sees the same views whatever its frame rate
      turn(((Math.PI * 2) / RUN_S) * dt);
    } else {
      this.key('forward', true);
      this.key('sprint', t % 20 >= 10);
      turn(0.06 * dt);
    }
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
    // a walk that went nowhere (a wall, a scrap pile, a dune face) is no walk either
    const seconds = Math.min(RUN_S, this.phaseT);
    if (RUN_S > 0 && !SPIN && seconds > 5 && this.travelled < seconds * 1.5) this.invalid.push(`the player barely moved (${Math.round(this.travelled)} m in ${Math.round(seconds)} s): blocked by something, turn or move the spawn`);
    if (RUN_S > 0 && this.phaseT < RUN_S - 0.5) this.invalid.push(`the run ended early, at ${Math.round(this.phaseT * 10) / 10} s of ${RUN_S} s`);
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
      // false when something other than the game's own frame cost decided the numbers: the player died, the walk was blocked, the run ended early.
      // The reasons are listed; tools/perf.ts prints them and exits with 2.
      valid: this.invalid.length === 0,
      invalidReasons: this.invalid,
      gameplay: RUN_S === 0 ? null : {
        seconds: RUN_S,
        route: SPIN ? 'spin' : 'walk',
        // the walk: where it started and ended, and what happened to the player on it
        startedAt: this.startPos ? [Math.round(this.startPos.x), Math.round(this.startPos.z)] : null,
        endedAt: this.player ? (({ x, z }) => [Math.round(x), Math.round(z)])(this.player()!) : null,
        travelledM: Math.round(this.travelled),
        events: this.events,
        died: this.events.some((e) => e.type === 'died'),
        // frames not in the numbers below because the player was down (or just respawned); the numbers cover the other frames only
        framesExcluded: this.framesExcluded,
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
        // GPU ms by render pass, biggest first. `share` of the frames the pass ran in tells which is which: the scene and the post passes run every frame,
        // the cascade that follows the player nearly every frame, the cached ones (cascade 1, 2, 3) a fraction of them.
        gpuPasses: [...this.passes].map(([ctx, e]) => ({ ctx, meanMs: Math.round((e.ms / e.n) * 100) / 100, maxMs: Math.round(e.max * 100) / 100, share: Math.round((e.n / Math.max(1, r.gpu.length)) * 100) / 100, perFrameMs: Math.round((e.ms / Math.max(1, r.gpu.length)) * 100) / 100 })).sort((a, b) => b.perFrameMs - a.perFrameMs).slice(0, 14),
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
