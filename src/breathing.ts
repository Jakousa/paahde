// Heavy breathing when heatstroke is close: from HEAT_HIGH (the meter's red zone) up, louder as the meter fills,
// fading out once you cool off below it again. While it plays the music goes quiet (the heatstroke state,
// src/music.ts).
//
// public/audio/breathing.mp3 is TomchikRec's "Breathing - Slow, Distraught, Tired" (CC BY 4.0, public/credits.txt),
// mono, trimmed to 56.72 s (gapless LAME header) with true peak −1 dBTP; the looped part measures −27 LUFS. It gets
// more laboured as it goes: the calmer first 32.85 s play once from the top, then it loops the heaviest stretch
// back to there (both ends fall in a silent gap between breaths). Plays through `audio.out` (volume slider, limiter).
import { audio } from './audio';
import { HEAT_HIGH, HEAT_MAX } from '../shared/water.ts';

const SRC = './audio/breathing.mp3';
const LOOP_START = 32.85;
const LOOP_END = 56.72;
/** Gain at HEAT_HIGH and at a full meter. */
const GAIN_LOW = 0.5;
const GAIN_FULL = 1;
/** It stops once the meter is this far back under HEAT_HIGH, so hovering at the line doesn't flap. */
const HYSTERESIS = 5;
/** Fade-out time constant (s); the source is dropped after FADE_OUT * 5. */
const FADE_OUT = 1.5;
/** Decoder delay (s) of an MP3 decoder that ignores the LAME header (576 encoder + 529 decoder samples). */
const MP3_DELAY = 1105 / 44100;

class Breathing {
  /** Breathing now (heatstroke is close). */
  on = false;
  private buf: AudioBuffer | null = null;
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  /** Context time a fading-out source is dropped; 0 while playing. */
  private dropAt = 0;

  constructor() {
    audio.onStart((ctx) => {
      fetch(SRC)
        .then((r) => r.arrayBuffer())
        .then((d) => ctx.decodeAudioData(d))
        .then((b) => (this.buf = b), (e) => console.warn('breathing failed to load', e));
    });
  }

  /** Every frame, with the heat meter (0..HEAT_MAX; 0 while dead). */
  update(heat: number) {
    this.on = this.on ? heat > HEAT_HIGH - HYSTERESIS : heat > HEAT_HIGH;
    const ctx = audio.ctx;
    if (!ctx || !this.buf || !audio.out || !audio.running) return;
    if (this.src && this.dropAt && ctx.currentTime >= this.dropAt) {
      this.src.stop();
      this.src.disconnect();
      this.gain!.disconnect();
      this.src = this.gain = null;
      this.dropAt = 0;
    }
    if (this.on) {
      const k = Math.min(1, Math.max(0, (heat - HEAT_HIGH) / (HEAT_MAX - HEAT_HIGH)));
      if (!this.src) this.start(ctx, audio.out, this.buf);
      this.dropAt = 0;
      this.gain!.gain.cancelScheduledValues(ctx.currentTime);
      this.gain!.gain.setTargetAtTime(GAIN_LOW + (GAIN_FULL - GAIN_LOW) * k, ctx.currentTime, 0.5);
    } else if (this.src && !this.dropAt) {
      this.gain!.gain.cancelScheduledValues(ctx.currentTime);
      this.gain!.gain.setTargetAtTime(0, ctx.currentTime, FADE_OUT);
      this.dropAt = ctx.currentTime + FADE_OUT * 5;
    }
  }

  private start(ctx: AudioContext, out: GainNode, buf: AudioBuffer) {
    // The file is exactly LOOP_END long; anything over that is decoder delay the browser didn't trim.
    const lead = buf.duration > LOOP_END + 0.001 ? Math.min(buf.duration - LOOP_END, MP3_DELAY) : 0;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = lead + LOOP_START;
    src.loopEnd = lead + LOOP_END;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(out);
    src.start(ctx.currentTime, lead);
    this.src = src;
    this.gain = gain;
  }
}

export const breathing = new Breathing();
