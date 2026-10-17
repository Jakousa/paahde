// Synthesised electric motors for the sand bikes: a hum whose pitch follows the wheel speed. No samples,
// a few oscillators per bike in a small Web Audio graph, after how real EV drives sound:
//   - body:     the motor's own tone. Electric whine is harmonically sparse, so instead of a sawtooth (every
//               harmonic, sounds like a petrol engine) a PeriodicWave with a few chosen ones: fundamental,
//               octave and fifth, and a faint higher "pole" order. A twin a fixed BEAT_HZ above makes a
//               slow throb at any speed.
//   - inverter: the motor controller switches at a fixed carrier frequency; its whistle has sidebands at
//               carrier ± the motor frequency, which spread apart as you speed up (the tram / metro sound).
//               Here: a fixed sine amplitude-modulated by a sine at the motor frequency.
// Pitch follows the wheel speed; loudness follows the load (throttle, i.e. torque) more than the speed, so
// coasting is quiet and opening up brings the whine in. A slow wobble on level and pitch keeps it alive.
// Sitting still on a bike it idles low and quiet. In the air the wheel spins up freely while the throttle
// is held and winds down when it is let go.
//
// Your own bike plays straight to your ears. Other riders' bikes are placed in 3D (HRTF PannerNode; the
// Web Audio listener follows the camera, set in src/crashSound.ts) with a little Doppler shift; we don't
// get their input, so their load is read from how hard they speed up or brake, and from holding a high speed.
// Only the nearest MAX_REMOTE within HEAR metres play.
//
// Plays through the shared output in src/audio.ts (volume slider, limiter); every level change is ramped.
import { audio } from './audio';

/** Motor frequency (Hz) at a standstill, and how much it rises per m/s of wheel speed. */
const F_IDLE = 32;
const F_PER_MS = 7;
/** The body's harmonics (amplitude of the 1st, 2nd, …): fundamental, octave, fifth, and a faint 6th order. */
const HARMONICS = [0, 1, 0.6, 0.3, 0.08, 0, 0.07, 0, 0.02];
/** The body's twin sits this many Hz above it: a slow beat, the same rate at any speed. */
const BEAT_HZ = 1.3;
/** Inverter carrier (Hz), and its sidebands' offset in multiples of the motor frequency. */
const CARRIER = 1500;
const SIDEBAND = 2;
/** Speed (m/s) that counts as top speed for the level and the whine. */
const TOP = 26;
/** Free-spinning wheel in the air: spin-up (m/s²) with the throttle held, and its top speed (m/s). */
const AIR_SPIN_UP = 30;
const AIR_TOP = 34;
/** Time constant (s) of the wind-down in the air, and of following the load (throttle). */
const AIR_DECAY = 1.2;
const LOAD_TAU = 0.15;
/** Level at idle, as a fraction of full (top speed, throttle held); how much of the rest is speed (vs load). */
const IDLE = 0.45;
const BY_SPEED = 0.3;
/** Full level at full slider volume. Measured offline (same graph in numpy, ffmpeg ebur128): about
 *  −39 LUFS idling, −33 coasting at 15 m/s, −27 at 15 m/s on the throttle, −26 at top speed on the throttle
 *  (the inverter whistle alone ~8 dB under that), under the wind at speed. Another rider's bike is as loud
 *  at REF metres. */
const MIX = 0.091;
/** Other bikes: audible within HEAR metres, fading in over the outer FADE; full level inside REF. */
const HEAR = 90;
const FADE = 25;
const REF = 4;
const ROLLOFF = 1.2;
const MAX_REMOTE = 4;
/** A remote bike's acceleration (m/s², either way) that reads as full throttle or brakes. */
const REMOTE_LOAD_ACC = 8;
/** Holding top speed needs the throttle open about this far. */
const REMOTE_CRUISE_LOAD = 0.8;
const SOUND_SPEED = 343;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Smooth pseudo-noise in about [-1, 1]. */
const wobble = (t: number, k: number) =>
  (Math.sin(t * 1.13 + k) + Math.sin(t * 2.71 + 2.3 * k) * 0.6 + Math.sin(t * 5.37 + 4.1 * k) * 0.35) / 1.95;

type Vec = { x: number; y: number; z: number };
type Vel = { vx: number; vy: number; vz: number };
/** What a remote rider looks like to us (src/net.ts RemotePlayer). */
type Rider = Vec & { id: number; riding: boolean; grounded: boolean; vx: number; vy: number; vz: number };

let bodyWave: PeriodicWave | null = null;

/** One bike's motor: its graph and the followed wheel speed and load. */
class Motor {
  readonly out: GainNode;
  private ctx: AudioContext;
  private body: OscillatorNode[];
  private bodyLp: BiquadFilterNode;
  private carrier: OscillatorNode;
  private mod: OscillatorNode;
  private inverter: GainNode;
  /** Wheel speed (m/s) the motor turns at; the ground speed while grounded. */
  private wheel = 0;
  private load = 0;
  private on = false;
  private time = 0;
  /** Each motor wobbles differently. */
  private seed = Math.random() * 100;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    bodyWave ??= ctx.createPeriodicWave(new Float32Array(HARMONICS.length), Float32Array.from(HARMONICS));
    const osc = (f: number) => {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.start();
      return o;
    };
    const gain = (v: number) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    this.out = gain(0);
    this.bodyLp = ctx.createBiquadFilter();
    this.bodyLp.type = 'lowpass';
    this.bodyLp.Q.value = 0.5;
    this.bodyLp.frequency.value = 400;
    this.bodyLp.connect(gain(0.5)).connect(this.out);
    this.body = [0, BEAT_HZ].map((df) => {
      const o = osc(F_IDLE + df);
      o.setPeriodicWave(bodyWave!);
      o.connect(this.bodyLp);
      return o;
    });
    // Amplitude modulation: carrier × (1 + mod) gives the carrier and a sideband either side.
    this.carrier = osc(CARRIER);
    this.mod = osc(F_IDLE * SIDEBAND);
    const am = gain(1);
    this.mod.connect(am.gain);
    this.inverter = gain(0);
    this.carrier.connect(am).connect(this.inverter).connect(this.out);
  }

  /** `throttle` in [0, 1]; `pitch` scales the frequency (Doppler). */
  update(dt: number, riding: boolean, grounded: boolean, speed: number, throttle: number, pitch = 1) {
    this.time += dt;
    if (!riding || grounded) this.wheel = speed;
    else if (throttle > 0.5) this.wheel = Math.min(AIR_TOP, this.wheel + AIR_SPIN_UP * dt);
    else this.wheel += (speed - this.wheel) * (1 - Math.exp(-dt / AIR_DECAY));
    this.load += (throttle - this.load) * (1 - Math.exp(-dt / LOAD_TAU));

    const now = this.ctx.currentTime;
    const set = (p: AudioParam, v: number, tau = 0.08) => p.setTargetAtTime(v, now, tau);
    const t = this.time, k = this.seed;
    const x = clamp01(this.wheel / TOP);
    const f = (F_IDLE + F_PER_MS * this.wheel) * pitch * (1 + 0.004 * wobble(t * 0.9, k));

    set(this.body[0].frequency, f);
    set(this.body[1].frequency, f + BEAT_HZ);
    set(this.mod.frequency, f * SIDEBAND);
    set(this.carrier.frequency, CARRIER * pitch);
    // Brighter under load, and the inverter whistle comes up with it (a faint trace when coasting).
    set(this.bodyLp.frequency, f * (2.5 + 2.5 * this.load) + 150);
    set(this.inverter.gain, 0.12 * (0.15 + 0.85 * this.load) * (0.5 + 0.5 * x) * (1 + 0.25 * wobble(t * 0.6, k + 3)));

    // Mounting and dismounting fade rather than click.
    const drive = BY_SPEED * x + (1 - BY_SPEED) * this.load;
    const level = riding ? MIX * (IDLE + (1 - IDLE) * drive) * (1 + 0.06 * wobble(t * 0.5, k + 7)) : 0;
    set(this.out.gain, level, riding !== this.on ? 0.15 : 0.1);
    this.on = riding;
  }

  /** Ramp out, then stop and disconnect. */
  dispose() {
    const now = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, now, 0.1);
    for (const o of [...this.body, this.carrier, this.mod]) o.stop(now + 0.6);
    setTimeout(() => this.out.disconnect(), 700);
  }
}

type Remote = { motor: Motor; fade: GainNode; panner: PannerNode; speed: number; acc: number };

export class EngineSound {
  private own: Motor | null = null;
  private remotes = new Map<number, Remote>();

  constructor() {
    audio.onStart((ctx, out) => {
      this.own = new Motor(ctx);
      this.own.out.connect(out);
    });
  }

  /** Your bike. `speed`: its ground speed (m/s); `throttle`: forward or back held. */
  update(dt: number, riding: boolean, grounded: boolean, speed: number, throttle: boolean) {
    if (!this.own || !audio.running) return;
    this.own.update(dt, riding, grounded, speed, throttle ? 1 : 0);
  }

  /** Other riders' bikes, heard from `listener` moving at `lv` (m/s). */
  updateRemotes(dt: number, riders: Rider[], listener: Vec, lv: Vel) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const near = riders
      .map((r) => ({ r, d: Math.hypot(r.x - listener.x, r.y - listener.y, r.z - listener.z) }))
      .filter((n) => n.r.riding && n.d < HEAR)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_REMOTE);

    const now = ctx.currentTime;
    const set = (p: AudioParam, v: number, tau = 0.05) => p.setTargetAtTime(v, now, tau);
    const keep = new Set<number>();
    for (const { r, d } of near) {
      keep.add(r.id);
      let a = this.remotes.get(r.id);
      if (!a) {
        const motor = new Motor(ctx);
        const fade = ctx.createGain();
        fade.gain.value = 0;
        const panner = new PannerNode(ctx, {
          panningModel: 'HRTF', distanceModel: 'inverse', refDistance: REF, rolloffFactor: ROLLOFF, maxDistance: 1000,
          positionX: r.x, positionY: r.y + 0.5, positionZ: r.z,
        });
        motor.out.connect(fade).connect(panner).connect(out);
        const speed = Math.hypot(r.vx, r.vz);
        this.remotes.set(r.id, (a = { motor, fade, panner, speed, acc: 0 }));
      }
      set(a.panner.positionX, r.x);
      set(a.panner.positionY, r.y + 0.5);
      set(a.panner.positionZ, r.z);
      set(a.fade.gain, 1 - smooth(HEAR - FADE, HEAR, d), 0.2);

      // Load from acceleration: snapshots step the speed, so follow it smoothly and differentiate that.
      const speed = Math.hypot(r.vx, r.vz);
      const prev = a.speed;
      a.speed += (speed - a.speed) * (1 - Math.exp(-dt / 0.15));
      a.acc += ((a.speed - prev) / Math.max(dt, 1e-3) - a.acc) * (1 - Math.exp(-dt / 0.2));
      const throttle = clamp01(Math.max(Math.abs(a.acc) / REMOTE_LOAD_ACC, REMOTE_CRUISE_LOAD * (a.speed / TOP) ** 2));

      // Doppler: how fast the bike closes on us along the line between.
      const inv = 1 / Math.max(d, 0.1);
      const closing = ((r.vx - lv.vx) * (listener.x - r.x) + (r.vy - lv.vy) * (listener.y - r.y) + (r.vz - lv.vz) * (listener.z - r.z)) * inv;
      const pitch = SOUND_SPEED / (SOUND_SPEED - Math.max(-60, Math.min(60, closing)));
      a.motor.update(dt, true, r.grounded, a.speed, throttle, pitch);
    }
    for (const [id, a] of this.remotes) {
      if (keep.has(id)) continue;
      a.motor.dispose();
      setTimeout(() => {
        a.fade.disconnect();
        a.panner.disconnect();
      }, 700);
      this.remotes.delete(id);
    }
  }
}
