// Synthesised electric motors for the sand bikes: a hum whose pitch follows the wheel speed. No samples,
// a few oscillators per bike in a small Web Audio graph, after how real EV drives sound:
//   - body:     the motor's own tone. Electric whine is harmonically sparse, so instead of a sawtooth (every
//               harmonic, sounds like a petrol engine) a PeriodicWave with a few chosen ones: fundamental,
//               octave and fifth, and a faint higher "pole" order. A twin a fixed BEAT_HZ above makes a
//               slow throb at any speed.
//   - inverter: the motor controller switches at a fixed carrier frequency; its whistle has sidebands at
//               carrier ± the motor frequency, which spread apart as you speed up (the tram / metro sound).
//               Here: a fixed sine amplitude-modulated by a sine at the motor frequency.
// Pitch follows the motor's revs: the wheel speed through a gearbox (GEARS). Near the top of a gear it shifts
// up: the drive cuts for a moment (the level dips), a clunk, and the revs drop into the next gear; slowing
// down it shifts back down with a softer clunk and the revs blipping up. Loudness follows the load
// (throttle, i.e. torque) more than the speed, so coasting is quiet and opening up brings the whine in. A
// slow wobble on level and pitch keeps it alive. Sitting still on a bike it idles low and quiet. In the air
// the wheel spins up freely while the throttle is held and winds down when it is let go.
//
// Your own bike plays straight to your ears. Other riders' bikes are placed in 3D (HRTF PannerNode; the
// Web Audio listener follows the camera, set in src/crashSound.ts) with a little Doppler shift; we don't
// get their input, so their load is read from how hard they speed up or brake, and from holding a high speed.
// Only the nearest MAX_REMOTE within HEAR metres play.
//
// Plays through the shared output in src/audio.ts (volume slider, limiter); every level change is ramped.
import { audio } from './audio';

/** Motor frequency (Hz) at idle and at the top of a gear. */
const F_IDLE = 24;
const F_RED = 88;
/** Wheel speed (m/s) at the top of each gear (the bikes cruise at 16 to 35 m/s; the last is for the air). */
const GEARS = [6, 11, 17, 24, 32, 42];
/** Shift up past this fraction of the gear's top with the throttle open (UP_COAST without), down once the
 *  speed falls under DOWN of the lower gear's top; not again within SHIFT_GAP s. */
const UP = 0.9;
const UP_COAST = 0.97;
const DOWN = 0.5;
const SHIFT_GAP = 0.35;
/** An upshift cuts the drive this long (s), the level dipping to CUT_LEVEL. */
const CUT = 0.12;
const CUT_LEVEL = 0.4;
/** The clunk of a shift: a low thump (Hz) and a click of noise through a band (Hz); level relative to the motor
 *  at full, a downshift's softer. */
const THUMP_HZ = 62;
const CLICK_HZ = 900;
const CLUNK = 0.5;
const CLUNK_DOWN = 0.3;
/** The body's harmonics (amplitude of the 1st, 2nd, …): fundamental, octave, fifth, and a faint 6th order. */
const HARMONICS = [0, 1, 0.6, 0.3, 0.08, 0, 0.07, 0, 0.02];
/** The body's twin sits this many Hz above it: a slow beat, the same rate at any speed. */
const BEAT_HZ = 1.3;
/** Inverter carrier (Hz), and its sidebands' offset in multiples of the motor frequency. */
const CARRIER = 900;
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
 *  −44 LUFS idling, −36 coasting at 15 m/s, −31 at 15 m/s on the throttle, −30 at top speed on the throttle,
 *  well under the wind at speed (3.5–4.5 dB under the old ungeared, higher-pitched motor). Another rider's
 *  bike is as loud at REF metres. */
const MIX = 0.065;
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
let noise: AudioBuffer | null = null;

/** One bike's motor: its graph and the followed wheel speed and load. */
class Motor {
  readonly out: GainNode;
  private ctx: AudioContext;
  private body: OscillatorNode[];
  private bodyLp: BiquadFilterNode;
  private carrier: OscillatorNode;
  private mod: OscillatorNode;
  private inverter: GainNode;
  /** The motor itself (dips on a shift); the clunks go past it into `out`, which only fades on and off. */
  private engine: GainNode;
  /** Wheel speed (m/s) the motor turns at; the ground speed while grounded. */
  private wheel = 0;
  private load = 0;
  private gear = 0;
  private sinceShift = Infinity;
  private cutLeft = 0; // s of an upshift's drive cut left
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
    this.engine = gain(0);
    this.engine.connect(this.out);
    if (!noise) {
      noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.1), ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    this.bodyLp = ctx.createBiquadFilter();
    this.bodyLp.type = 'lowpass';
    this.bodyLp.Q.value = 0.5;
    this.bodyLp.frequency.value = 400;
    this.bodyLp.connect(gain(0.5)).connect(this.engine);
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
    this.carrier.connect(am).connect(this.inverter).connect(this.engine);
  }

  /** The gearbox: up near the top of a gear, down once well into the one below. Returns the shift (+1, −1, 0). */
  private shift(throttle: number): number {
    if (this.sinceShift < SHIFT_GAP) return 0;
    const g = this.gear;
    if (g < GEARS.length - 1 && this.wheel > GEARS[g] * (throttle > 0.5 ? UP : UP_COAST)) this.gear++;
    else if (g > 0 && this.wheel < GEARS[g - 1] * DOWN) this.gear--;
    else return 0;
    this.sinceShift = 0;
    return this.gear - g;
  }

  /** The clunk of the gear going in: a thump and a click, `level` × MIX. */
  private clunk(level: number) {
    const ctx = this.ctx, now = ctx.currentTime;
    const a = MIX * level * (0.85 + Math.random() * 0.3);
    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(THUMP_HZ * (0.9 + Math.random() * 0.2), now);
    thump.frequency.exponentialRampToValueAtTime(THUMP_HZ * 0.6, now + 0.12);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0, now);
    tg.gain.linearRampToValueAtTime(a, now + 0.004);
    tg.gain.setTargetAtTime(0, now + 0.004, 0.035);
    thump.connect(tg).connect(this.out);
    thump.start(now);
    thump.stop(now + 0.3);
    const click = ctx.createBufferSource();
    click.buffer = noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = CLICK_HZ * (0.85 + Math.random() * 0.3);
    band.Q.value = 1.5;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(a * 0.8, now);
    cg.gain.setTargetAtTime(0, now, 0.012);
    click.connect(band).connect(cg).connect(this.out);
    click.start(now);
  }

  /** `throttle` in [0, 1]; `pitch` scales the frequency (Doppler). */
  update(dt: number, riding: boolean, grounded: boolean, speed: number, throttle: number, pitch = 1) {
    this.time += dt;
    if (!riding || grounded) this.wheel = speed;
    else if (throttle > 0.5) this.wheel = Math.min(AIR_TOP, this.wheel + AIR_SPIN_UP * dt);
    else this.wheel += (speed - this.wheel) * (1 - Math.exp(-dt / AIR_DECAY));
    this.sinceShift += dt;
    const shifted = riding ? this.shift(throttle) : 0;
    if (!riding) this.gear = 0;
    if (shifted) this.clunk(shifted > 0 ? CLUNK : CLUNK_DOWN);
    // An upshift cuts the drive: no load while the clutch is out.
    this.cutLeft = shifted > 0 ? CUT : Math.max(0, this.cutLeft - dt);
    const cut = this.cutLeft > 0;
    this.load += ((cut ? 0 : throttle) - this.load) * (1 - Math.exp(-dt / (cut ? 0.03 : LOAD_TAU)));

    const now = this.ctx.currentTime;
    const set = (p: AudioParam, v: number, tau = 0.08) => p.setTargetAtTime(v, now, tau);
    const t = this.time, k = this.seed;
    const x = clamp01(this.wheel / TOP);
    // Revs: through the gear, gliding to the new gear's after a shift (the frequencies' 80 ms ramp).
    const revs = clamp01(this.wheel / GEARS[this.gear]);
    const f = (F_IDLE + (F_RED - F_IDLE) * revs) * pitch * (1 + 0.004 * wobble(t * 0.9, k));

    set(this.body[0].frequency, f);
    set(this.body[1].frequency, f + BEAT_HZ);
    set(this.mod.frequency, f * SIDEBAND);
    set(this.carrier.frequency, CARRIER * pitch);
    // Brighter under load, and the inverter whistle comes up with it (a faint trace when coasting).
    set(this.bodyLp.frequency, f * (2.5 + 2.5 * this.load) + 150);
    set(this.inverter.gain, 0.05 * (0.15 + 0.85 * this.load) * (0.5 + 0.5 * x) * (1 + 0.25 * wobble(t * 0.6, k + 3)));

    const drive = BY_SPEED * x + (1 - BY_SPEED) * this.load;
    set(this.engine.gain, MIX * (IDLE + (1 - IDLE) * drive) * (cut ? CUT_LEVEL : 1) * (1 + 0.06 * wobble(t * 0.5, k + 7)), cut ? 0.02 : 0.1);
    // Mounting and dismounting fade rather than click.
    set(this.out.gain, riding ? 1 : 0, riding !== this.on ? 0.15 : 0.1);
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
