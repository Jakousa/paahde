// Dynamic resolution. The frame is bound by shading ground pixels (the sand shader, cascaded shadows,
// post), so its cost scales with the pixel count: ~32 ms at a 2x retina ratio, ~14 ms at 1.5x, in a
// 1280x800 window on an M2 Pro, and a bigger window or a weaker GPU costs proportionally more. Instead
// of guessing one ratio for everyone, the render pixel ratio follows the measured frame time.
//
// Too slow: drop straight to the ratio that should fit (cost ∝ ratio²), and remember that the ratio
// we left was too much. Steady 60 fps: creep back up, never past a ceiling that failed recently, so
// looking at the sky and back doesn't pump the resolution up and down every few seconds.
import type * as THREE from 'three/webgpu';

/** Never render finer than this (retina screens report 2–3). */
const MAX_RATIO = 1.5;
const MIN_RATIO = 0.5;
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
    if (avg === 0) return;

    if (avg > SLOW_MS) {
      this.calm = 0;
      if (this.ratio <= MIN_RATIO) return;
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
