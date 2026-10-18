// Chat: Enter opens a line at the bottom left, Enter sends it (Esc or an empty line just closes). Lines from
// everyone show above it for a while, each behind a swatch of the speaker's avatar colour and their name (src/name.ts); while typing, the
// recent ones all come back. Each line starts with the time it was said (local hh:mm). Deaths are lines too; the
// world keeps them, so joining brings back its latest ones, faded, for when you open chat. The input keeps the keys
// to itself, so typing doesn't walk or open menus.
import { CHAT_MAX, type DeathCause, type Obituary } from '../shared/protocol.ts';
import type { Net } from './net';
import { tools, ui } from './input';

/** How long a line stays up (ms), fading out over the last second. */
const SHOW_MS = 12000;
/** Lines kept (shown while typing). */
const KEEP = 12;

/** A death in chat, after the dead player's swatch, in their colour. */
const OBITUARY: Record<DeathCause, string> = {
  heat: 'died of the heat',
  guardian: 'stepped on by a guardian',
  laser: 'shot down',
  missile: 'blown up',
  crawler: 'bitten to death',
  worm: 'eaten by the worm',
  stomp: 'crushed by the colossus',
  bomb: 'bombed by the carrier',
  queen: 'killed by the queen',
};

const css = `
#chat { position: fixed; left: 16px; bottom: 110px; width: min(380px, calc(100vw - 32px)); z-index: 6;
  pointer-events: none; font: 13px var(--mono); color: #f2e6d6; }
#chat .log { display: flex; flex-direction: column; gap: 2px; }
#chat .line { padding: 2px 6px; border-radius: 4px; background: rgba(20, 14, 10, 0.45); text-shadow: 0 1px 2px #000;
  overflow-wrap: anywhere; animation: chatFade ${SHOW_MS}ms linear forwards; }
#chat .line.death { font-style: italic; }
#chat .line time { opacity: 0.55; margin-right: 6px; }
#chat .line b { font-weight: 600; margin-right: 6px; }
#chat .line i { display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 2px; }
#chat .line.gone { animation: none; opacity: 0; visibility: hidden; }
#chat.open .line { animation: none; opacity: 1; visibility: visible; }
@keyframes chatFade { 0%, 92% { opacity: 1; } 100% { opacity: 0; visibility: hidden; } }
#chat input { display: none; box-sizing: border-box; width: 100%; margin-top: 4px; padding: 5px 7px; border-radius: 4px;
  border: 1px solid rgba(255, 240, 220, 0.25); background: rgba(20, 14, 10, 0.75); color: #fff4e4;
  font: 13px var(--mono); outline: none; pointer-events: auto; }
#chat.open input { display: block; }
`;

export class Chat {
  private el = document.createElement('div');
  private log = document.createElement('div');
  private input = document.createElement('input');

  constructor(net: Net) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.el.id = 'chat';
    this.log.className = 'log';
    this.input.maxLength = CHAT_MAX;
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.el.append(this.log, this.input);
    document.body.append(this.el);

    net.onChat = (m) => this.add(m.color, m.name, m.text, m.at);
    net.onObituary = (m) => this.add(m.color, m.name, OBITUARY[m.cause], m.at, 'death');
    // On every (re)join: the world's latest deaths replace the ones we have, already faded.
    net.onObituaries = (list: Obituary[]) => {
      for (const line of [...this.log.querySelectorAll('.line.death')]) line.remove();
      for (const m of list) this.add(m.color, m.name, OBITUARY[m.cause], m.at, 'death', true);
    };

    // Only from the game itself: not over the inventory, the Esc menu or the disassembly.
    addEventListener('keydown', (e) => {
      if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
      if (e.repeat || this.open || !document.pointerLockElement || ui.inventoryOpen || tools.frozen) return;
      e.preventDefault(); // or the same press lands in the input
      this.toggle(true);
    });
    // Every key stays in the input: the game's own listeners are on window, past this one.
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        const text = this.input.value.trim();
        if (text) net.chat(text);
        this.toggle(false);
      } else if (e.code === 'Escape') {
        e.preventDefault();
        this.toggle(false);
      }
    });
    // Clicking back into the game (or anywhere else) drops the line.
    this.input.addEventListener('blur', () => this.toggle(false));
  }

  get open() {
    return this.el.classList.contains('open');
  }

  private toggle(open: boolean) {
    if (open === this.open) return;
    this.el.classList.toggle('open', open);
    if (open) this.input.focus();
    else {
      this.input.value = '';
      this.input.blur();
      // Each line fades on from where its own time is up to, not from the start.
      const now = performance.now();
      for (const line of this.log.children as HTMLCollectionOf<HTMLElement>) {
        const age = now - Number(line.dataset.at);
        line.classList.toggle('gone', age >= SHOW_MS);
        line.style.animationDelay = `${-age}ms`;
      }
    }
  }

  /** A line said at `at` (ms since epoch), in order among the others; `old`: already faded (history). */
  private add(color: number, name: string, text: string, at: number, kind?: 'death', old = false) {
    const line = document.createElement('div');
    line.className = kind ? `line ${kind}` : 'line';
    if (old) line.classList.add('gone');
    line.dataset.at = String(old ? -Infinity : performance.now());
    line.dataset.said = String(at);
    const hex = `#${color.toString(16).padStart(6, '0')}`;
    if (kind === 'death') line.style.color = hex; // in the dead player's colour
    const time = document.createElement('time');
    time.textContent = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    line.append(time);
    const swatch = document.createElement('i');
    swatch.style.background = hex;
    line.append(swatch);
    if (name) {
      const who = document.createElement('b');
      who.textContent = name;
      line.append(who);
    }
    line.append(text);
    const after = [...this.log.children as HTMLCollectionOf<HTMLElement>].find((l) => Number(l.dataset.said) > at);
    this.log.insertBefore(line, after ?? null);
    while (this.log.children.length > KEEP) this.log.firstElementChild!.remove();
  }
}
