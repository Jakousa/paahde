// Metal sounds while taking a machine apart (src/teardown/): a tink per click on a screw, clinks as fasteners come
// off, a clang as a cover drops, and a metal ring while you circle a big bolt round. Played locally; steps finished
// by other players at a shared site are heard too, a little quieter.
//
// public/audio/teardown-clang.mp3 is a sprite of four hits sliced from a clings-and-clangs recording (see
// public/credits.txt), one per SLOT seconds, each starting at its slot start: a small tink, a clink, a softer
// clink and a big clang. Each is levelled to about −23..−26 LUFS (true peak ≤ −1 dBTP).
// public/audio/teardown-bolt.mp3 is the first second of a hose being rung round a metal pipe, about −26 LUFS.
import { audio } from './audio';

const CLANG_SRC = './audio/teardown-clang.mp3';
const BOLT_SRC = './audio/teardown-bolt.mp3';
const SLOT = 0.6;

export type Hit = 'tink' | 'clink' | 'soft' | 'clang';
const HITS: Record<Hit, { slot: number; gain: number }> = {
  tink: { slot: 0, gain: 0.25 },
  clink: { slot: 1, gain: 0.35 },
  soft: { slot: 2, gain: 0.5 },
  clang: { slot: 3, gain: 0.4 },
};
/** Level of the bolt ring at full slider volume. */
const BOLT_GAIN = 0.35;
/** The ring fades out once the pointer has stopped circling for this long (s). */
const BOLT_IDLE = 0.12;

class TeardownSound {
  private clang: AudioBuffer | null = null;
  private bolt: AudioBuffer | null = null;
  private ring: { src: AudioBufferSourceNode; gain: GainNode; t0: number } | null = null;
  private idle: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    audio.onStart((ctx) => {
      const load = (src: string, set: (b: AudioBuffer) => void) =>
        fetch(src)
          .then((r) => r.arrayBuffer())
          .then((d) => ctx.decodeAudioData(d))
          .then(set, (e) => console.warn(`${src} failed to load`, e));
      load(CLANG_SRC, (b) => (this.clang = b));
      load(BOLT_SRC, (b) => (this.bolt = b));
    });
  }

  /** One metal hit; `level` scales it (remote players' steps are quieter). */
  hit(kind: Hit, level = 1) {
    const ctx = audio.ctx, buf = this.clang;
    if (!ctx || !buf || !audio.out || !audio.running) return;
    const h = HITS[kind];
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const gain = ctx.createGain();
    gain.gain.value = h.gain * level * (0.85 + Math.random() * 0.3);
    src.connect(gain).connect(audio.out);
    src.start(ctx.currentTime, h.slot * SLOT, SLOT);
  }

  /** The pointer is circling a bolt: keep the ring going (restarting it as it runs out), fading once it stops. */
  turn() {
    const ctx = audio.ctx, buf = this.bolt;
    if (!ctx || !buf || !audio.out || !audio.running) return;
    const now = ctx.currentTime;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), BOLT_IDLE * 1000);
    if (this.ring && now - this.ring.t0 < buf.duration - 0.25) return;
    this.stop();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.92 + Math.random() * 0.16;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(BOLT_GAIN, now, 0.01);
    src.connect(gain).connect(audio.out);
    src.start(now);
    const ring = { src, gain, t0: now };
    src.onended = () => {
      if (this.ring === ring) this.ring = null;
    };
    this.ring = ring;
  }

  /** Fade out the bolt ring. */
  stop() {
    clearTimeout(this.idle);
    const r = this.ring, ctx = audio.ctx;
    if (!r || !ctx) return;
    this.ring = null;
    r.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
    r.src.stop(ctx.currentTime + 0.2);
  }
}

export const teardownSound = new TeardownSound();
