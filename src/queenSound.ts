// Sounds of the brood queen (shared/queen.ts, src/world/queen.ts), synthesised, all placed in the desert through
// src/acoustics.ts (late by the distance, duller and more reverb further off, out through the master and limiter):
// - stab: each foot punching into the sand: a guardian footfall's thump, lighter, under a hard wet chunk of steel
//   into sand and a short scrape.
// - chitter: it has seen you: a big, slow rattle of clicks, a crawler's chitter an octave and more down.
// - screech: rearing up: a metallic shriek (detuned saws, a fast vibrato, driven, swept up then down) over a hiss.
// - slam: the front legs coming down: two bolt-burst booms and a hull's slam (src/guardianSound.ts, src/rifleSound.ts).
// Levels set against the guardians' (a footfall at 12 m ≈ −22 LUFS): a stab within 15 m sits a little under that, the
// screech pokes above it briefly (one-off, ~1 s).
import { placed, type P } from './acoustics';
import { audio } from './audio';
import { guardianSound } from './guardianSound';
import { rifleSound } from './rifleSound';

const STAB_GAIN = 0.5;
const STAB_REF = 15;
const STAB_HEAR = 600;
const CHITTER_GAIN = 0.3;
const SCREECH_GAIN = 0.35;
const SCREECH_REF = 40;

let noiseBuf: AudioBuffer | null = null;
function noise(ctx: AudioContext) {
  if (noiseBuf) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

/** A noise burst through a filter into `o` at t: rises in `att`, decays over `dur`. */
function burst(ctx: AudioContext, o: AudioNode, t: number, dur: number, type: BiquadFilterType, f: number, q: number, level: number, att = 0.004) {
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const bf = ctx.createBiquadFilter();
  bf.type = type;
  bf.frequency.value = f;
  bf.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + att);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  n.connect(bf).connect(g).connect(o);
  n.start(t, Math.random());
  n.stop(t + dur + 0.05);
  return bf;
}

function tone(ctx: AudioContext, o: AudioNode, t: number, dur: number, type: OscillatorType, f0: number, f1: number, level: number, att = 0.005) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + att);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(g).connect(o);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

class QueenSound {
  /** A foot stabbing into the sand at `at`, `weight` 0..1. */
  stab(at: P, ear: P, weight: number) {
    guardianSound.footfall(at.x, at.y, at.z, 0.45 * weight, ear);
    const ctx = audio.ctx, s = placed(at, ear, STAB_GAIN * weight, STAB_REF, STAB_HEAR);
    if (!ctx || !s) return;
    const { input: o, t } = s;
    tone(ctx, o, t, 0.14, 'triangle', 170 + Math.random() * 40, 55, 0.7);
    burst(ctx, o, t, 0.09, 'bandpass', 1500 + Math.random() * 600, 1.6, 0.8);
    burst(ctx, o, t + 0.02, 0.35, 'lowpass', 700, 0.7, 0.45, 0.02);
    // The spike's steel ringing a moment.
    tone(ctx, o, t, 0.25, 'sine', 1240 + Math.random() * 200, 1200, 0.06);
  }

  /** It has seen someone: a big slow rattle from `at`. */
  chitter(at: P, ear: P) {
    const ctx = audio.ctx, s = placed(at, ear, CHITTER_GAIN, 30, 700);
    if (!ctx || !s) return;
    const { input: o, t } = s;
    for (let i = 0; i < 16; i++) {
      const at2 = t + i * 0.055 + Math.random() * 0.015;
      const lv = 0.5 + 0.5 * Math.sin((i / 15) * Math.PI);
      tone(ctx, o, at2, 0.045, 'square', 520 + Math.random() * 380, 140, 0.35 * lv, 0.002);
      burst(ctx, o, at2, 0.04, 'bandpass', 2200 + Math.random() * 1500, 4, 0.4 * lv, 0.002);
    }
  }

  /** Rearing up at `at`: a metallic shriek for about `s` seconds. */
  screech(at: P, ear: P, s = 1.1) {
    const ctx = audio.ctx, p = placed(at, ear, SCREECH_GAIN, SCREECH_REF, 1500);
    if (!ctx || !p) return;
    const { input: o, t } = p;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.08);
    env.gain.setValueAtTime(1, t + s * 0.75);
    env.gain.exponentialRampToValueAtTime(0.001, t + s + 0.25);
    const drive = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * 2 - 1;
      curve[i] = Math.tanh(x * 3) / Math.tanh(3);
    }
    drive.curve = curve;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.exponentialRampToValueAtTime(2200, t + s * 0.6);
    bp.frequency.exponentialRampToValueAtTime(1100, t + s + 0.2);
    const pre = ctx.createGain();
    pre.gain.value = 0.35;
    pre.connect(drive).connect(bp).connect(env).connect(o);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 11 + Math.random() * 3;
    const depth = ctx.createGain();
    depth.gain.value = 40;
    lfo.connect(depth);
    for (const [f, k] of [[330, 1], [341, 1], [497, 0.6], [702, 0.35]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * 2.6, t + s * 0.6);
      osc.frequency.exponentialRampToValueAtTime(f * 1.7, t + s + 0.25);
      depth.connect(osc.frequency);
      const g = ctx.createGain();
      g.gain.value = k;
      osc.connect(g).connect(pre);
      osc.start(t);
      osc.stop(t + s + 0.3);
    }
    lfo.start(t);
    lfo.stop(t + s + 0.3);
    // Steam hissing out of the joints under it.
    burst(ctx, env, t, s + 0.2, 'highpass', 3500, 0.7, 0.5, 0.1);
  }

  /** The front legs slamming down at `at`. */
  slam(at: P, ear: P) {
    guardianSound.boom(at.x, at.y, at.z, ear);
    rifleSound.slam(at, ear, true);
  }
}

export const queenSound = new QueenSound();
