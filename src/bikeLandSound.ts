// The thump of a bike coming down after a long jump (src/bike.ts, with the landing dust cloud). Every rider's
// is heard: panned, and fading with distance.
//
// public/audio/bike-land.mp3: a single landing thump, to be levelled to about −23 LUFS (true peak ≤ −1 dBTP)
// and credited in public/credits.txt. Until the file is there the landing is silent.
import { audio } from './audio';

const SRC = './audio/bike-land.mp3';
/** Level at full slider volume, for the hardest landing under your own wheels. */
const GAIN = 0.6;
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

  /** A bike landed at (x, z); `strength` 0..1 is how hard (a long fall is heavier: louder and lower). */
  play(x: number, z: number, strength: number) {
    const ctx = audio.ctx, buf = this.buf;
    if (!ctx || !buf || !audio.out || !audio.running) return;
    const dx = x - this.lx, dz = z - this.lz;
    const d = Math.hypot(dx, dz);
    if (d > FAR) return;
    const level = GAIN * (0.45 + 0.55 * strength) * Math.min(1, NEAR / d) * Math.min(1, (FAR - d) / 10);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (1.08 - 0.16 * strength) * (0.95 + Math.random() * 0.1);
    const gain = ctx.createGain();
    gain.gain.value = level * (0.9 + Math.random() * 0.2);
    const pan = ctx.createStereoPanner();
    const right = dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw);
    pan.pan.value = Math.max(-1, Math.min(1, right / Math.max(d, NEAR))) * 0.7;
    src.connect(gain).connect(pan).connect(audio.out);
    src.start();
  }
}

export const bikeLandSound = new BikeLandSound();
