// Contextual music. The game is in one music state at a time, the highest-priority one whose cue has held
// long enough; each state names a song (or none: silence). Changing state fades the old song out and starts
// the new one. Cues come from main.ts every frame; a state switches on after its cue has held for `enter`
// seconds and off after it has been gone for `leave`, so a short stop or a trip down the stairs doesn't cut
// the music.
//
// Songs (public/credits.txt), levelled to −23 LUFS, with gapless LAME headers:
// - "Dune riding" (dune-riding.mp3), on the bike: 120 bpm in 4/4 (2 s a bar), 32 bars, trimmed to exactly
//   64 s. Bars 1–4 are the fade-in, played once from the top; after that it loops from the end of bar 32
//   back to the start of bar 5.
// - "Desert ambience" (desert-ambience.mp3), outdoors when nothing else is going on: exactly 112 s, loops
//   whole, and picks up where it left off when you come back to it.
// - "Epic battle" (epic-battle.mp3, by Veikko Suhonen), against a boss or a guardian hunting close by: 150 bpm in
//   4/4 (1.6 s a bar), 25 bars (1764000 samples, exactly 40 s). Bar 1 is the intro and bars 2–9 part A, played once
//   from the top; then part B, bars 10–25, loops for as long as the fight lasts.
// - "Cinematic drum loop Ares 127" (combat-drums.mp3, harrisonlace, CC0), while something is after you: 127 bpm,
//   16 bars (1333418 samples), loops whole, from the top each fight.
// - "Death" (death.mp3, by Veikko Suhonen), once when you die: 9.56 s (421707 samples), the last 1.2 s faded
//   out. It cuts whatever was playing (quick fade) and plays to its end, through the respawn; then the music
//   picks up again from a clean slate (no combat carried over from before you died).
//
// Everything plays through `audio.music` (music slider, then the volume slider and limiter).
import { audio } from './audio';

export type MusicState = 'dead' | 'heatstroke' | 'epic' | 'combat' | 'sandstorm' | 'riding' | 'indoors' | 'peaceful';
/** What is going on, from main.ts. `peaceful` is not a cue: it is when none of these is. `dead` only starts the
 *  death music (on the way in); the state lasts as long as the song. */
export type MusicCues = Partial<Record<Exclude<MusicState, 'peaceful'>, boolean>>;

interface Song {
  src: string;
  /** Level at full slider volumes. */
  gain: number;
  /** Loop region (s); `loopEnd` is the file's length. */
  loopStart: number;
  loopEnd: number;
  /** Come back to it where it was stopped, not from the top. */
  resume: boolean;
  /** Played once, not looped. */
  once?: boolean;
  /** Fade-out time constant (s) of whatever it takes over from, when not FADE_OUT. */
  cut?: number;
}

const BAR = 2;
const DUNE_RIDING: Song = { src: './audio/dune-riding.mp3', gain: 0.5, loopStart: 4 * BAR, loopEnd: 32 * BAR, resume: false };
const DESERT_AMBIENCE: Song = { src: './audio/desert-ambience.mp3', gain: 0.45, loopStart: 0, loopEnd: 112, resume: true };
const COMBAT_DRUMS: Song = { src: './audio/combat-drums.mp3', gain: 0.55, loopStart: 0, loopEnd: 1333418 / 44100, resume: false };
const EPIC_BAR = 1.6;
const EPIC_BATTLE: Song = { src: './audio/epic-battle.mp3', gain: 0.55, loopStart: 9 * EPIC_BAR, loopEnd: 1764000 / 44100, resume: false };
const DEATH: Song = { src: './audio/death.mp3', gain: 0.55, loopStart: 0, loopEnd: 421707 / 44100, resume: false, once: true, cut: 0.15 };

/** Highest priority first. */
const STATES: { state: MusicState; song: Song | null; enter: number; leave: number }[] = [
  { state: 'dead', song: DEATH, enter: 0, leave: 0 },
  // Not cued: the breathing (src/breathing.ts) plays over whatever music is on.
  { state: 'heatstroke', song: null, enter: 0, leave: 3 },
  { state: 'epic', song: EPIC_BATTLE, enter: 0, leave: 8 },
  { state: 'combat', song: COMBAT_DRUMS, enter: 0, leave: 8 },
  { state: 'sandstorm', song: null, enter: 1, leave: 4 },
  // Under the mix: the wind roars while riding.
  { state: 'riding', song: DUNE_RIDING, enter: 5, leave: 4 },
  { state: 'indoors', song: null, enter: 1.5, leave: 3 },
  { state: 'peaceful', song: DESERT_AMBIENCE, enter: 6, leave: 0 },
];

/** Fade-out time constant (s); the source is dropped after FADE_OUT * 5. */
const FADE_OUT = 1;
/** Fade-in time constant (s) when resuming mid-song; from the top a song starts at once (it has its own intro). */
const FADE_IN = 1;
/** Decoder delay (s) of an MP3 decoder that ignores the LAME header (576 encoder + 529 decoder samples). */
const MP3_DELAY = 1105 / 44100;

interface Voice {
  song: Song;
  src: AudioBufferSourceNode;
  gain: GainNode;
  /** Context time it started and the song position (s) it started at. */
  t0: number;
  pos0: number;
  /** Context time a fading-out voice is dropped; 0 while playing. */
  dropAt: number;
}

class Music {
  /** The state playing now. */
  state: MusicState | null = null;
  private bufs = new Map<Song, AudioBuffer>();
  private voices: Voice[] = [];
  /** Per state (same order as STATES): whether it is on, and how long its cue has held / been gone. */
  private on = STATES.map(() => false);
  private held = STATES.map(() => 0);
  private gone = STATES.map(() => 0);
  /** Where a `resume` song was stopped (s). */
  private resumeAt = new Map<Song, number>();
  /** Context time the death music ends; the `dead` cue last frame. */
  private deathUntil = 0;
  private wasDead = false;

  constructor() {
    audio.onStart((ctx) => {
      for (const song of new Set(STATES.map((s) => s.song))) {
        if (!song) continue;
        fetch(song.src)
          .then((r) => r.arrayBuffer())
          .then((d) => ctx.decodeAudioData(d))
          .then((b) => this.bufs.set(song, b), (e) => console.warn('music failed to load', song.src, e));
      }
    });
  }

  /** Every frame, with what is going on. */
  update(dt: number, cues: MusicCues) {
    const ctx = audio.ctx;
    if (!ctx || !audio.music || !audio.running) return;
    if (cues.dead && !this.wasDead) {
      this.deathUntil = ctx.currentTime + DEATH.loopEnd;
      // Dying resets the context: no state holds over (combat's `leave` would bring the drums back after).
      this.on.fill(false);
      this.held.fill(0);
      this.gone.fill(0);
    }
    this.wasDead = !!cues.dead;
    // The dead aren't in a fight, whatever the walkers still think.
    if (cues.dead) cues = { ...cues, epic: false, combat: false };
    const quiet = !STATES.some((s) => s.state !== 'peaceful' && s.state !== 'dead' && cues[s.state as keyof MusicCues]);
    let top = -1;
    STATES.forEach((s, i) => {
      const cue = s.state === 'peaceful' ? quiet : s.state === 'dead' ? ctx.currentTime < this.deathUntil : !!cues[s.state as keyof MusicCues];
      if (cue) {
        this.held[i] += dt;
        this.gone[i] = 0;
      } else {
        this.held[i] = 0;
        this.gone[i] += dt;
      }
      if (!this.on[i] && cue && this.held[i] >= s.enter) this.on[i] = true;
      else if (this.on[i] && !cue && this.gone[i] >= s.leave) this.on[i] = false;
      if (this.on[i] && top < 0) top = i;
    });
    this.state = top < 0 ? null : STATES[top].state;
    const want = top < 0 ? null : STATES[top].song;

    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.dropAt && ctx.currentTime >= v.dropAt) {
        v.src.stop();
        v.src.disconnect();
        v.gain.disconnect();
        this.voices.splice(i, 1);
      } else if (v.song !== want && !v.dropAt) {
        if (v.song.resume) this.resumeAt.set(v.song, this.position(ctx, v));
        v.gain.gain.cancelScheduledValues(ctx.currentTime);
        const tau = want?.cut ?? FADE_OUT;
        v.gain.gain.setTargetAtTime(0, ctx.currentTime, tau);
        v.dropAt = ctx.currentTime + tau * 5;
      }
    }
    if (!want) return;
    // A one-shot that is fading (or over) isn't brought back: it starts again from the top.
    const v = this.voices.find((v) => v.song === want && !(want.once && v.dropAt));
    if (v?.dropAt) {
      // Back before it faded away: bring it back up where it is.
      v.gain.gain.cancelScheduledValues(ctx.currentTime);
      v.gain.gain.setTargetAtTime(want.gain, ctx.currentTime, 0.3);
      v.dropAt = 0;
    } else if (!v) {
      const buf = this.bufs.get(want);
      if (buf) this.start(ctx, audio.music, want, buf);
    }
  }

  /** Where in the song a voice is now (s). */
  private position(ctx: AudioContext, v: Voice) {
    const p = v.pos0 + ctx.currentTime - v.t0;
    const { loopStart: a, loopEnd: b } = v.song;
    return p < b ? p : a + ((p - a) % (b - a));
  }

  private start(ctx: AudioContext, out: GainNode, song: Song, buf: AudioBuffer) {
    // The file is exactly loopEnd long; anything over that is decoder delay the browser didn't trim.
    const lead = buf.duration > song.loopEnd + 0.001 ? Math.min(buf.duration - song.loopEnd, MP3_DELAY) : 0;
    const pos = song.resume ? (this.resumeAt.get(song) ?? 0) : 0;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = !song.once;
    src.loopStart = lead + song.loopStart;
    src.loopEnd = lead + song.loopEnd;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(song.gain, ctx.currentTime, pos > 0 ? FADE_IN : 0.02);
    src.connect(gain).connect(out);
    src.start(ctx.currentTime, lead + pos);
    this.voices.push({ song, src, gain, t0: ctx.currentTime, pos0: pos, dropAt: 0 });
  }
}

export const music = new Music();
