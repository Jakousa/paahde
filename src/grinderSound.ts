// The grinder (src/grinder.ts), synthesised: no samples. It is a motor and a disc, and two things happen to the sound.
//   Spin: hold the use button and the motor spools up from nothing (a hum that rises with the revs, a gear whine over it, the
//   disc moving air), a second or so to full speed; let go and it coasts down slower than it came up.
//   Contact: the disc touches something hard and the load pulls the revs down a little and keeps them unsteady (the motor fights the
//   material, a bite as it lands, the teeth catching now and then). On top come the sounds of the cut itself, sharp and ragged: a
//   chopped scrape, a ringing "sing" (a narrow resonance that climbs the faster the disc is drawn over the surface), a growl chopped at
//   the tooth rate and the crackle of sparks; and under them an even bed of grinding and a held buzz that do not stutter.
// Plays through the shared output in src/audio.ts (volume slider, limiter); every level change is ramped.
//
// One `Voice` is the whole synth. Yours plays dry; every other player with a grinder running gets a voice of their own, placed at them (a
// panner that follows them) and driven by what their hands say (shared/protocol.ts Hands: 4 running, 5 cutting): the same spool, sag and
// snags, with a made-up draw speed since only whether the disc touches is sent.
//
// Levels: set by ear against the other synthesised loops (src/slideSound.ts) and not yet measured offline: if this is touched, render
// the graph and check it against the −23 LUFS mix target in CLAUDE.md.
import { audio } from './audio';
import { EYE_HEIGHT } from '../shared/dig.ts';

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
const IN = 0.012;
const OUT = 0.05;
/** Other players' grinders: level (at REMOTE_REF m, falling off with distance), heard to REMOTE_HEAR m, and the speed (m/s) their disc is
 *  taken to be drawn at while it touches. At most REMOTE_MAX at once (the nearest). */
const REMOTE_MIX = 0.3;
const REMOTE_REF = 2;
const REMOTE_HEAR = 40;
const REMOTE_SPEED = 1.6;
const REMOTE_MAX = 4;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

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

/** Clicks, each one to three milliseconds of hard noise: sparks ticking off the disc. They come in bursts and gaps (the rate jumps
 *  about every 30-120 ms) so the crackle is ragged, not a steady rain. */
function crackle(ctx: AudioContext): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * NOISE_S);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let click = 0, amp = 0, size = 1, hold = 0, rate = 0;
  for (let i = 0; i < len; i++) {
    if (--hold <= 0) {
      hold = Math.floor(ctx.sampleRate * (0.03 + Math.random() * 0.09));
      rate = (Math.random() < 0.35 ? 1100 : Math.random() < 0.5 ? 220 : 40) / ctx.sampleRate;
    }
    if (Math.random() < rate) {
      size = Math.floor(ctx.sampleRate * (0.001 + Math.random() * 0.002));
      click = size;
      amp = 0.3 + Math.random() * 0.7;
    }
    if (click > 0) {
      d[i] = (Math.random() * 2 - 1) * amp * (click / size) ** 0.5;
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

type Buffers = { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer; spark: AudioBuffer };
let cached: { ctx: AudioContext; bufs: Buffers } | null = null;
/** The loops every voice plays, made once per context (each voice reads them from its own offset, so they are not in step). */
function buffers(ctx: AudioContext): Buffers {
  if (cached?.ctx !== ctx) cached = { ctx, bufs: { white: noise(ctx, 'white'), pink: noise(ctx, 'pink'), brown: noise(ctx, 'brown'), spark: crackle(ctx) } };
  return cached.bufs;
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
  bedBand: BiquadFilterNode;
  bedGain: GainNode;
  buzz: OscillatorNode;
  buzzGain: GainNode;
}

class Voice {
  private n: Nodes;
  private ctx: AudioContext;
  private sources: (OscillatorNode | AudioBufferSourceNode)[] = [];
  /** The disc's revs, 0 stopped to 1 full speed, and the dip as it bites (1 as it lands, dying away). */
  private revs = 0;
  private bite = 0;
  private contact = 0;
  private wasContact = false;
  private clock = Math.random() * 100; // (voices are not in step)
  /** A catch of the teeth (1 as it happens, dying away) and the time to the next. */
  private snag = 0;
  private nextSnag = 0;
  /** The disc's revs as they are this instant, 0 stopped to 1 full speed, sag and stagger included: the spin of the disc in the hands
   *  follows it, so what is seen is what is heard. */
  spin = 0;
  /** How hard the grinder shudders in the hands, -1..1 (it follows the stagger of the revs); 0 when not cutting. */
  judder = 0;
  /** Level at full revs and contact. */
  mix: number;

  constructor(ctx: AudioContext, dest: AudioNode, mix: number) {
    this.ctx = ctx;
    this.mix = mix;
    const loop = (buf: AudioBuffer) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.start(ctx.currentTime + Math.random() * 0.1, Math.random() * NOISE_S);
      this.sources.push(s);
      return s;
    };
    const osc = (type: OscillatorType) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.start();
      this.sources.push(o);
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
    const { white, pink, brown, spark } = buffers(ctx);

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
    const scrapeBand = filter('bandpass', 4200, 2.4);
    const scrapeGain = gain();
    loop(white).connect(filter('highpass', 2400, 0.9)).connect(scrapeBand).connect(scrapeGain).connect(out);
    const singBand = filter('bandpass', 1500, 24);
    const singGain = gain();
    loop(pink).connect(singBand).connect(singGain).connect(out);
    const growlAm = gain(0.5), growlLfo = osc('square'), growlDepth = gain(0.5);
    growlLfo.connect(growlDepth).connect(growlAm.gain);
    const growlGain = gain();
    loop(brown).connect(filter('lowpass', 520, 1.2)).connect(growlAm).connect(growlGain).connect(out);
    const crackGain = gain();
    loop(spark).connect(filter('bandpass', 4800, 1.2)).connect(crackGain).connect(out);

    // The even layer under the ragged one: a steady bed of grinding (smooth noise, no chop) and a held buzz of the disc on the work.
    const bedBand = filter('bandpass', 2300, 0.8);
    const bedGain = gain();
    loop(pink).connect(bedBand).connect(bedGain).connect(out);
    const buzz = osc('sawtooth');
    const buzzGain = gain();
    buzz.connect(filter('bandpass', 900, 1.5)).connect(buzzGain).connect(out);

    this.n = { bedBand, bedGain, buzz, buzzGain, out, hum, hum2, humGain, whine, whineGain, airBand, airGain, scrapeBand, scrapeGain, singBand, singGain, growlGain, growlLfo, crackGain };
  }

  /** The disc has stopped turning and nothing is touching: nothing to hear (a remote voice is let go then). */
  get still() {
    return this.revs < 0.004 && this.contact < 0.004;
  }

  /** Every frame. `using`: the use button is held with the grinder in hand. `touching`: the disc is on something hard. `speed`: how fast
   *  (m/s) the contact point is drawn over the surface. */
  step(dt: number, using: boolean, touching: boolean, speed: number) {
    this.clock += dt;
    const t = this.clock;
    // The revs: a steady spool up, the load pulling them down, a slower coast when let go. Landing on something bites a dip in them.
    if (touching && !this.wasContact) this.bite = 1;
    this.wasContact = touching;
    this.bite *= Math.exp(-dt * 5);
    // Cutting is uneven: now and then the teeth catch and the revs drop for a moment, harder the harder it is drawn across.
    this.snag *= Math.exp(-dt * 14);
    this.nextSnag -= dt;
    if (using && touching && this.nextSnag <= 0) {
      this.nextSnag = 0.05 + Math.random() * 0.2;
      if (Math.random() < 0.7) this.snag = 0.4 + 0.6 * Math.random();
    }
    const target = !using ? 0 : touching ? LOADED : 1;
    this.revs += Math.max(-dt * (using ? SAG : COAST), Math.min(dt / SPOOL_S, target - this.revs));
    this.contact += ((using && touching ? 1 : 0) - this.contact) * Math.min(1, dt / (touching ? IN : OUT));
    const c = this.contact;
    // Under load the motor does not hold still: the revs stagger (faster and deeper the harder the disc is drawn across).
    const drawn = clamp01(speed / 3);
    const fight = c * (0.03 + 0.035 * drawn) * (Math.sin(t * 31) * Math.sin(t * 11.3 + 1) + 0.5 * Math.sin(t * 57) + 0.4 * Math.sin(t * 83 + 2));
    const r = Math.max(0, this.revs - 0.07 * this.bite * c - 0.06 * this.snag * c + fight);
    this.spin = r;
    this.judder = clamp(c * (fight / 0.05 + 0.8 * this.snag * Math.sin(t * 97)), -1, 1);

    const n = this.n;
    const now = this.ctx.currentTime;
    if (this.still) {
      if (n.out.gain.value > 0) n.out.gain.setTargetAtTime(0, now, 0.05);
      return;
    }
    const set = (p: AudioParam, v: number, tau = 0.03) => p.setTargetAtTime(v, now, tau);

    set(n.out.gain, this.mix, 0.05);
    const hz = 80 + 135 * r;
    set(n.hum.frequency, hz);
    set(n.hum2.frequency, hz * 2.01);
    set(n.humGain.gain, 0.34 * Math.sqrt(r));
    set(n.whine.frequency, 650 + 1950 * r);
    set(n.whineGain.gain, 0.05 * r * r);
    set(n.airBand.frequency, 900 + 3200 * r);
    set(n.airGain.gain, 0.26 * r * r * (1 - 0.5 * c)); // (the cut covers it)

    // The cut: sharp and ragged. The scrape is cut up by a fast irregular chop and flares on a snag; the ring climbs with how fast the
    // disc is drawn and wanders as it finds the material.
    const wander = Math.sin(t * 3.1) * Math.sin(t * 1.3 + 2);
    const chop = clamp01(0.62 + 0.38 * Math.sin(t * 47) * Math.sin(t * 19.3 + 1) + 0.25 * Math.sin(t * 131));
    set(n.scrapeGain.gain, 0.6 * c * (0.5 + 0.5 * r) * chop * (1 + 1.1 * this.snag), 0.012);
    set(n.scrapeBand.frequency, 3400 + 1500 * r + 700 * drawn + 1500 * this.snag, 0.015);
    set(n.singBand.frequency, 1250 + 1150 * drawn + 380 * wander + 400 * r + 500 * this.snag, 0.02);
    set(n.singGain.gain, 1.1 * c * (0.3 + 0.7 * drawn) * (0.45 + 0.55 * Math.sin(t * 7.9 + 0.7) * Math.sin(t * 2.3)) ** 2, 0.015);
    set(n.growlLfo.frequency, 14 + 110 * r + 40 * this.snag); // the teeth meeting the work
    set(n.growlGain.gain, 0.5 * c * (1 - 0.4 * this.snag));
    set(n.crackGain.gain, 0.7 * c * (1 + 0.8 * this.snag), 0.01);

    // The even layer: it only follows the contact and the revs, so it holds steady while the rest stutters over it.
    set(n.bedBand.frequency, 1700 + 1300 * r, 0.05);
    set(n.bedGain.gain, 0.5 * c * (0.4 + 0.6 * r), 0.03);
    set(n.buzz.frequency, 150 + 260 * r);
    set(n.buzzGain.gain, 0.16 * c * r, 0.03);
  }

  /** Let it go: faded out, its sources stopped and the graph taken apart. */
  dispose() {
    const now = this.ctx.currentTime;
    this.n.out.gain.setTargetAtTime(0, now, 0.03);
    for (const s of this.sources) s.stop(now + 0.25);
    setTimeout(() => this.n.out.disconnect(), 400);
  }
}

/** Another player's grinder: its voice, and the panner that puts it where they stand. */
interface Heard {
  voice: Voice;
  pan: PannerNode;
}

class GrinderSound {
  private own: Voice | null = null;
  private heard = new Map<number, Heard>();

  constructor() {
    audio.onStart((ctx, dest) => (this.own = new Voice(ctx, dest, MIX)));
  }

  /** The disc's revs as heard (0..1) and the shudder (-1..1): the disc and the hands in the viewmodel follow them. */
  get spin() {
    return this.own?.spin ?? 0;
  }
  get judder() {
    return this.own?.judder ?? 0;
  }

  /** Every frame, yours. `using`: the use button held with the grinder in hand; `touching`: the disc is on something hard; `speed`: how
   *  fast (m/s) the contact point is drawn over the surface. */
  update(dt: number, using: boolean, touching: boolean, speed: number) {
    this.own?.step(dt, using, touching, speed);
  }

  /** Every frame, the other players (interpolated; `grinding`: 0 not, 1 the disc runs, 2 it is cutting) and where we hear from: each one
   *  with a grinder going is heard from where they stand, and a voice is let go of once its disc has stopped. */
  remotes(dt: number, players: readonly { id: number; x: number; y: number; z: number; grinding: 0 | 1 | 2; down: unknown }[], ear: { x: number; y: number; z: number }) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const now = ctx.currentTime;
    const near = players
      .filter((p) => p.grinding && !p.down)
      .map((p) => ({ p, d: Math.hypot(p.x - ear.x, p.y - ear.y, p.z - ear.z) }))
      .filter((e) => e.d < REMOTE_HEAR)
      .sort((a, b) => a.d - b.d)
      .slice(0, REMOTE_MAX);
    const on = new Map(near.map((e) => [e.p.id, e.p]));
    for (const [id, p] of on) {
      let h = this.heard.get(id);
      if (!h) {
        const pan = ctx.createPanner();
        pan.panningModel = 'equalpower';
        pan.distanceModel = 'inverse';
        pan.refDistance = REMOTE_REF;
        pan.rolloffFactor = 1.3;
        pan.positionX.value = p.x;
        pan.positionY.value = p.y + EYE_HEIGHT - 0.4;
        pan.positionZ.value = p.z;
        pan.connect(out);
        this.heard.set(id, (h = { voice: new Voice(ctx, pan, REMOTE_MIX), pan }));
      }
      h.pan.positionX.setTargetAtTime(p.x, now, 0.05);
      h.pan.positionY.setTargetAtTime(p.y + EYE_HEIGHT - 0.4, now, 0.05);
      h.pan.positionZ.setTargetAtTime(p.z, now, 0.05);
      h.voice.step(dt, true, p.grinding === 2, REMOTE_SPEED);
    }
    for (const [id, h] of this.heard) {
      if (on.has(id)) continue;
      // Let go (or out of earshot): the disc coasts down, then the voice goes.
      h.voice.step(dt, false, false, 0);
      if (!h.voice.still) continue;
      h.voice.dispose();
      setTimeout(() => h.pan.disconnect(), 500);
      this.heard.delete(id);
    }
  }
}

export const grinderSound = new GrinderSound();
