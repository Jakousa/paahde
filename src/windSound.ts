// Synthesised wind noise, driven by the wind at the listener (src/world/wind.ts). No samples: filtered
// noise in a small Web Audio graph whose levels and filter frequencies follow the local wind every frame.
//
// What you hear in real wind, and the layer that stands in for it:
//   - rumble: low-frequency pressure buffeting on the ears (brown noise, lowpass). Grows fast with speed.
//   - rush:   broadband turbulence, the "whoosh" (pink-ish noise, wide bandpass). Its centre rises with
//             speed, and it is louder and brighter in the ear facing the wind.
//   - howl:   aeolian tones (Strouhal shedding, f ≈ 0.2·U/d) off scrap and edges: narrow resonances that
//             only come up in strong wind and slide in pitch with the gusts.
//   - hiss:   saltating sand ticking against everything, high-passed noise that follows the transport
//             strength q and swells when a streamer passes over you.
// The regional wind and gust patches change over seconds; on top of that a fast turbulence term (a few
// incommensurate sines, so it never visibly repeats) makes the sound breathe.
// What reaches the ears is the apparent wind, the wind minus your own velocity: riding the bike into a
// calm still roars, and riding downwind with it goes quiet.
//
// Plays through the shared output in src/audio.ts (volume slider, limiter).
import { audio } from './audio';
import { uAt, ustarFrom10, wind, type WindSample } from './world/wind';
import { heightAt } from '../shared/terrain.ts';

const NOISE_S = 4;
/** Ear height above the sand (m). */
const EAR = 1.7;
/** Ear-level wind speed (m/s) that counts as "full" for the mix; a sandstorm (u10 ≈ 23) is past it. */
const U_FULL = 15;
/** The wind is averaged over a ring this wide (m) around the head, so 4 m terrain cells don't step. */
const RING = 4;
const RING_N = 6;
/** How much of the local wind (vs the regional one) you hear: < 1 so dune lees are quieter, not silent. */
const LOCAL = 0.6;
/** Friction velocity left underground (the base's bunker), as a fraction of the surface's: a storm overhead
 *  still roars down the skylight and the stairs, but through the muffle below. */
const BURIED = 0.45;
/** Underground everything goes through a lowpass at this cutoff (Hz): the wind is heard through the earth. */
const MUFFLE_HZ = 420;
/** Time constant (s) of the followed wind; about a second to settle. */
const TAU = 0.6;
/** Own speeds (m/s) over which moving through the air fades in: running adds little, sliding some, the
 *  bike the most. */
const OWN_FROM = 8;
const OWN_FULL = 22;
/** How much of our own speed counts at most, so riding into a calm is loud but not a sandstorm. */
const OWN = 0.75;
/** Wind level at full slider volume. */
const MIX = 0.7;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Smooth pseudo-noise in about [-1, 1]. */
const wobble = (t: number, k: number) =>
  (Math.sin(t * 1.13 + k) + Math.sin(t * 2.71 + 2.3 * k) * 0.6 + Math.sin(t * 5.37 + 4.1 * k) * 0.35) / 1.95;

function noiseBuffer(ctx: AudioContext, brown: boolean): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * NOISE_S);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    // Pink (Paul Kellet's economy filter) or brown (leaky integrated white) noise.
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else {
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
      }
    }
    // Crossfade the ends so the loop has no click.
    const fade = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const a = i / fade;
      d[i] = d[i] * a + d[len - fade + i] * (1 - a);
    }
  }
  return buf;
}

type Graph = {
  ctx: AudioContext;
  master: GainNode;
  muffle: BiquadFilterNode;
  rumble: GainNode;
  rumbleLp: BiquadFilterNode;
  rushL: GainNode;
  rushR: GainNode;
  rushBp: BiquadFilterNode;
  rushLp: BiquadFilterNode;
  howl: { bp: BiquadFilterNode; gain: GainNode; ratio: number }[];
  hiss: GainNode;
  hissHp: BiquadFilterNode;
};

export class WindSound {
  private g: Graph | null = null;
  private s: WindSample = { dx: 0, dz: 0, ustar: 0, q: 0, emit: 0 };
  /** Smoothed listener wind: shear velocity, transport and streamer weight. */
  private ustar = -1;
  private q = 0;
  private emit = 0;
  /** Slower-followed ear-level speed, so the gust term below can be the difference. */
  private uSlow = 0;
  private time = 0;

  constructor() {
    audio.onStart((ctx, out) => (this.g = this.build(ctx, out)));
  }

  private build(ctx: AudioContext, out: GainNode): Graph {
    const master = ctx.createGain();
    master.gain.value = 0;
    const muffle = ctx.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = 20000;
    muffle.Q.value = 0.5;
    master.connect(muffle).connect(out);
    const pink = noiseBuffer(ctx, false);
    const brown = noiseBuffer(ctx, true);
    // Each layer reads the loop from a different offset so they stay uncorrelated.
    const source = (buf: AudioBuffer, offset: number) => {
      const n = ctx.createBufferSource();
      n.buffer = buf;
      n.loop = true;
      n.start(0, offset);
      return n;
    };
    const filter = (type: BiquadFilterType, f: number, q: number) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const gain = () => {
      const g = ctx.createGain();
      g.gain.value = 0;
      return g;
    };

    const rumbleLp = filter('lowpass', 120, 0.5);
    const rumble = gain();
    source(brown, 0).connect(rumbleLp).connect(rumble).connect(master);

    // Rush: split the stereo noise into ears with their own gains, so we can lean it into the wind.
    const rushBp = filter('bandpass', 500, 0.6);
    const rushLp = filter('lowpass', 3000, 0.4);
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const rushL = gain(), rushR = gain();
    source(pink, 1.3).connect(rushBp).connect(rushLp).connect(split);
    split.connect(rushL, 0).connect(merge, 0, 0);
    split.connect(rushR, 1).connect(merge, 0, 1);
    merge.connect(master);

    // Two slightly inharmonic resonances, panned apart.
    const howl = [0, 1].map((i) => {
      const bp = filter('bandpass', 600, 28);
      const g = gain();
      const pan = ctx.createStereoPanner();
      pan.pan.value = i ? 0.5 : -0.5;
      source(pink, 2.1 + i * 0.9).connect(bp).connect(g).connect(pan).connect(master);
      return { bp, gain: g, ratio: i ? 1.47 : 1 };
    });

    const hissHp = filter('highpass', 3500, 0.7);
    const hiss = gain();
    source(pink, 3.2).connect(hissHp).connect(hiss).connect(master);

    master.gain.setTargetAtTime(MIX, ctx.currentTime, 1.5); // fade in rather than pop on the first click
    return { ctx, master, muffle, rumble, rumbleLp, rushL, rushR, rushBp, rushLp, howl, hiss, hissHp };
  }

  /** Follow the wind at the listener. `yaw` is the camera yaw (three.js: forward = (−sin, −cos)); `vel` is
   *  the listener's own velocity (m/s), on foot or on the bike. */
  update(dt: number, listener: { x: number; y: number; z: number }, yaw: number, vel: { vx: number; vy: number; vz: number }) {
    const g = this.g;
    if (!g || g.ctx.state !== 'running') return;
    this.time += dt;
    const t = this.time;

    // Average over the head and a ring around it, then lean towards the regional wind.
    const s = wind.sample(listener.x, listener.z, this.s);
    let us = s.ustar, q = s.q, emit = s.emit;
    for (let i = 0; i < RING_N; i++) {
      const a = (i / RING_N) * Math.PI * 2;
      wind.sample(listener.x + RING * Math.cos(a), listener.z + RING * Math.sin(a), s);
      us += s.ustar;
      q += s.q;
      emit += s.emit;
    }
    const usR = ustarFrom10(wind.u10);
    const qR = wind.storm * 4;
    us = LOCAL * (us / (RING_N + 1)) + (1 - LOCAL) * usR;
    q = LOCAL * (q / (RING_N + 1)) + (1 - LOCAL) * qR;
    // Down in the bunker the wind is a faint draught from the skylight and the stairs.
    const buried = listener.y < heightAt(listener.x, listener.z) - 0.5;
    if (buried) {
      us *= BURIED;
      q = 0;
    }
    emit /= RING_N + 1;
    if (this.ustar < 0) this.ustar = us;
    const k = 1 - Math.exp(-dt / TAU);
    this.ustar += (us - this.ustar) * k;
    this.q += (q - this.q) * k;
    this.emit += (emit - this.emit) * k;

    // Ear-level speed. A light wind comes in puffs with near-calm lulls between them; a strong wind
    // blows steadily, with only gentle turbulence on top.
    const u0 = uAt(this.ustar, EAR);
    const steady = smooth(0.25, 0.85, u0 / U_FULL);
    const puff = clamp01(0.5 + 0.8 * wobble(t * 0.4, 7));
    const lull = 1 - 0.95 * (1 - steady) * (1 - puff);
    const turb = 0.18 - 0.1 * steady;
    const u = u0 * lull * (1 + turb * wobble(t * 0.7, 0) + 0.04 * wobble(t * 2.3, 5));
    this.uSlow += (u - this.uSlow) * (1 - Math.exp(-dt / 4));
    const gust = clamp01((u - this.uSlow) / Math.max(2, this.uSlow * 0.5)); // rising edge of a gust

    // Apparent wind: the air's velocity minus ours. Our part fades in with speed, so walking about
    // or running doesn't sound like a breeze but the bike (and a long fall) does.
    const own = Math.hypot(vel.vx, vel.vy, vel.vz);
    const ownK = OWN * smooth(OWN_FROM, OWN_FULL, own);
    const ax = u * s.dx - vel.vx * ownK, az = u * s.dz - vel.vz * ownK, ay = -vel.vy * ownK;
    const uA = Math.hypot(ax, ay, az);
    const x = clamp01(uA / U_FULL);

    // Where the apparent wind comes from, in the listener's frame: +1 right/front.
    const uH = Math.hypot(ax, az);
    const fromX = uH > 1e-3 ? -ax / uH : -s.dx, fromZ = uH > 1e-3 ? -az / uH : -s.dz;
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const right = fromX * cy - fromZ * sy;
    const front = -fromX * sy - fromZ * cy;

    const now = g.ctx.currentTime;
    const set = (p: AudioParam, v: number, tau = 0.3) => p.setTargetAtTime(v, now, tau);
    set(g.muffle.frequency, buried ? MUFFLE_HZ : 20000, 0.4);

    // A faint floor of moving air even in a calm, so the desert is never dead silent.
    set(g.rumble.gain, 0.03 + 0.55 * x ** 1.4 * (1 + 0.4 * gust));
    set(g.rumbleLp.frequency, 70 + 150 * x);

    const rush = 0.02 + 0.4 * x ** 1.6 * (1 + 0.35 * gust);
    // Facing into the wind is louder and brighter; the windward ear gets more than the lee one.
    const face = 0.85 + 0.15 * front;
    set(g.rushL.gain, rush * face * (1 - 0.3 * right));
    set(g.rushR.gain, rush * face * (1 + 0.3 * right));
    set(g.rushBp.frequency, 220 + 750 * x ** 1.3 + 300 * gust);
    set(g.rushLp.frequency, 1300 + 2700 * x * (0.8 + 0.2 * front));

    // Strouhal: f = 0.2 · U / d. With d ≈ 2–3 cm of scrap edge, ~8–30 Hz per m/s; keep it musical.
    const howlAmt = smooth(0.45, 0.95, x);
    for (const [i, h] of g.howl.entries()) {
      set(h.bp.frequency, (180 + 30 * uA) * h.ratio, 0.5);
      set(h.gain.gain, howlAmt * 0.45 * clamp01(0.55 + 0.45 * wobble(t * 0.37, 2 + i * 3)) ** 2, 0.5);
    }

    // Sand hiss follows transport, and swells when a streamer sweeps through (emit).
    const sand = clamp01(this.q / 3);
    set(g.hiss.gain, 0.07 * sand * (0.5 + 0.5 * this.emit) * (1 + 0.3 * gust));
    set(g.hissHp.frequency, 3000 + 2000 * sand);
  }
}
