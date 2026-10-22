// Synthesized acoustic personality and mechanical feedback for companion robots (src/world/npcs.ts).
// Generates soft expressive chirps, tactical alerts, worklight relay clicks, and celebration melodies.
// Levelled according to AGENTS.md audio guidelines (modest peak gains, smooth ramps, no clipping).
import { audio } from './audio';

const CHIRP_GAIN = 0.055;
const ALERT_GAIN = 0.07;
const CLICK_GAIN = 0.04;
const CELEBRATE_GAIN = 0.06;

class NpcSound {
  /** A friendly retro robotic double-chirp when acknowledging orders or talking over radio. */
  chirp() {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;

    const t = ctx.currentTime + 0.005;
    const notes = [580, 880];
    notes.forEach((freq, i) => {
      const start = t + i * 0.065;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);
      osc.frequency.linearRampToValueAtTime(freq * 1.08, start + 0.045);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(CHIRP_GAIN, start + 0.006);
      gain.gain.setTargetAtTime(0, start + 0.006, 0.025);

      osc.connect(gain).connect(out);
      osc.start(start);
      osc.stop(start + 0.08);
      osc.onended = () => gain.disconnect();
    });
  }

  /** A rapid dual-tone warning warble when detecting hostile threats or incoming sandstorms. */
  alert() {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;

    const t = ctx.currentTime + 0.005;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(680, t);
    osc.frequency.linearRampToValueAtTime(440, t + 0.08);
    osc.frequency.linearRampToValueAtTime(720, t + 0.16);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(ALERT_GAIN, t + 0.008);
    gain.gain.setTargetAtTime(0, t + 0.16, 0.04);

    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + 0.28);
    osc.onended = () => gain.disconnect();
  }

  /** A crisp mechanical relay click when toggling the worklight. */
  click() {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;

    const t = ctx.currentTime + 0.002;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1200, t);
    osc.frequency.exponentialRampToValueAtTime(140, t + 0.015);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(CLICK_GAIN, t + 0.002);
    gain.gain.setTargetAtTime(0, t + 0.002, 0.008);

    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + 0.035);
    osc.onended = () => gain.disconnect();
  }

  /** A joyous 4-note ascending robot arpeggio during victory spins or dances. */
  celebrate() {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;

    const t = ctx.currentTime + 0.005;
    const arpeggio = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
    arpeggio.forEach((freq, i) => {
      const start = t + i * 0.075;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(CELEBRATE_GAIN, start + 0.005);
      gain.gain.setTargetAtTime(0, start + 0.005, 0.035);

      osc.connect(gain).connect(out);
      osc.start(start);
      osc.stop(start + 0.12);
      osc.onended = () => gain.disconnect();
    });
  }
}

export const npcSound = new NpcSound();
