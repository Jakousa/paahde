// Synthesised electric motor for your own sand bike: a hum whose pitch follows the wheel speed. No samples,
// a few oscillators in a small Web Audio graph:
//   - body:  two slightly detuned sawtooths at the motor frequency, lowpassed, so they beat gently.
//   - hum:   a sine an octave up, the smooth "electric" part of the tone.
//   - whine: a quiet high sine (the inverter), which comes up when you hold the throttle.
// Sitting still on the bike it idles low and quiet; the pitch rises with speed. In the air the wheel
// spins up freely while you hold the throttle and winds down when you let go.
//
// Plays through the shared output in src/audio.ts (volume slider, limiter).
import { audio } from './audio';

/** Motor frequency (Hz) at a standstill, and how much it rises per m/s of wheel speed. */
const F_IDLE = 46;
const F_PER_MS = 13;
/** Free-spinning wheel in the air: spin-up (m/s²) with the throttle held, and its top speed (m/s). */
const AIR_SPIN_UP = 30;
const AIR_TOP = 34;
/** Time constant (s) of the wind-down in the air, and of following the load (throttle). */
const AIR_DECAY = 1.2;
const LOAD_TAU = 0.15;
/** Level at idle, as a fraction of full (top speed, throttle held). */
const IDLE = 0.4;
/** Full level at full slider volume. Measured offline (same graph in numpy, ffmpeg ebur128): about
 *  −38 LUFS idling, −32 cruising at 15 m/s, −26 at top speed on the throttle, under the wind at speed. */
const MIX = 0.075;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

type Graph = {
  ctx: AudioContext;
  master: GainNode;
  saws: OscillatorNode[];
  bodyLp: BiquadFilterNode;
  hum: OscillatorNode;
  humGain: GainNode;
  whine: OscillatorNode;
  whineGain: GainNode;
};

export class EngineSound {
  private g: Graph | null = null;
  /** Wheel speed (m/s) the motor turns at; the ground speed while grounded. */
  private wheel = 0;
  private load = 0;
  private on = false;

  constructor() {
    audio.onStart((ctx, out) => (this.g = this.build(ctx, out)));
  }

  private build(ctx: AudioContext, out: GainNode): Graph {
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(out);
    const osc = (type: OscillatorType, f: number) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.start();
      return o;
    };
    const gain = (v: number) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };

    const bodyLp = ctx.createBiquadFilter();
    bodyLp.type = 'lowpass';
    bodyLp.Q.value = 0.7;
    bodyLp.frequency.value = 300;
    const bodyGain = gain(0.5);
    bodyLp.connect(bodyGain).connect(master);
    const saws = [1, 1.004].map((r) => {
      const o = osc('sawtooth', F_IDLE * r);
      o.connect(bodyLp);
      return o;
    });

    const hum = osc('sine', F_IDLE * 2);
    const humGain = gain(0.5);
    hum.connect(humGain).connect(master);

    const whine = osc('sine', F_IDLE * 6);
    const whineGain = gain(0);
    whine.connect(whineGain).connect(master);

    return { ctx, master, saws, bodyLp, hum, humGain, whine, whineGain };
  }

  /** `riding`: on your bike; `speed`: its ground speed (m/s); `throttle`: forward or back held. */
  update(dt: number, riding: boolean, grounded: boolean, speed: number, throttle: boolean) {
    const g = this.g;
    if (!g || g.ctx.state !== 'running') return;

    if (!riding || grounded) this.wheel = speed;
    else if (throttle) this.wheel = Math.min(AIR_TOP, this.wheel + AIR_SPIN_UP * dt);
    else this.wheel += (speed - this.wheel) * (1 - Math.exp(-dt / AIR_DECAY));
    this.load += ((throttle ? 1 : 0) - this.load) * (1 - Math.exp(-dt / LOAD_TAU));

    const now = g.ctx.currentTime;
    const set = (p: AudioParam, v: number, tau = 0.08) => p.setTargetAtTime(v, now, tau);
    const x = clamp01(this.wheel / 26);
    const f = F_IDLE + F_PER_MS * this.wheel;

    for (const [i, o] of g.saws.entries()) set(o.frequency, f * (i ? 1.004 : 1));
    set(g.hum.frequency, f * 2);
    set(g.whine.frequency, f * 6);
    // Brighter and louder under load and at speed.
    set(g.bodyLp.frequency, f * (2 + 2 * this.load) + 150);
    set(g.whineGain.gain, 0.06 * this.load * (0.3 + 0.7 * x));
    set(g.humGain.gain, 0.4 + 0.2 * this.load);

    // Mounting and dismounting fade rather than click.
    const level = riding ? MIX * (IDLE + (1 - IDLE) * (0.65 * x + 0.35 * this.load)) : 0;
    set(g.master.gain, level, riding !== this.on ? 0.15 : 0.1);
    this.on = riding;
  }
}
