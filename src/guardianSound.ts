// Sounds of the guardians and drones (shared/guardians.ts), synthesised:
// - footfall: each landing foot is a deep thump (a sine sweeping 55 → 24 Hz), a low rumble of noise and a
//   short metal clank, placed at the foot in 3D and heard late by the distance at the speed of sound, duller
//   further off. Hundreds of metres away you hear them before you see them land; it sells the size.
// - horn: a guardian starting to hunt you sounds a low brass blare (detuned saws through a low-pass).
// - drones: the nearest few buzz where they hover (rotor saw + whine); one locking on to you gives a short
//   rising double chirp, once (not a siren: the beam and the HUD say the rest).
// - missiles: a falling whistle at the impact point over the last WHISTLE_S of the flight.
// Footfalls (and so the bolts' and missiles' blasts) and the cannon carry across the desert through src/acoustics.ts.
// The Web Audio listener follows the camera (src/crashSound.ts sets it). Through the shared output in
// src/audio.ts; levels ramped. Measured at the default volume (OfflineAudioContext + ffmpeg ebur128): a step
// every 1.2 s ≈ −22 LUFS within 12 m and −27 at 20 m (peaks −4 dBFS close up); one drone at 15 m −31; the
// chirp −26 (momentary); the horn at 60 m −25.
import { audio } from './audio';
import { placed } from './acoustics';

/** Footfalls are heard within this distance (m); full level at REF. */
const STEP_HEAR = 500;
const STEP_REF = 12;
const STEP_GAIN = 1.4;
/** Drone buzz within this distance (m), at most this many at once. */
const BUZZ_HEAR = 110;
const BUZZ_REF = 15;
const BUZZ_GAIN = 0.16;
const MAX_BUZZ = 3;
const CHIRP_GAIN = 0.07;
/** A missile whistles over the last this many seconds of its fall, heard within WHISTLE_HEAR m of the impact. */
const WHISTLE_S = 2.2;
const WHISTLE_HEAR = 150;
const WHISTLE_GAIN = 0.1;
const HORN_GAIN = 0.22;
const CHARGE_GAIN = 0.05;
/** Crawler feet are heard within this distance (m). */
const TICK_HEAR = 30;
const TICK_GAIN = 0.12;
const CHITTER_GAIN = 0.05;
const ZAP_GAIN = 0.35;

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

  /** A foot landed at (x, y, z), `weight` 0..1; the listener is at `ear`. */
  footfall(x: number, y: number, z: number, weight: number, ear: { x: number; y: number; z: number }) {
    const ctx = audio.ctx, s = placed({ x, y, z }, ear, STEP_GAIN * weight, STEP_REF, STEP_HEAR);
    if (!ctx || !s) return;
    const { input: air, t } = s;

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

  /** A crawler's foot at (x, y, z): a dry little tick of claw on sand and metal, heard within TICK_HEAR. */
  tick(x: number, y: number, z: number, ear: { x: number; y: number; z: number }) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    if (Math.hypot(x - ear.x, y - ear.y, z - ear.z) > TICK_HEAR) return;
    const t = ctx.currentTime;
    const n = ctx.createBufferSource();
    n.buffer = noise(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2500 + Math.random() * 2500;
    bp.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(TICK_GAIN, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    n.connect(bp).connect(g).connect(panner(ctx, x, y, z, 3)).connect(out);
    n.start(t, Math.random());
    n.stop(t + 0.05);
  }

  /** A crawler at (x, y, z) goes for you (`bite`: and gets you): a rattling chitter, a snap of mandibles. */
  chitter(x: number, y: number, z: number, bite: boolean) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const t = ctx.currentTime;
    const p = panner(ctx, x, y, z, 4);
    p.connect(out);
    const n = bite ? 3 : 9;
    for (let i = 0; i < n; i++) {
      const at = t + i * (bite ? 0.05 : 0.035) + Math.random() * 0.01;
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.setValueAtTime(bite ? 900 : 1800 + Math.random() * 900, at);
      o.frequency.exponentialRampToValueAtTime(bite ? 200 : 700, at + 0.03);
      const g = ctx.createGain();
      g.gain.setValueAtTime(CHITTER_GAIN * (bite ? 2 : 1), at);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.03);
      o.connect(g).connect(p);
      o.start(at);
      o.stop(at + 0.04);
    }
  }

  /** A guardian's cannon at (x, y, z) starts charging: a rising whine over `s` seconds. */
  charge(x: number, y: number, z: number, s: number) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const t = ctx.currentTime;
    const p = panner(ctx, x, y, z, 30);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(880, t + s);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(400, t);
    lp.frequency.exponentialRampToValueAtTime(3000, t + s);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(CHARGE_GAIN, t + s);
    g.gain.linearRampToValueAtTime(0, t + s + 0.05);
    o.connect(lp).connect(g).connect(p).connect(out);
    o.start(t);
    o.stop(t + s + 0.1);
  }

  /** A bolt fired from (x, y, z): a heavy descending zap with a thump, heard late with distance. */
  zap(x: number, y: number, z: number, ear: { x: number; y: number; z: number }) {
    const ctx = audio.ctx, s = placed({ x, y, z }, ear, ZAP_GAIN, 25, STEP_HEAR);
    if (!ctx || !s) return;
    const t = s.t;
    const g = ctx.createGain();
    g.gain.setValueAtTime(1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    g.connect(s.input);
    for (const [type, f0, f1] of [['square', 1400, 90], ['sawtooth', 700, 45], ['sine', 120, 30]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + 0.7);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2500;
      const og = ctx.createGain();
      og.gain.value = type === 'sine' ? 1 : 0.35;
      o.connect(lp).connect(og).connect(g);
      o.start(t);
      o.stop(t + 1);
    }
  }

  /** A bolt burst at (x, y, z): a footfall's boom, twice over, with a crackle. */
  boom(x: number, y: number, z: number, ear: { x: number; y: number; z: number }) {
    this.footfall(x, y, z, 1, ear);
    this.footfall(x, y, z, 0.8, ear);
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

  /** A drone just locked on to you: two short rising chirps. */
  chirp() {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const t0 = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const t = t0 + i * 0.16;
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(900 + i * 300, t);
      o.frequency.exponentialRampToValueAtTime(1300 + i * 300, t + 0.1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(CHIRP_GAIN, t + 0.01);
      g.gain.setTargetAtTime(0, t + 0.08, 0.02);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 0.25);
    }
  }

  /** A missile comes down at (x, y, z) in `s` seconds: whistles over the last WHISTLE_S of it. */
  whistle(x: number, y: number, z: number, s: number, ear: { x: number; y: number; z: number }) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running || s <= 0.2) return;
    if (Math.hypot(x - ear.x, z - ear.z) > WHISTLE_HEAR) return;
    const t1 = ctx.currentTime + s, t0 = Math.max(ctx.currentTime, t1 - WHISTLE_S);
    // Heard from above the impact: the missile is still up there.
    const p = panner(ctx, x, y + 30, z, 40);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(2200, t0);
    o.frequency.exponentialRampToValueAtTime(500, t1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(WHISTLE_GAIN, t1 - 0.1);
    g.gain.linearRampToValueAtTime(0, t1);
    o.connect(g).connect(p).connect(out);
    o.start(t0);
    o.stop(t1 + 0.05);
  }

  /** Every frame: the drones near the listener. */
  drones(list: { id: number; x: number; y: number; z: number }[], ear: { x: number; z: number }) {
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
  }
}

export const guardianSound = new GuardianSound();
