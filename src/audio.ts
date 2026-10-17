// Shared Web Audio output: one context, a master gain that follows the volume slider (Esc menu,
// src/menu.ts; remembered per browser), and a limiter in front of the speakers. Every sound connects to `audio.out`;
// music connects to `audio.music`, a gain under its own slider that feeds `out`.
//
// Browsers only start audio after a user gesture, so the context is created on the first click or key;
// `onStart` callbacks run then (or immediately, if it is already running).

const VOLUME_KEY = 'dadajam.volume';
const MUSIC_KEY = 'dadajam.musicVolume';

function stored(key: string, fallback: number) {
  try {
    const v = parseFloat(localStorage.getItem(key) ?? '');
    if (v >= 0 && v <= 1) return v;
  } catch {}
  return fallback;
}

class AudioOut {
  /** Overall volume, 0..1. 1 is the reference level; the slider only attenuates. */
  volume = stored(VOLUME_KEY, 0.4);
  /** Music volume, 0..1, on top of `volume`. */
  musicVolume = stored(MUSIC_KEY, 1);
  ctx: AudioContext | null = null;
  /** Connect sources here. */
  out: GainNode | null = null;
  /** Connect music here. */
  music: GainNode | null = null;
  private starters: ((ctx: AudioContext, out: GainNode) => void)[] = [];

  constructor() {
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
    const music = ctx.createGain();
    music.gain.value = this.musicVolume;
    music.connect(out);
    this.ctx = ctx;
    this.out = out;
    this.music = music;
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

  /** From the menu's music slider, likewise. */
  setMusicVolume(v: number) {
    this.musicVolume = v;
    if (this.ctx && this.music) this.music.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    try {
      localStorage.setItem(MUSIC_KEY, String(v));
    } catch {}
  }
}

export const audio = new AudioOut();
