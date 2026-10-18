// Shared Web Audio output: one context, a master gain that follows the volume slider (Esc menu,
// src/menu.ts; remembered per browser), and a limiter in front of the speakers. Every sound connects to `audio.out`,
// which goes through a muffle low-pass (`setMuffled`: dull and quieter while you lie dead) to the master; music
// connects to `audio.music`, a gain under its own slider that feeds the master directly, so it is never muffled.
//
// Browsers only start audio after a user gesture, so the context is created on the first click or key;
// `onStart` callbacks run then (or immediately, if it is already running).
//
// A single NaN or infinite sample reaching a BiquadFilter leaves it putting out NaN for good (Chrome), so one bad
// sample from any sound would silence everything through the muffle low-pass for the rest of the session. `out`
// goes through a small worklet that zeroes non-finite samples first (and warns once, to help find the culprit).

const VOLUME_KEY = 'dadajam.volume';
const MUSIC_KEY = 'dadajam.musicVolume';
/** Muffled: low-pass cutoff (Hz) and level; open cutoff; time constants (s) in and back out. */
const MUFFLE_HZ = 350;
const MUFFLE_GAIN = 0.5;
const MUFFLE_OFF_HZ = 20000;
const MUFFLE_IN = 0.15;
const MUFFLE_OUT = 0.8;

const FINITE = `registerProcessor('finite', class extends AudioWorkletProcessor {
  constructor() { super(); this.told = false; }
  process(inputs, outputs) {
    const i = inputs[0], o = outputs[0];
    let bad = false;
    for (let c = 0; c < o.length; c++) {
      const a = i[c], b = o[c];
      if (!a) continue;
      for (let k = 0; k < b.length; k++) {
        const v = a[k];
        if (v - v === 0) b[k] = v;
        else { b[k] = 0; bad = true; }
      }
    }
    if (bad && !this.told) { this.told = true; this.port.postMessage(0); }
    return true;
  }
});`;

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
  private master: GainNode | null = null;
  private muffle: { lp: BiquadFilterNode; duck: GainNode } | null = null;
  private muffled = false;

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
    const master = ctx.createGain();
    master.gain.value = this.volume;
    // Gentle limiter: layers stack up in a storm gust and should squash, not clip.
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -10;
    limit.knee.value = 6;
    limit.ratio.value = 8;
    master.connect(limit).connect(ctx.destination);
    const out = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = MUFFLE_OFF_HZ;
    lp.Q.value = 0.707;
    const duck = ctx.createGain();
    out.connect(lp).connect(duck).connect(master);
    const url = URL.createObjectURL(new Blob([FINITE], { type: 'text/javascript' }));
    ctx.audioWorklet
      .addModule(url)
      .then(() => {
        const finite = new AudioWorkletNode(ctx, 'finite', { outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
        finite.port.onmessage = () => console.warn('audio: a sound put out NaN/Infinity (zeroed)');
        out.disconnect();
        out.connect(finite).connect(lp);
      })
      .catch((e) => console.warn('audio: no NaN guard', e))
      .finally(() => URL.revokeObjectURL(url));
    const music = ctx.createGain();
    music.gain.value = this.musicVolume;
    music.connect(master);
    this.ctx = ctx;
    this.master = master;
    this.muffle = { lp, duck };
    this.out = out;
    this.music = music;
    for (const f of this.starters) f(ctx, out);
    this.starters.length = 0;
  }

  /** From the menu's slider: follow it (ramped, no clicks) and remember it. */
  setVolume(v: number) {
    this.volume = v;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    try {
      localStorage.setItem(VOLUME_KEY, String(v));
    } catch {}
  }

  /** Muffle every sound but the music (dying), or bring it back: quickly in, slowly out. */
  setMuffled(on: boolean) {
    if (on === this.muffled || !this.ctx || !this.muffle) return;
    this.muffled = on;
    const now = this.ctx.currentTime, tau = on ? MUFFLE_IN : MUFFLE_OUT;
    const { lp, duck } = this.muffle;
    lp.frequency.cancelScheduledValues(now);
    lp.frequency.setTargetAtTime(on ? MUFFLE_HZ : MUFFLE_OFF_HZ, now, tau);
    duck.gain.cancelScheduledValues(now);
    duck.gain.setTargetAtTime(on ? MUFFLE_GAIN : 1, now, tau);
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
