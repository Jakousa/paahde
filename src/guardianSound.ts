// Sounds of the guardians and drones (shared/guardians.ts), synthesised:
// - footfall: each landing foot is a deep thump (a sine sweeping 55 → 24 Hz), a low rumble of noise and a
//   short metal clank, placed at the foot in 3D and heard late by the distance at the speed of sound, duller
//   further off. Hundreds of metres away you hear them before you see them land; it sells the size.
// - horn: a guardian starting to hunt you sounds a low brass blare (detuned saws through a low-pass).
// - drones: the nearest few buzz where they hover (rotor saw + whine); one locked on to you wails a two-tone
//   siren straight into your ears.
// The Web Audio listener follows the camera (src/crashSound.ts sets it). Through the shared output in
// src/audio.ts; levels ramped. Measured at the default volume (OfflineAudioContext + ffmpeg ebur128): a step
// every 1.2 s ≈ −22 LUFS within 12 m and −27 at 20 m (peaks −4 dBFS close up); one drone at 15 m −31; the
// siren −25; the horn at 60 m −25.
import { audio } from './audio';

const SPEED_OF_SOUND = 343;
/** Footfalls are heard within this distance (m); full level at REF. */
const STEP_HEAR = 500;
const STEP_REF = 12;
const STEP_GAIN = 1.4;
/** Drone buzz within this distance (m), at most this many at once. */
const BUZZ_HEAR = 110;
const BUZZ_REF = 15;
const BUZZ_GAIN = 0.16;
const MAX_BUZZ = 3;
const SIREN_GAIN = 0.12;
const HORN_GAIN = 0.22;

type Buzz = { id: number; osc: OscillatorNode; whine: OscillatorNode; gain: GainNode; panner: PannerNode };

let noiseBuf: AudioBuffer | null = null;
function noise(ctx: AudioContext) {
  if (noiseBuf) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

function panner(ctx: AudioContext, x: number, y: number, z: number, ref: number) {
  const p = ctx.createPanner();
  p.panningModel = 'equalpower';
  p.distanceModel = 'inverse';
  p.refDistance = ref;
  p.rolloffFactor = 1;
  p.positionX.value = x;
  p.positionY.value = y;
  p.positionZ.value = z;
  return p;
}

class GuardianSound {
  private buzz = new Map<number, Buzz>();
  private siren: { osc: OscillatorNode; gain: GainNode; lfo: OscillatorNode } | null = null;

  /** A foot landed at (x, y, z), `weight` 0..1; the listener is at `ear`. */
  footfall(x: number, y: number, z: number, weight: number, ear: { x: number; y: number; z: number }) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const d = Math.hypot(x - ear.x, y - ear.y, z - ear.z);
    if (d > STEP_HEAR) return;
    const t = ctx.currentTime + d / SPEED_OF_SOUND;
    const fade = 1 - Math.max(0, (d - STEP_HEAR * 0.6) / (STEP_HEAR * 0.4));
    const p = panner(ctx, x, y, z, STEP_REF);
    // Air takes the highs off with distance.
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = 6000 / (1 + d / 60);
    const level = ctx.createGain();
    level.gain.value = STEP_GAIN * weight * fade;
    air.connect(level).connect(p).connect(out);

    // Thump.
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(55, t);
    o.frequency.exponentialRampToValueAtTime(24, t + 0.5);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(1, t + 0.01);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    o.connect(og).connect(air);
    o.start(t);
    o.stop(t + 1);
    // Rumble and sand.
    const n = ctx.createBufferSource();
    n.buffer = noise(ctx);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(0.9, t + 0.02);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    n.connect(lp).connect(ng).connect(air);
    n.start(t, Math.random());
    n.stop(t + 1.5);
    // Clank of the joints taking the weight.
    const c = ctx.createBufferSource();
    c.buffer = noise(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700 + Math.random() * 400;
    bp.Q.value = 9;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0, t + 0.04);
    cg.gain.linearRampToValueAtTime(0.5, t + 0.05);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    c.connect(bp).connect(cg).connect(air);
    c.start(t + 0.04, Math.random());
    c.stop(t + 0.5);
  }

  /** A guardian at (x, y, z) has started hunting you. */
  horn(x: number, y: number, z: number) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const t = ctx.currentTime;
    const p = panner(ctx, x, y, z, 60);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(180, t);
    lp.frequency.linearRampToValueAtTime(900, t + 0.6);
    lp.frequency.linearRampToValueAtTime(300, t + 3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(HORN_GAIN, t + 0.4);
    g.gain.setTargetAtTime(0, t + 2.2, 0.4);
    lp.connect(g).connect(p).connect(out);
    for (const f of [41, 41.6, 61.7, 82.4]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(lp);
      o.start(t);
      o.stop(t + 4.5);
    }
  }

  /** Every frame: the drones near the listener (lock 2: on you). */
  drones(list: { id: number; x: number; y: number; z: number; lock: number }[], ear: { x: number; z: number }) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const now = ctx.currentTime;
    const near = list.map((d) => ({ d, r: Math.hypot(d.x - ear.x, d.z - ear.z) })).filter((o) => o.r < BUZZ_HEAR)
      .sort((a, b) => a.r - b.r).slice(0, MAX_BUZZ);
    const keep = new Set(near.map((o) => o.d.id));
    for (const [id, b] of this.buzz) {
      if (keep.has(id)) continue;
      b.gain.gain.setTargetAtTime(0, now, 0.3);
      b.osc.stop(now + 1.5);
      b.whine.stop(now + 1.5);
      this.buzz.delete(id);
    }
    for (const { d, r } of near) {
      let b = this.buzz.get(d.id);
      if (!b) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = 118 + (d.id % 5) * 4;
        const whine = ctx.createOscillator();
        whine.frequency.value = 1420 + (d.id % 7) * 30;
        const wg = ctx.createGain();
        wg.gain.value = 0.08;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 900;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        const p = panner(ctx, d.x, d.y, d.z, BUZZ_REF);
        osc.connect(lp).connect(gain);
        whine.connect(wg).connect(gain);
        gain.connect(p).connect(out);
        osc.start();
        whine.start();
        this.buzz.set(d.id, (b = { id: d.id, osc, whine, gain, panner: p }));
      }
      const fade = 1 - Math.max(0, (r - BUZZ_HEAR * 0.7) / (BUZZ_HEAR * 0.3));
      b.gain.gain.setTargetAtTime(BUZZ_GAIN * fade, now, 0.2);
      b.panner.positionX.setTargetAtTime(d.x, now, 0.05);
      b.panner.positionY.setTargetAtTime(d.y, now, 0.05);
      b.panner.positionZ.setTargetAtTime(d.z, now, 0.05);
    }
    // The siren: on while one has you.
    const onMe = list.some((d) => d.lock === 2);
    if (onMe && !this.siren) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 760;
      // Two tones, 0.35 s each: a square LFO pushing the pitch up and down.
      const lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = 1.4;
      const depth = ctx.createGain();
      depth.gain.value = 140;
      lfo.connect(depth).connect(osc.frequency);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2200;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.gain.setTargetAtTime(SIREN_GAIN, now, 0.05);
      osc.connect(lp).connect(gain).connect(out);
      osc.start();
      lfo.start();
      this.siren = { osc, gain, lfo };
    } else if (!onMe && this.siren) {
      this.siren.gain.gain.setTargetAtTime(0, now, 0.15);
      this.siren.osc.stop(now + 1);
      this.siren.lfo.stop(now + 1);
      this.siren = null;
    }
  }
}

export const guardianSound = new GuardianSound();
