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
//   direct sound, so the further off, the more of what you hear is the tail;
// - between walls (a canyon, src/echo.ts `enclosure`), a send into a second, longer and brighter reverb, in place of
//   some of the desert one;
// - echoes off the walls round you (src/echo.ts `echoTaps`): each a late copy from the wall's direction, duller the
//   further it went.
// The Web Audio listener follows the camera (src/crashSound.ts sets it). Out through `audio.out`.
import { audio } from './audio';
import { echoTaps, enclosure } from './echo';
import { AudioBudget } from './audioBudget.ts';
import { obstruction } from './obstruction.ts';

export const audioMetrics = { voices: new AudioBudget(80), echoes: new AudioBudget(64) };

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
/** Canyon reverb: send at full enclosure (and your own sounds'), how much of the desert send it takes the place of,
 *  tail length (s) and decay time constant (s). */
const CANYON_WET = 0.35;
const OWN_CANYON_WET = 0.12;
const CANYON_DUCKS = 0.6;
const CANYON_TAIL_S = 4.5;
const CANYON_TAU = 1.1;
/** Echoes: air on their way, as `AIR_D` but gentler (bare rock walls give back a lot of the top). */
const ECHO_AIR_D = 450;
const ECHO_AIR_MIN = 500;
/** Echoes carry further than the direct sound's earshot, × it: a loud sound rings off walls a long way off. */
const ECHO_HEAR = 3;

let reverb: { ctx: AudioContext; node: ConvolverNode } | null = null;
let canyon: { ctx: AudioContext; node: ConvolverNode } | null = null;

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
  // Shared wet tails always use the effects bus, even when the first source is a protected warning.
  node.connect(audio.out ?? out);
  reverb = { ctx, node };
  return node;
}

/** The canyon reverb, made once per context: a long tail off rock, its highs dying slower than the desert's. */
function canyonIn(ctx: AudioContext, out: AudioNode): AudioNode {
  if (canyon?.ctx === ctx) return canyon.node;
  const sr = ctx.sampleRate, n = Math.floor(CANYON_TAIL_S * sr);
  const ir = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const k = 0.3 + 0.55 * Math.min(1, t / 3);
      lp = lp * k + (Math.random() * 2 - 1) * (1 - k);
      // (Builds up over the first tenth of a second: the walls are tens of metres off, not the dune at your feet.)
      d[i] = lp * Math.exp(-t / CANYON_TAU) * Math.min(1, t / 0.1);
    }
  }
  const node = ctx.createConvolver();
  node.buffer = ir;
  node.connect(audio.out ?? out);
  canyon = { ctx, node };
  return node;
}

/** The echoes of a sound (src/echo.ts) off `input`, × `scale` of what comes out of it, out to `out`. `level`: the
 *  level it's heard at (to drop the inaudible ones). */
function echoes(ctx: AudioContext, input: AudioNode, out: AudioNode, at: P | null, scale: number, level: number, hear: number, duration = 8) {
  const taps = echoTaps(at, level, hear, SPEED_OF_SOUND);
  if (taps.length === 0) return;
  // One filter for them all, at the loudest tap's path.
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = Math.max(ECHO_AIR_MIN, AIR_F * Math.exp(-taps[0].path / ECHO_AIR_D));
  lp.Q.value = 0.707;
  input.connect(lp);
  for (const t of taps.slice(0, 4)) {
    let voice: GainNode | undefined;
    if (!audioMetrics.echoes.reserve(ctx.currentTime, t.delay + duration, 0, level * t.gain, () => {
      voice?.gain.setTargetAtTime(0, ctx.currentTime, 0.015);
      setTimeout(() => voice?.disconnect(), 150);
    })) continue;
    const delay = ctx.createDelay(t.delay + 0.01);
    delay.delayTime.value = t.delay;
    const g = ctx.createGain();
    voice = g;
    g.gain.value = t.gain * scale;
    const p = ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'linear';
    p.rolloffFactor = 0;
    p.positionX.value = t.x;
    p.positionY.value = t.y;
    p.positionZ.value = t.z;
    lp.connect(delay).connect(g).connect(p).connect(out);
  }
}

/**
 * For a short sound that finds its own way out (footsteps, a bike landing): its echoes off the walls round you and
 * its share of the canyon reverb, fed from `input` (the sound at the level it's heard at, `level`), × `wet`. `at`
 * null: at the ear (your own). Echoes that travel further than `hear` m are left out.
 */
export function reflect(input: AudioNode, at: P | null, level: number, hear: number, wet = 1) {
  const ctx = audio.ctx, out = audio.out;
  if (!ctx || !out || !audio.running || enclosure < 0.01) return;
  const cw = ctx.createGain();
  cw.gain.value = OWN_CANYON_WET * enclosure * wet;
  input.connect(cw).connect(canyonIn(ctx, out));
  echoes(ctx, input, out, at, wet, level * wet, hear);
}

/** The echo bus: for sounds that go on (the bike's engine, the sand slide, the wind), a few delay lines whose times
 *  follow the walls round you (`tickEchoBus`), from their direction, and a send into the canyon reverb. */
const BUS_TAPS = 4;
const BUS_MAX_S = 7;
/** Echoes further than this (m) aren't followed. */
const BUS_HEAR = 2000;
/** How often (s) the lines follow the walls; a line whose wall moves further than JUMP_S (s) of delay fades out,
 *  jumps and fades back in, rather than gliding (a glide is a pitch sweep). */
const BUS_EVERY = 0.25;
const JUMP_S = 0.08;
const BUS_CANYON_WET = 0.25;
type Line = { delay: DelayNode; gain: GainNode; pan: PannerNode; at: number };
let bus: { ctx: AudioContext; input: GainNode; lines: Line[]; wet: GainNode; next: number } | null = null;

/** The echo bus to connect a lasting sound to (at the level it's heard at), or null before audio starts. */
export function echoBus(): AudioNode | null {
  const ctx = audio.ctx, out = audio.out;
  if (!ctx || !out) return null;
  if (bus?.ctx === ctx) return bus.input;
  const input = ctx.createGain();
  // (Air on the way: as for the per-sound echoes, at a typical canyon's path.)
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 3500;
  input.connect(lp);
  const lines: Line[] = [];
  for (let i = 0; i < BUS_TAPS; i++) {
    const delay = ctx.createDelay(BUS_MAX_S);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const pan = ctx.createPanner();
    pan.panningModel = 'equalpower';
    pan.distanceModel = 'linear';
    pan.rolloffFactor = 0;
    lp.connect(delay).connect(gain).connect(pan).connect(out);
    lines.push({ delay, gain, pan, at: 0 });
  }
  const wet = ctx.createGain();
  wet.gain.value = 0;
  input.connect(wet).connect(canyonIn(ctx, out));
  bus = { ctx, input, lines, wet, next: 0 };
  return input;
}

/** Every frame: the bus's lines follow the walls round you. */
export function tickEchoBus() {
  if (!bus || bus.ctx.state !== 'running') return;
  const now = bus.ctx.currentTime;
  if (now < bus.next) return;
  bus.next = now + BUS_EVERY;
  bus.wet.gain.setTargetAtTime(BUS_CANYON_WET * enclosure, now, 0.5);
  const taps = echoTaps(null, 1, BUS_HEAR, SPEED_OF_SOUND);
  // Each line takes the tap nearest its delay, so lines keep to their walls as you move.
  const free = taps.filter((t) => t.delay < BUS_MAX_S);
  for (const l of bus.lines) {
    let bi = -1;
    for (let i = 0; i < free.length; i++) if (bi < 0 || Math.abs(free[i].delay - l.at) < Math.abs(free[bi].delay - l.at)) bi = i;
    const t = bi >= 0 ? free.splice(bi, 1)[0] : null;
    if (!t) { l.gain.gain.setTargetAtTime(0, now, 0.2); continue; }
    if (Math.abs(t.delay - l.at) > JUMP_S) {
      l.gain.gain.setTargetAtTime(0, now, 0.03);
      l.delay.delayTime.setValueAtTime(t.delay, now + 0.15);
      l.gain.gain.setTargetAtTime(t.gain, now + 0.15, 0.1);
    } else {
      l.delay.delayTime.setTargetAtTime(t.delay, now, 0.1);
      l.gain.gain.setTargetAtTime(t.gain, now, 0.2);
    }
    l.at = t.delay;
    l.pan.positionX.setTargetAtTime(t.x, now, 0.2);
    l.pan.positionY.setTargetAtTime(t.y, now, 0.2);
    l.pan.positionZ.setTargetAtTime(t.z, now, 0.2);
  }
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
export function placed(at: P | null, ear: P | null, gain: number, ref: number, hear = 600,
  options: { warning?: boolean; duration?: number } = {}): { input: AudioNode; t: number } | null {
  const ctx = audio.ctx, out = options.warning ? audio.warning : audio.out;
  if (!ctx || !out || !audio.running) return null;
  const now = ctx.currentTime;
  const distance = at && ear ? Math.hypot(at.x - ear.x, at.y - ear.y, at.z - ear.z) : 0;
  if (distance >= hear) return null;
  const input = ctx.createGain();
  const duration = options.duration ?? 8;
  if (!audioMetrics.voices.reserve(now, duration + distance / SPEED_OF_SOUND, options.warning ? 3 : !at ? 2 : 1,
    gain * falloff(distance, ref), () => {
      input.gain.cancelScheduledValues(ctx.currentTime);
      input.gain.setTargetAtTime(0, ctx.currentTime, 0.015);
      setTimeout(() => input.disconnect(), 150);
    })) return null;
  if (options.warning) audio.protectWarning(Math.min(4, duration));
  if (!at || !ear) {
    input.gain.value = gain;
    input.connect(out);
    const wet = ctx.createGain();
    wet.gain.value = OWN_WET;
    input.connect(wet).connect(reverbIn(ctx, out));
    if (enclosure > 0.01) {
      const cw = ctx.createGain();
      cw.gain.value = OWN_CANYON_WET * enclosure;
      input.connect(cw).connect(canyonIn(ctx, out));
    }
    echoes(ctx, input, out, null, 1, gain, hear * ECHO_HEAR, duration);
    return { input, t: now };
  }
  const d = distance;
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
  const blocked = obstruction(at, ear, now);
  direct.gain.value = gain * dry * edge * HRTF_MAKEUP * (1 - blocked * 0.65);
  const muffled = ctx.createBiquadFilter();
  muffled.type = 'lowpass';
  muffled.frequency.value = f;
  muffled.frequency.setTargetAtTime(Math.min(f, 20000 - blocked * 18800), now, 0.04);
  muffled.Q.value = 0.707;
  const p = ctx.createPanner();
  p.panningModel = 'HRTF';
  p.distanceModel = 'linear';
  p.rolloffFactor = 0; // the level is ours (above)
  p.positionX.value = at.x;
  p.positionY.value = at.y;
  p.positionZ.value = at.z;
  node.connect(muffled).connect(direct).connect(p).connect(out);
  const wet = ctx.createGain();
  wet.gain.value = gain * WET * Math.sqrt(dry) * Math.min(1, d / WET_FROM) * edge * (1 - CANYON_DUCKS * enclosure);
  node.connect(wet).connect(reverbIn(ctx, out));
  if (enclosure > 0.01) {
    const cw = ctx.createGain();
    cw.gain.value = gain * CANYON_WET * Math.sqrt(dry) * edge * enclosure;
    node.connect(cw).connect(canyonIn(ctx, out));
  }
  echoes(ctx, input, out, at, gain * dry * edge, gain * dry * edge, hear * ECHO_HEAR, duration + d / SPEED_OF_SOUND);
  return { input, t };
}
