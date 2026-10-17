// Gulps while you drink from the canteen, a sigh of relief after when you were overheating (heat over
// SIGH_ABOVE when the sip goes down), and the pour while you refill it at the pump. Other players' gulps and pours
// play at them (src/acoustics.ts) when their snapshot's hands say they started (shared/protocol.ts Hands); the
// sigh is yours alone.
//
// Both are cut from SilverIllusionist's "Liquid Drink" (CC BY 4.0, public/credits.txt), mono: drink.mp3 is the
// three gulps (1.07 s, fits in DRINK_MS), peak-limited to −1.6 dBTP (−29 LUFS); sigh.mp3 the sigh after
// (1.02 s), levelled to −23 LUFS. fill.mp3 is the first 1.75 s of Lastered's "Bottle Filling" (CC BY 4.0), the
// pour with its resonance rising as the bottle fills; mono, high-passed at 250 Hz (the recording's hum), faded
// out over its last 0.3 s, −25.6 LUFS, −2.2 dBTP. The gains keep them about as loud as your own footsteps.
import { FILL_MS } from '../shared/water.ts';
import { audio } from './audio';
import { placed, type P } from './acoustics';

/** Heat (0..HEAT_MAX) above which a finished sip gets the sigh. */
export const SIGH_ABOVE = 50;

const DRINK = { src: './audio/drink.mp3', gain: 0.7 };
const SIGH = { src: './audio/sigh.mp3', gain: 0.4 };
const FILL = { src: './audio/fill.mp3', gain: 0.5 };
/** Other players' sounds: level at REMOTE_REF (m), out of earshot past REMOTE_HEAR (m). */
const REMOTE_REF = 1.5;
const REMOTE_HEAR = 30;

/** The pour speeds up by this much over FILL_MS, so it rises in pitch as the bottle fills. */
const FILL_RISE = 0.12;

class DrinkSound {
  private bufs = new Map<string, AudioBuffer>();
  /** The gulps playing now, cut short if you stop drinking. */
  private gulps: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  /** Per other player: what their hands were doing last frame, and the sound they're making. */
  private others = new Map<number, { act: 0 | 1 | 2; voice: { src: AudioBufferSourceNode; gain: GainNode } | null }>();

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

  /** Every frame, with the other players (interpolated) and where the camera is. */
  remotes(players: { id: number; x: number; y: number; z: number; drinking: boolean; filling: boolean }[], ear: P) {
    const ctx = audio.ctx;
    const seen = new Set<number>();
    for (const p of players) {
      seen.add(p.id);
      const act = p.drinking ? 1 : p.filling ? 2 : 0;
      let o = this.others.get(p.id);
      if (!o) this.others.set(p.id, (o = { act: 0, voice: null }));
      if (act === o.act) continue;
      // Stopped (done or let go): a sip's gulps are over by then, a pour's tail is cut short.
      if (o.voice && ctx) this.cut(ctx, o.voice);
      o.voice = null;
      o.act = act;
      if (act) o.voice = this.playAt(act === 1 ? DRINK : FILL, act === 1, { x: p.x, y: p.y + 1.4, z: p.z }, ear);
    }
    for (const [id, o] of this.others) {
      if (seen.has(id)) continue;
      if (o.voice && ctx) this.cut(ctx, o.voice);
      this.others.delete(id);
    }
  }

  /** You started refilling at the pump. */
  fill() {
    this.stop();
    this.gulps = this.play(FILL, false);
    const ctx = audio.ctx;
    if (ctx && this.gulps) this.rise(ctx, this.gulps.src, ctx.currentTime);
  }

  /** The refill finished: let the pour's tail play out. */
  filled() {
    this.gulps = null;
  }

  /** You let go before the sip went down, or walked off the pump: cut the gulps or the pour. */
  stop() {
    const ctx = audio.ctx;
    if (!ctx || !this.gulps) return;
    this.cut(ctx, this.gulps);
    this.gulps = null;
  }

  private cut(ctx: AudioContext, { src, gain }: { src: AudioBufferSourceNode; gain: GainNode }) {
    gain.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
    src.stop(ctx.currentTime + 0.2);
  }

  /** The sip went down; `heat` is the meter before it. */
  done(heat: number) {
    this.gulps = null;
    if (heat > SIGH_ABOVE) this.play(SIGH);
  }

  private play(s: { src: string; gain: number }, vary = true) {
    const ctx = audio.ctx;
    if (!ctx || !audio.out || !audio.running) return null;
    return this.start(ctx, s, vary, audio.out, s.gain, ctx.currentTime);
  }

  /** Another player's sound, at `at`, heard from `ear`; a pour rises like yours. */
  private playAt(s: { src: string; gain: number }, vary: boolean, at: P, ear: P) {
    const ctx = audio.ctx;
    const out = ctx && this.bufs.has(s.src) ? placed(at, ear, s.gain, REMOTE_REF, REMOTE_HEAR) : null;
    if (!ctx || !out) return null;
    const v = this.start(ctx, s, vary, out.input, 1, out.t);
    if (v && s === FILL) this.rise(ctx, v.src, out.t);
    return v;
  }

  private start(ctx: AudioContext, s: { src: string }, vary: boolean, out: AudioNode, level: number, t: number) {
    const buf = this.bufs.get(s.src);
    if (!buf) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = vary ? 0.96 + Math.random() * 0.08 : 1;
    const gain = ctx.createGain();
    gain.gain.value = level;
    src.connect(gain).connect(out);
    src.start(t);
    return { src, gain };
  }

  /** Speed the pour up over FILL_MS from `t`. */
  private rise(ctx: AudioContext, src: AudioBufferSourceNode, t: number) {
    const rate = src.playbackRate;
    rate.setValueAtTime(rate.value, t);
    rate.linearRampToValueAtTime(rate.value + FILL_RISE, t + FILL_MS / 1000);
  }
}

export const drinkSound = new DrinkSound();
