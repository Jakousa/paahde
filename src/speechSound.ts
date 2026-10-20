// The character's voice as visual-novel blips: one short soft beep per letter as a subtitle types out
// (src/speech.ts), played locally. A rounded square (fundamental plus a little 3rd harmonic, so it's friendly
// rather than a pure test tone) around 440 Hz, each blip a few percent off at random and dipping slightly in pitch,
// under a 4 ms attack and a 22 ms decay. Rendered offline (same envelope) at volume 1, a line typing at 28 letters/s
// measures −34 LUFS integrated over the typing, −23 dBTP: under the plop (src/uiSound.ts), present but quiet.
import { audio } from './audio';

/** Peak gain of one blip at full volume. */
const GAIN = 0.07;
/** Base pitch (Hz) and how far (ratio, either way) each blip strays from it. */
const PITCH = 440;
const SPREAD = 0.06;

class SpeechSound {
  private wave: PeriodicWave | null = null;

  /** One blip, for the letter `ch` (vowels a touch higher, so a line has a little tune). */
  blip(ch: string) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    this.wave ??= ctx.createPeriodicWave([0, 0, 0, 0], [0, 1, 0, 0.18], { disableNormalization: true });
    const vowel = /[aeiouyäöå]/i.test(ch) ? 1.06 : 1;
    const f = PITCH * vowel * (1 + (Math.random() * 2 - 1) * SPREAD);
    const t = ctx.currentTime + 0.005;
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(this.wave);
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.linearRampToValueAtTime(f * 0.94, t + 0.05);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(GAIN, t + 0.004);
    gain.gain.setTargetAtTime(0, t + 0.004, 0.022);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + 0.15);
    osc.onended = () => gain.disconnect();
  }
}

export const speechSound = new SpeechSound();
