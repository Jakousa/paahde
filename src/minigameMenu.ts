// The teardown minigame as a thing to play from the Esc menu (src/menu.ts), over the world, which stays visible behind
// a see-through backdrop. Four games, each with its own leaderboard (server/minigame.ts):
//   5 / 10 / 20 machines    a speedrun: the time to take that many apart, lowest wins
//   Endless                 as many machines as you can in one go, scored by how many
// Pick one and see its records (and your best) before starting; play it (src/loadingGame.ts runs the game), then put
// your name to the result and see where it ranks.
// Esc steps back: out of a run to the records, out of the records to the choice, out of the choice to the menu.
import { NAME_MAX } from '../shared/protocol.ts';
import { loading } from './loadingGame';
import type { Mode, RunResult } from './loadingRunner';

const NAME_KEY = 'dadajam.name'; // the same name as in the world (src/name.ts)
const MODES: { mode: Mode; key: string; title: string }[] = [
  { mode: 5, key: '5', title: '5 machines' },
  { mode: 10, key: '10', title: '10 machines' },
  { mode: 20, key: '20', title: '20 machines' },
  { mode: 'endless', key: 'endless', title: 'Endless' },
];

type Entry = { name: string; score: number; machines: number };

const css = `
#play { position: fixed; inset: 0; z-index: 31; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 16px; background: rgba(12, 6, 2, 0.3); font: 12px var(--mono); color: #fff4e4; user-select: none; -webkit-user-select: none; }
#play button { padding: 8px 22px; font: 600 13px var(--mono); letter-spacing: 0.08em; color: #2a160a; background: #ffd9a0;
  border: 0; border-radius: 5px; cursor: pointer; }
#play button:hover { background: #ffe6bf; }
#play button.quiet { background: transparent; color: #ffd9a0; box-shadow: 0 0 0 1px rgba(255, 217, 160, 0.3); }
#play button.quiet:hover { background: rgba(255, 217, 160, 0.12); }
#play .row { display: flex; gap: 10px; }
#play .panel { padding: 16px 18px; border-radius: 8px; background: rgba(28, 15, 7, 0.92);
  box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.16), 0 10px 40px rgba(0, 0, 0, 0.5); }
#play h2 { margin: 0 0 12px; font: 600 15px var(--mono); letter-spacing: 0.18em; text-transform: uppercase; color: #ffd9a0; }
#play .modes { display: grid; grid-template-columns: repeat(2, 200px); gap: 12px; }
#play .card { text-align: left; padding: 10px 12px 9px; background: rgba(255, 217, 160, 0.08); color: #fff4e4;
  box-shadow: 0 0 0 1px rgba(255, 217, 160, 0.2); letter-spacing: 0; font: 12px var(--mono); border-radius: 6px; cursor: pointer; border: 0; }
#play .card:hover { background: rgba(255, 217, 160, 0.18); }
#play .card b { display: block; font: 600 13px var(--mono); letter-spacing: 0.08em; color: #ffd9a0; margin-bottom: 6px; text-transform: uppercase; }
#play .card .best { opacity: 0.6; margin-bottom: 4px; min-height: 14px; }
#play ol { margin: 0; padding: 0; list-style: none; font-variant-numeric: tabular-nums; }
#play li { display: flex; gap: 8px; line-height: 1.55; }
#play li i { font-style: normal; width: 16px; text-align: right; opacity: 0.5; }
#play li span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#play li.me { color: #ffd9a0; font-weight: 600; }
#play .big { font: 600 28px var(--mono); color: #ffd9a0; margin: 2px 0 12px; }
#play .big small { display: block; font: 12px var(--mono); opacity: 0.6; letter-spacing: 0.1em; text-transform: uppercase; }
#play input { font: 14px var(--mono); width: 170px; padding: 8px 10px; border: 0; border-radius: 4px; color: #2a120a; background: #fff4d0; outline: none; }
#play .result { width: 280px; }
#play .result .row { margin: 12px 0; }
#play .none { opacity: 0.5; }
`;

/** m:ss.cc */
const timeText = (ms: number) => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(2).padStart(5, '0')}`;
const scoreText = (mode: Mode, score: number) => (mode === 'endless' ? String(score) : timeText(score));
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const bestKey = (key: string) => `dadajam.mini.${key}`;
function myBest(key: string): number {
  try {
    return Number(localStorage.getItem(bestKey(key))) || 0;
  } catch {
    return 0;
  }
}

async function fetchTop(key: string): Promise<Entry[] | null> {
  try {
    const r = await fetch(`api/minigame?mode=${key}`);
    return r.ok ? ((await r.json()) as { top: Entry[] }).top : null;
  } catch {
    return null;
  }
}

function list(mode: Mode, top: Entry[] | null, me?: string, limit = 10): string {
  if (!top) return '<div class="none">offline</div>';
  if (!top.length) return '<div class="none">nobody yet</div>';
  return `<ol>${top.slice(0, limit).map((e, i) => `<li class="${e.name === me ? 'me' : ''}"><i>${i + 1}</i><span>${esc(e.name)}</span><b>${scoreText(mode, e.score)}</b></li>`).join('')}</ol>`;
}

/** Opens the minigame over the world; `onClose` when the player leaves it. */
export function openMinigame(onClose: () => void) {
  if (document.getElementById('play')) return;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const o = document.createElement('div');
  o.id = 'play';
  document.body.append(o);

  let screen: 'pick' | 'intro' | 'run' | 'result' = 'pick';
  let current = MODES[0];
  let alive = true;

  const close = () => {
    alive = false;
    loading.stop();
    removeEventListener('keydown', onKey, true);
    o.remove();
    style.remove();
    onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.code !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (screen === 'pick') close();
    else if (screen === 'run' || screen === 'result') intro(current);
    else pick();
  };
  addEventListener('keydown', onKey, true);

  function pick() {
    screen = 'pick';
    loading.stop();
    o.innerHTML = `<div class="panel"><h2>Teardown</h2><div class="modes">${MODES.map((m) => {
      const best = myBest(m.key);
      return `<button class="card" data-m="${m.key}"><b>${m.title}</b><div class="best">${best ? `your best ${scoreText(m.mode, best)}` : ''}</div><div class="top" data-top="${m.key}"></div></button>`;
    }).join('')}</div></div><button class="leave">Leave</button>`;
    o.querySelector('.leave')!.addEventListener('click', close);
    for (const card of o.querySelectorAll<HTMLElement>('.card')) {
      card.addEventListener('click', () => intro(MODES.find((m) => m.key === card.dataset.m)!));
    }
    for (const m of MODES) {
      fetchTop(m.key).then((top) => {
        const el = o.querySelector(`[data-top="${m.key}"]`);
        if (alive && screen === 'pick' && el) el.innerHTML = list(m.mode, top, undefined, 3);
      });
    }
  }

  /** What the end of a run shows, before it: the records, your best on top if you have one, and Start. */
  function intro(m: (typeof MODES)[number]) {
    current = m;
    screen = 'intro';
    loading.stop();
    const best = myBest(m.key);
    o.innerHTML = `<div class="panel result"><h2>${m.title}</h2>${best ? `<div class="big"><small>your best</small>${scoreText(m.mode, best)}</div>` : ''}<div class="board"><div class="none">…</div></div></div>
<div class="row"><button class="start">Start</button><button class="quiet back">Back</button></div>`;
    o.querySelector('.start')!.addEventListener('click', () => play(m));
    o.querySelector('.back')!.addEventListener('click', pick);
    let me: string | undefined;
    try {
      me = localStorage.getItem(NAME_KEY) ?? undefined;
    } catch {}
    const board = o.querySelector<HTMLElement>('.board')!;
    fetchTop(m.key).then((top) => alive && screen === 'intro' && current === m && (board.innerHTML = list(m.mode, top, me)));
  }

  function play(m: (typeof MODES)[number]) {
    current = m;
    screen = 'run';
    loading.stop();
    o.innerHTML = `<div class="stage"></div><div class="row"><button class="leave quiet">Leave</button>${m.mode === 'endless' ? '<button class="finish">Finish</button>' : ''}</div>`;
    o.querySelector('.leave')!.addEventListener('click', () => intro(m));
    o.querySelector('.finish')?.addEventListener('click', () => loading.finishNow());
    loading.start(o.querySelector<HTMLElement>('.stage')!, m.mode, (r) => alive && screen === 'run' && result(r));
  }

  function result(r: RunResult) {
    screen = 'result';
    loading.stop();
    const m = current;
    const score = r.mode === 'endless' ? r.machines : r.ms;
    const prev = myBest(m.key);
    const better = !prev || (r.mode === 'endless' ? score > prev : score < prev);
    if (better) {
      try {
        localStorage.setItem(bestKey(m.key), String(score));
      } catch {}
    }
    let saved = '';
    try {
      saved = localStorage.getItem(NAME_KEY) ?? '';
    } catch {}
    o.innerHTML = `<div class="panel result"><h2>${m.title}</h2><div class="big"><small>${r.mode === 'endless' ? 'machines' : 'time'}</small>${scoreText(r.mode, score)}</div>
<form class="row"><input maxlength="${NAME_MAX}" placeholder="your name" value="${esc(saved)}" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true"><button>Submit</button></form>
<div class="board"></div></div><div class="row"><button class="again">Again</button><button class="quiet modes">Modes</button><button class="quiet leave">Leave</button></div>`;
    o.querySelector('.again')!.addEventListener('click', () => play(m));
    o.querySelector('.modes')!.addEventListener('click', pick);
    o.querySelector('.leave')!.addEventListener('click', close);
    const board = o.querySelector<HTMLElement>('.board')!;
    const form = o.querySelector<HTMLFormElement>('form')!;
    const input = form.querySelector('input')!;
    input.focus();
    input.select();
    input.addEventListener('keydown', (e) => e.stopPropagation()); // typing in the box is not the game's keys
    fetchTop(m.key).then((top) => alive && !form.dataset.sent && (board.innerHTML = list(m.mode, top)));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (form.dataset.sent) return;
      form.dataset.sent = '1';
      const name = input.value.trim();
      try {
        if (name) localStorage.setItem(NAME_KEY, name);
      } catch {}
      form.querySelector('button')!.disabled = true;
      try {
        const res = await fetch('api/minigame', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: m.key === 'endless' ? 'endless' : m.key, name, score, machines: r.machines }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const out = (await res.json()) as { top: Entry[]; rank: number; name: string };
        if (alive) {
          form.style.display = 'none';
          board.innerHTML = `${list(m.mode, out.top, out.name)}${out.rank > 10 ? `<div class="none">you are #${out.rank}</div>` : ''}`;
        }
      } catch {
        if (alive) board.innerHTML = '<div class="none">couldn’t reach the board</div>';
      }
    });
  }

  pick();
}
