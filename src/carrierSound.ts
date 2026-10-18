// Sounds of the hive carrier (shared/carrier.ts), synthesised:
// - thrum: the four big fans, a deep beating drone heard kilometres off: low-passed noise chopped at the blade rate
//   (each fan a little off the others, so they beat against each other), a low hum and its fifth, and a breathy
//   whoosh nearer in. Late by the distance at the speed of sound (a delay line, so it also bends a little as it comes
//   and goes), duller further off, and thinner with every dead fan.
// - whistle: a falling bomb's whistle, dropping in pitch and swelling until it lands (the burst is the walkers' boom).
// - bombs and the crash reuse guardianSound.boom, rifleSound.firework and rifleSound.slam.
// - its gun drones: a launch clunk out of the bay, a waspish buzz each (the nearest few), the rising whine while
//   one aims, and the crack of its shot.
// Through the shared output (src/audio.ts: master gain and limiter); every level ramped. Levels set against the jets'
// roar (src/guardianSound.ts): right under it the thrum is a little under a low jet pass, a bomb's whistle a short
// one-shot over it.
import { audio } from './audio';
import { SPEED_OF_SOUND } from './acoustics';

/** Thrum: heard within HEAR m, full level within REF (1/d past it); the whoosh opens up within NEAR. */
const HEAR = 3200;
const REF = 90;
const NEAR = 160;
const THRUM_GAIN = 0.32;
/** Blade rate (Hz) of a healthy fan; the four detuned by this much. */
const CHOP_HZ = 11;
const CHOP_SPREAD = 0.35;
const WHISTLE_GAIN = 0.05;
const WHISTLE_REF = 15;
/** Gun drones: buzz heard within BUZZ_HEAR m (the nearest MAX_BUZZ of them), full level within BUZZ_REF; the aim's
 *  whine, the shot's crack and the launch clunk (levels against the searchlight drones' buzz and a walker's charge,
 *  src/guardianSound.ts: a buzz a little under theirs, the whine like a cannon's charge, the crack a short one-shot). */
const BUZZ_HEAR = 120;
const BUZZ_REF = 12;
const BUZZ_GAIN = 0.11;
const MAX_BUZZ = 3;
const AIM_GAIN = 0.035;
const AIM_REF = 18;
const CRACK_GAIN = 0.14;
const CRACK_REF = 20;
const CLUNK_GAIN = 0.12;
const CLUNK_REF = 40;

type P = { x: number; y: number; z: number };
type Buzz = { osc: OscillatorNode; whine: OscillatorNode; trem: OscillatorNode; gain: GainNode; panner: PannerNode };

function panner(ctx: AudioContext, at: P, ref: number) {
  const p = ctx.createPanner();
  p.panningModel = 'equalpower';
  p.distanceModel = 'inverse';
  p.refDistance = ref;
  p.positionX.value = at.x;
  p.positionY.value = at.y;
  p.positionZ.value = at.z;
  return p;
}

let noiseBuf: AudioBuffer | null = null;
function noise(ctx: AudioContext) {
  if (noiseBuf) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

type Voice = {
  stop: (() => void)[];
  delay: DelayNode; air: BiquadFilterNode; gain: GainNode; whoosh: GainNode; panner: PannerNode;
  fans: GainNode[];
};

export class CarrierSound {
  private v: Voice | null = null;
  private buzz = new Map<number, Buzz>();

  /** Every frame: the carrier at `at` with fan i alive while bit i of `alive` is set (dead: 0), heard from `ear`. */
  thrum(at: P, alive: number, ear: P) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const d = Math.hypot(at.x - ear.x, at.y - ear.y, at.z - ear.z);
    if (!this.v && d < HEAR && alive) this.v = this.voice(ctx, out);
    const v = this.v;
    if (!v) return;
    const now = ctx.currentTime;
    let n = 0;
    v.fans.forEach((g, i) => {
      const on = (alive >> i) & 1;
      n += on;
      g.gain.setTargetAtTime(on ? 1 : 0, now, on ? 0.2 : 1.5);
    });
    const edge = Math.max(0, Math.min(1, (HEAR - d) / (HEAR * 0.3)));
    v.gain.gain.setTargetAtTime(n ? THRUM_GAIN * (REF / Math.max(REF, d)) * edge * (0.4 + 0.6 * (n / 4)) : 0, now, n ? 0.1 : 1.5);
    const near = 1 - Math.min(1, Math.max(0, (d - NEAR) / (NEAR * 3)));
    v.whoosh.gain.setTargetAtTime(0.15 + 0.85 * near * near, now, 0.2);
    v.air.frequency.setTargetAtTime(Math.max(160, 6000 * Math.exp(-d / 500)), now, 0.2);
    v.delay.delayTime.setTargetAtTime(d / SPEED_OF_SOUND, now, 0.3);
    v.panner.positionX.setTargetAtTime(at.x, now, 0.05);
    v.panner.positionY.setTargetAtTime(at.y, now, 0.05);
    v.panner.positionZ.setTargetAtTime(at.z, now, 0.05);
    if (d > HEAR + 200 || (!n && v.gain.gain.value < 1e-4)) this.stop();
  }

  /** Every frame: the gun drones out (by slot), heard from `ear`; the nearest few buzz. */
  drones(list: { id: number; at: P }[], ear: P) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const now = ctx.currentTime;
    const near = list.map((d) => ({ d, r: Math.hypot(d.at.x - ear.x, d.at.y - ear.y, d.at.z - ear.z) })).filter((o) => o.r < BUZZ_HEAR)
      .sort((a, b) => a.r - b.r).slice(0, MAX_BUZZ);
    const keep = new Set(near.map((o) => o.d.id));
    for (const [id, b] of this.buzz) {
      if (keep.has(id)) continue;
      this.dropBuzz(b, now);
      this.buzz.delete(id);
    }
    for (const { d, r } of near) {
      let b = this.buzz.get(d.id);
      if (!b) {
        // A rasping saw through a band-pass, trembling fast (the little rotors), and a thin whine over it.
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = 165 + d.id * 7;
        const band = ctx.createBiquadFilter();
        band.type = 'bandpass';
        band.frequency.value = 1100;
        band.Q.value = 0.8;
        const whine = ctx.createOscillator();
        whine.frequency.value = 2100 + d.id * 45;
        const wg = ctx.createGain();
        wg.gain.value = 0.05;
        const am = ctx.createGain();
        am.gain.value = 0.7;
        const trem = ctx.createOscillator();
        trem.frequency.value = 38 + d.id * 1.3;
        const depth = ctx.createGain();
        depth.gain.value = 0.3;
        trem.connect(depth).connect(am.gain);
        const gain = ctx.createGain();
        gain.gain.value = 0;
        const p = panner(ctx, d.at, BUZZ_REF);
        osc.connect(band).connect(am);
        whine.connect(wg).connect(am);
        am.connect(gain).connect(p).connect(out);
        osc.start();
        whine.start();
        trem.start();
        this.buzz.set(d.id, (b = { osc, whine, trem, gain, panner: p }));
      }
      const fade = 1 - Math.max(0, (r - BUZZ_HEAR * 0.7) / (BUZZ_HEAR * 0.3));
      b.gain.gain.setTargetAtTime(BUZZ_GAIN * fade, now, 0.15);
      b.panner.positionX.setTargetAtTime(d.at.x, now, 0.05);
      b.panner.positionY.setTargetAtTime(d.at.y, now, 0.05);
      b.panner.positionZ.setTargetAtTime(d.at.z, now, 0.05);
    }
  }

  private dropBuzz(b: Buzz, now: number) {
    b.gain.gain.setTargetAtTime(0, now, 0.15);
    b.osc.stop(now + 1);
    b.whine.stop(now + 1);
    b.trem.stop(now + 1);
  }

  /** A drone out of the bay at `at`: a heavy latch letting go. */
  launch(at: P) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(CLUNK_GAIN, t + 0.005);
    g.gain.setTargetAtTime(0, t + 0.02, 0.07);
    const n = ctx.createBufferSource();
    n.buffer = noise(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 2400;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(CLUNK_GAIN * 0.8, t + 0.003);
    ng.gain.setTargetAtTime(0, t + 0.01, 0.02);
    const p = panner(ctx, at, CLUNK_REF);
    o.connect(g).connect(p);
    n.connect(hp).connect(ng).connect(p);
    p.connect(out);
    o.start(t);
    o.stop(t + 0.6);
    n.start(t, Math.random());
    n.stop(t + 0.2);
  }

  /** A drone at `at` aiming for `s` seconds: a whine climbing to the shot, pulsing faster. */
  aim(at: P, s: number) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(520, t);
    o.frequency.exponentialRampToValueAtTime(2200, t + s);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    const pulse = ctx.createGain();
    pulse.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.setValueAtTime(5, t);
    lfo.frequency.exponentialRampToValueAtTime(24, t + s);
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(pulse.gain);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(AIM_GAIN * 0.5, t + 0.04);
    g.gain.linearRampToValueAtTime(AIM_GAIN, t + s);
    g.gain.setTargetAtTime(0, t + s, 0.01);
    const p = panner(ctx, at, AIM_REF);
    o.connect(lp).connect(pulse).connect(g).connect(p).connect(out);
    o.start(t);
    lfo.start(t);
    o.stop(t + s + 0.15);
    lfo.stop(t + s + 0.15);
  }

  /** A drone's shot ending at `at`: a sharp crack and a falling zap. */
  shot(at: P) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const t = ctx.currentTime;
    const n = ctx.createBufferSource();
    n.buffer = noise(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(CRACK_GAIN, t + 0.002);
    ng.gain.setTargetAtTime(0, t + 0.01, 0.03);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(2400, t);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.18);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3500;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(CRACK_GAIN * 0.5, t + 0.004);
    og.gain.setTargetAtTime(0, t + 0.05, 0.05);
    const p = panner(ctx, at, CRACK_REF);
    n.connect(hp).connect(ng).connect(p);
    o.connect(lp).connect(og).connect(p);
    p.connect(out);
    n.start(t, Math.random());
    n.stop(t + 0.3);
    o.start(t);
    o.stop(t + 0.4);
  }

  /** Out of view: fade out and let go. */
  stop() {
    const ctx = audio.ctx, v = this.v;
    this.v = null;
    if (ctx) for (const b of this.buzz.values()) this.dropBuzz(b, ctx.currentTime);
    this.buzz.clear();
    if (!ctx || !v) return;
    v.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
    setTimeout(() => v.stop.forEach((f) => f()), 2500);
  }

  private voice(ctx: AudioContext, out: AudioNode): Voice {
    const buf = noise(ctx);
    const t = ctx.currentTime;
    const stop: (() => void)[] = [];
    const mix = ctx.createGain();
    // Four fans: each the same low noise, chopped at its own blade rate (a gain swinging 0.15..1).
    const fans: GainNode[] = [];
    for (let i = 0; i < 4; i++) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 110 + i * 12;
      const lp2 = ctx.createBiquadFilter();
      lp2.type = 'lowpass';
      lp2.frequency.value = 220;
      const chop = ctx.createGain();
      chop.gain.value = 0.575;
      const osc = ctx.createOscillator();
      osc.frequency.value = CHOP_HZ + (i - 1.5) * CHOP_SPREAD;
      const depth = ctx.createGain();
      depth.gain.value = 0.425;
      osc.connect(depth).connect(chop.gain);
      const fan = ctx.createGain();
      fan.gain.value = 0;
      src.connect(lp).connect(lp2).connect(chop).connect(fan).connect(mix);
      src.start(t, Math.random() * buf.duration);
      osc.start(t);
      stop.push(() => src.stop(), () => osc.stop());
      fans.push(fan);
    }
    const rumble = ctx.createGain();
    rumble.gain.value = 3.2; // the low-passed noise is quiet
    mix.connect(rumble);
    // The hum: a low drone and its fifth, the motors.
    const hum = ctx.createGain();
    hum.gain.value = 0.18;
    for (const [f, a] of [[33, 1], [49.5, 0.5], [66, 0.3]] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = a;
      o.connect(g).connect(hum);
      o.start(t);
      stop.push(() => o.stop());
    }
    // The whoosh: band-passed noise, the air through the ducts; mostly heard close.
    const ws = ctx.createBufferSource();
    ws.buffer = buf;
    ws.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 420;
    band.Q.value = 0.6;
    const whoosh = ctx.createGain();
    whoosh.gain.value = 0.15;
    const wl = ctx.createGain();
    wl.gain.value = 0.5;
    ws.connect(band).connect(wl).connect(whoosh);
    ws.start(t, Math.random() * buf.duration);
    stop.push(() => ws.stop());
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = 600;
    const delay = ctx.createDelay(12);
    delay.delayTime.value = 0;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'linear';
    p.rolloffFactor = 0; // the level is ours
    rumble.connect(air);
    hum.connect(air);
    whoosh.connect(air);
    air.connect(delay).connect(gain).connect(p).connect(out);
    return { stop, delay, air, gain, whoosh, panner: p, fans };
  }

  /** A bomb falling from now for `s` seconds; move it with the returned function (stops itself when it lands). */
  whistle(s: number, at: P): ((at: P) => void) | null {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return null;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(2300, t);
    o.frequency.exponentialRampToValueAtTime(650, t + s);
    const o2 = ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.setValueAtTime(2330, t);
    o2.frequency.exponentialRampToValueAtTime(662, t + s);
    const g2 = ctx.createGain();
    g2.gain.value = 0.3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(WHISTLE_GAIN * 0.3, t + s * 0.3);
    g.gain.linearRampToValueAtTime(WHISTLE_GAIN, t + s * 0.97);
    g.gain.setTargetAtTime(0, t + s * 0.97, 0.02);
    const p = ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = WHISTLE_REF;
    p.positionX.value = at.x;
    p.positionY.value = at.y;
    p.positionZ.value = at.z;
    o.connect(g);
    o2.connect(g2).connect(g);
    g.connect(p).connect(out);
    o.start(t);
    o2.start(t);
    o.stop(t + s + 0.2);
    o2.stop(t + s + 0.2);
    return (q) => {
      const now = ctx.currentTime;
      p.positionX.setTargetAtTime(q.x, now, 0.02);
      p.positionY.setTargetAtTime(q.y, now, 0.02);
      p.positionZ.setTargetAtTime(q.z, now, 0.02);
    };
  }
}

export const carrierSound = new CarrierSound();
