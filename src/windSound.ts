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
//
// Browsers only start audio after a user gesture, so the context is created on the first click or key.
import { uAt, wind, type WindSample } from './world/wind';

const NOISE_S = 4;
/** Ear height above the sand (m). */
const EAR = 1.7;
/** Ear-level wind speed (m/s) that counts as "full" for the mix; ~a sandstorm (u10 ≈ 18). */
const U_FULL = 15;

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

const VOLUME_KEY = 'dadajam.volume';
const css = `
#volume { position: fixed; top: 8px; right: 8px; display: flex; align-items: center; gap: 6px; padding: 3px 8px;
  font: 12px monospace; color: #ccc; background: rgba(20, 10, 5, 0.35); border-radius: 4px; }
#volume input { width: 90px; accent-color: #ffd9a0; }
`;

export class WindSound {
  /** Overall volume, 0..1, set by the slider in the top-right corner (remembered per browser). */
  volume = 0.4;
  private g: Graph | null = null;
  private s: WindSample = { dx: 0, dz: 0, ustar: 0, q: 0, emit: 0 };
  /** Slowly-followed local wind, so the gust term below can be the difference. */
  private uSlow = 0;
  private time = 0;

  constructor() {
    try {
      const v = parseFloat(localStorage.getItem(VOLUME_KEY) ?? '');
      if (v >= 0 && v <= 1) this.volume = v;
    } catch {}
    this.slider();
    const start = () => {
      if (!this.g) this.g = this.build();
      if (this.g.ctx.state === 'suspended') void this.g.ctx.resume();
    };
    addEventListener('pointerdown', start);
    addEventListener('keydown', start);
    document.addEventListener('visibilitychange', () => {
      if (!this.g) return;
      if (document.hidden) void this.g.ctx.suspend();
      else void this.g.ctx.resume();
    });
  }

  private slider() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const label = document.createElement('label');
    label.id = 'volume';
    label.textContent = 'volume';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '1';
    input.step = '0.01';
    input.value = String(this.volume);
    input.addEventListener('input', () => {
      this.volume = parseFloat(input.value);
      try {
        localStorage.setItem(VOLUME_KEY, input.value);
      } catch {}
    });
    // Drop focus afterwards, or the arrow keys would nudge the slider while walking.
    input.addEventListener('change', () => input.blur());
    input.addEventListener('pointerup', () => input.blur());
    label.appendChild(input);
    document.body.appendChild(label);
  }

  private build(): Graph {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0;
    // Gentle limiter: the layers stack up in a storm gust and should squash, not clip.
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -10;
    limit.knee.value = 6;
    limit.ratio.value = 8;
    master.connect(limit).connect(ctx.destination);
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

    master.gain.setTargetAtTime(1, ctx.currentTime, 1.5); // fade in rather than pop on the first click
    return { ctx, master, rumble, rumbleLp, rushL, rushR, rushBp, rushLp, howl, hiss, hissHp };
  }

  /** Follow the wind at the listener. `yaw` is the camera yaw (three.js: forward = (−sin, −cos)). */
  update(dt: number, listener: { x: number; z: number }, yaw: number) {
    const g = this.g;
    if (!g || g.ctx.state !== 'running') return;
    const s = wind.sample(listener.x, listener.z, this.s);
    this.time += dt;
    const t = this.time;

    // Ear-level speed with fast turbulence on top (intensity ~25% in a gusty surface layer).
    const u0 = uAt(s.ustar, EAR);
    const u = u0 * (1 + 0.22 * wobble(t * 0.9, 0) + 0.08 * wobble(t * 3.1, 5));
    this.uSlow += (u - this.uSlow) * Math.min(1, dt * 0.5);
    const gust = clamp01((u - this.uSlow) / Math.max(2, this.uSlow * 0.5)); // rising edge of a gust
    const x = clamp01(u / U_FULL);

    // Where the wind comes from, in the listener's frame: +1 right/front.
    const fromX = -s.dx, fromZ = -s.dz;
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const right = fromX * cy - fromZ * sy;
    const front = -fromX * sy - fromZ * cy;

    const now = g.ctx.currentTime;
    const set = (p: AudioParam, v: number, tau = 0.12) => p.setTargetAtTime(v, now, tau);

    set(g.master.gain, this.volume);
    // A faint floor of moving air even in a calm, so the desert is never dead silent.
    set(g.rumble.gain, 0.02 + 0.6 * x ** 1.6 * (1 + 0.6 * gust));
    set(g.rumbleLp.frequency, 70 + 170 * x);

    const rush = 0.015 + 0.55 * x ** 2 * (1 + 0.5 * gust);
    // Facing into the wind is louder and brighter; the windward ear gets more than the lee one.
    const face = 0.8 + 0.2 * front;
    set(g.rushL.gain, rush * face * (1 - 0.35 * right));
    set(g.rushR.gain, rush * face * (1 + 0.35 * right));
    set(g.rushBp.frequency, 260 + 1100 * x ** 1.3 + 500 * gust);
    set(g.rushLp.frequency, 1800 + 4500 * x * (0.75 + 0.25 * front));

    // Strouhal: f = 0.2 · U / d. With d ≈ 2–3 cm of scrap edge, ~8–30 Hz per m/s; keep it musical.
    const howlAmt = smooth(0.45, 0.95, x);
    for (const [i, h] of g.howl.entries()) {
      set(h.bp.frequency, (180 + 34 * u) * h.ratio, 0.3);
      set(h.gain.gain, howlAmt * 0.7 * clamp01(0.55 + 0.45 * wobble(t * 0.37, 2 + i * 3)) ** 2, 0.25);
    }

    // Sand hiss follows transport, and swells when a streamer sweeps through (emit).
    const sand = clamp01(s.q / 3);
    set(g.hiss.gain, 0.12 * sand * (0.4 + 0.6 * s.emit) * (1 + 0.4 * gust));
    set(g.hissHp.frequency, 3000 + 2500 * sand);
  }
}
