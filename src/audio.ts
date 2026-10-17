// Shared Web Audio output: one context, a master gain that follows the volume slider (Esc menu,
// src/menu.ts; remembered per browser), and a limiter in front of the speakers. Every sound connects to `audio.out`.
//
// Browsers only start audio after a user gesture, so the context is created on the first click or key;
// `onStart` callbacks run then (or immediately, if it is already running).

const VOLUME_KEY = 'dadajam.volume';

class AudioOut {
  /** Overall volume, 0..1. 1 is the reference level; the slider only attenuates. */
  volume = 0.4;
  ctx: AudioContext | null = null;
  /** Connect sources here. */
  out: GainNode | null = null;
  private starters: ((ctx: AudioContext, out: GainNode) => void)[] = [];

  constructor() {
    try {
      const v = parseFloat(localStorage.getItem(VOLUME_KEY) ?? '');
      if (v >= 0 && v <= 1) this.volume = v;
    } catch {}
    const start = () => {
      if (!this.ctx) this.build();
      if (this.ctx!.state === 'suspended') void this.ctx!.resume();
    };
    addEventListener('pointerdown', start);
    addEventListener('keydown', start);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    });
  }

  /** Run `f` once the context exists (after the first user gesture). */
  onStart(f: (ctx: AudioContext, out: GainNode) => void) {
    if (this.ctx && this.out) f(this.ctx, this.out);
    else this.starters.push(f);
  }

  get running() {
    return this.ctx?.state === 'running';
  }

  private build() {
    const ctx = new AudioContext();
    const out = ctx.createGain();
    out.gain.value = this.volume;
    // Gentle limiter: layers stack up in a storm gust and should squash, not clip.
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -10;
    limit.knee.value = 6;
    limit.ratio.value = 8;
    out.connect(limit).connect(ctx.destination);
    this.ctx = ctx;
    this.out = out;
    for (const f of this.starters) f(ctx, out);
    this.starters.length = 0;
  }

  /** From the menu's slider: follow it (ramped, no clicks) and remember it. */
  setVolume(v: number) {
    this.volume = v;
    if (this.ctx && this.out) this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    try {
      localStorage.setItem(VOLUME_KEY, String(v));
    } catch {}
  }
}

export const audio = new AudioOut();
