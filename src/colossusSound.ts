// Sounds of the colossus (shared/colossus.ts), synthesised, through src/acoustics.ts (late by the distance, duller and
// more reverb further off) and the shared output (src/audio.ts: master gain and limiter):
// - footfall: a foot landing is a guardian's footfall made huge: a sub boom sweeping 40 → 14 Hz, a long low rumble
//   of sand, the iron joints clanking as they take the weight; heard out to FOOT_HEAR (well before it's seen over
//   the dunes). The big stomp's is heavier still, with a crack and a walker's hull-slam on top.
// - lift: the hydraulics hiss as a foot comes up (a sigh of steam), louder for the big stomp.
// - tell: the big stomp held overhead: a rising steam shriek and a servo groan for as long as it hangs there.
// - salvo (against a crowd): a klaxon from the shoulder pods as they open, a roar per launch, and a falling whistle
//   over each missile's landing spot before it hits (the burst is a bolt's boom, src/guardianSound.ts).
// - charge: an arm coming up to point for a hand volley: a servo groan and a whine rising as the palm heats (its
//   rockets then launch, whistle and burst like the salvo's).
// - engine: while it's near, a slow, deep furnace drone with a throb, following it; louder when it hunts.
// - dying: a falling groan as the furnace fails; collapse: the body hitting the sand, several slams and a long rumble.
// Levels are set against the guardians' (src/guardianSound.ts, measured there): a step here at 25 m about as loud as a
// guardian's at 12 m and a little more (one-shots may poke above the mix); the engine bed well under the mix.
import { audio } from './audio';
import { placed, type P } from './acoustics';
import { rifleSound } from './rifleSound';

/** Footfalls heard within this distance (m), full level within FOOT_REF. */
const FOOT_HEAR = 1500;
const FOOT_REF = 25;
const FOOT_GAIN = 1.5;
const LIFT_GAIN = 0.12;
const TELL_GAIN = 0.35;
/** The engine drone: heard within ENGINE_HEAR, full within ENGINE_REF (1/d past it). */
const ENGINE_HEAR = 900;
const ENGINE_REF = 40;
const ENGINE_GAIN = 0.1;
/** The salvo (a crowd only): the pods' klaxon, each launch, each missile's whistle coming down. Set by ear against
 *  the tell and the footfalls (no file measured: synthesised one-shots under the footfall's level). */
const KLAXON_GAIN = 0.22;
const LAUNCH_GAIN = 0.5;
const INCOMING_GAIN = 0.18;
/** The hand volley's tell: the arm's servos and the palm's rising whine (by ear, under the klaxon). */
const CHARGE_GAIN = 0.2;

let noiseBuf: AudioBuffer | null = null;
function noise(ctx: AudioContext) {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

/** Filtered noise from t, `len` s, rising in `a` to `peak` and decaying. */
function hiss(ctx: AudioContext, to: AudioNode, t: number, len: number, type: BiquadFilterType, f: number, q: number, peak: number, a = 0.01) {
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  n.loop = true;
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

/** An oscillator from t: f0 → f1 over `len`, decaying from `peak`. */
function tone(ctx: AudioContext, to: AudioNode, t: number, len: number, type: OscillatorType, f0: number, f1: number, peak: number, a = 0.01) {
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

type Engine = { srcs: AudioScheduledSourceNode[]; gain: GainNode; lp: BiquadFilterNode; panner: PannerNode };

class ColossusSound {
  private eng: Engine | null = null;

  /** A foot landed at (x, y, z), `weight` 0..1 (more for the big stomp). */
  footfall(x: number, y: number, z: number, weight: number, ear: P, big: boolean) {
    const ctx = audio.ctx, s = placed({ x, y, z }, ear, FOOT_GAIN * Math.min(1.5, weight), FOOT_REF, FOOT_HEAR);
    if (!ctx || !s) return;
    const { input: o, t } = s;
    tone(ctx, o, t, big ? 2.2 : 1.5, 'sine', big ? 46 : 40, 14, 1);
    tone(ctx, o, t, 0.5, 'triangle', 70, 30, 0.35);
    hiss(ctx, o, t, big ? 3.2 : 2.2, 'lowpass', 170, 0.7, 0.9, 0.03);
    hiss(ctx, o, t + 0.02, 0.9, 'bandpass', 420, 1.2, 0.25);
    // Iron joints taking the weight: a couple of deep clanks just after.
    for (let i = 0; i < 2; i++) hiss(ctx, o, t + 0.08 + i * 0.13 + Math.random() * 0.05, 0.5, 'bandpass', 260 + Math.random() * 260, 14, 0.55);
    if (big) {
      hiss(ctx, o, t, 0.25, 'highpass', 1800, 0.7, 0.4, 0.002); // the crack of it
      rifleSound.slam({ x, y, z }, ear, true);
    }
  }

  /** A foot lifts: hydraulics venting. */
  lift(x: number, y: number, z: number, ear: P, big: boolean) {
    const ctx = audio.ctx, s = placed({ x, y: y + 20, z }, ear, LIFT_GAIN * (big ? 2 : 1), 20, 500);
    if (!ctx || !s) return;
    const bp = hiss(ctx, s.input, s.t, big ? 1.4 : 0.9, 'bandpass', 2600, 1.4, 1, 0.12);
    bp.frequency.setValueAtTime(3400, s.t);
    bp.frequency.exponentialRampToValueAtTime(1500, s.t + 0.9);
  }

  /** The big stomp hangs over its prey for `len` s: a steam shriek rising, a servo groan. */
  tell(x: number, y: number, z: number, ear: P, len: number) {
    const ctx = audio.ctx, s = placed({ x, y, z }, ear, TELL_GAIN, 30, 900);
    if (!ctx || !s) return;
    const { input: o, t } = s;
    const n = ctx.createBufferSource();
    n.buffer = noise(ctx);
    n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 6;
    bp.frequency.setValueAtTime(1200, t);
    bp.frequency.exponentialRampToValueAtTime(4200, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + len * 0.8);
    g.gain.linearRampToValueAtTime(0, t + len + 0.1);
    n.connect(bp).connect(g).connect(o);
    n.start(t, Math.random());
    n.stop(t + len + 0.2);
    const groan = ctx.createOscillator();
    groan.type = 'sawtooth';
    groan.frequency.setValueAtTime(48, t);
    groan.frequency.linearRampToValueAtTime(62, t + len);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 240;
    const gg = ctx.createGain();
    gg.gain.setValueAtTime(0, t);
    gg.gain.linearRampToValueAtTime(0.5, t + 0.3);
    gg.gain.setTargetAtTime(0, t + len, 0.08);
    groan.connect(lp).connect(gg).connect(o);
    groan.start(t);
    groan.stop(t + len + 0.6);
  }

  /** An arm comes up to point for a hand volley (`len` s till the first rocket): a servo groan and a whine rising
   *  as the palm heats. */
  charge(x: number, y: number, z: number, ear: P, len: number) {
    const ctx = audio.ctx, s = placed({ x, y, z }, ear, CHARGE_GAIN, 30, 1000);
    if (!ctx || !s) return;
    const { input: o, t } = s;
    const whine = ctx.createOscillator();
    whine.type = 'triangle';
    whine.frequency.setValueAtTime(260, t);
    whine.frequency.exponentialRampToValueAtTime(1500, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35, t + len * 0.9);
    g.gain.setTargetAtTime(0, t + len, 0.05);
    whine.connect(g).connect(o);
    whine.start(t);
    whine.stop(t + len + 0.4);
    const bp = hiss(ctx, o, t, 0.9, 'bandpass', 1800, 1.4, 0.6, 0.1);
    bp.frequency.setValueAtTime(2600, t);
    bp.frequency.exponentialRampToValueAtTime(1200, t + 0.8);
    tone(ctx, o, t, 0.8, 'sawtooth', 55, 70, 0.4);
  }

  /** The shoulder pods open for a salvo (`len` s till the first launch): a two-tone klaxon blaring from up there. */
  klaxon(x: number, y: number, z: number, ear: P, len: number) {
    const ctx = audio.ctx, s = placed({ x, y, z }, ear, KLAXON_GAIN, 40, 1200);
    if (!ctx || !s) return;
    const { input: o, t } = s;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    bp.connect(g).connect(o);
    const osc = ctx.createOscillator();
    osc.type = 'square';
    const beats = Math.max(2, Math.round(len / 0.4));
    for (let i = 0; i < beats; i++) {
      const tb = t + i * 0.4;
      osc.frequency.setValueAtTime(i % 2 ? 420 : 560, tb);
      g.gain.setValueAtTime(0, tb);
      g.gain.linearRampToValueAtTime(0.6, tb + 0.03);
      g.gain.setTargetAtTime(0, tb + 0.3, 0.03);
    }
    osc.connect(bp);
    osc.start(t);
    osc.stop(t + beats * 0.4 + 0.3);
  }

  /** A missile leaves its pod: a cough of the motor lighting, then a tearing roar fading as it climbs. */
  launch(x: number, y: number, z: number, ear: P) {
    const ctx = audio.ctx, s = placed({ x, y, z }, ear, LAUNCH_GAIN, 30, 1500);
    if (!ctx || !s) return;
    const { input: o, t } = s;
    tone(ctx, o, t, 0.35, 'sine', 110, 40, 0.8);
    const bp = hiss(ctx, o, t, 1.6, 'bandpass', 900, 0.8, 0.9, 0.03);
    bp.frequency.setValueAtTime(600, t);
    bp.frequency.exponentialRampToValueAtTime(2200, t + 1.4);
    hiss(ctx, o, t, 0.12, 'highpass', 2500, 0.7, 0.5, 0.002);
  }

  /** A missile coming down on (x, y, z) in `len` s: a whistle falling in pitch. */
  incoming(x: number, y: number, z: number, ear: P, len: number) {
    const ctx = audio.ctx, s = placed({ x, y: y + 15, z }, ear, INCOMING_GAIN, 20, 400);
    if (!ctx || !s || len <= 0.05) return;
    const { input: o, t } = s;
    const n = ctx.createBufferSource();
    n.buffer = noise(ctx);
    n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 18;
    bp.frequency.setValueAtTime(2600, t);
    bp.frequency.exponentialRampToValueAtTime(900, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + len * 0.9);
    g.gain.linearRampToValueAtTime(0, t + len + 0.02);
    n.connect(bp).connect(g).connect(o);
    n.start(t, Math.random());
    n.stop(t + len + 0.1);
  }

  /** Its furnace drone at (x, y, z) every frame while drawn (`speed` 0..1, `angry` hunting); `off` fades it out. */
  engine(x: number, y: number, z: number, ear: P | null, speed: number, angry: boolean, off = false) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const d = ear ? Math.hypot(x - ear.x, y - ear.y, z - ear.z) : Infinity;
    if (off || d > ENGINE_HEAR) {
      if (this.eng) {
        const e = this.eng;
        this.eng = null;
        e.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
        for (const s of e.srcs) s.stop(ctx.currentTime + 2);
      }
      return;
    }
    if (!this.eng) {
      const panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = ENGINE_REF;
      panner.rolloffFactor = 1;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 160;
      lp.connect(gain).connect(panner).connect(out);
      const srcs: AudioScheduledSourceNode[] = [];
      for (const f of [27.5, 27.9, 41.2]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.connect(lp);
        o.start();
        srcs.push(o);
      }
      // The furnace's roar: low noise, throbbing.
      const n = ctx.createBufferSource();
      n.buffer = noise(ctx);
      n.loop = true;
      const ng = ctx.createGain();
      ng.gain.value = 0.8;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.7;
      const lg = ctx.createGain();
      lg.gain.value = 0.5;
      lfo.connect(lg).connect(ng.gain);
      n.connect(ng).connect(lp);
      n.start();
      lfo.start();
      srcs.push(n, lfo);
      this.eng = { srcs, gain, lp, panner };
    }
    const e = this.eng, t = ctx.currentTime;
    e.panner.positionX.setTargetAtTime(x, t, 0.1);
    e.panner.positionY.setTargetAtTime(y, t, 0.1);
    e.panner.positionZ.setTargetAtTime(z, t, 0.1);
    const edge = Math.min(1, (ENGINE_HEAR - d) / (ENGINE_HEAR * 0.3));
    e.gain.gain.setTargetAtTime(ENGINE_GAIN * edge * (0.7 + 0.3 * Math.min(1, speed)) * (angry ? 1.4 : 1), t, 0.3);
    e.lp.frequency.setTargetAtTime(angry ? 240 : 160, t, 0.5);
  }

  /** Its last weak point broke: the furnace dies with a long falling groan. */
  dying(x: number, y: number, z: number, ear: P) {
    const ctx = audio.ctx, s = placed({ x, y, z }, ear, 0.6, 40, 1500);
    if (!ctx || !s) return;
    const { input: o, t } = s;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(600, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 4);
    lp.connect(o);
    for (const f of [55, 56.5, 82]) tone(ctx, lp, t, 4.5, 'sawtooth', f, f * 0.45, 0.35, 0.2);
    hiss(ctx, o, t, 3, 'bandpass', 2400, 2, 0.25, 0.05);
  }

  /** It hits the sand along its length. */
  collapse(x: number, y: number, z: number, ear: P) {
    const ctx = audio.ctx, s = placed({ x, y, z }, ear, FOOT_GAIN * 1.4, 40, 2000);
    if (!ctx || !s) return;
    const { input: o, t } = s;
    tone(ctx, o, t, 3, 'sine', 38, 12, 1);
    hiss(ctx, o, t, 5, 'lowpass', 200, 0.7, 1, 0.08);
    for (let i = 0; i < 3; i++) rifleSound.slam({ x: x + (Math.random() - 0.5) * 40, y, z: z + (Math.random() - 0.5) * 40 }, ear, true);
    for (let i = 0; i < 10; i++) hiss(ctx, o, t + 0.1 + Math.random() * 1.6, 0.4, 'bandpass', 250 + Math.random() * 500, 12, 0.4);
  }
}

export const colossusSound = new ColossusSound();
