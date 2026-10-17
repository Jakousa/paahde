// Synthesised interface sounds, played locally:
// - plop: an item picked up or put down in the inventory, or moved between boxes; moving many at once plops
//   once per item in a quick run. A sine that drops from ~520 Hz to 160 Hz over a few tens of ms under a 3 ms
//   attack and a 35 ms decay. Rendered offline (same envelope) at volume 1: one plop peaks at −32 LUFS momentary,
//   −14 dBTP; a run of twelve about −26.
// - full: no room for an item (bag full, doesn't fit). Two soft low bonks, the second a fourth down, each a
//   few odd harmonics (rounded triangle) with a 45 ms decay: −29 LUFS momentary, −16 dBTP; a bit over the plop.
import { audio } from './audio';

/** Peak gain of one plop at full volume. */
const GAIN = 0.2;
/** Peak gain of each bonk of the no-room sound. */
const FULL_GAIN = 0.18;
/** Each plop of a run is this much quieter, so a long run doesn't stack up loud. */
const RUN_GAIN = 0.7;
/** Seconds between plops in a run, and the most plops a run plays. */
const RUN_GAP = 0.06;
const RUN_MAX = 20;
/** Pitch rises by this ratio per plop of a run. */
const RUN_RISE = 1.03;

class UiSound {
  private wave: PeriodicWave | null = null;

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

  /** No room for it. */
  full() {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    this.wave ??= ctx.createPeriodicWave([0, 0, 0, 0, 0, 0], [0, 1, 0, 1 / 9, 0, 1 / 25], { disableNormalization: true });
    const t = ctx.currentTime + 0.005;
    this.bonk(ctx, out, t, 233);
    this.bonk(ctx, out, t + 0.11, 175);
  }

  private bonk(ctx: AudioContext, out: GainNode, t: number, f: number) {
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(this.wave!);
    osc.frequency.value = f;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(FULL_GAIN, t + 0.004);
    gain.gain.setTargetAtTime(0, t + 0.004, 0.045);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + 0.3);
    osc.onended = () => gain.disconnect();
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
