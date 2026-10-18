// Building a material's shader (and its shadow-pass twin) takes tens to hundreds of ms of main-thread time, and the very
// first frame needs all of them: 1.5-2 s in one go, in which the page can't take a click. three's compileAsync does not
// build the same ones the real render asks for, so instead the loading screen draws real frames, a few materials at a
// time: everything drawn is hidden but one object per distinct material and geometry layout, and the batch grows while
// frames stay quick. Each step() is one real render (shadows, post passes and all), so what it builds is exactly what
// the first visible frame would have built. Done, everything is put back.
import * as THREE from 'three/webgpu';

type Drawn = THREE.Object3D & { material?: THREE.Material | THREE.Material[]; geometry?: THREE.BufferGeometry };

const FAST_MS = 25;
const SLOW_MS = 70;

export class Warmup {
  private queue: THREE.Object3D[] = [];
  private every: { o: THREE.Object3D; visible: boolean; culled: boolean }[] = [];
  private started = false;
  private done = false;
  private batch = 1;

  private roots: THREE.Object3D[];
  private render: () => void;

  constructor(roots: THREE.Object3D[], render: () => void) {
    this.roots = roots;
    this.render = render;
  }

  /** Draws the next few materials. True once everything is built (and put back). */
  step(): boolean {
    if (this.done) return true;
    if (!this.started) this.collect();
    if (!this.queue.length) return this.finish();
    const stage = this.queue.splice(0, this.batch);
    for (const e of this.every) e.o.visible = false;
    for (const o of stage) {
      o.visible = true;
      o.frustumCulled = false; // built even when it is behind the camera
    }
    const t0 = performance.now();
    this.render();
    const ms = performance.now() - t0;
    this.batch = ms < FAST_MS ? this.batch * 2 : ms > SLOW_MS ? Math.max(1, this.batch >> 1) : this.batch;
    return false;
  }

  /** Put everything back as it was (also if the loading screen gives up waiting). */
  finish(): boolean {
    if (this.started && !this.done) for (const e of this.every) {
      e.o.visible = e.visible;
      e.o.frustumCulled = e.culled;
    }
    this.done = true;
    return true;
  }

  private collect() {
    this.started = true;
    const seen = new Map<string, THREE.Object3D>();
    const all = new Set<THREE.Object3D>();
    for (const root of this.roots) {
      root.traverseVisible((o) => {
        const d = o as Drawn;
        if (!d.material || !d.geometry || all.has(o)) return;
        all.add(o);
        const mats = Array.isArray(d.material) ? d.material : [d.material];
        const attrs = Object.keys(d.geometry.attributes).sort().join();
        const inst = (o as THREE.InstancedMesh).isInstancedMesh ? o.uuid : '';
        const bones = (o as THREE.SkinnedMesh).skeleton ? (o as THREE.SkinnedMesh).skeleton.bones.length : 0;
        const key = `${mats.map((m) => m.uuid).join()}|${attrs}|${inst}|${bones}|${o.receiveShadow}|${o.castShadow}`;
        if (!seen.has(key)) seen.set(key, o);
      });
    }
    this.queue = [...seen.values()];
    this.every = [...all].map((o) => ({ o, visible: o.visible, culled: o.frustumCulled }));
  }
}
