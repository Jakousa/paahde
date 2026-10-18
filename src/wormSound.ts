// Sounds of the worm (shared/worm.ts), synthesised:
// - rumble: while it swims, a deep grinding drone from the sand over its head (a low saw beating against a detuned
//   one, a growl of low noise, the grinder's teeth chattering in it), louder the shallower and faster it runs, heard
//   a few hundred metres off: you hear it coming before you see anything.
// - tell: the sand over its head starts to shiver before it bursts out: a swelling roar of low noise.
// - breach: bursting out, a blast of sand and a long descending howl of metal; plunge: a footfall's boom twice over.
// Through the shared output in src/audio.ts (one-offs via src/acoustics.ts, so they carry and lag like the guardians'
// footfalls); gains ramped. Levels set against the guardians' footfalls (src/guardianSound.ts, measured there):
// the rumble at its loudest, right over you, sits about level with a footfall at 20 m.
import { audio } from './audio';
import { placed } from './acoustics';
import { guardianSound } from './guardianSound';

/** The rumble: heard within RUMBLE_HEAR m, full level within RUMBLE_REF (1/d past it). */
const RUMBLE_HEAR = 600;
const RUMBLE_REF = 25;
const RUMBLE_GAIN = 0.32;
const TELL_GAIN = 0.9;
const HOWL_GAIN = 0.5;

type P = { x: number; y: number; z: number };

let noiseBuf: AudioBuffer | null = null;
function noise(ctx: AudioContext) {
  if (noiseBuf) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

type Rumble = { gain: GainNode; panner: PannerNode; lp: BiquadFilterNode; saws: OscillatorNode[]; srcs: AudioScheduledSourceNode[] };

class WormSound {
  private rumbles = new Map<number, Rumble>();

  /** Every frame: the worms' heads (at the sand over them), how loud (0..1: shallow and fast), and the listener. Ones
   *  missing from the list fade out. */
  update(list: { id: number; x: number; y: number; z: number; level: number }[], ear: P) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const now = ctx.currentTime;
    for (const [id, r] of this.rumbles) {
      if (list.some((w) => w.id === id)) continue;
      r.gain.gain.setTargetAtTime(0, now, 0.5);
      for (const s of r.srcs) s.stop(now + 3);
      this.rumbles.delete(id);
    }
    for (const w of list) {
      const d = Math.hypot(w.x - ear.x, w.z - ear.z);
      let r = this.rumbles.get(w.id);
      if (!r) {
        if (d > RUMBLE_HEAR) continue;
        r = this.make(ctx, out, w);
        this.rumbles.set(w.id, r);
      }
      const fade = Math.max(0, 1 - Math.max(0, d - RUMBLE_HEAR * 0.7) / (RUMBLE_HEAR * 0.3));
      r.gain.gain.setTargetAtTime(RUMBLE_GAIN * fade * (0.25 + 0.75 * w.level), now, 0.25);
      r.lp.frequency.setTargetAtTime(120 + 260 * w.level, now, 0.3);
      r.saws[0].frequency.setTargetAtTime(30 + 10 * w.level, now, 0.3);
      r.saws[1].frequency.setTargetAtTime(30.7 + 10 * w.level, now, 0.3);
      r.panner.positionX.setTargetAtTime(w.x, now, 0.05);
      r.panner.positionY.setTargetAtTime(w.y, now, 0.05);
      r.panner.positionZ.setTargetAtTime(w.z, now, 0.05);
    }
  }

  private make(ctx: AudioContext, out: AudioNode, w: P): Rumble {
    const p = ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = RUMBLE_REF;
    p.positionX.value = w.x;
    p.positionY.value = w.y;
    p.positionZ.value = w.z;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(p).connect(out);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 150;
    lp.Q.value = 2;
    lp.connect(gain);
    // Two low saws a little apart, beating.
    const saws = [30, 30.7].map((f) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      o.connect(g).connect(lp);
      o.start();
      return o;
    });
    // Low noise, chattered by the grinder (an LFO on its level).
    const n = ctx.createBufferSource();
    n.buffer = noise(ctx);
    n.loop = true;
    const nlp = ctx.createBiquadFilter();
    nlp.type = 'lowpass';
    nlp.frequency.value = 400;
    const ng = ctx.createGain();
    ng.gain.value = 0.7;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 9;
    const lg = ctx.createGain();
    lg.gain.value = 0.35;
    lfo.connect(lg).connect(ng.gain);
    n.connect(nlp).connect(ng).connect(gain);
    n.start(0, Math.random() * 2);
    lfo.start();
    return { gain, panner: p, lp, saws, srcs: [...saws, n, lfo] };
  }

  /** The sand at (x, y, z) shivers: it's about to burst out there, in `len` s. */
  tell(at: P, ear: P, len: number) {
    const ctx = audio.ctx, s = placed(at, ear, TELL_GAIN, 20, 700);
    if (!ctx || !s) return;
    const { input, t } = s;
    const n = ctx.createBufferSource();
    n.buffer = noise(ctx);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(90, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(1, t + len - 0.1);
    g.gain.setTargetAtTime(0, t + len, 0.3);
    n.connect(lp).connect(g).connect(input);
    n.start(t, Math.random());
    n.stop(t + len + 1.4);
  }

  /** It burst out of the sand at (x, y, z): a blast of sand and a howl of metal falling away. */
  breach(at: P, ear: P) {
    guardianSound.boom(at.x, at.y, at.z, ear);
    const ctx = audio.ctx, s = placed(at, ear, HOWL_GAIN, 30, 1500);
    if (!ctx || !s) return;
    const { input, t } = s;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1400, t);
    lp.frequency.exponentialRampToValueAtTime(300, t + 2.5);
    lp.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + 0.15);
    g.gain.setTargetAtTime(0, t + 1.6, 0.6);
    lp.connect(g).connect(input);
    for (const [f0, f1] of [[96, 38], [101, 41], [143, 55]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + 3);
      o.connect(lp);
      o.start(t);
      o.stop(t + 4.5);
    }
  }

  /** It plunged back into the sand at (x, y, z). */
  plunge(at: P, ear: P) {
    guardianSound.boom(at.x, at.y, at.z, ear);
  }
}

export const wormSound = new WormSound();
