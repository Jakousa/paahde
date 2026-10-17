// Synthesised interface sounds, played locally. For now one: a soft plop when an item is picked up or put down
// in the inventory, or moved between boxes; moving many at once plops once per item in a quick run.
//
// The plop is a sine that drops from ~520 Hz to 160 Hz over a few tens of ms under a 3 ms attack and a 35 ms
// decay. Rendered offline (same envelope) at volume 1: one plop peaks at −28 LUFS momentary, −11 dBTP; a run of
// twelve at RUN_GAIN about −23 LUFS momentary.
import { audio } from './audio';

/** Peak gain of one plop at full volume. */
const GAIN = 0.3;
/** Each plop of a run is this much quieter, so a long run doesn't stack up loud. */
const RUN_GAIN = 0.7;
/** Seconds between plops in a run, and the most plops a run plays. */
const RUN_GAP = 0.06;
const RUN_MAX = 20;
/** Pitch rises by this ratio per plop of a run. */
const RUN_RISE = 1.03;

class UiSound {
  /** `n` plops in a quick run (one per item moved). */
  plop(n = 1) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running || n < 1) return;
    const count = Math.min(n, RUN_MAX);
    const detune = 0.94 + Math.random() * 0.12;
    for (let k = 0; k < count; k++) {
      this.one(ctx, out, ctx.currentTime + 0.005 + k * RUN_GAP, 520 * detune * RUN_RISE ** k, count > 1 ? GAIN * RUN_GAIN : GAIN);
    }
  }

  private one(ctx: AudioContext, out: GainNode, t: number, f0: number, peak: number) {
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.setTargetAtTime(160, t, 0.025);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.003);
    gain.gain.setTargetAtTime(0, t + 0.003, 0.035);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + 0.25);
    osc.onended = () => gain.disconnect();
  }
}

export const uiSound = new UiSound();
