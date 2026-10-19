// Sounds of the harvester (shared/harvester.ts), synthesised, for the nearest one crawling:
// - engine: a slow, heavy diesel: two low saws a fifth apart through a low-pass, thudding at its firing rate.
// - treads: band-passed noise clanking at the rate the shoes come round (SPEED / pitch), and a thin squeal of steel.
// - drum: a gravelly grind from the maw, churning.
// Late by the distance at the speed of sound (a delay line), duller further off, the clank and grind fading out before
// the engine does. At a charge it all runs faster (the clank at the shoes' rate), the engine climbing, louder and
// opening up into a roar; rougher with every core shot out; silent once it's dead.
// Through the shared output (src/audio.ts: master gain and limiter); every level ramped. Set against the carrier's
// thrum (src/carrierSound.ts): at REF a little under it, since it's heard for longer.
import { audio } from './audio';
import { SPEED_OF_SOUND } from './acoustics';
import { CHARGE, CORES, SPEED } from '../shared/harvester.ts';

/** Heard within HEAR m, full level within REF (1/d past it); the treads and drum are heard within NEAR. */
const HEAR = 2500;
const REF = 40;
const NEAR = 260;
const GAIN = 0.26;
/** Engine firing rate (Hz) and its two notes; tread clanks a second (a shoe is about 0.8 m). */
const FIRE_HZ = 8.5;
const NOTES = [33, 49.5];
const CLANK_HZ = SPEED / 0.84;
/** The engine and treads follow its speed up to this many times their crawl (a charge is ten times it). */
const RATE_MAX = 4;
/** At a full charge, this much louder. */
const CHARGE_GAIN = 1.6;

type P = { x: number; y: number; z: number };

let noiseBuf: AudioBuffer | null = null;
function noise(ctx: AudioContext) {
  if (noiseBuf) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

type Voice = {
  id: number;
  stop: (() => void)[];
  delay: DelayNode; air: BiquadFilterNode; gain: GainNode; near: GainNode; engine: BiquadFilterNode; panner: PannerNode;
  /** Oscillators that run faster with its speed: base frequency, and how much of the speed-up they follow. */
  rates: { o: OscillatorNode; f: number; k: number }[];
};

export class HarvesterSound {
  private v: Voice | null = null;

  /** Every frame: the nearest harvester crawling (at `v` m/s, `cores` still glowing), or null, heard from `ear`. */
  update(h: { id: number; x: number; y: number; z: number; v: number; cores: number } | null, ear: P) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const d = h ? Math.hypot(h.x - ear.x, h.y - ear.y, h.z - ear.z) : Infinity;
    if (this.v && h && this.v.id !== h.id) this.stop();
    if (!this.v && h && d < HEAR) this.v = this.voice(ctx, out, h.id, h);
    const v = this.v;
    if (!v) return;
    const now = ctx.currentTime;
    if (!h || d > HEAR + 200) {
      v.gain.gain.setTargetAtTime(0, now, 0.8);
      if (v.gain.gain.value < 1e-4) this.stop();
      return;
    }
    const edge = Math.max(0, Math.min(1, (HEAR - d) / (HEAR * 0.3)));
    // How far into a charge (0 crawling .. 1 flat out).
    const rate = Math.min(RATE_MAX, Math.max(1, h.v / SPEED)), c = Math.min(1, (h.v / SPEED - 1) / (CHARGE / SPEED - 1));
    v.gain.gain.setTargetAtTime(GAIN * (1 + (CHARGE_GAIN - 1) * c) * (REF / Math.max(REF, d)) * edge, now, 0.3);
    const near = 1 - Math.min(1, Math.max(0, (d - NEAR * 0.4) / NEAR));
    v.near.gain.setTargetAtTime(near, now, 0.3);
    for (const r of v.rates) r.o.frequency.setTargetAtTime(r.f * (1 + r.k * (rate - 1)), now, 0.25);
    // A charge, or cores shot out: the engine runs harder and rougher, its low-pass opening up.
    v.engine.frequency.setTargetAtTime(200 + 420 * c + (CORES.length - h.cores) * 90, now, 0.4);
    v.air.frequency.setTargetAtTime(Math.max(140, 7000 * Math.exp(-d / 450)), now, 0.2);
    v.delay.delayTime.setTargetAtTime(d / SPEED_OF_SOUND, now, 0.3);
    v.panner.positionX.setTargetAtTime(h.x, now, 0.05);
    v.panner.positionY.setTargetAtTime(h.y, now, 0.05);
    v.panner.positionZ.setTargetAtTime(h.z, now, 0.05);
  }

  private voice(ctx: AudioContext, out: AudioNode, id: number, at: P): Voice {
    const t = ctx.currentTime;
    const stop: (() => void)[] = [];
    const rates: Voice['rates'] = [];
    /** An oscillator at `f` Hz, following `k` of its speed-up. */
    const osc = (type: OscillatorType, f: number, k = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.start(t);
      stop.push(() => o.stop());
      if (k) rates.push({ o, f, k });
      return o;
    };
    const src = () => {
      const n = ctx.createBufferSource();
      n.buffer = noise(ctx);
      n.loop = true;
      n.start(t, Math.random() * 2);
      stop.push(() => n.stop());
      return n;
    };
    /** `node`'s level swung by an LFO at `hz` (a square for clanks), `depth` of the way to silence. */
    const pulse = (node: AudioNode, hz: number, depth: number, type: OscillatorType = 'sine', k = 0) => {
      const am = ctx.createGain();
      am.gain.value = 1 - depth / 2;
      const lfo = osc(type, hz, k), g = ctx.createGain();
      g.gain.value = depth / 2;
      lfo.connect(g).connect(am.gain);
      node.connect(am);
      return am;
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
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = 2000;
    const delay = ctx.createDelay(10);
    const mix = ctx.createGain();
    mix.connect(air).connect(delay).connect(gain).connect(panner).connect(out);

    // Engine.
    const engine = ctx.createBiquadFilter();
    engine.type = 'lowpass';
    engine.frequency.value = 200;
    engine.Q.value = 2;
    for (const f of NOTES) osc('sawtooth', f, 0.3).connect(engine);
    osc('sine', NOTES[0] / 2, 0.3).connect(engine);
    pulse(engine, FIRE_HZ, 0.6, 'sine', 0.5).connect(mix);

    // Treads and drum, only near.
    const near = ctx.createGain();
    near.gain.value = 0;
    near.connect(mix);
    const clank = ctx.createBiquadFilter();
    clank.type = 'bandpass';
    clank.frequency.value = 1300;
    clank.Q.value = 1.4;
    src().connect(clank);
    const cg = ctx.createGain();
    cg.gain.value = 0.55;
    pulse(clank, CLANK_HZ, 1, 'square', 1).connect(cg).connect(near);
    const squeal = osc('triangle', 760);
    const vib = osc('sine', 0.23), vg = ctx.createGain();
    vg.gain.value = 40;
    vib.connect(vg).connect(squeal.frequency);
    const sg = ctx.createGain();
    sg.gain.value = 0.025;
    squeal.connect(sg).connect(near);
    const grind = ctx.createBiquadFilter();
    grind.type = 'bandpass';
    grind.frequency.value = 280;
    grind.Q.value = 0.7;
    src().connect(grind);
    const gg = ctx.createGain();
    gg.gain.value = 0.9;
    pulse(grind, 5.3, 0.7, 'sine', 0.6).connect(gg).connect(near);
    return { id, stop, delay, air, gain, near, engine, panner, rates };
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

export const harvesterSound = new HarvesterSound();
