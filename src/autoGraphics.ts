// Auto quality measures the two bottlenecks separately. CPU cost is the game's own frame callback;
// GPU pressure is confirmed by resolution probes that actually made frames faster. This works without
// GPU timestamp support, and doesn't mistake a 30 Hz screen or battery-saver cap for a weak GPU.
import { adaptGraphics, graphics, onGraphics } from './graphics.ts';

type Tier = 0 | 1 | 2;
const WINDOW_S = 3;
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Two windows to reduce detail, six to restore it: don't chase a single stutter or a brief look at the sky. */
class Level {
  value: Tier;
  private candidate: Tier;
  private windows = 0;

  constructor(initial: Tier = 1) { this.value = this.candidate = initial; }

  observe(wanted: Tier) {
    if (wanted !== this.candidate) { this.candidate = wanted; this.windows = 0; }
    if (wanted === this.value) { this.windows = 0; return; }
    if (++this.windows >= (wanted < this.value ? 2 : 6)) { this.value = wanted; this.windows = 0; }
  }
}

/** Pure measurement policy, also exercised with mixed CPU/GPU workloads by tools/check-graphics.ts. */
export class AutoQuality {
  private cpu: Level;
  // Keep GPU effects until there is evidence they are the bottleneck, including on a CPU-bound device.
  private gpu: Level;
  private warmup = 3;
  private elapsed = 0;
  private costs: number[] = [];
  private scales: number[] = [];
  private gaps: number[] = [];
  private pixelBoundFrames = 0;

  constructor(cpu: Tier = 1, gpu: Tier = 2) { this.cpu = new Level(cpu); this.gpu = new Level(gpu); }

  /** Call only for visible, playable frames. Inactive periods discard partial samples and settle again. */
  update(dt: number, cpuMs: number, scale: number, pixelBound: boolean, active: boolean) {
    if (!active || dt <= 0 || dt >= 0.25 || !Number.isFinite(cpuMs) || cpuMs <= 0) {
      this.clear();
      this.warmup = 3;
      return null;
    }
    if ((this.warmup -= dt) > 0) return null;
    this.elapsed += dt;
    this.costs.push(cpuMs);
    this.scales.push(scale);
    this.gaps.push(dt * 1000);
    if (pixelBound) this.pixelBoundFrames++;
    if (this.elapsed < WINDOW_S || this.costs.length < 20) return null;
    const cpu = median(this.costs), ratio = median(this.scales), gap = median(this.gaps);
    this.cpu.observe(cpu > 12 ? 0 : cpu > 8 ? 1 : 2);
    // Only a successful resolution probe can justify cutting GPU effects. Otherwise keep their detail.
    const gpu = this.pixelBoundFrames > this.costs.length / 2 ? (ratio < 0.65 ? 0 : ratio < 0.9 ? 1 : 2)
      : ratio >= 0.95 && gap < 19 ? 2 : this.gpu.value;
    this.gpu.observe(gpu);
    this.clear();
    return {
      shadowRefresh: this.cpu.value === 2 ? 1 : 2,
      shadowDistance: [400, 800, 1600][this.cpu.value],
      shadows: this.gpu.value > 0,
      sandDetail: this.gpu.value,
      occlusion: this.gpu.value === 2 ? 0.7 : 0,
    };
  }

  private clear() {
    this.elapsed = this.pixelBoundFrames = 0;
    this.costs.length = this.scales.length = this.gaps.length = 0;
  }
}

// Resume from Auto's saved choices, instead of putting costly effects back on at every page load.
function makePolicy() {
  return new AutoQuality(graphics.shadowDistance <= 400 ? 0 : graphics.shadowDistance <= 800 ? 1 : 2,
    !graphics.shadows ? 0 : graphics.occlusion > 0 ? 2 : 1);
}
let policy = makePolicy();
onGraphics((_g, changed) => { if (changed === 'autoQuality') policy = makePolicy(); });

export function autoGraphicsFrame(dt: number, cpuMs: number, scale: number, pixelBound: boolean, active: boolean) {
  if (!graphics.autoQuality) return;
  const change = policy.update(dt, cpuMs, scale, pixelBound, active);
  if (change) adaptGraphics(change);
}
