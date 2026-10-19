// The grinder (src/grinder.ts), synthesised: no samples. It is a motor and a disc, and two things happen to the sound.
//   Spin: hold the use button and the motor spools up from nothing (a hum that rises with the revs, a gear whine over it, the
//   disc moving air), a second or so to full speed; let go and it coasts down slower than it came up.
//   Contact: the disc touches something hard and the load pulls the revs down a little and keeps them unsteady (the motor fights the
//   material, a bite as it lands). On top come the sounds of the cut itself: a rasping scrape, a ringing "sing" (a narrow resonance
//   that climbs the faster the disc is drawn over the surface), a low growl chopped at the tooth rate, and the crackle of sparks.
// Plays through the shared output in src/audio.ts (volume slider, limiter); every level change is ramped.
//
// Levels: set by ear against the other synthesised loops (src/slideSound.ts) and not yet measured offline: if this is touched, render
// the graph and check it against the −23 LUFS mix target in CLAUDE.md.
import { audio } from './audio';

const NOISE_S = 3;
/** Level at full slider volume, full revs and full contact. */
const MIX = 0.2;
/** Seconds from stopped to full revs (a steady spool), and revs per second lost coasting down. */
const SPOOL_S = 1.1;
const COAST = 0.65;
/** Revs the disc settles at under load, and how fast the load pulls them down (revs per second). */
const LOADED = 0.87;
const SAG = 1.8;
/** Gain smoothing (s) for the contact sounds: they land at once and trail off a little. */
const IN = 0.02;
const OUT = 0.07;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function noise(ctx: AudioContext, kind: 'white' | 'pink' | 'brown'): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * NOISE_S);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'white') d[i] = w;
    else if (kind === 'brown') {
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
  fadeEnds(ctx, d);
  return buf;
}

/** Sparse clicks, each a few milliseconds of decaying noise: sparks ticking off the disc, about as many a second as are drawn. */
function crackle(ctx: AudioContext): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * NOISE_S);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const rate = 150 / ctx.sampleRate;
  let click = 0, amp = 0;
  for (let i = 0; i < len; i++) {
    if (Math.random() < rate) {
      click = Math.floor(ctx.sampleRate * (0.002 + Math.random() * 0.004));
      amp = 0.35 + Math.random() * 0.65;
    }
    if (click > 0) {
      d[i] = (Math.random() * 2 - 1) * amp * (click / (ctx.sampleRate * 0.006));
      click--;
    }
  }
  fadeEnds(ctx, d);
  return buf;
}

/** Crossfade the ends so the loop has no click. */
function fadeEnds(ctx: AudioContext, d: Float32Array) {
  const len = d.length;
  const fade = Math.floor(ctx.sampleRate * 0.05);
  for (let i = 0; i < fade; i++) {
    const a = i / fade;
    d[i] = d[i] * a + d[len - fade + i] * (1 - a);
  }
}

interface Nodes {
  out: GainNode;
  hum: OscillatorNode;
  hum2: OscillatorNode;
  humGain: GainNode;
  whine: OscillatorNode;
  whineGain: GainNode;
  airBand: BiquadFilterNode;
  airGain: GainNode;
  scrapeBand: BiquadFilterNode;
  scrapeGain: GainNode;
  singBand: BiquadFilterNode;
  singGain: GainNode;
  growlGain: GainNode;
  growlLfo: OscillatorNode;
  crackGain: GainNode;
}

class GrinderSound {
  private n: Nodes | null = null;
  /** The disc's revs, 0 stopped to 1 full speed, and the dip as it bites (1 as it lands, dying away). */
  private revs = 0;
  private bite = 0;
  private contact = 0;
  private wasContact = false;
  private clock = 0;

  constructor() {
    audio.onStart((ctx, dest) => {
      const loop = (buf: AudioBuffer) => {
        const s = ctx.createBufferSource();
        s.buffer = buf;
        s.loop = true;
        s.start(ctx.currentTime + Math.random() * 0.1, Math.random() * NOISE_S);
        return s;
      };
      const osc = (type: OscillatorType) => {
        const o = ctx.createOscillator();
        o.type = type;
        o.start();
        return o;
      };
      const filter = (type: BiquadFilterType, f: number, q: number) => {
        const b = ctx.createBiquadFilter();
        b.type = type;
        b.frequency.value = f;
        b.Q.value = q;
        return b;
      };
      const gain = (v = 0) => {
        const g = ctx.createGain();
        g.gain.value = v;
        return g;
      };
      const out = gain();
      out.connect(dest);
      const white = noise(ctx, 'white'), pink = noise(ctx, 'pink'), brown = noise(ctx, 'brown');

      // The motor: a buzzing hum and its octave (a universal motor's commutator), a gear whine, the disc moving air.
      const hum = osc('sawtooth'), hum2 = osc('square');
      const humGain = gain();
      hum.connect(filter('lowpass', 650, 0.7)).connect(humGain);
      const h2 = gain(0.4);
      hum2.connect(filter('lowpass', 900, 0.7)).connect(h2).connect(humGain);
      humGain.connect(out);
      const whine = osc('triangle');
      const whineGain = gain();
      whine.connect(filter('bandpass', 1600, 3)).connect(whineGain).connect(out);
      const airBand = filter('bandpass', 2000, 0.7);
      const airGain = gain();
      loop(pink).connect(airBand).connect(airGain).connect(out);

      // The cut: a scrape, a ring, a growl chopped at the teeth and the sparks.
      const scrapeBand = filter('bandpass', 3400, 1.1);
      const scrapeGain = gain();
      loop(white).connect(filter('highpass', 1500, 0.7)).connect(scrapeBand).connect(scrapeGain).connect(out);
      const singBand = filter('bandpass', 1500, 14);
      const singGain = gain();
      loop(pink).connect(singBand).connect(singGain).connect(out);
      const growlAm = gain(0.55), growlLfo = osc('sine'), growlDepth = gain(0.45);
      growlLfo.connect(growlDepth).connect(growlAm.gain);
      const growlGain = gain();
      loop(brown).connect(filter('lowpass', 420, 0.8)).connect(growlAm).connect(growlGain).connect(out);
      const crackGain = gain();
      loop(crackle(ctx)).connect(filter('bandpass', 3200, 0.8)).connect(crackGain).connect(out);

      this.n = { out, hum, hum2, humGain, whine, whineGain, airBand, airGain, scrapeBand, scrapeGain, singBand, singGain, growlGain, growlLfo, crackGain };
    });
  }

  /** Every frame. `using`: the use button is held with the grinder in hand. `touching`: the disc is on something hard. `speed`: how fast
   *  (m/s) the contact point is drawn over the surface. */
  update(dt: number, using: boolean, touching: boolean, speed: number) {
    const ctx = audio.ctx, n = this.n;
    if (!ctx || !n) return;
    this.clock += dt;
    const t = this.clock;
    // The revs: a steady spool up, the load pulling them down, a slower coast when let go. Landing on something bites a dip in them.
    if (touching && !this.wasContact) this.bite = 1;
    this.wasContact = touching;
    this.bite *= Math.exp(-dt * 5);
    const target = !using ? 0 : touching ? LOADED : 1;
    this.revs += Math.max(-dt * (using ? SAG : COAST), Math.min(dt / SPOOL_S, target - this.revs));
    this.contact += ((using && touching ? 1 : 0) - this.contact) * Math.min(1, dt / (touching ? IN : OUT));
    const c = this.contact;
    const idle = this.revs < 0.004 && c < 0.004;
    const now = ctx.currentTime;
    if (idle) {
      if (n.out.gain.value > 0) n.out.gain.setTargetAtTime(0, now, 0.05);
      return;
    }
    // Under load the motor does not hold still: the revs stagger (faster and deeper the harder the disc is drawn across).
    const drawn = clamp01(speed / 3);
    const fight = c * (0.025 + 0.03 * drawn) * (Math.sin(t * 31) * Math.sin(t * 11.3 + 1) + 0.5 * Math.sin(t * 57));
    const r = Math.max(0, this.revs - 0.07 * this.bite * c + fight);
    const set = (p: AudioParam, v: number, tau = 0.03) => p.setTargetAtTime(v, now, tau);

    set(n.out.gain, MIX, 0.05);
    const hz = 80 + 135 * r;
    set(n.hum.frequency, hz);
    set(n.hum2.frequency, hz * 2.01);
    set(n.humGain.gain, 0.34 * Math.sqrt(r));
    set(n.whine.frequency, 650 + 1950 * r);
    set(n.whineGain.gain, 0.05 * r * r);
    set(n.airBand.frequency, 900 + 3200 * r);
    set(n.airGain.gain, 0.26 * r * r * (1 - 0.4 * c)); // (the cut covers it)

    // The cut. The ring climbs with how fast the disc is drawn, and wanders as it finds the material.
    const wander = Math.sin(t * 3.1) * Math.sin(t * 1.3 + 2);
    set(n.scrapeGain.gain, 0.5 * c * (0.55 + 0.45 * r), IN);
    set(n.scrapeBand.frequency, 2600 + 1400 * r + 600 * drawn);
    set(n.singBand.frequency, 1250 + 1150 * drawn + 380 * wander + 400 * r);
    set(n.singGain.gain, 0.9 * c * (0.35 + 0.65 * drawn) * (0.6 + 0.4 * Math.sin(t * 5.3 + 0.7)));
    set(n.growlLfo.frequency, 14 + 110 * r); // the teeth meeting the work
    set(n.growlGain.gain, 0.8 * c);
    set(n.crackGain.gain, 0.45 * c);
  }
}

export const grinderSound = new GrinderSound();
