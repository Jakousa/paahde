// The player character talking to themselves: a subtitle at the bottom of the screen when something happens that
// they'd have a word about (the lines, their conditions and how often: src/speechLines.ts; how to write them:
// docs/speech.md). Only one line at a time, with a pause after it; an event that comes while talking is dropped
// (a `tick` remark just comes up again later). Remarks said once are remembered on this browser (localStorage).
import { LINES, type Line, type SpeechEvents, type SpeechState } from './speechLines';

const KEY = 'dadajam.said';
/** Nothing said this long (s) after joining: let the world come in first. */
const QUIET_START = 4;
/** How often (s) `tick` lines are checked. */
const TICK = 0.5;
/** On screen for this long (s): a base plus reading time, within limits. */
const showFor = (text: string) => Math.min(7, Math.max(2.5, 1.2 + text.length * 0.06));
/** Silence after a line (s), before the next. */
const GAP = 2;

const css = `
#speech { position: fixed; left: 50%; bottom: 78px; transform: translateX(-50%); z-index: 7; max-width: min(640px, 80vw);
  padding: 3px 10px; font: 500 16px var(--mono); line-height: 1.35; text-align: center; color: #fff4e4;
  background: rgba(12, 6, 2, 0.45); border-radius: 4px; text-shadow: 0 1px 2px #000;
  pointer-events: none; opacity: 0; transition: opacity .3s; }
#speech.on { opacity: 1; }
`;

export class Speech {
  private el = document.createElement('div');
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

  constructor() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.el.id = 'speech';
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
    if (this.hideAt && this.t >= this.hideAt) {
      this.hideAt = 0;
      this.el.classList.remove('on');
    }
    if ((this.tickIn -= dt) <= 0) {
      this.tickIn = TICK;
      this.event('tick', undefined);
    }
  }

  /** Something happened: say the first line for it whose condition holds, unless busy talking. */
  event<E extends keyof SpeechEvents>(on: E, arg: SpeechEvents[E]) {
    const s = this.state;
    if (!s || this.t < this.quietUntil) return;
    for (const line of LINES) {
      if (line.on !== on || !this.ready(line)) continue;
      const when = line.when as ((s: SpeechState, arg: SpeechEvents[E]) => boolean) | undefined;
      if (when && !when(s, arg)) continue;
      this.say(line);
      return;
    }
  }

  private ready(line: Line): boolean {
    if (line.again === undefined) return !this.once.has(line.id);
    const last = this.said.get(line.id);
    return last === undefined || this.t - last >= line.again / 1000;
  }

  private say(line: Line) {
    const texts = typeof line.say === 'string' ? [line.say] : line.say;
    const text = texts[Math.floor(Math.random() * texts.length)];
    this.said.set(line.id, this.t);
    if (line.again === undefined) {
      this.once.add(line.id);
      try {
        localStorage.setItem(KEY, JSON.stringify([...this.once]));
      } catch { /* not kept */ }
    }
    this.el.textContent = text;
    this.el.classList.add('on');
    const show = showFor(text);
    this.hideAt = this.t + show;
    this.quietUntil = this.t + show + GAP;
  }
}
