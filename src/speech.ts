// The player character talking to themselves: a subtitle at the bottom of the screen when something happens that
// they'd have a word about (the lines, their conditions and how often: src/speechLines.ts; how to write them:
// docs/speech.md). One line at a time: hazards interrupt casual remarks, important discoveries wait briefly,
// and stale events are discarded (`tick` remarks are rechecked). Remarks said once are remembered on this browser (localStorage), those
// said once per world under the world's id.
// A line types out letter by letter, visual-novel style, a soft blip per letter (src/speechSound.ts), a breath
// after punctuation; the rest of the line is laid out hidden, so the box doesn't grow as it types.
import { LINES, type Line, type SpeechEvents, type SpeechState } from './speechLines';
import { speechSound } from './speechSound';

const KEY = 'dadajam.said';
/** This world's id (the page's `?w=`), for remarks said once per world. */
const WORLD = new URLSearchParams(location.search).get('w') ?? '';
/** Nothing said this long (s) after joining: let the world come in first. */
const QUIET_START = 4;
/** How often (s) `tick` lines are checked. */
const TICK = 0.5;
/** Letters typed per second, and the extra pause (s) after a comma and after the end of a sentence. */
const TYPE_RATE = 28;
const COMMA_PAUSE = 0.12;
const STOP_PAUSE = 0.25;
/** On screen for this long (s) once typed out: a base plus reading time, within limits. */
const showFor = (text: string) => Math.min(7, Math.max(2.5, 1.2 + text.length * 0.06));
/** Silence after a line (s), before the next. */
const GAP = 2;
const QUEUE_LIMIT = 4;
type Pending = { line: Line; expires: number; valid: () => boolean; remembered: boolean };

const css = `
#speech { position: fixed; left: 50%; bottom: 78px; transform: translateX(-50%); z-index: 7; max-width: min(640px, 80vw);
  padding: 3px 10px; font: 500 16px var(--mono); line-height: 1.35; text-align: center; color: #fff4e4;
  background: rgba(12, 6, 2, 0.45); border-radius: 4px; text-shadow: 0 1px 2px #000;
  pointer-events: none; opacity: 0; transition: opacity .3s; }
#speech.on { opacity: 1; }
#speech .rest { visibility: hidden; }
`;

export class Speech {
  private el = document.createElement('div');
  private shown = document.createElement('span');
  private rest = document.createElement('span');
  /** The line being typed, how many letters are out, and the time (s) until the next one. */
  private text = '';
  private typed = 0;
  private nextIn = 0;
  /** Remarks said once ever (no `again`). */
  private once: Set<string>;
  /** Remark id → when it was last said (s, this session). */
  private said = new Map<string, number>();
  private state: SpeechState | null = null;
  private t = 0;
  private tickIn = 0;
  /** Showing until, then quiet until (s). */
  private hideAt = 0;
  private quietUntil = QUIET_START;
  private current: Pending | null = null;
  private pending: Pending[] = [];
  /** A line was just said: its id, and how long (s) it stays on screen. */
  onSaid: ((id: string, showS: number) => void) | null = null;

  constructor() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.el.id = 'speech';
    this.rest.className = 'rest';
    this.el.append(this.shown, this.rest);
    document.body.appendChild(this.el);
    let once: string[] = [];
    try {
      once = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    } catch { /* private window: once per visit */ }
    this.once = new Set(Array.isArray(once) ? once : []);
  }

  /** Per render frame, with what the lines may look at. */
  update(dt: number, state: SpeechState) {
    this.t += dt;
    this.state = state;
    if (state.dead) {
      this.text = '';
      this.current = null;
      this.hideAt = 0;
      this.el.classList.remove('on');
    }
    if (this.typed < this.text.length) this.type(dt);
    if (this.hideAt && this.t >= this.hideAt) {
      this.hideAt = 0;
      this.current = null;
      this.el.classList.remove('on');
    }
    this.pending = this.pending.filter((p) => p.expires > this.t && this.ready(p.line) && p.valid());
    if (!state.dead && this.t >= this.quietUntil && this.pending.length) this.say(this.pending.shift()!);
    if ((this.tickIn -= dt) <= 0) {
      this.tickIn = TICK;
      this.event('tick', undefined);
    }
  }

  /** Something happened: highest matching priority wins; urgent warnings can interrupt lower priorities. */
  event<E extends keyof SpeechEvents>(on: E, arg: SpeechEvents[E]) {
    const s = this.state;
    if (!s || s.dead) return;
    const line = LINES.filter((l) => l.on === on && this.ready(l) && this.matches(l, on, arg))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
    if (!line || this.current?.line.id === line.id) return;
    const p: Pending = { line, expires: this.t + (line.queueFor ?? 0) / 1000,
      valid: () => this.matches(line, on, arg), remembered: false };
    const interrupts = (line.priority ?? 0) >= 2 && (line.priority ?? 0) > (this.current?.line.priority ?? 0);
    if (this.t >= this.quietUntil || interrupts) {
      if (this.current && !this.current.remembered) this.enqueue(this.current);
      this.say(p);
    } else this.enqueue(p);
  }

  private matches<E extends keyof SpeechEvents>(line: Line, on: E, arg: SpeechEvents[E]): boolean {
    const state = this.state;
    if (!state || state.dead) return false;
    // A queued discovery stops being relevant when the item is dropped, fitted, or repaired meanwhile.
    const live = on === 'got' ? state.bag.find((it) => it?.id === (arg as SpeechEvents['got']).id) : arg;
    if (on === 'got' && !live) return false;
    const when = line.when as ((s: SpeechState, arg: SpeechEvents[E]) => boolean) | undefined;
    return !when || when(state, live as SpeechEvents[E]);
  }

  private enqueue(p: Pending) {
    if (!p.line.queueFor || p.expires <= this.t || !p.valid()) return;
    if (this.pending.some((q) => q.line.id === p.line.id)) return;
    this.pending.push(p);
    this.pending.sort((a, b) => (b.line.priority ?? 0) - (a.line.priority ?? 0));
    this.pending.length = Math.min(QUEUE_LIMIT, this.pending.length);
  }

  private ready(line: Line): boolean {
    if (line.again === undefined) return !this.once.has(onceKey(line));
    const last = this.said.get(line.id);
    return last === undefined || this.t - last >= line.again / 1000;
  }

  private say(p: Pending) {
    const line = p.line;
    this.pending = this.pending.filter((q) => q.line.id !== line.id);
    this.current = p;
    const texts = typeof line.say === 'string' ? [line.say] : line.say;
    const text = texts[Math.floor(Math.random() * texts.length)];
    this.text = text;
    this.typed = 0;
    this.nextIn = 0;
    this.shown.textContent = '';
    this.rest.textContent = text;
    this.el.classList.add('on');
    // Immediate danger is readable at once, before a long typewriter animation can hide the instruction.
    const instant = line.priority === 3;
    if (instant) {
      this.typed = text.length;
      this.shown.textContent = text;
      this.rest.textContent = '';
      this.remember();
    }
    const show = (instant ? 0 : typingTime(text)) + showFor(text);
    this.hideAt = this.t + show;
    this.quietUntil = this.t + show + GAP;
    this.onSaid?.(line.id, show);
  }

  /** Let out the letters due this frame, a blip for each (not for spaces and punctuation). */
  private type(dt: number) {
    this.nextIn -= dt;
    let blipped = false;
    while (this.nextIn <= 0 && this.typed < this.text.length) {
      const ch = this.text[this.typed++];
      this.nextIn += letterTime(ch);
      // A slow frame lets out several letters at once: one blip for them, not a burst.
      if (!blipped && /\p{L}|\p{N}/u.test(ch)) {
        speechSound.blip(ch);
        blipped = true;
      }
    }
    this.shown.textContent = this.text.slice(0, this.typed);
    this.rest.textContent = this.text.slice(this.typed);
    if (this.typed === this.text.length) this.remember();
  }

  /** An interrupted typewriter line has not delivered its information and remains eligible. */
  private remember() {
    const p = this.current;
    if (!p || p.remembered) return;
    p.remembered = true;
    this.said.set(p.line.id, this.t);
    if (p.line.again === undefined) {
      this.once.add(onceKey(p.line));
      try {
        localStorage.setItem(KEY, JSON.stringify([...this.once]));
      } catch { /* not kept */ }
    }
  }
}

/** What a remark said once is remembered by: its id, and the world's for one said once per world. */
function onceKey(line: Line) {
  return line.world ? `${line.id}@${WORLD}` : line.id;
}

/** Time (s) after letting out `ch` before the next letter. */
function letterTime(ch: string) {
  const base = 1 / TYPE_RATE;
  if (ch === ',' || ch === ';' || ch === ':') return base + COMMA_PAUSE;
  if (ch === '.' || ch === '!' || ch === '?' || ch === '…') return base + STOP_PAUSE;
  return base;
}

/** Time (s) to type out the whole line. */
function typingTime(text: string) {
  let t = 0;
  for (const ch of text) t += letterTime(ch);
  return t;
}
