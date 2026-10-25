// The nearest running electric well (shared/wells.ts), synthesised:
// - the control box: a faint electric hum (100 Hz and its harmonics through a band-pass, a slow waver), all the time it
//   runs, so you can tell a live well from a dead one by ear before you see its lamp;
// - the pump, while a bottle fills there: a contactor's clack, the motor down the bore (a low hum, muffled by the
//   casing, spinning up over half a second) and the water rushing up the riser (band-passed noise with a slow surge).
// Placed at the well (a panner), level 1/d past REF, gone past HEAR; every level ramped. Through the shared output
// (src/audio.ts: master gain and limiter).
//
// Levels (measured offline: this graph rendered in headless Chrome's OfflineAudioContext at the default volume, ffmpeg
// ebur128): the hum −47 LUFS at REF, an ambience you notice only up close; the pump running −31 LUFS at REF, about the
// pour of the bottle filling under it (src/drinkSound.ts); true peak ≤ −23 dBTP.
import { audio } from './audio';

type P = { x: number; y: number; z: number };

/** Full level within REF (m), 1/d past it, silent past HEAR. */
const REF = 2;
const HEAR = 25;
/** The hum's level, and the pump's (motor and water) at full run. */
const HUM = 0.06;
const PUMP = 0.27;
/** How long the pump takes to spin up and to run down (s, time constants). */
const SPIN_UP = 0.18;
const RUN_DOWN = 0.35;

let noiseBuf: AudioBuffer | null = null;
function noise(ctx: BaseAudioContext) {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

export type WellVoice = { stop: (() => void)[]; gain: GainNode; pump: GainNode; motor: OscillatorNode[]; panner: PannerNode };

/** The well's sound graph into `out` (also used to measure it offline): the hum always, the pump under `pump`'s gain. */
export function wellVoice(ctx: BaseAudioContext, out: AudioNode, at: P): WellVoice {
  const t = ctx.currentTime;
  const stop: (() => void)[] = [];
  const osc = (type: OscillatorType, f: number) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.start(t);
    stop.push(() => o.stop());
    return o;
  };
  const gainOf = (v: number) => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };
  const panner = ctx.createPanner();
  panner.panningModel = 'equalpower';
  panner.distanceModel = 'linear';
  panner.refDistance = 1;
  panner.maxDistance = 1e6;
  panner.rolloffFactor = 0; // the level is ours (gain); the panner only places it
  panner.positionX.value = at.x;
  panner.positionY.value = at.y;
  panner.positionZ.value = at.z;
  const gain = gainOf(0);
  gain.connect(panner).connect(out);

  // The hum: a buzzy 100 Hz, band-passed to its middle harmonics, wavering a little.
  const hum = ctx.createBiquadFilter();
  hum.type = 'bandpass';
  hum.frequency.value = 300;
  hum.Q.value = 1.2;
  osc('sawtooth', 100).connect(hum);
  const waver = gainOf(0.8), lfo = osc('sine', 0.31), lg = gainOf(0.2);
  lfo.connect(lg).connect(waver.gain);
  hum.connect(waver).connect(gainOf(HUM)).connect(gain);

  // The pump: motor and water, under its own gain (0 until it runs).
  const pump = gainOf(0);
  pump.connect(gain);
  const motorLp = ctx.createBiquadFilter();
  motorLp.type = 'lowpass';
  motorLp.frequency.value = 260;
  motorLp.Q.value = 0.9;
  const motor = [osc('sawtooth', 30), osc('triangle', 60)];
  motor.forEach((o, i) => o.connect(gainOf(i ? 0.5 : 0.8)).connect(motorLp));
  motorLp.connect(gainOf(0.9)).connect(pump);
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  src.loop = true;
  src.start(t, 0.37);
  stop.push(() => src.stop());
  const rush = ctx.createBiquadFilter();
  rush.type = 'bandpass';
  rush.frequency.value = 900;
  rush.Q.value = 0.8;
  const surge = gainOf(0.75), sl = osc('sine', 1.7), sg = gainOf(0.25);
  sl.connect(sg).connect(surge.gain);
  src.connect(rush).connect(surge).connect(gainOf(0.35)).connect(pump);
  return { stop, gain, pump, motor, panner };
}

/** The contactor pulling in: a short dull click into `out`. */
export function clack(ctx: BaseAudioContext, out: AudioNode, level = PUMP * 1.6) {
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1800;
  bp.Q.value = 2.5;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + 0.002);
  g.gain.setTargetAtTime(0, t + 0.004, 0.012);
  src.connect(bp).connect(g).connect(out);
  src.start(t, 1.1);
  src.stop(t + 0.12);
}

class WellSound {
  private v: (WellVoice & { id: number; pumping: boolean }) | null = null;

  /** Every frame: the nearest running well (`w`, or null), heard from `ear`; `pumping`: a bottle fills there now. */
  update(w: (P & { id: number }) | null, ear: P, pumping: boolean) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    if (this.v && (!w || this.v.id !== w.id)) this.stop();
    if (!w) return;
    const d = Math.hypot(w.x - ear.x, w.y - ear.y, w.z - ear.z);
    if (!this.v && d < HEAR) this.v = { ...wellVoice(ctx, out, w), id: w.id, pumping: false };
    const v = this.v;
    if (!v) return;
    const now = ctx.currentTime;
    if (d > HEAR + 5) return this.stop();
    const edge = Math.max(0, Math.min(1, (HEAR - d) / (HEAR * 0.3)));
    v.gain.gain.setTargetAtTime((REF / Math.max(REF, d)) * edge, now, 0.2);
    if (pumping !== v.pumping) {
      v.pumping = pumping;
      if (pumping) clack(ctx, v.gain);
      v.pump.gain.setTargetAtTime(pumping ? PUMP : 0, now, pumping ? SPIN_UP : RUN_DOWN);
      // The motor winds up from a growl, and down again.
      v.motor.forEach((o, i) => {
        o.frequency.setTargetAtTime(pumping ? 48 * (i + 1) : 30 * (i + 1), now, pumping ? SPIN_UP : RUN_DOWN);
      });
    }
  }

  private stop() {
    const v = this.v;
    if (!v) return;
    this.v = null;
    const ctx = audio.ctx;
    if (ctx) v.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
    setTimeout(() => v.stop.forEach((f) => f()), 600);
  }
}

export const wellSound = new WellSound();
