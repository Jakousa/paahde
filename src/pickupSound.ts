// A soft metal latch when you pick up a piece of scrap (played locally, as soon as you ask; only you hear it).
//
// public/audio/pickup.mp3 is the main hit of a latch recording (see public/credits.txt), trimmed to 1.26 s
// and levelled to −23 LUFS. GAIN keeps it quiet: about as loud as your own footsteps.
import { audio } from './audio';

const SRC = './audio/pickup.mp3';
/** Level at full slider volume. */
const GAIN = 0.2;

class PickupSound {
  private buf: AudioBuffer | null = null;

  constructor() {
    audio.onStart((ctx) => {
      fetch(SRC)
        .then((r) => r.arrayBuffer())
        .then((d) => ctx.decodeAudioData(d))
        .then((b) => (this.buf = b), (e) => console.warn('pickup sound failed to load', e));
    });
  }

  play() {
    const ctx = audio.ctx, buf = this.buf;
    if (!ctx || !buf || !audio.out || !audio.running) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.94 + Math.random() * 0.12;
    const gain = ctx.createGain();
    gain.gain.value = GAIN * (0.9 + Math.random() * 0.2);
    src.connect(gain).connect(audio.out);
    src.start();
  }
}

export const pickupSound = new PickupSound();
