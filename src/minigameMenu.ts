// The teardown minigame as a thing to play from the Esc menu (src/menu.ts), over the world, which stays visible behind
// a see-through backdrop. Four games, each with its own leaderboard (server/minigame.ts):
//   5 / 10 / 20 machines    a speedrun: the time to take that many apart, lowest wins
//   Endless                 as many machines as you can in one go, scored by how many
// Pick one and see its records (and your best) before starting; play it (src/loadingGame.ts runs the game), then put
// your name to the result and see where it ranks.
// Esc steps back: out of a run to the records, out of the records and the result to the choice, out of the choice to the menu.
import { NAME_MAX } from '../shared/protocol.ts';
import { loading } from './loadingGame';
import type { Hint, Mode, RunResult } from './loadingRunner';
import { TEXT } from '../shared/text.ts';

const NAME_KEY = 'dadajam.name'; // the same name as in the games (src/profile.ts)
const TIPS_KEY = 'dadajam.mini.tips'; // '0' once tips are hidden
const MODES: { mode: Mode; key: string; title: string }[] = [
  { mode: 5, key: '5', title: TEXT.minigame.machines(5) },
  { mode: 10, key: '10', title: TEXT.minigame.machines(10) },
  { mode: 20, key: '20', title: TEXT.minigame.machines(20) },
  { mode: 'endless', key: 'endless', title: TEXT.minigame.endless },
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
#play h2 { margin: 0 0 12px; font: 15px var(--title); letter-spacing: 0.18em; text-transform: uppercase; color: #ffd9a0; }
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
#play .tip { position: relative; box-sizing: border-box; width: min(360px, calc(94vw / var(--ui, 1))); height: 52px; padding: 0 16px; display: flex; align-items: center;
  gap: 12px; border-radius: 8px; background: rgba(28, 15, 7, 0.88); box-shadow: 0 0 0 1px rgba(255, 217, 160, 0.22); font-size: 13px;
  transition: opacity .25s; }
#play .tip.off { opacity: 0; }
#play .tip .label { position: absolute; top: -7px; left: 10px; padding: 0 6px; border-radius: 3px; background: #2a160a;
  font: 600 10px var(--mono); letter-spacing: 0.16em; text-transform: uppercase; color: #ffd9a0; }
#play .tip svg { flex: none; width: 32px; height: 32px; overflow: visible; }
#play .tip svg * { transform-box: fill-box; transform-origin: center; }
#play button.tipsw { margin-top: -10px; padding: 2px 8px; background: none; color: #fff4e4; opacity: 0.4; font: 11px var(--mono); letter-spacing: 0; }
#play button.tipsw:hover { background: none; opacity: 0.75; }
.tipDot { animation: tipTap 1s ease-in-out infinite; }
@keyframes tipTap { 0%, 60%, 100% { transform: scale(1); } 25% { transform: scale(1.7); } }
.tipSpin { animation: tipSpin 1.1s linear infinite; }
@keyframes tipSpin { to { transform: rotate(360deg); } }
.tipSlide { animation: tipSlide 1.2s ease-in-out infinite; }
@keyframes tipSlide { 0% { transform: translateX(0); opacity: 0; } 15% { opacity: 1; } 70%, 100% { transform: translateX(11px); opacity: 1; } 90% { opacity: 0.2; } }
.tipShake { animation: tipShake 0.35s ease-in-out infinite; }
@keyframes tipShake { 0%, 100% { transform: translateX(-5px); } 50% { transform: translateX(5px); } }
.tipGlow { animation: tipGlow 1.2s ease-in-out infinite; }
@keyframes tipGlow { 50% { transform: scale(1.3); opacity: 0.6; } }
`;

/** The tip's picture: the step's marker in miniature, moving the way the move goes (as in src/loadingRunner.ts). */
const TIP_ICONS: Record<Hint, string> = {
  screw: `<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="5" fill="#8a8f93"/><g fill="#ffb050"><circle class="tipDot" cx="16" cy="5" r="2.6"/><circle class="tipDot" style="animation-delay:.2s" cx="25.5" cy="21.5" r="2.6"/><circle class="tipDot" style="animation-delay:.4s" cx="6.5" cy="21.5" r="2.6"/></g></svg>`,
  bolt: `<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="5" fill="#8a8f93"/><g class="tipSpin" style="transform-box:view-box;transform-origin:16px 16px"><path d="M16 4a12 12 0 1 1-12 12" fill="none" stroke="#ffb050" stroke-width="2.6" stroke-linecap="round"/><path d="M4 6.5l5.5 8.5h-11z" fill="#ffb050"/></g></svg>`,
  wire: `<svg viewBox="0 0 32 32"><path d="M3 16h26" stroke="#c47a3a" stroke-width="4" stroke-linecap="round"/><path d="M4 9l-3 3 3 3M28 9l3 3-3 3" transform="translate(0 4)" fill="none" stroke="#ffb050" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><g class="tipShake"><circle cx="16" cy="16" r="5.5" fill="rgba(28,15,7,.6)" stroke="#ffb050" stroke-width="2.2"/><circle cx="16" cy="16" r="1.8" fill="#ffb050"/></g></svg>`,
  pry: `<svg viewBox="0 0 32 32"><rect x="3" y="9" width="9" height="14" rx="2" fill="#8a8f93" stroke="#3b2616" stroke-width="1.5"/><path d="M6 12v8M9 12v8" stroke="#2b2622" stroke-width="1.6"/><g class="tipSlide"><circle cx="8" cy="16" r="5" fill="rgba(28,15,7,.6)" stroke="#ffb050" stroke-width="2.2"/><circle cx="8" cy="16" r="1.8" fill="#ffb050"/></g><path d="M25 12l4 4-4 4" fill="none" stroke="#ffb050" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  part: `<svg viewBox="0 0 32 32"><defs><radialGradient id="tg"><stop offset="0" stop-color="#ff9a3c" stop-opacity=".8"/><stop offset="1" stop-color="#ff9a3c" stop-opacity="0"/></radialGradient></defs><circle class="tipGlow" cx="16" cy="16" r="15" fill="url(#tg)"/><circle cx="16" cy="16" r="7" fill="#ff9a3c"/><circle cx="16" cy="16" r="2.6" fill="#1c0f07"/></svg>`,
};

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
  if (!top) return `<div class="none">${TEXT.minigame.offline}</div>`;
  if (!top.length) return `<div class="none">${TEXT.minigame.nobody}</div>`;
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
    else if (screen === 'run') intro(current);
    else pick();
  };
  addEventListener('keydown', onKey, true);

  function pick() {
    screen = 'pick';
    loading.stop();
    o.innerHTML = `<div class="panel"><h2>${TEXT.minigame.title}</h2><div class="modes">${MODES.map((m) => {
      const best = myBest(m.key);
      return `<button class="card" data-m="${m.key}"><b>${m.title}</b><div class="best">${best ? `${TEXT.minigame.yourBest} ${scoreText(m.mode, best)}` : ''}</div><div class="top" data-top="${m.key}"></div></button>`;
    }).join('')}</div></div><button class="leave">${TEXT.menu.leave}</button>`;
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
    o.innerHTML = `<div class="panel result"><h2>${m.title}</h2>${best ? `<div class="big"><small>${TEXT.minigame.yourBest}</small>${scoreText(m.mode, best)}</div>` : ''}<div class="board"><div class="none">…</div></div></div>
<div class="row"><button class="start">${TEXT.minigame.start}</button><button class="quiet back">${TEXT.minigame.back}</button></div>`;
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
    let tips = true;
    try {
      tips = localStorage.getItem(TIPS_KEY) !== '0';
    } catch {}
    o.innerHTML = `<div class="tip off"><span class="label">${TEXT.minigame.tip}</span></div><button class="tipsw"></button><div class="stage"></div><div class="row"><button class="leave quiet">${TEXT.menu.leave}</button>${m.mode === 'endless' ? `<button class="finish">${TEXT.minigame.finish}</button>` : ''}</div>`;
    o.querySelector('.leave')!.addEventListener('click', () => intro(m));
    o.querySelector('.finish')?.addEventListener('click', () => loading.finishNow());
    // The tip box above the game, and the dim line under it that hides the tips (kept for next time).
    const tip = o.querySelector<HTMLElement>('.tip')!;
    const sw = o.querySelector<HTMLElement>('.tipsw')!;
    let now: Hint | null = null;
    const showTip = () => {
      tip.querySelectorAll('svg, .text').forEach((e) => e.remove());
      if (now && tips) {
        tip.insertAdjacentHTML('beforeend', `${TIP_ICONS[now]}<span class="text">${TEXT.minigame.hint[now]}</span>`);
        tip.classList.remove('off');
      } else tip.classList.add('off');
      sw.textContent = tips ? TEXT.minigame.hideTips : TEXT.minigame.showTips;
    };
    showTip();
    sw.addEventListener('click', () => {
      tips = !tips;
      try {
        localStorage.setItem(TIPS_KEY, tips ? '1' : '0');
      } catch {}
      showTip();
    });
    loading.start(o.querySelector<HTMLElement>('.stage')!, m.mode, (r) => alive && screen === 'run' && result(r), (k) => {
      now = k;
      showTip();
    });
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
    o.innerHTML = `<div class="panel result"><h2>${m.title}</h2><div class="big"><small>${r.mode === 'endless' ? TEXT.minigame.machinesLabel : TEXT.minigame.timeLabel}</small>${scoreText(r.mode, score)}</div>
<form class="row"><input maxlength="${NAME_MAX}" placeholder="${TEXT.landing.yourName}" value="${esc(saved)}" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true"><button>${TEXT.minigame.submit}</button></form>
<div class="board"></div></div><div class="row"><button class="again">${TEXT.minigame.again}</button><button class="quiet back">${TEXT.minigame.back}</button></div>`;
    o.querySelector('.again')!.addEventListener('click', () => play(m));
    o.querySelector('.back')!.addEventListener('click', pick);
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
          board.innerHTML = `${list(m.mode, out.top, out.name)}${out.rank > 10 ? `<div class="none">${TEXT.minigame.rank(out.rank)}</div>` : ''}`;
        }
      } catch {
        if (alive) board.innerHTML = `<div class="none">${TEXT.minigame.unreachable}</div>`;
      }
    });
  }

  pick();
}
