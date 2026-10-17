// Sounds of the laser rifle (src/rifle.ts) and of what it does to the walkers:
// - shot: one of three pulses cut from Defunct3's "Pulse laser" (CC0, public/credits.txt; laser-1..3.mp3, mono,
//   0.40–0.55 s, each levelled to −18.5 LUFS momentary, true peak ≤ −1.5 dBTP), picked at random and a little
//   off pitch each time; the pistol plays them higher and lighter. Then the desert answers, synthesised: a dull
//   slap off the dunes a moment later. Your own is dry and in your head; another player's is placed in 3D and
//   heard late by the distance, like the guardians' footfalls.
// The rest is synthesised:
// - recharge: the cell whining back up between shots, with a click when it's ready.
// - impact: where the beam struck: a hiss of sand, a metal ping, or the red glass of a weak point shattering with an
//   electric fizz.
// - a dying walker: servos winding down with a clunk as each leg gives out, then the crash of the hull on the sand.
// Through the shared output (src/audio.ts), every level ramped. Measured at the default volume (OfflineAudioContext +
// ffmpeg ebur128, integrated): your own shot every 0.5 s ≈ −23 LUFS (peaks −2 dBFS), one shot −27; another player's
// at 40 m −34; glass shattering at 20 m −28; a guardian dying at 40 m −27, a crawler at 8 m −33.
import { audio } from './audio';

const SPEED_OF_SOUND = 343;
const SHOT_GAIN = 0.75;
/** The pulse samples, on top of SHOT_GAIN: together about 1. */
const PULSE_GAIN = 1.3;
const PULSES = ['./audio/laser-1.mp3', './audio/laser-2.mp3', './audio/laser-3.mp3'];
const CHARGE_GAIN = 0.035;
const IMPACT_GAIN = 1.2;
const DEATH_GAIN = 1.8;

type P = { x: number; y: number; z: number };

let noiseBuf: AudioBuffer | null = null;
function noise(ctx: AudioContext) {
  if (noiseBuf) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

/** A level, placed at `at` in 3D (refDistance `ref`), duller with distance; or dry and centred when `at` is null. */
function bus(ctx: AudioContext, out: AudioNode, gain: number, at: P | null, ear: P | null, ref: number): AudioNode {
  const g = ctx.createGain();
  g.gain.value = gain;
  if (!at) {
    g.connect(out);
    return g;
  }
  const d = ear ? Math.hypot(at.x - ear.x, at.y - ear.y, at.z - ear.z) : 0;
  const p = ctx.createPanner();
  p.panningModel = 'equalpower';
  p.distanceModel = 'inverse';
  p.refDistance = ref;
  p.positionX.value = at.x;
  p.positionY.value = at.y;
  p.positionZ.value = at.z;
  const air = ctx.createBiquadFilter();
  air.type = 'lowpass';
  air.frequency.value = 9000 / (1 + d / 50);
  g.connect(air).connect(p).connect(out);
  return g;
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

  constructor() {
    audio.onStart((ctx) => {
      for (const src of PULSES) {
        fetch(src)
          .then((r) => r.arrayBuffer())
          .then((d) => ctx.decodeAudioData(d))
          .then((b) => this.pulses.push(b), (e) => console.warn('laser sound failed to load', src, e));
      }
    });
  }

  /** A shot: yours (`at` null) or someone else's at `at`, heard from `ear`. `pistol`: the laser pistol's, higher,
   *  shorter and lighter. */
  shot(at: P | null = null, ear: P | null = null, pistol = false) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const d = at && ear ? Math.hypot(at.x - ear.x, at.y - ear.y, at.z - ear.z) : 0;
    if (d > 600) return;
    const t = ctx.currentTime + d / SPEED_OF_SOUND;
    const o = bus(ctx, out, SHOT_GAIN * (pistol ? 0.75 : 1), at, ear, 15);
    // The pistol: up in pitch (so quicker), less body.
    const len = pistol ? 0.6 : 1;
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
    // The dunes answer: a dull slap and a tail.
    hiss(ctx, o, t + 0.16 + Math.random() * 0.08, 0.7 * len, 'lowpass', 900, 0.5, 0.16 * len, 0.02);
    hiss(ctx, o, t + 0.42 + Math.random() * 0.15, 0.9 * len, 'lowpass', 600, 0.5, 0.07 * len, 0.04);
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
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const d = Math.hypot(at.x - ear.x, at.y - ear.y, at.z - ear.z);
    if (d > 400) return;
    const t = ctx.currentTime + d / SPEED_OF_SOUND;
    const o = bus(ctx, out, IMPACT_GAIN, at, ear, what === 'sand' ? 4 : 10);
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
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const d = Math.hypot(at.x - ear.x, at.y - ear.y, at.z - ear.z);
    if (d > (heavy ? 500 : 60)) return;
    const t = ctx.currentTime + d / SPEED_OF_SOUND;
    const k = heavy ? 1 : 2.6; // small ones higher and quicker
    const o = bus(ctx, out, DEATH_GAIN * (heavy ? 1 : 0.4), at, ear, heavy ? 14 : 3);
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
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const d = Math.hypot(at.x - ear.x, at.y - ear.y, at.z - ear.z);
    if (d > (heavy ? 800 : 80)) return;
    const t = ctx.currentTime + d / SPEED_OF_SOUND;
    const k = heavy ? 1 : 2.4;
    const o = bus(ctx, out, DEATH_GAIN * (heavy ? 1.4 : 0.45), at, ear, heavy ? 16 : 3);
    tone(ctx, o, t, 1.4 / k, 'sine', 50 * k, 20 * k, 1, 0.01);
    hiss(ctx, o, t, 1.8 / k, 'lowpass', 300 * k, 0.6, 0.9, 0.01);
    // Plates and struts clattering down after it.
    for (let i = 0; i < 6; i++) hiss(ctx, o, t + 0.05 + Math.random() * 0.6 / k, 0.25, 'bandpass', (500 + Math.random() * 900) * k, 10, 0.35);
  }
}

export const rifleSound = new RifleSound();
