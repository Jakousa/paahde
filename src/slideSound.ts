// Sliding on sand, for the local player: the hiss of grains under the body (bandpassed pink noise, brighter and
// louder the faster you go) over a soft low rumble, with a scuff as a speed slide starts. Synthesised, no samples.
// A speed slide plays it fully; slipping down a slip face on your feet, softer.
//
// Levels (measured offline: the same graph rendered in Node, ffmpeg ebur128): about −27 LUFS at full slider volume
// sliding at 15 m/s, −35 at 5 m/s, under the wind; the start scuff pokes ~5 dB above for a moment. Peaks ≤ −18 dBFS.
// Plays through the shared output in src/audio.ts (volume slider, limiter); every level change is ramped.
import { audio } from './audio';
import { echoBus } from './acoustics';

const NOISE_S = 3;
/** Level at full slider volume, full amount and speed. */
const MIX = 0.2;
/** Speeds (m/s) over which the hiss comes up, and how much it brightens with speed (Hz per m/s). */
const QUIET = 2;
const FULL = 15;
const HZ = 600;
const HZ_PER = 110;
/** Gain smoothing (s): in quickly, out a little slower. */
const IN = 0.04;
const OUT = 0.12;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function noise(ctx: AudioContext, brown: boolean): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * NOISE_S);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else {
      // Pink (Paul Kellet's economy filter).
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
  }
  // Crossfade the ends so the loop has no click.
  const fade = Math.floor(ctx.sampleRate * 0.05);
  for (let i = 0; i < fade; i++) {
    const a = i / fade;
    d[i] = d[i] * a + d[len - fade + i] * (1 - a);
  }
  return buf;
}

class SlideSound {
  private nodes: { band: BiquadFilterNode; out: GainNode } | null = null;
  private on = false;
  private kick = 0; // 1 as a speed slide starts, dying away: the scuff
  private clock = 0;

  constructor() {
    audio.onStart((ctx, dest) => {
      const src = (brown: boolean) => {
        const s = ctx.createBufferSource();
        s.buffer = noise(ctx, brown);
        s.loop = true;
        s.start(ctx.currentTime + Math.random() * 0.1);
        return s;
      };
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = HZ;
      band.Q.value = 0.8;
      const low = ctx.createBiquadFilter();
      low.type = 'lowpass';
      low.frequency.value = 220;
      low.Q.value = 0;
      const hiss = ctx.createGain(), rumble = ctx.createGain(), out = ctx.createGain();
      hiss.gain.value = 1;
      rumble.gain.value = 0.5;
      out.gain.value = 0;
      src(false).connect(band).connect(hiss).connect(out);
      src(true).connect(low).connect(rumble).connect(out);
      out.connect(dest);
      // Hissing back off the walls round you (src/acoustics.ts `echoBus`).
      const bus = echoBus();
      if (bus) out.connect(bus);
      this.nodes = { band, out };
    });
  }

  /** Per render frame. `amount`: 1 in a speed slide, ~0.5 slipping down a slip face, 0 otherwise. */
  update(dt: number, amount: number, speed: number) {
    const ctx = audio.ctx, n = this.nodes;
    if (!ctx || !n) return;
    const sliding = amount > 0;
    if (sliding && !this.on && amount >= 1) this.kick = 1;
    this.on = sliding;
    this.kick *= Math.exp(-dt * 7);
    this.clock += dt;
    const fast = clamp01((speed - QUIET) / (FULL - QUIET));
    // Grains: the level breathes a little with the sand under you.
    const grain = 0.85 + 0.15 * Math.sin(this.clock * 13.1) * Math.sin(this.clock * 3.7 + 1);
    const level = sliding ? MIX * amount * (0.25 + 0.75 * fast) * grain * (1 + 0.9 * this.kick) : 0;
    const now = ctx.currentTime;
    n.out.gain.setTargetAtTime(level, now, level > n.out.gain.value ? IN : OUT);
    n.band.frequency.setTargetAtTime(HZ + HZ_PER * Math.max(0, speed) + 900 * this.kick, now, 0.05);
  }
}

export const slideSound = new SlideSound();
