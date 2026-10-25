// The sand vortex's roar (shared/vortex.ts; drawn by src/post.ts, felt by src/vortex.ts): synthesised, no samples. From
// a kilometre or two off a faint murmur under the wind; closer, a deep, violent roar that swells by the metre, until
// at its foot it's a freight train of pressure, howling and grit.
//
//   - sub:   the pressure of it, brown noise under 60 Hz you feel more than hear.
//   - roar:  the body, brown and pink noise through low resonances (~110–200 Hz and an octave up) whose centre climbs as
//            you close in.
//   - howl:  two narrow resonances wailing and sliding over it, only once you're near.
//   - grit:  sand and debris blasting past, high-passed noise, only at its foot.
// Everything shakes with gusts (incommensurate sines, so it never visibly repeats) that get more violent the closer you
// are, comes through the air as a lowpass that opens up as you near, and leans to the ear it's on.
//
// Loudness: in dB, falling with distance^FALL, from 0 at its core to LEVEL_FAR at HEARD m. Measured (this graph rendered in
// headless Chrome's OfflineAudioContext at the default volume 0.4, ffmpeg ebur128): at its foot −18 LUFS, true peak
// −5.7 dBTP (an event, over the −23 mix); at the edge of its pull (450 m) −27 LUFS; 1.1 km off −47; 1.5 km off −61.
// In a bunker or shelter it's heard through the earth (lowpass, quieter). Plays through the shared output (src/audio.ts).
import { audio } from './audio';
import { indoors } from '../shared/shelters.ts';
import { CORE_R, vortexCentre, vortexEnvelope, type Vortex } from '../shared/vortex.ts';

/** Heard from this far (m); its level there (dB under the foot's); how the level falls with distance (dB go with
 *  distance^FALL: > 1 keeps it loud near and drops it away far off). */
const HEARD = 2000;
const LEVEL_FAR = -60;
const FALL = 1.3;
/** Level at full slider volume, at its foot. */
const MIX = 1.9;
/** Underground: lowpass (Hz) and level. */
const MUFFLE_HZ = 260;
const MUFFLE_GAIN = 0.5;
/** How far it leans to one ear. */
const PAN = 0.6;

const NOISE_S = 4;

/** Smooth pseudo-noise in about [-1, 1]. */
const wobble = (t: number, k: number) =>
  (Math.sin(t * 1.13 + k) + Math.sin(t * 2.71 + 2.3 * k) * 0.6 + Math.sin(t * 5.37 + 4.1 * k) * 0.35) / 1.95;

function noise(ctx: BaseAudioContext, brown: boolean): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * NOISE_S);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
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
  const fade = Math.floor(ctx.sampleRate * 0.05);
  for (let i = 0; i < fade; i++) {
    const a = i / fade;
    d[i] = d[i] * a + d[len - fade + i] * (1 - a);
  }
  return buf;
}

/** The roar's graph into `out`; `set` drives it: closeness `k` 0..1 (1 at its foot), `pan` −1..1 (left..right), under
 *  ground or not, at time `t` (s). */
export function vortexVoice(ctx: BaseAudioContext, out: AudioNode) {
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
  const brown = noise(ctx, true), pink = noise(ctx, false);
  const source = (buf: AudioBuffer, offset: number) => {
    const n = ctx.createBufferSource();
    n.buffer = buf;
    n.loop = true;
    n.start(0, offset);
    return n;
  };
  const master = gain();
  const air = filter('lowpass', 300, 0.5);
  const pan = ctx.createStereoPanner();
  const muffle = filter('lowpass', 20000, 0.5);
  master.connect(air).connect(pan).connect(muffle).connect(out);

  const sub = gain();
  source(brown, 0).connect(filter('lowpass', 60, 0.7)).connect(sub).connect(master);
  const roarBp = filter('bandpass', 130, 0.8);
  const roar = gain();
  source(brown, 1.1).connect(roarBp).connect(roar).connect(master);
  const roar2Bp = filter('bandpass', 260, 1.2);
  const roar2 = gain();
  source(pink, 2.3).connect(roar2Bp).connect(roar2).connect(master);
  const howl = [170, 255].map((f, i) => {
    const bp = filter('bandpass', f, 11);
    const g = gain();
    source(pink, 0.7 + i * 1.7).connect(bp).connect(g).connect(master);
    return { bp, g, f };
  });
  const grit = gain();
  source(pink, 3.1).connect(filter('highpass', 700, 0.5)).connect(filter('lowpass', 3500, 0.5)).connect(grit).connect(master);

  const to = (p: AudioParam, v: number, t: number, tau: number) => p.setTargetAtTime(v, t, tau);
  return {
    set(k: number, side: number, under: boolean, t: number) {
      const now = ctx.currentTime;
      const level = k > 0 ? MIX * Math.pow(10, (LEVEL_FAR * Math.pow(1 - k, FALL)) / 20) : 0;
      to(master.gain, level * (under ? MUFFLE_GAIN : 1), now, 0.15);
      to(air.frequency, 220 + 4200 * k * k * k, now, 0.2);
      to(pan.pan, side * PAN * (0.4 + 0.6 * k), now, 0.2);
      to(muffle.frequency, under ? MUFFLE_HZ : 20000, now, 0.3);
      // Gusts: slow heaves and fast slams, more violent closer in.
      const v = 0.15 + 0.3 * k;
      const g = Math.max(0.3, 1 + v * (wobble(t * 0.9, 1) * 0.7 + wobble(t * 3.7, 2) * 0.35 + wobble(t * 9.3, 3) * 0.12));
      to(sub.gain, 1.1 * g, now, 0.05);
      to(roar.gain, 0.9 * g, now, 0.05);
      to(roar2.gain, 0.6 * g * (0.3 + 0.7 * k), now, 0.05);
      to(roarBp.frequency, 110 + 90 * k + 25 * wobble(t * 1.7, 4), now, 0.1);
      to(roar2Bp.frequency, 220 + 160 * k + 40 * wobble(t * 2.3, 5), now, 0.1);
      for (const [i, h] of howl.entries()) {
        to(h.g.gain, 0.25 * k * k * Math.max(0, 0.6 + wobble(t * 0.7, 6 + i)) * g, now, 0.08);
        to(h.bp.frequency, h.f * (1 + 0.3 * k) * (1 + 0.12 * wobble(t * 1.3, 8 + i)), now, 0.1);
      }
      to(grit.gain, 0.3 * Math.pow(k, 4) * g, now, 0.05);
    },
  };
}

export class VortexSound {
  private voice: ReturnType<typeof vortexVoice> | null = null;
  private c = { x: 0, z: 0 };
  private time = 0;

  constructor() {
    audio.onStart((ctx, out) => (this.voice = vortexVoice(ctx, out)));
  }

  /** Per frame: the vortices, server time `now` (ms), the camera and the way it looks (yaw: forward is (−sin, −cos)). */
  update(dt: number, vortices: readonly Vortex[], now: number, cam: { x: number; y: number; z: number }, yaw: number) {
    if (!this.voice) return;
    this.time += dt;
    let k = 0, side = 0;
    for (const v of vortices) {
      const e = vortexEnvelope(v, now);
      if (e <= 0) continue;
      vortexCentre(v, now, this.c);
      const dx = this.c.x - cam.x, dz = this.c.z - cam.z, d = Math.hypot(dx, dz);
      const kv = e * (1 - Math.min(1, Math.max(0, (d - CORE_R) / (HEARD - CORE_R))));
      if (kv <= k) continue;
      k = kv;
      // Right ear (cos yaw, −sin yaw).
      side = d > 1 ? (dx * Math.cos(yaw) - dz * Math.sin(yaw)) / d : 0;
    }
    this.voice.set(k, side, indoors(cam.x, cam.y, cam.z), this.time);
  }
}
