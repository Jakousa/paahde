// Gulps while you drink from the canteen, a sigh of relief after when you were overheating (heat over
// SIGH_ABOVE when the sip goes down), and the pour while you refill it at the pump. Played locally; only you hear them.
//
// Both are cut from SilverIllusionist's "Liquid Drink" (CC BY 4.0, public/credits.txt), mono: drink.mp3 is the
// three gulps (1.07 s, fits in DRINK_MS), peak-limited to −1.6 dBTP (−29 LUFS); sigh.mp3 the sigh after
// (1.02 s), levelled to −23 LUFS. fill.mp3 is the first 1.75 s of Lastered's "Bottle Filling" (CC BY 4.0), the
// pour with its resonance rising as the bottle fills; mono, high-passed at 250 Hz (the recording's hum), faded
// out over its last 0.3 s, −25.6 LUFS, −2.2 dBTP. The gains keep them about as loud as your own footsteps.
import { FILL_MS } from '../shared/water.ts';
import { audio } from './audio';

/** Heat (0..HEAT_MAX) above which a finished sip gets the sigh. */
export const SIGH_ABOVE = 50;

const DRINK = { src: './audio/drink.mp3', gain: 0.7 };
const SIGH = { src: './audio/sigh.mp3', gain: 0.4 };
const FILL = { src: './audio/fill.mp3', gain: 0.5 };
/** The pour speeds up by this much over FILL_MS, so it rises in pitch as the bottle fills. */
const FILL_RISE = 0.12;

class DrinkSound {
  private bufs = new Map<string, AudioBuffer>();
  /** The gulps playing now, cut short if you stop drinking. */
  private gulps: { src: AudioBufferSourceNode; gain: GainNode } | null = null;

  constructor() {
    audio.onStart((ctx) => {
      for (const { src } of [DRINK, SIGH, FILL]) {
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

  /** You started refilling at the pump. */
  fill() {
    this.stop();
    this.gulps = this.play(FILL, false);
    const ctx = audio.ctx;
    if (ctx && this.gulps) {
      const rate = this.gulps.src.playbackRate;
      rate.setValueAtTime(rate.value, ctx.currentTime);
      rate.linearRampToValueAtTime(rate.value + FILL_RISE, ctx.currentTime + FILL_MS / 1000);
    }
  }

  /** The refill finished: let the pour's tail play out. */
  filled() {
    this.gulps = null;
  }

  /** You let go before the sip went down, or walked off the pump: cut the gulps or the pour. */
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

  private play(s: { src: string; gain: number }, vary = true) {
    const ctx = audio.ctx, buf = this.bufs.get(s.src);
    if (!ctx || !buf || !audio.out || !audio.running) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = vary ? 0.96 + Math.random() * 0.08 : 1;
    const gain = ctx.createGain();
    gain.gain.value = s.gain;
    src.connect(gain).connect(audio.out);
    src.start();
    return { src, gain };
  }
}

export const drinkSound = new DrinkSound();
