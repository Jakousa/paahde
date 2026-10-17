// Sounds of the laser rifle (src/rifle.ts) and of what it does to the walkers:
// - shot: one of three pulses cut from Defunct3's "Pulse laser" (CC0, public/credits.txt; laser-1..3.mp3, mono,
//   0.40–0.55 s, each levelled to −18.5 LUFS momentary, true peak ≤ −1.5 dBTP), picked at random and a little
//   off pitch each time; the pistol plays them higher and lighter. Your own is dry and in your head; another
//   player's carries across the desert (src/acoustics.ts: late, duller, softer and more reverb with distance). A
//   guardian's cannon fires the same pulses an octave down (CANNON_PITCH), slower and heavier: −18 LUFS momentary
//   max within CANNON_REF, true peak ≤ −1.5 dBTP.
// - firework: a weak point shattering (a crawler's softer), a shot-down drone crashing (softer) and a missile's blast
//   (lower) burst like a firework: one of
//   four of TB0Y298's "Firework Explosion" 1–4 (CC BY 4.0; firework-1..4.mp3, mono, each levelled to −18.9 LUFS
//   momentary max, true peak ≤ −4 dBTP), at random and a little off pitch, carried through src/acoustics.ts.
// The rest is synthesised:
// - recharge: the cell whining back up between shots, with a click when it's ready.
// - impact: where the beam struck: a hiss of sand, a metal ping, or the red glass of a weak point shattering with an
//   electric fizz.
// - a dying walker: servos winding down with a clunk as each leg gives out, then the crash of the hull on the sand.
// Everything placed in the world goes through src/acoustics.ts, then the shared output (src/audio.ts), every level
// ramped. Measured at the default volume (OfflineAudioContext + ffmpeg ebur128, momentary max): your own shot −24 LUFS
// (peaks −10 dBFS); another player's at 45 m −37, 100 m −43, 300 m −51 (mostly tail), 500 m −57. The synthesised
// ones, before the acoustics (integrated): glass shattering at 20 m −28; a guardian dying at 40 m −27, a crawler at
// 8 m −33.
import { audio } from './audio';
import { placed, type P } from './acoustics';

const SHOT_GAIN = 0.75;
/** The pulse samples, on top of SHOT_GAIN: together about 1. */
const PULSE_GAIN = 1.3;
const PULSES = ['./audio/laser-1.mp3', './audio/laser-2.mp3', './audio/laser-3.mp3'];
/** A guardian's cannon: the pulses at this pitch (lower: slower, heavier), level and full-level distance (m). */
const CANNON_PITCH = 0.5;
const CANNON_GAIN = 1;
const CANNON_REF = 25;
const CHARGE_GAIN = 0.035;
const IMPACT_GAIN = 1.2;
const DEATH_GAIN = 1.8;
const FIREWORKS = ['./audio/firework-1.mp3', './audio/firework-2.mp3', './audio/firework-3.mp3', './audio/firework-4.mp3'];
/** Full level within FIREWORK_REF m. */
const FIREWORK_GAIN = 2;
const FIREWORK_REF = 35;

let noiseBuf: AudioBuffer | null = null;
function noise(ctx: AudioContext) {
  if (noiseBuf) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

/** Filtered noise from t for `len` s: attack `a`, exponential decay. */
function hiss(ctx: AudioContext, to: AudioNode, t: number, len: number, type: BiquadFilterType, f: number, q: number, peak: number, a = 0.002) {
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = type;
  bp.frequency.value = f;
  bp.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  n.connect(bp).connect(g).connect(to);
  n.start(t, Math.random());
  n.stop(t + len + 0.05);
  return bp;
}

/** An oscillator from t: frequency f0 → f1 over `len`, exponential decay from `peak`. */
function tone(ctx: AudioContext, to: AudioNode, t: number, len: number, type: OscillatorType, f0: number, f1: number, peak: number, a = 0.003) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + len);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g).connect(to);
  o.start(t);
  o.stop(t + len + 0.05);
  return o;
}

class RifleSound {
  private charge: { osc: OscillatorNode; gain: GainNode } | null = null;
  private pulses: AudioBuffer[] = [];
  private fireworks: AudioBuffer[] = [];

  constructor() {
    audio.onStart((ctx) => {
      for (const src of PULSES) {
        fetch(src)
          .then((r) => r.arrayBuffer())
          .then((d) => ctx.decodeAudioData(d))
          .then((b) => this.pulses.push(b), (e) => console.warn('laser sound failed to load', src, e));
      }
      for (const src of FIREWORKS) {
        fetch(src)
          .then((r) => r.arrayBuffer())
          .then((d) => ctx.decodeAudioData(d))
          .then((b) => this.fireworks.push(b), (e) => console.warn('firework sound failed to load', src, e));
      }
    });
  }

  /** A shot: yours (`at` null) or someone else's at `at`, heard from `ear`. `pistol`: the laser pistol's, higher,
   *  shorter and lighter. */
  shot(at: P | null = null, ear: P | null = null, pistol = false) {
    const ctx = audio.ctx, s = placed(at, ear, SHOT_GAIN * (pistol ? 0.75 : 1), 15, 600);
    if (!ctx || !s) return;
    const { input: o, t } = s;
    // The pistol: up in pitch (so quicker), less body.
    const buf = this.pulses[Math.floor(Math.random() * this.pulses.length)];
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = (pistol ? 1.35 : 1) * (0.96 + Math.random() * 0.08);
      const g = ctx.createGain();
      g.gain.value = PULSE_GAIN;
      src.connect(g).connect(o);
      src.start(t);
      src.onended = () => g.disconnect();
    }
  }

  /** A firework burst at `at`, heard from `ear`, at `level` × FIREWORK_GAIN and `pitch` (about 1, lower is bigger). */
  firework(at: P, ear: P, level = 1, pitch = 1) {
    const ctx = audio.ctx, buf = this.fireworks[Math.floor(Math.random() * this.fireworks.length)];
    const s = buf ? placed(at, ear, FIREWORK_GAIN * level, FIREWORK_REF, 600) : null;
    if (!ctx || !s) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pitch * (0.92 + Math.random() * 0.16);
    src.connect(s.input);
    src.start(s.t);
  }

  /** A guardian's cannon firing at `at`, heard from `ear` (src/guardians.ts): a rifle shot an octave down. */
  cannon(at: P, ear: P) {
    const ctx = audio.ctx, buf = this.pulses[Math.floor(Math.random() * this.pulses.length)];
    const s = buf ? placed(at, ear, CANNON_GAIN, CANNON_REF, 500) : null;
    if (!ctx || !s) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = CANNON_PITCH * (0.95 + Math.random() * 0.1);
    src.connect(s.input);
    src.start(s.t);
  }

  /** The cell recharging over `s` seconds, then a click: yours only. */
  recharge(s: number) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const t = ctx.currentTime + 0.05;
    this.charge?.osc.stop();
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(380, t);
    osc.frequency.exponentialRampToValueAtTime(1700, t + s);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(CHARGE_GAIN, t + s * 0.6);
    gain.gain.setTargetAtTime(0, t + s, 0.015);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + s + 0.2);
    this.charge = { osc, gain };
    // Ready.
    const g = ctx.createGain();
    g.gain.value = 0.25;
    g.connect(out);
    hiss(ctx, g, t + s, 0.03, 'bandpass', 3200, 6, 0.6, 0.001);
  }

  /** Where the beam struck: sand, metal, or a weak point's glass. */
  impact(what: 'sand' | 'metal' | 'glass', at: P, ear: P) {
    const ctx = audio.ctx, s = placed(at, ear, IMPACT_GAIN, what === 'sand' ? 4 : 10, 400);
    if (!ctx || !s) return;
    const { input: o, t } = s;
    if (what === 'sand') {
      hiss(ctx, o, t, 0.35, 'bandpass', 1800, 0.8, 0.5);
      tone(ctx, o, t, 0.1, 'sine', 160, 60, 0.4);
      return;
    }
    // Metal: a ping of a few inharmonic partials.
    for (const [f, a] of [[1870, 0.25], [3120, 0.16], [4650, 0.1]] as const) tone(ctx, o, t, 0.5 + Math.random() * 0.3, 'sine', f * (0.95 + Math.random() * 0.1), f * 0.98, a);
    hiss(ctx, o, t, 0.08, 'highpass', 3000, 0.7, 0.4);
    if (what !== 'glass') return;
    // Glass: a crunch, then shards tinkling, and the electrics fizzing out.
    hiss(ctx, o, t, 0.18, 'bandpass', 2400, 1.2, 1.0, 0.001);
    for (let i = 0; i < 9; i++) hiss(ctx, o, t + 0.03 + Math.random() * 0.35, 0.05 + Math.random() * 0.06, 'bandpass', 4000 + Math.random() * 5000, 8, 0.4 * Math.random() + 0.1);
    const fizz = hiss(ctx, o, t + 0.02, 0.9, 'bandpass', 6000, 2, 0.35, 0.02);
    fizz.frequency.setValueAtTime(6000, t);
    fizz.frequency.exponentialRampToValueAtTime(1500, t + 0.9);
    tone(ctx, o, t, 0.6, 'square', 110, 55, 0.08, 0.01);
  }

  /** A walker's leg giving out (`heavy`: a guardian): a servo winding down and a clunk. */
  fail(at: P, ear: P, heavy: boolean) {
    const ctx = audio.ctx, s = placed(at, ear, DEATH_GAIN * (heavy ? 1 : 0.4), heavy ? 14 : 3, heavy ? 500 : 60);
    if (!ctx || !s) return;
    const { input: o, t } = s;
    const k = heavy ? 1 : 2.6; // small ones higher and quicker
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400 * k;
    lp.connect(o);
    tone(ctx, lp, t, 0.8 / k, 'sawtooth', 420 * k, 45 * k, 0.3, 0.02);
    tone(ctx, lp, t, 0.8 / k, 'sawtooth', 433 * k, 47 * k, 0.2, 0.02);
    hiss(ctx, o, t + 0.55 / k, 0.4, 'bandpass', 600 * k, 6, 0.6);
    tone(ctx, o, t + 0.55 / k, 0.3, 'sine', 90 * k, 40 * k, 0.6);
  }

  /** A dead walker's hull hitting the sand. */
  slam(at: P, ear: P, heavy: boolean) {
    const ctx = audio.ctx, s = placed(at, ear, DEATH_GAIN * (heavy ? 1.4 : 0.45), heavy ? 16 : 3, heavy ? 800 : 80);
    if (!ctx || !s) return;
    const { input: o, t } = s;
    const k = heavy ? 1 : 2.4;
    tone(ctx, o, t, 1.4 / k, 'sine', 50 * k, 20 * k, 1, 0.01);
    hiss(ctx, o, t, 1.8 / k, 'lowpass', 300 * k, 0.6, 0.9, 0.01);
    // Plates and struts clattering down after it.
    for (let i = 0; i < 6; i++) hiss(ctx, o, t + 0.05 + Math.random() * 0.6 / k, 0.25, 'bandpass', (500 + Math.random() * 900) * k, 10, 0.35);
  }
}

export const rifleSound = new RifleSound();
