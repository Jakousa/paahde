// Dynamic resolution. The frame is bound by shading ground pixels (the sand shader, cascaded shadows,
// post), so its cost scales with the pixel count: ~32 ms at a 2x retina ratio, ~14 ms at 1.5x, in a
// 1280x800 window on an M2 Pro, and a bigger window or a weaker GPU costs proportionally more. Instead
// of guessing one ratio for everyone, the render pixel ratio follows the measured frame time.
//
// Too slow: drop straight to the ratio that should fit (cost ∝ ratio²), and remember that the ratio
// we left was too much. Steady 60 fps: creep back up, never past a ceiling that failed recently, so
// looking at the sky and back doesn't pump the resolution up and down every few seconds.
//
// Not every slow frame is pixels: a CPU spike, or a browser throttled to 30 fps (battery saver), is
// just as slow at any ratio, and dropping for it only pixelates the screen with nothing to climb back
// on. So each drop is a probe: if the next window isn't clearly faster, the ratio goes back and drops
// wait a while (longer each time it happens again).
import type * as THREE from 'three/webgpu';

/** Never render finer than this (retina screens report 2–3): one pixel per CSS pixel is plenty for
 *  this look, and it leaves headroom for 60 fps on laptops. */
const MAX_RATIO = 1;
const MIN_RATIO = 0.65;
/** Frame time we aim for, a little under 60 fps so vsync jitter doesn't count as slow. */
const TARGET_MS = 1000 / 57;
/** Frames slower than this are treated as slow when averaged (55 fps). */
const SLOW_MS = 1000 / 55;
/** Measurement window. */
const WINDOW_S = 0.5;
/** Seconds of steady frames before stepping the ratio up, and how much each step adds. */
const CALM_S = 2;
const STEP_UP = 1.1;
/** A failed ceiling relaxes back towards the maximum over about this many seconds. */
const CEILING_RELAX_S = 60;
/** Loading and shader compiles make the first frames slow: don't judge them. */
const WARMUP_S = 3;
/** Single frames longer than this (shader compiles, a hidden tab) are left out of the average. */
const HITCH_MS = 100;
/** A drop has to save at least this share of the frame time to count as helping. */
const MIN_GAIN = 0.1;
/** After a drop that didn't help, no drops for this long, doubling on each repeat up to the max. */
const HOLD_S = 8;
const HOLD_MAX_S = 120;

export class DynamicResolution {
  ratio: number;
  private renderer: THREE.WebGPURenderer;
  private max: number;
  private ceiling: number;
  private ms = 0;
  private frames = 0;
  private elapsed = 0;
  private calm = 0;
  private warmup = WARMUP_S;
  /** The drop being judged: the ratio, ceiling and frame time before it. */
  private probe: { ratio: number; ceiling: number; ms: number } | null = null;
  private hold = 0;
  private holdS = HOLD_S;

  constructor(renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
    this.max = Math.min(window.devicePixelRatio, MAX_RATIO);
    this.ratio = this.ceiling = this.max;
    renderer.setPixelRatio(this.ratio);
  }

  /** Call once per rendered frame with its duration in seconds. */
  update(dt: number) {
    if ((this.warmup -= dt) > 0) return;
    this.elapsed += dt;
    if (dt * 1000 < HITCH_MS) {
      this.ms += dt * 1000;
      this.frames++;
    }
    if (this.elapsed < WINDOW_S) return;
    const span = this.elapsed;
    const avg = this.frames > 0 ? this.ms / this.frames : 0;
    this.elapsed = this.ms = this.frames = 0;
    this.ceiling += (this.max - this.ceiling) * Math.min(1, span / CEILING_RELAX_S);
    this.hold = Math.max(0, this.hold - span);
    if (avg === 0) return;

    const probe = this.probe;
    this.probe = null;
    if (probe) {
      if (avg > probe.ms * (1 - MIN_GAIN)) {
        // Fewer pixels didn't help: not pixel-bound, so put the resolution back.
        this.ceiling = probe.ceiling;
        this.set(probe.ratio);
        this.hold = this.holdS;
        this.holdS = Math.min(HOLD_MAX_S, this.holdS * 2);
        this.calm = 0;
        return;
      }
      this.holdS = HOLD_S;
    }

    if (avg > SLOW_MS) {
      this.calm = 0;
      if (this.ratio <= MIN_RATIO || this.hold > 0) return;
      this.probe = { ratio: this.ratio, ceiling: this.ceiling, ms: avg };
      this.ceiling = Math.min(this.ceiling, this.ratio * 0.97);
      this.set(this.ratio * Math.max(0.7, Math.sqrt(TARGET_MS / avg)));
    } else if ((this.calm += span) >= CALM_S) {
      this.calm = 0;
      if (this.ratio < this.ceiling) this.set(Math.min(this.ceiling, this.ratio * STEP_UP));
    }
  }

  private set(ratio: number) {
    this.ratio = Math.max(MIN_RATIO, Math.min(this.max, ratio));
    this.renderer.setPixelRatio(this.ratio);
  }
}
