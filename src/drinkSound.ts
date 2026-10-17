// Gulps while you drink from the canteen, and a sigh of relief after when you were overheating (heat over
// SIGH_ABOVE when the sip goes down). Played locally; only you hear them.
//
// Both are cut from SilverIllusionist's "Liquid Drink" (CC BY 4.0, public/credits.txt), mono: drink.mp3 is the
// three gulps (1.07 s, fits in DRINK_MS), peak-limited to −1.6 dBTP (−29 LUFS); sigh.mp3 the sigh after
// (1.02 s), levelled to −23 LUFS. GAIN keeps them about as loud as your own footsteps.
import { audio } from './audio';

/** Heat (0..HEAT_MAX) above which a finished sip gets the sigh. */
export const SIGH_ABOVE = 70;

const DRINK = { src: './audio/drink.mp3', gain: 0.7 };
const SIGH = { src: './audio/sigh.mp3', gain: 0.4 };

class DrinkSound {
  private bufs = new Map<string, AudioBuffer>();
  /** The gulps playing now, cut short if you stop drinking. */
  private gulps: { src: AudioBufferSourceNode; gain: GainNode } | null = null;

  constructor() {
    audio.onStart((ctx) => {
      for (const { src } of [DRINK, SIGH]) {
        fetch(src)
          .then((r) => r.arrayBuffer())
          .then((d) => ctx.decodeAudioData(d))
          .then((b) => this.bufs.set(src, b), (e) => console.warn('drink sound failed to load', src, e));
      }
    });
  }

  /** You started a sip. */
  drink() {
    this.stop();
    this.gulps = this.play(DRINK);
  }

  /** You let go before the sip went down: cut the gulps. */
  stop() {
    const ctx = audio.ctx;
    if (!ctx || !this.gulps) return;
    const { src, gain } = this.gulps;
    gain.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
    src.stop(ctx.currentTime + 0.2);
    this.gulps = null;
  }

  /** The sip went down; `heat` is the meter before it. */
  done(heat: number) {
    this.gulps = null;
    if (heat > SIGH_ABOVE) this.play(SIGH);
  }

  private play(s: { src: string; gain: number }) {
    const ctx = audio.ctx, buf = this.bufs.get(s.src);
    if (!ctx || !buf || !audio.out || !audio.running) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.96 + Math.random() * 0.08;
    const gain = ctx.createGain();
    gain.gain.value = s.gain;
    src.connect(gain).connect(audio.out);
    src.start();
    return { src, gain };
  }
}

export const drinkSound = new DrinkSound();
