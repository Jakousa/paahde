// The thump of a bike coming down after a long jump (src/bike.ts, with the landing dust cloud). Every rider's
// is heard: panned, and fading with distance.
//
// public/audio/bike-crash.mp3 is mixed for the game from CC0 sounds: a heavy hit, then rumble and debris dying
// away over ~2 s. Mono, levelled to −23 LUFS (true peak −6 dBTP). How rough the landing was decides how much
// of it is heard: most landings are just the hit, quiet and muffled (a thud in the sand), a little fuller the
// rougher; only near the sim's hard landing does it open up into the crash, loud and bright, and only a really
// hard one (well past it) lets the debris play out.
import { audio } from './audio';
import { BIKE_HARD_LANDING } from '../shared/sim.ts';

const SRC = './audio/bike-crash.mp3';
/** Level at full slider volume, for a hard landing under your own wheels. */
const GAIN = 0.45;
/** Impact (m/s into the sand) at which it is the softest thud; up to BIKE_HARD_LANDING it stays a muffled thud. */
const SOFT = 4;
/** The crash comes in from this fraction of BIKE_HARD_LANDING, whole at it. */
const HARD_FROM = 0.8;
/** Past BIKE_HARD_LANDING by this much (m/s), the whole crash plays out. */
const CRASH = 14;
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
    const hard = Math.min(1, Math.max(0, (impact / BIKE_HARD_LANDING - HARD_FROM) / (1 - HARD_FROM)));
    const crash = Math.min(1, Math.max(0, (impact - BIKE_HARD_LANDING) / CRASH));
    const level = GAIN * (0.15 + 0.2 * rough + 0.65 * hard) * Math.min(1, NEAR / d) * Math.min(1, (FAR - d) / 10);
    const now = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (1.06 - 0.12 * rough) * (0.95 + Math.random() * 0.1);
    // A thud in the sand (350 Hz, up to 1.2 kHz the rougher), opening up to the whole crash only when it's hard.
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 350 * Math.pow(3.5, rough) * Math.pow(17, hard);
    // The tail rings longer the harder it was; under a crash the debris is faded out before it comes.
    const tail = 0.05 + 0.12 * rough * rough + 0.25 * hard + 4 * crash * crash;
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
