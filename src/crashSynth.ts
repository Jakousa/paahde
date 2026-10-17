// The electronic "voice" of a crash site (played by crashSound.ts): sparse, soft sci-fi sounds from
// half-dead systems in the wreck. Pure Web Audio synthesis (oscillators, envelopes, filters, a noise
// buffer), no samples and no imports, so it also runs in an OfflineAudioContext for loudness checks.
//
// Events, picked at irregular intervals by a PRNG seeded from the site id:
//   - beep:    one or two soft sine/triangle notes from the site's pitch set
//   - chirp:   a quick sine sweep up or down
//   - data:    a short burst of quiet square blips alternating between two pitches (a data link)
//   - warble:  a dying console tone sagging in pitch with a wobbly vibrato
//   - servo:   a faint filtered-saw motor whine gliding up, holding, and back down
//   - crackle: a scatter of tiny band-passed noise grains (arcing wiring)
// Each site gets its own root note, scale and tempo, so different wrecks sound slightly different.

/** Output level of a voice before distance: tuned so a voice 5 m away measures about −26 LUFS. */
export const VOICE_GAIN = 0.32;

type Rng = () => number;
function mulberry(seed: number): Rng {
  let h = seed | 0;
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCALES = [
  [0, 3, 5, 7, 10, 12], // minor pentatonic
  [0, 2, 7, 9, 12, 14], // open fifths
  [0, 4, 7, 11, 12, 16], // major seventh
  [0, 1, 5, 7, 8, 12], // a slightly sour one
];

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function noise(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, Math.floor(ctx.sampleRate), ctx.sampleRate);
    const d = b.getChannelData(0);
    const r = mulberry(0x51a7);
    for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}

export class CrashVoice {
  /** Connect this to wherever the voice should go (a panner); its gain is VOICE_GAIN. */
  readonly out: GainNode;
  private r: Rng;
  private root: number;
  private scale: number[];
  private tempo: number;
  private bright: number;
  private next: number;
  private ctx: BaseAudioContext;

  constructor(ctx: BaseAudioContext, id: number, start = ctx.currentTime) {
    this.ctx = ctx;
    this.r = mulberry(Math.imul(id + 1, 0x9e3779b1) ^ 0x2545f491);
    const r = this.r;
    // Root between ~A4 and ~E6, so it sits above the wind's rumble and rush.
    this.root = 440 * Math.pow(2, Math.floor(r() * 19) / 12);
    this.scale = SCALES[Math.floor(r() * SCALES.length)];
    this.tempo = 0.7 + 0.6 * r();
    this.bright = 0.8 + 0.4 * r();
    this.out = ctx.createGain();
    this.out.gain.value = VOICE_GAIN;
    this.next = start + 0.3 + r() * 1.5;
  }

  /** Schedule every event that starts before `until` (seconds on the context clock). */
  schedule(until: number) {
    const now = this.ctx.currentTime;
    if (this.next < now) this.next = now + 0.05; // after a pause (hidden tab, out of range)
    while (this.next < until) {
      const t = this.next;
      const p = this.r();
      let len: number;
      if (p < 0.3) len = this.beep(t);
      else if (p < 0.48) len = this.chirp(t);
      else if (p < 0.64) len = this.data(t);
      else if (p < 0.72) len = this.warble(t);
      else if (p < 0.83) len = this.servo(t);
      else len = this.crackle(t);
      // Irregular gaps: mostly short-ish, now and then a long silence.
      const r = this.r();
      this.next = t + len + (0.35 + 2.6 * r * r * r + (this.r() < 0.12 ? 2.5 : 0)) / this.tempo;
    }
  }

  private note(): number {
    const st = this.scale[Math.floor(this.r() * this.scale.length)];
    return this.root * Math.pow(2, st / 12);
  }

  private env(t: number, peak: number, attack: number, decay: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setTargetAtTime(0, t + attack, decay / 4);
    g.connect(this.out);
    return g;
  }

  private osc(type: OscillatorType, f: number, t: number, len: number, to: AudioNode): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.connect(to);
    o.start(t);
    o.stop(t + len);
    return o;
  }

  private lowpass(f: number, q = 0.7, to: AudioNode): BiquadFilterNode {
    const b = this.ctx.createBiquadFilter();
    b.type = 'lowpass';
    b.frequency.value = f;
    b.Q.value = q;
    b.connect(to);
    return b;
  }

  private beep(t: number): number {
    const two = this.r() < 0.35;
    const type: OscillatorType = this.r() < 0.6 ? 'sine' : 'triangle';
    const dec = 0.12 + 0.2 * this.r();
    for (let i = 0; i < (two ? 2 : 1); i++) {
      const at = t + i * (0.11 + 0.05 * this.r());
      const g = this.env(at, 0.9, 0.004, dec);
      this.osc(type, this.note(), at, dec + 0.05, this.lowpass(3000 * this.bright, 0.7, g));
    }
    return two ? 0.3 : 0.15;
  }

  private chirp(t: number): number {
    const f = this.note() * (this.r() < 0.5 ? 1 : 2);
    const len = 0.05 + 0.05 * this.r();
    const g = this.env(t, 0.7, 0.003, len);
    const o = this.osc('sine', f, t, len * 2.5, g);
    o.frequency.exponentialRampToValueAtTime(f * (this.r() < 0.6 ? 1.8 : 0.55), t + len);
    return len;
  }

  private data(t: number): number {
    const n = 5 + Math.floor(this.r() * 7);
    const step = 0.045 + 0.03 * this.r();
    const fa = 1400 + 1800 * this.r(), fb = fa * (this.r() < 0.5 ? 1.26 : 0.79);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = (fa + fb) / 2;
    bp.Q.value = 1.2;
    bp.connect(this.out);
    for (let i = 0; i < n; i++) {
      if (this.r() < 0.2) continue; // the odd dropped bit
      const at = t + i * step;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.22, at + 0.002);
      g.gain.setTargetAtTime(0, at + 0.012, 0.004);
      g.connect(bp);
      this.osc('square', this.r() < 0.5 ? fa : fb, at, 0.04, g);
    }
    return n * step;
  }

  private warble(t: number): number {
    const len = 1.2 + 1.3 * this.r();
    const f = this.note() * 0.5;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.08);
    g.gain.setTargetAtTime(0.25, t + 0.1, len / 3);
    g.gain.setTargetAtTime(0, t + len * 0.7, len / 8);
    g.connect(this.out);
    const o = this.osc('triangle', f, t, len + 0.3, this.lowpass(1600 * this.bright, 0.9, g));
    o.frequency.exponentialRampToValueAtTime(f * (0.6 + 0.15 * this.r()), t + len);
    // Vibrato and a dying-battery tremble.
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 5 + 3 * this.r();
    const depth = this.ctx.createGain();
    depth.gain.value = f * 0.025;
    lfo.connect(depth).connect(o.frequency);
    lfo.start(t);
    lfo.stop(t + len + 0.3);
    return len;
  }

  private servo(t: number): number {
    const up = 0.3 + 0.3 * this.r(), hold = 0.2 + 0.5 * this.r(), down = 0.3 + 0.3 * this.r();
    const len = up + hold + down;
    const f0 = 140 + 80 * this.r(), f1 = f0 * (1.8 + 0.8 * this.r());
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.3, t + up * 0.6);
    g.gain.setValueAtTime(0.3, t + up + hold);
    g.gain.linearRampToValueAtTime(0, t + len);
    g.connect(this.out);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 3;
    bp.frequency.setValueAtTime(f0 * 4, t);
    bp.frequency.linearRampToValueAtTime(f1 * 4, t + up);
    bp.frequency.setValueAtTime(f1 * 4, t + up + hold);
    bp.frequency.linearRampToValueAtTime(f0 * 4, t + len);
    bp.connect(g);
    const o = this.osc('sawtooth', f0, t, len + 0.05, bp);
    o.frequency.linearRampToValueAtTime(f1, t + up);
    o.frequency.setValueAtTime(f1, t + up + hold);
    o.frequency.linearRampToValueAtTime(f0, t + len);
    return len;
  }

  private crackle(t: number): number {
    const len = 0.2 + 0.6 * this.r();
    const n = 6 + Math.floor(this.r() * 14);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2500 + 3500 * this.r();
    bp.Q.value = 0.9;
    bp.connect(this.out);
    const buf = noise(this.ctx);
    for (let i = 0; i < n; i++) {
      const at = t + len * this.r() * this.r(); // bunched at the start, like a spark that settles
      const dur = 0.002 + 0.006 * this.r();
      const g = this.ctx.createGain();
      g.gain.value = 0;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.25 + 0.6 * this.r(), at + 0.0005);
      g.gain.setTargetAtTime(0, at + 0.0005, dur / 3);
      g.connect(bp);
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      s.connect(g);
      s.start(at, this.r() * 0.9, dur * 3);
    }
    return len;
  }
}
