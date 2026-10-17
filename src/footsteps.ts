// Footstep sounds: one short crunch per stride, played when an avatar plants a foot (src/players.ts,
// alongside the footprint). Remote players' steps are panned and fade with distance.
//
// public/audio/footsteps.mp3 is a sprite of single steps sliced from a recorded walk on a gravel trail
// (see public/credits.txt): SLOTS slots of SLOT seconds, each a step starting near the slot start.
// The sprite is levelled so a steady walk at ~2.4 steps/s measures −23 LUFS; GAIN pulls it well under
// the wind, since in game you take ~5 steps/s.
import { audio } from './audio';

const SRC = './audio/footsteps.mp3';
const SLOT = 0.4;
const SLOTS = 8;
/** Level at full slider volume, for the local player walking. Footsteps should be barely noticed. */
const GAIN = 0.2;
/** Steps are at full level within this distance (m) of the listener, then fall off as 1/d. */
const NEAR = 2.5;
/** Beyond this (m) a step is not played at all. */
const FAR = 30;
const WALK = 6;

class Footsteps {
  private buf: AudioBuffer | null = null;
  private data: Promise<ArrayBuffer> | null = null;
  private last = -1;
  private lx = 0;
  private lz = 0;
  private yaw = 0;

  constructor() {
    audio.onStart((ctx) => {
      this.data ??= fetch(SRC).then((r) => r.arrayBuffer());
      this.data
        .then((d) => ctx.decodeAudioData(d))
        .then((b) => (this.buf = b), (e) => console.warn('footsteps failed to load', e));
    });
  }

  /** Where the ears are. `yaw` is the camera yaw (three.js: forward = (−sin, −cos)). */
  listener(p: { x: number; z: number }, yaw: number) {
    this.lx = p.x;
    this.lz = p.z;
    this.yaw = yaw;
  }

  /** A foot planted at (x, z), moving at `speed` m/s. */
  step(x: number, z: number, speed: number) {
    const ctx = audio.ctx, buf = this.buf;
    if (!ctx || !buf || !audio.out || !audio.running) return;
    const dx = x - this.lx, dz = z - this.lz;
    const d = Math.hypot(dx, dz);
    if (d > FAR) return;
    // Faster is heavier, a bit; distance falls off as 1/d with a fade to nothing at FAR.
    const level = GAIN * Math.min(1.4, 0.6 + 0.4 * (speed / WALK)) * Math.min(1, NEAR / d) * Math.min(1, (FAR - d) / 5);

    // A random step, never the same one twice in a row, slightly varied in pitch and level.
    let i = Math.floor(Math.random() * (SLOTS - 1));
    if (i >= this.last) i++;
    this.last = i;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.92 + Math.random() * 0.16;
    const gain = ctx.createGain();
    gain.gain.value = level * (0.85 + Math.random() * 0.3);
    // Pan by which side of the listener it is on; steps under your own feet stay centred.
    const pan = ctx.createStereoPanner();
    const right = dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw);
    pan.pan.value = Math.max(-1, Math.min(1, right / Math.max(d, NEAR))) * 0.7;
    src.connect(gain).connect(pan).connect(audio.out);
    src.start(ctx.currentTime, i * SLOT, SLOT);
  }
}

export const footsteps = new Footsteps();
