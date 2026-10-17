// How weapon sounds carry across the desert: one place every gunshot, blast and impact goes through on its way
// to the speakers, so near ones are sharp and dry and far ones dull, soft and mostly reverb.
//
// For a sound at `at`, heard from `ear` (null `at`: your own, dry and centred), `placed` returns the node to
// connect sources to and the time to start them. On the way out:
// - late by the distance at the speed of sound;
// - the attack softened (a short fade-in, longer further off): the front edge doesn't carry;
// - air absorption: two low-passes in a row (24 dB/oct) whose cutoff falls with distance, ~10 kHz at 100 m,
//   ~3 kHz at 300 m, a few hundred Hz at the edge of hearing;
// - the low end that carries: a low shelf lifting up to +6 dB from 100 m to 500 m, so a far shot is a thump;
// - level: 1/d from `ref`, then faster past FAR (1/d^1.5), and faded to nothing at the edge of hearing;
// - direct sound panned with HRTF (front/back and height, not just left/right);
// - a send into one shared reverb (a short dark desert tail with a few dune slaps), falling off slower than the
//   direct sound, so the further off, the more of what you hear is the tail.
// The Web Audio listener follows the camera (src/crashSound.ts sets it). Out through `audio.out`.
import { audio } from './audio';

export type P = { x: number; y: number; z: number };

export const SPEED_OF_SOUND = 343;
/** HRTF panning comes out ~3 dB under equal-power panning (measured); made up on the direct sound. */
const HRTF_MAKEUP = 1.4;
/** Past this distance (m) the level falls faster than 1/d. */
const FAR = 100;
/** Reverb send at full, and from how near (m) it is all in. */
const WET = 0.3;
const WET_FROM = 40;
/** Your own sounds: a touch of the tail, no more. */
const OWN_WET = 0.06;
/** Longest attack softening (s), and metres per second of it. */
const ATTACK_MAX = 0.025;
const ATTACK_PER_M = 1 / 12000;
/** Air: cutoff at 0 m (Hz), e-folding distance (m), floor (Hz). */
const AIR_F = 20000;
const AIR_D = 150;
const AIR_MIN = 300;
/** Low shelf: corner (Hz), most lift (dB), from and full at (m). */
const SHELF_F = 250;
const SHELF_DB = 6;
const SHELF_FROM = 100;
const SHELF_FULL = 500;
/** Reverb tail length (s) and decay time constant (s). */
const TAIL_S = 2;
const TAIL_TAU = 0.35;

let reverb: { ctx: AudioContext; node: ConvolverNode } | null = null;

/** The shared reverb, made once per context: a dark, quickly decaying tail with a few early slaps off the dunes. */
function reverbIn(ctx: AudioContext, out: AudioNode): AudioNode {
  if (reverb?.ctx === ctx) return reverb.node;
  const sr = ctx.sampleRate, n = Math.floor(TAIL_S * sr);
  const ir = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    // Late tail: noise through a one-pole low-pass that closes as it decays (the highs die first).
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const k = 0.55 + 0.4 * Math.min(1, t / 1.2);
      lp = lp * k + (Math.random() * 2 - 1) * (1 - k);
      d[i] = lp * Math.exp(-t / TAIL_TAU) * Math.min(1, t / 0.03);
    }
    // Early slaps off dune faces, different in each ear.
    for (let r = 0; r < 6; r++) {
      const at = Math.floor((0.04 + Math.random() * 0.26) * sr), amp = (0.15 + Math.random() * 0.25) * Math.exp(-at / sr / 0.2);
      let e = 0;
      for (let i = 0; i < 0.012 * sr && at + i < n; i++) {
        e = e * 0.7 + (Math.random() * 2 - 1) * 0.3;
        d[at + i] += e * amp * Math.exp(-i / (0.004 * sr));
      }
    }
  }
  const node = ctx.createConvolver();
  node.buffer = ir; // normalised by the node, so the send gain sets the level
  node.connect(out);
  reverb = { ctx, node };
  return node;
}

/** Level of the direct sound at `d` m for a sound at full level within `ref` m. */
function falloff(d: number, ref: number) {
  const inv = ref / Math.max(ref, d);
  return d > FAR ? inv * Math.sqrt(FAR / d) : inv;
}

/**
 * Where a weapon sound is heard: the node to connect its sources to, at level `gain` (full within `ref` m), and
 * the context time to start them (late by the distance). Null when out of earshot (`hear` m) or audio is off.
 * `at` null is your own: dry, centred, now.
 */
export function placed(at: P | null, ear: P | null, gain: number, ref: number, hear = 600): { input: AudioNode; t: number } | null {
  const ctx = audio.ctx, out = audio.out;
  if (!ctx || !out || !audio.running) return null;
  const now = ctx.currentTime;
  const input = ctx.createGain();
  if (!at || !ear) {
    input.gain.value = gain;
    input.connect(out);
    const wet = ctx.createGain();
    wet.gain.value = OWN_WET;
    input.connect(wet).connect(reverbIn(ctx, out));
    return { input, t: now };
  }
  const d = Math.hypot(at.x - ear.x, at.y - ear.y, at.z - ear.z);
  if (d >= hear) return null;
  const t = now + d / SPEED_OF_SOUND;
  // Softened attack.
  const attack = Math.min(ATTACK_MAX, d * ATTACK_PER_M);
  input.gain.setValueAtTime(attack > 0.001 ? 0 : 1, now);
  if (attack > 0.001) {
    input.gain.setValueAtTime(0, t);
    input.gain.linearRampToValueAtTime(1, t + attack);
  }
  // Air, and the lows that carry.
  const f = Math.max(AIR_MIN, AIR_F * Math.exp(-d / AIR_D));
  let node: AudioNode = input;
  for (let i = 0; i < 2; i++) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = f;
    lp.Q.value = 0.707;
    node = node.connect(lp);
  }
  const shelf = ctx.createBiquadFilter();
  shelf.type = 'lowshelf';
  shelf.frequency.value = SHELF_F;
  shelf.gain.value = SHELF_DB * Math.min(1, Math.max(0, (d - SHELF_FROM) / (SHELF_FULL - SHELF_FROM)));
  node = node.connect(shelf);
  // Level, faded out over the last 30% of earshot so nothing pops in or out.
  const edge = Math.min(1, Math.max(0, (hear - d) / (hear * 0.3)));
  const dry = falloff(d, ref);
  const direct = ctx.createGain();
  direct.gain.value = gain * dry * edge * HRTF_MAKEUP;
  const p = ctx.createPanner();
  p.panningModel = 'HRTF';
  p.distanceModel = 'linear';
  p.rolloffFactor = 0; // the level is ours (above)
  p.positionX.value = at.x;
  p.positionY.value = at.y;
  p.positionZ.value = at.z;
  node.connect(direct).connect(p).connect(out);
  const wet = ctx.createGain();
  wet.gain.value = gain * WET * Math.sqrt(dry) * Math.min(1, d / WET_FROM) * edge;
  node.connect(wet).connect(reverbIn(ctx, out));
  return { input, t };
}
