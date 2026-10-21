// Synthesised electric motors for the sand bikes: a hum whose pitch follows the wheel speed. No samples,
// a few oscillators per bike in a small Web Audio graph, after how real EV drives sound:
//   - body:     the motor's own tone. Electric whine is harmonically sparse, so instead of a sawtooth (every
//               harmonic, sounds like a petrol engine) a PeriodicWave with a few chosen ones: fundamental,
//               octave and fifth, and a faint higher "pole" order. A twin a fixed BEAT_HZ above makes a
//               slow throb at any speed.
//   - inverter: the motor controller switches at a fixed carrier frequency; its whistle has sidebands at
//               carrier ± the motor frequency, which spread apart as you speed up (the tram / metro sound).
//               Here: a fixed sine amplitude-modulated by a sine at the motor frequency.
// Pitch follows the motor's revs (RPM): the wheel speed through a gearbox (GEARS), its ratios longer on a faster
// bike, so every bike revs through the same range. Near the redline it shifts
// up: the drive cuts (the level dips), a clunk, and the revs drop into the next gear, slowly on a Scrap bike, at
// once on a Space-grade quickshifter (SHIFT_SLOW .. SHIFT_QUICK); slowing
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
import { echoBus } from './acoustics';
import { bikeCruise } from '../shared/sim.ts';

/** The revs: idle and redline (the limiter holds it there), and the motor frequency (Hz) at each. */
const IDLE_RPM = 1500;
const RED_RPM = 12000;
const F_IDLE = 20;
const F_RED = 150;
/** Gear ratios, as where each gear reaches the redline: a fraction of the speed the bike cruises at on the flat
 *  (shared/sim.ts bikeCruise). A faster bike has longer gears, so every bike revs through the same range. The
 *  bikes get to cruise in about 2 s, most of it in the first second, so the gears are long: a second of 1st,
 *  then 2nd, cruising in 3rd at about 80% of its revs; 4th is for running downhill and the air. Neighbouring
 *  gears must be no further apart than UP_RPM / DOWN_RPM (here 1.83×), or an upshift lands under DOWN_RPM and a
 *  downshift near the limiter. */
const GEARS = [0.7, 1.0, 1.25, 1.5];
/** Shift up past UP_RPM with the throttle open (UP_COAST_RPM without: coasting it revs on further), down once
 *  the revs fall under DOWN_RPM, but only if the lower gear lands clear of the upshift (no hunting between
 *  them); not again within SHIFT_GAP s. */
const UP_RPM = 11000;
const UP_COAST_RPM = 11500;
const DOWN_RPM = 6000;
const SHIFT_GAP = 0.35;
/** How long a shift takes (s), by the bike's quality: a Scrap bike's slow, clunky box (SHIFT_SLOW) to a
 *  Space-grade quickshifter (SHIFT_QUICK), evenly on a log scale between. While it shifts the drive is cut, the
 *  level dipping to CUT_LEVEL (a quickshifter's to CUT_LEVEL_QUICK: barely), and the revs glide to the new gear. */
const SHIFT_SLOW = 0.45;
const SHIFT_QUICK = 0.03;
const CUT_LEVEL = 0.3;
const CUT_LEVEL_QUICK = 0.8;
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
/** Free-spinning wheel in the air: spin-up (fraction of the bike's cruising speed per s) with the throttle held,
 *  up to the top gear's redline. */
const AIR_SPIN_UP = 1;
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
type Rider = Vec & { id: number; riding: boolean; grounded: boolean; vx: number; vy: number; vz: number; bike: number };

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
  private cutLeft = 0; // s of the shift (drive cut) left
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
  private shift(throttle: number, cruise: number, shiftTime: number): number {
    if (this.sinceShift < Math.max(SHIFT_GAP, shiftTime + 0.15)) return 0;
    const g = this.gear, rpm = this.rpm(g, cruise);
    if (g < GEARS.length - 1 && rpm > (throttle > 0.5 ? UP_RPM : UP_COAST_RPM)) this.gear++;
    else if (g > 0 && rpm < DOWN_RPM && this.rpm(g - 1, cruise) < UP_RPM * 0.95) this.gear--;
    else return 0;
    this.sinceShift = 0;
    return this.gear - g;
  }

  /** Revs in gear `g` at the wheel speed, on a bike cruising at `cruise` (m/s): never under idle (the clutch
   *  slips), held at the redline by the limiter. */
  private rpm(g: number, cruise: number): number {
    return Math.min(RED_RPM, Math.max(IDLE_RPM, (this.wheel / (GEARS[g] * cruise)) * RED_RPM));
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

  /** `throttle` in [0, 1]; `bike` the motorcycle (PlayerState.bike: 1 + its quality); `pitch` scales the
   *  frequency (Doppler). */
  update(dt: number, riding: boolean, grounded: boolean, speed: number, throttle: number, bike: number, pitch = 1) {
    this.time += dt;
    const q = clamp01((bike - 1) / 3); // quality, 0 Scrap .. 1 Space-grade
    const cruise = bikeCruise(Math.max(0, bike - 1));
    const shiftTime = SHIFT_SLOW * (SHIFT_QUICK / SHIFT_SLOW) ** q;
    if (!riding || grounded) this.wheel = speed;
    else if (throttle > 0.5) this.wheel = Math.min(GEARS[GEARS.length - 1] * cruise, this.wheel + AIR_SPIN_UP * cruise * dt);
    else this.wheel += (speed - this.wheel) * (1 - Math.exp(-dt / AIR_DECAY));
    this.sinceShift += dt;
    const shifted = riding ? this.shift(throttle, cruise, shiftTime) : 0;
    if (!riding) this.gear = 0;
    // A slow box clunks heavily; a quickshifter clicks.
    if (shifted) this.clunk((shifted > 0 ? CLUNK : CLUNK_DOWN) * (1.2 - 0.6 * q));
    // A shift cuts the drive: no load while the clutch is out.
    this.cutLeft = shifted ? shiftTime : Math.max(0, this.cutLeft - dt);
    const cut = this.cutLeft > 0;
    this.load += ((cut ? 0 : throttle) - this.load) * (1 - Math.exp(-dt / (cut ? 0.03 : LOAD_TAU)));

    const now = this.ctx.currentTime;
    const set = (p: AudioParam, v: number, tau = 0.08) => p.setTargetAtTime(v, now, tau);
    const t = this.time, k = this.seed;
    const x = clamp01(this.wheel / cruise);
    // Pitch follows the revs, gliding to the new gear's over the shift (else an 80 ms ramp).
    const revs = (this.rpm(this.gear, cruise) - IDLE_RPM) / (RED_RPM - IDLE_RPM);
    const f = (F_IDLE + (F_RED - F_IDLE) * revs) * pitch * (1 + 0.004 * wobble(t * 0.9, k));
    const glide = cut ? Math.max(0.01, shiftTime * 0.4) : 0.08;

    set(this.body[0].frequency, f, glide);
    set(this.body[1].frequency, f + BEAT_HZ, glide);
    set(this.mod.frequency, f * SIDEBAND, glide);
    set(this.carrier.frequency, CARRIER * pitch);
    // Brighter under load, and the inverter whistle comes up with it (a faint trace when coasting).
    set(this.bodyLp.frequency, f * (2.5 + 2.5 * this.load) + 150);
    set(this.inverter.gain, 0.05 * (0.15 + 0.85 * this.load) * (0.5 + 0.5 * x) * (1 + 0.25 * wobble(t * 0.6, k + 3)));

    const drive = BY_SPEED * x + (1 - BY_SPEED) * this.load;
    set(this.engine.gain, MIX * (IDLE + (1 - IDLE) * drive) * (cut ? CUT_LEVEL + (CUT_LEVEL_QUICK - CUT_LEVEL) * q : 1) * (1 + 0.06 * wobble(t * 0.5, k + 7)), cut ? Math.min(0.02, shiftTime * 0.3) : 0.1);
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
      // Echoing off the walls round you (src/acoustics.ts `echoBus`).
      const bus = echoBus();
      if (bus) this.own.out.connect(bus);
    });
  }

  /** Your bike (`bike`: PlayerState.bike). `speed`: its ground speed (m/s); `throttle`: forward or back held. */
  update(dt: number, riding: boolean, grounded: boolean, speed: number, throttle: boolean, bike: number) {
    if (!this.own || !audio.running) return;
    this.own.update(dt, riding, grounded, speed, throttle ? 1 : 0, bike);
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
        const bus = echoBus();
        if (bus) panner.connect(bus);
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
      const cruise = bikeCruise(Math.max(0, r.bike - 1));
      const throttle = clamp01(Math.max(Math.abs(a.acc) / REMOTE_LOAD_ACC, REMOTE_CRUISE_LOAD * (a.speed / cruise) ** 2));

      // Doppler: how fast the bike closes on us along the line between.
      const inv = 1 / Math.max(d, 0.1);
      const closing = ((r.vx - lv.vx) * (listener.x - r.x) + (r.vy - lv.vy) * (listener.y - r.y) + (r.vz - lv.vz) * (listener.z - r.z)) * inv;
      const pitch = SOUND_SPEED / (SOUND_SPEED - Math.max(-60, Math.min(60, closing)));
      a.motor.update(dt, true, r.grounded, a.speed, throttle, r.bike, pitch);
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
