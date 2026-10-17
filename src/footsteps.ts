// Footstep sounds: one short step per stride, played when an avatar plants a foot (src/players.ts,
// alongside the footprint). Remote players' steps are panned and fade with distance.
//
// Each surface is a sprite of single steps sliced from a recording (see public/credits.txt): `slots` slots
// of SLOT seconds, each a step starting near the slot start. Outside it is a walk on a gravel trail,
// levelled so a steady walk at ~2.4 steps/s measures −23 LUFS; inside the base it is footsteps on concrete,
// which only peak-normalise to about −30 LUFS, so their gain is higher to sound as loud. `gain` pulls both
// well under the wind, since in game you take ~5 steps/s.
import { audio } from './audio';

export type Surface = 'sand' | 'concrete';

const SLOT = 0.4;
/** Level at full slider volume, for the local player walking. Footsteps should be barely noticed. */
const SPRITES: Record<Surface, { src: string; slots: number; gain: number }> = {
  sand: { src: './audio/footsteps.mp3', slots: 8, gain: 0.2 },
  concrete: { src: './audio/footsteps-concrete.mp3', slots: 10, gain: 0.45 },
};
/** Steps are at full level within this distance (m) of the listener, then fall off as 1/d. */
const NEAR = 2.5;
/** Beyond this (m) a step is not played at all. */
const FAR = 30;
const WALK = 6;

class Footsteps {
  private bufs: Partial<Record<Surface, AudioBuffer>> = {};
  private data: Promise<[Surface, ArrayBuffer]>[] | null = null;
  private last = -1;
  private lx = 0;
  private lz = 0;
  private yaw = 0;

  constructor() {
    audio.onStart((ctx) => {
      this.data ??= (Object.keys(SPRITES) as Surface[]).map((s) =>
        fetch(SPRITES[s].src).then((r) => r.arrayBuffer()).then((d): [Surface, ArrayBuffer] => [s, d]));
      for (const p of this.data) {
        p.then(([s, d]) => ctx.decodeAudioData(d).then((b) => (this.bufs[s] = b)))
          .catch((e) => console.warn('footsteps failed to load', e));
      }
    });
  }

  /** Where the ears are. `yaw` is the camera yaw (three.js: forward = (−sin, −cos)). */
  listener(p: { x: number; z: number }, yaw: number) {
    this.lx = p.x;
    this.lz = p.z;
    this.yaw = yaw;
  }

  /** A foot planted at (x, z) on `surface`, moving at `speed` m/s. */
  step(x: number, z: number, speed: number, surface: Surface = 'sand') {
    const ctx = audio.ctx, buf = this.bufs[surface], sprite = SPRITES[surface];
    if (!ctx || !buf || !audio.out || !audio.running) return;
    const dx = x - this.lx, dz = z - this.lz;
    const d = Math.hypot(dx, dz);
    if (d > FAR) return;
    // Faster is heavier, a bit; distance falls off as 1/d with a fade to nothing at FAR.
    const level = sprite.gain * Math.min(1.4, 0.6 + 0.4 * (speed / WALK)) * Math.min(1, NEAR / d) * Math.min(1, (FAR - d) / 5);

    // A random step, never the same one twice in a row, slightly varied in pitch and level.
    let i = Math.floor(Math.random() * (sprite.slots - 1));
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
