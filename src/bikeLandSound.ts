// The thump of a bike coming down after a long jump (src/bike.ts, with the landing dust cloud). Every rider's
// is heard: panned, and fading with distance.
//
// public/audio/bike-land.mp3 is a car crash with glass (see public/credits.txt): the hit, then crunching, clatter
// and breaking glass. Trimmed to 2.15 s, the tail after 0.35 s turned down (to −6 dB by 0.8 s), mono, levelled to
// −23 LUFS (true peak −5 dBTP). How rough the landing was decides how much of it is heard: a soft one is just
// the hit, muffled; the rougher, the brighter and the longer the tail is let ring, and only a really hard crash
// (well past the sim's hard landing) lets the clatter and glass play out.
import { audio } from './audio';
import { BIKE_HARD_LANDING } from '../shared/sim.ts';

const SRC = './audio/bike-land.mp3';
/** Level at full slider volume, for a hard landing under your own wheels. */
const GAIN = 0.6;
/** Impact (m/s into the sand) at which it is the softest thump; at BIKE_HARD_LANDING it is the full hit. */
const SOFT = 3;
/** Past BIKE_HARD_LANDING by this much (m/s), the whole crash plays out. */
const CRASH = 6;
/** The hit is let through whole for this long (s), then the tail fades. */
const HOLD = 0.2;
/** Full level within this distance (m) of the listener, then falling off as 1/d. */
const NEAR = 4;
/** Beyond this (m) it is not played at all. */
const FAR = 60;

class BikeLandSound {
  private buf: AudioBuffer | null = null;
  private lx = 0;
  private lz = 0;
  private yaw = 0;

  constructor() {
    audio.onStart((ctx) => {
      fetch(SRC)
        .then((r) => r.arrayBuffer())
        .then((d) => ctx.decodeAudioData(d))
        .then((b) => (this.buf = b), (e) => console.warn('bike landing sound failed to load', e));
    });
  }

  /** Where the ears are. `yaw` is the camera yaw (three.js: forward = (−sin, −cos)). */
  listener(p: { x: number; z: number }, yaw: number) {
    this.lx = p.x;
    this.lz = p.z;
    this.yaw = yaw;
  }

  /** A bike landed at (x, z), hitting the sand at `impact` m/s (across the slope, as shared/sim.ts stepBike). */
  play(x: number, z: number, impact: number) {
    const ctx = audio.ctx, buf = this.buf;
    if (!ctx || !buf || !audio.out || !audio.running) return;
    const dx = x - this.lx, dz = z - this.lz;
    const d = Math.hypot(dx, dz);
    if (d > FAR) return;
    const rough = Math.min(1, Math.max(0, (impact - SOFT) / (BIKE_HARD_LANDING - SOFT)));
    const crash = Math.min(1, Math.max(0, (impact - BIKE_HARD_LANDING) / CRASH));
    const level = GAIN * (0.4 + 0.6 * rough) * Math.min(1, NEAR / d) * Math.min(1, (FAR - d) / 10);
    const now = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (1.06 - 0.12 * rough) * (0.95 + Math.random() * 0.1);
    // Soft: a dull thud in the sand (600 Hz), opening up to the whole crash.
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 600 * Math.pow(35, rough);
    // The tail rings longer the rougher it was; under a crash the clatter and glass are faded out before they come.
    const tail = 0.06 + 0.3 * rough * rough + 4 * crash * crash;
    const gain = ctx.createGain();
    const g = level * (0.9 + Math.random() * 0.2);
    gain.gain.setValueAtTime(g, now);
    gain.gain.setValueAtTime(g, now + HOLD);
    gain.gain.setTargetAtTime(0, now + HOLD, tail);
    const pan = ctx.createStereoPanner();
    const right = dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw);
    pan.pan.value = Math.max(-1, Math.min(1, right / Math.max(d, NEAR))) * 0.7;
    src.connect(tone).connect(gain).connect(pan).connect(audio.out);
    src.start(now);
    src.stop(now + Math.min(buf.duration, HOLD + tail * 7));
  }
}

export const bikeLandSound = new BikeLandSound();
