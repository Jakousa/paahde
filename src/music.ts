// Situational music. For now one song: "Dune riding" plays once you have been riding the bike for a while,
// and fades out a few seconds after you stop or get off.
//
// public/audio/dune-riding.mp3 is 120 bpm in 4/4 (2 s a bar), 32 bars, trimmed to exactly 64 s (gapless
// LAME header) and levelled to −23 LUFS. Bars 1–4 are the fade-in, played once from the top; after that it
// loops from the end of bar 32 back to the start of bar 5. Plays through `audio.music` (music slider, then
// the volume slider and limiter).
import { audio } from './audio';

const SRC = './audio/dune-riding.mp3';
/** Level at full slider volumes: under the mix, the wind roars while riding. */
const GAIN = 0.5;
const BAR = 2;
const LOOP_START = 4 * BAR;
const LOOP_END = 32 * BAR;
/** Riding faster than this (m/s) counts as riding. */
const MOVING = 3;
/** Seconds of riding before the music starts. */
const START_AFTER = 5;
/** Seconds after you stop riding before it fades out, so a short stop doesn't cut it. */
const STOP_AFTER = 4;
/** Fade-out time constant (s); the source is dropped after FADE_OUT * 5. */
const FADE_OUT = 1;
/** Decoder delay (s) of an MP3 decoder that ignores the LAME header (576 encoder + 529 decoder samples). */
const MP3_DELAY = 1105 / 44100;

class Music {
  private buf: AudioBuffer | null = null;
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  /** Context time when a fading-out source is dropped; 0 while playing. */
  private dropAt = 0;
  private riding = 0;
  private idle = 0;

  constructor() {
    audio.onStart((ctx) => {
      fetch(SRC)
        .then((r) => r.arrayBuffer())
        .then((d) => ctx.decodeAudioData(d))
        .then((b) => (this.buf = b), (e) => console.warn('music failed to load', e));
    });
  }

  /** Every frame, with the local player's state. */
  update(dt: number, s: { riding: boolean; vx: number; vz: number }) {
    const ctx = audio.ctx;
    if (!ctx || !this.buf || !audio.music || !audio.running) return;
    if (s.riding && Math.hypot(s.vx, s.vz) > MOVING) {
      this.riding += dt;
      this.idle = 0;
    } else {
      this.riding = 0;
      this.idle += dt;
    }
    if (this.src && this.dropAt && ctx.currentTime >= this.dropAt) {
      this.src.stop();
      this.src.disconnect();
      this.gain!.disconnect();
      this.src = this.gain = null;
      this.dropAt = 0;
    }
    if (!this.src) {
      if (this.riding >= START_AFTER) this.start(ctx, audio.music, this.buf);
    } else if (this.dropAt && this.riding > 0) {
      // Back on the move before it faded away: bring it back up where it is.
      this.gain!.gain.cancelScheduledValues(ctx.currentTime);
      this.gain!.gain.setTargetAtTime(GAIN, ctx.currentTime, 0.3);
      this.dropAt = 0;
    } else if (!this.dropAt && this.idle >= STOP_AFTER) {
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
    gain.gain.setTargetAtTime(GAIN, ctx.currentTime, 0.02);
    src.connect(gain).connect(out);
    src.start(ctx.currentTime, lead);
    this.src = src;
    this.gain = gain;
  }
}

export const music = new Music();
