// The landing page (no world in the URL) and the end screens over the game (game over, unknown world), in views:
// the start (Join, Create, Options); Join, with tabs for the games this browser joined (kept in localStorage when the
// server says hello, with how each is doing, your name there and how long you've played) and the public games
// (sortable), and in both a box to join a game by its code; Create, a new game's settings (name, public or private,
// most players, a password: server/index.ts /api/worlds), then straight to its lobby. Every
// game's link opens its lobby (src/lobby.ts), where your name and colour are chosen. Also the victory screen (every boss beaten), which goes away again: the world plays on. The landing
// page plays the desert guitar (the game's outdoor music, src/music.ts) once the browser lets it, after the first
// click or key.
import { audio } from './audio';
import { BOSS_KINDS } from '../shared/bosses.ts';
import { checkName, GAME_NAME, MAX_PLAYERS } from '../shared/names.ts';
import type { WorldStats } from '../shared/protocol.ts';
import { TEXT } from '../shared/text.ts';
import { WORLD_ID, WORLD_ID_RE } from '../shared/world.ts';
import { lobbyView } from './lobby';
import { MENU_CSS, bindOptions, bindTips, optionsHtml } from './options';
import { getBrowserId, setWorldKey } from './profile';

export const LANDING_CSS = `
#landing { position: fixed; inset: 0; z-index: 40; display: block; color: #e8d2ae;
  background: #4a2414; font-family: var(--mono); overflow: hidden auto; }
#landing { user-select: none; -webkit-user-select: none; } /* a menu, not a page to copy from: only the boxes take a selection */
#landing input { user-select: text; -webkit-user-select: text; }
#landing .bg { position: fixed; inset: -3%; background: url(./landing.svg) 72% bottom / cover; animation: landing-drift 60s ease-in-out infinite alternate; }
#landing .shade { position: fixed; inset: 0; pointer-events: none;
  background: radial-gradient(ellipse 80% 70% at 50% 55%, transparent 60%, rgba(30, 14, 8, .45) 100%); }
#landing.over .bg, #landing.over .shade { display: none; }
#landing.over { background: rgba(17, 10, 6, 0.82); }
/* Placed by centre() (a transform, not the layout), so the title glides between views instead of jumping. */
#landing .panel { position: relative; display: grid; justify-items: center; gap: 22px; text-align: center; padding: 0 16px 24px;
  animation: landing-in 1.6s ease-out both; will-change: transform; }
#landing h1 { margin: 0; font: clamp(40px, 7vw, 88px) var(--title); letter-spacing: .3em;
  margin-right: -.3em; color: #fff4d0;
  text-shadow: 0 0 40px rgba(255, 179, 71, .45), 0 0 12px rgba(140, 50, 10, .5), 0 2px 3px rgba(60, 20, 5, .45); }
#landing p { margin: 0; font: 14px var(--title); letter-spacing: .2em; color: #fff4d0; text-shadow: 0 1px 2px rgba(60, 20, 5, .6); }
#landing .link, #landing .row { display: flex; gap: 0; }
#landing input:not([type=color]) { font: 14px var(--mono); width: min(64vw, 380px); padding: 12px 14px; border: 1px solid rgba(255, 244, 208, .5);
  border-radius: 2px; color: #2a120a; background: rgba(255, 244, 208, .92); outline: none; box-sizing: border-box; }
#landing .link input, #landing .row input:not([type=color]) { border-right: 0; border-radius: 2px 0 0 2px; }
#landing input.bad { border-color: #ff8a6a; box-shadow: inset 0 0 0 1px #ff8a6a; }
#landing input[type=color] { width: 46px; height: auto; padding: 4px; border: 1px solid rgba(255, 244, 208, .5); border-right: 0;
  background: rgba(42, 18, 10, .55); cursor: pointer; }
#landing .link button, #landing .row button { border-radius: 0 2px 2px 0; padding: 12px 18px; }
#landing button { font: 13px var(--mono); padding: 12px 30px; color: #fff4d0; background: rgba(42, 18, 10, .55);
  border: 1px solid rgba(255, 244, 208, .45); border-radius: 2px; cursor: pointer; letter-spacing: .3em;
  text-transform: uppercase; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  transition: background .25s, border-color .25s, color .25s; }
#landing button:hover, #landing button.on { background: rgba(255, 244, 208, .92); border-color: #fff4d0; color: #2a120a; }
#landing button:disabled { opacity: .5; cursor: default; }
#landing button:disabled:hover { background: rgba(42, 18, 10, .55); color: #fff4d0; }
#landing .profile { display: grid; gap: 6px; justify-items: center; }
#landing .codeChip { padding: 6px 14px; font-size: 12px; letter-spacing: .15em; text-transform: none; }
#landing .profile.locked input { cursor: default; background: rgba(255, 244, 208, .7); border-right: 1px solid rgba(255, 244, 208, .5); }
#landing .profile.locked input[type=color] { border-radius: 0 2px 2px 0; }
#landing .why { min-height: 1em; font: 12px var(--mono); color: #ffb39a; text-shadow: 0 1px 2px rgba(60, 20, 5, .6); }
#landing .buttons { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; }
#landing .make { display: grid; gap: 10px; justify-items: center; }
#landing .seg { display: flex; gap: 8px; align-items: center; justify-content: center; }
#landing .seg button { padding: 10px 18px; }
#landing .seg .n { min-width: 2.5em; font: 15px var(--mono); color: #fff4d0; }
#landing .seg .label { font: 12px var(--mono); letter-spacing: .15em; text-transform: uppercase; opacity: .85; }
#landing .games { display: grid; gap: 8px; width: min(88vw, 440px); }
#landing .view, #landing .joinView { display: grid; gap: 16px; justify-items: center; }
#landing .tabs button { padding: 10px 22px; }
#landing .sorts button { padding: 4px 12px; font-size: 11px; letter-spacing: .15em; }
#landing .sorts[hidden] { display: none; }
#landing .games .none { font: 12px var(--mono); opacity: .7; padding: 12px 0; }
#landing .games ol { display: grid; gap: 6px; margin: 0; padding: 0 2px; list-style: none; max-height: 44vh; overflow-y: auto; }
#landing .games a { display: grid; grid-template-columns: 1fr auto; gap: 2px 16px; padding: 10px 14px; text-align: left;
  color: #fff4d0; text-decoration: none; background: rgba(42, 18, 10, .55); border: 1px solid rgba(255, 244, 208, .25);
  border-radius: 2px; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); transition: background .25s, border-color .25s, color .25s; }
#landing .games a:hover { background: rgba(255, 244, 208, .92); border-color: #fff4d0; color: #2a120a; }
#landing .games a.dead { opacity: .55; }
#landing .games .id { font: 14px var(--mono); letter-spacing: .1em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#landing .games a { grid-template-columns: 1fr auto; grid-template-rows: auto auto auto; }
#landing .games .stats, #landing .games .you { font: 12px var(--mono); opacity: .8; grid-column: 1; }
#landing .up, #landing .crowd, #landing .mine { display: inline-flex; gap: 5px; align-items: center; justify-content: flex-end; font: 12px var(--mono); opacity: .8; }
#landing .games .crowd { grid-column: 2; grid-row: 2 / span 2; align-self: end; justify-self: end; }
#landing .dot { margin: 0 .5em; }
#landing .games .you { display: flex; align-items: center; }
#landing .games .you .mine { opacity: 1; }
#landing .on { color: #9fe39a; }
#landing .tip { position: fixed; z-index: 60; display: none; padding: 6px 8px; border-radius: 5px; pointer-events: none; font: 11px/1.4 var(--mono);
  letter-spacing: 0; text-transform: none; text-align: left; color: #fff4d0;
  background: rgba(20, 10, 4, 0.96); box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.2), 0 6px 18px rgba(0, 0, 0, 0.5); }
#landing p.stats { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; }
#landing p.stats .up, #landing p.stats .crowd, #landing p.stats .mine { font: inherit; opacity: 1; }
#landing p.stats svg { width: 15px; height: 15px; }
#landing .games a:hover .on { color: #2f6b2a; }
@keyframes landing-drift { from { transform: scale(1) translateX(0); } to { transform: scale(1.06) translateX(-1.5%); } }
@keyframes landing-in { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { #landing .bg, #landing .panel { animation: none; transition: none !important; } }
`;

/** The page's style, once. */
export function landingStyle() {
  if (document.getElementById('landingStyle')) return;
  const style = document.createElement('style');
  style.id = 'landingStyle';
  style.textContent = LANDING_CSS;
  document.head.appendChild(style);
}

/** The menu's views, as history.state holds them: the browser's Back and Forward walk them, and moving between them
 *  never loads a page (the background and title stay put). `from`: the lobby was reached from another view. */
export type View = { v: 'intro' } | { v: 'join'; tab: 'mine' | 'pub' } | { v: 'create' } | { v: 'lobby'; id: string; from?: boolean };

/** The page showing now: where views go, why it's up over a game (the end screens), and how to load this page's game. */
let shown: { view: HTMLElement; why?: 'over' | 'missing'; play?: () => void } | null = null;

const urlOf = (v: View) => (v.v === 'lobby' ? `${location.pathname}?w=${encodeURIComponent(v.id)}` : location.pathname);
const viewOfUrl = (): View => {
  const id = new URLSearchParams(location.search).get('w') ?? '';
  return WORLD_ID_RE.test(id) ? { v: 'lobby', id } : { v: 'intro' };
};

/** Show the page; `why` puts it over the game as an end screen. `start` is the view to open on (the start screen, or a
 *  game's lobby when its link was opened), `play` loads this page's game (src/entry.ts). */
export function landing(why?: 'over' | 'missing', start: View = { v: 'intro' }, play?: () => void) {
  if (document.getElementById('landing')) return;
  document.exitPointerLock?.();
  // The loading cover (index.html) stays under the menu: Join loads the game behind it, and src/main.ts needs it. Only
  // over a game that's ended does it go.
  if (why) document.getElementById('cover')?.remove();
  landingStyle();
  const el = document.createElement('div');
  el.id = 'landing';
  if (why) el.className = 'over';
  const line = why === 'over' ? TEXT.landing.gameOver : why === 'missing' ? TEXT.landing.noSuchWorld : '';
  el.innerHTML = `${why ? '' : '<div class="bg"></div><div class="shade"></div>'}<div class="panel"><h1>${TEXT.game.name}</h1>${line ? `<p>${line}</p>` : ''}</div>`;
  // Typing here is not playing: the end screens sit over the game, whose listeners are on window.
  el.addEventListener('keydown', (e) => e.stopPropagation());
  document.body.append(el);
  bindTips(el);
  centre(el);
  if (!why) music(el);
  const view = document.createElement('div');
  view.className = 'view';
  el.querySelector('.panel')!.append(view);
  shown = { view, why, play };
  if (!why) {
    history.replaceState(start, '', location.href);
    addEventListener('popstate', onPop);
  }
  render(start);
}

const onPop = (e: PopStateEvent) => shown && render((e.state as View | null) ?? viewOfUrl());

/** Go to view `v` in place; the address follows (a lobby's is the game's link). Over a game (the end screens) a lobby is
 *  a page of its own: the game behind has to go. */
export function nav(v: View, how: 'push' | 'replace' = 'push') {
  if (!shown) return;
  if (shown.why) return void (v.v === 'lobby' ? location.assign(urlOf(v)) : render(v));
  if (how === 'push') history.pushState(v, '', urlOf(v));
  else history.replaceState(v, '', urlOf(v));
  render(v);
}

/** Back to where you were: the view before, or the start screen when there's none in this page (a link opened). */
const back = (v: View) => () => (shown?.why || (v.v === 'lobby' && !v.from) ? nav({ v: 'intro' }) : history.back());

/** Keep the panel in `page` centred, the title with it: up out of the way fast (0.1 s) when the view grows, back down
 *  slowly when it shrinks, and up again whenever it grows (a list coming in, a lobby filled). Too tall to fit, it
 *  sits at the top and the page scrolls. */
function centre(page: HTMLElement) {
  const panel = page.querySelector<HTMLElement>('.panel')!;
  let at: number | null = null;
  const place = () => {
    if (!panel.isConnected) return void watch.disconnect();
    const y = Math.max(16, Math.round((page.clientHeight - panel.offsetHeight) / 2));
    if (y === at) return;
    const up = at !== null && y < at;
    panel.style.transition = at === null ? 'none' : up ? 'transform .1s ease-out' : 'transform 1.4s cubic-bezier(.3, 0, .2, 1)';
    panel.style.transform = `translateY(${y}px)`;
    panel.style.marginBottom = `${y}px`; // the scroll height follows the shift (a transform takes no room)
    at = y;
  };
  const watch = new ResizeObserver(place);
  watch.observe(panel);
  watch.observe(page);
  place();
}

function render(v: View) {
  if (!shown) return;
  const el =
    v.v === 'join' ? joinView(v.tab, back(v))
    : v.v === 'create' ? make(back(v))
    : v.v === 'lobby' ? lobbyView(v.id, back(v), v.id === WORLD_ID ? shown.play : undefined)
    : intro(shown.why);
  const first = !shown.view.childElementCount;
  shown.view.replaceChildren(el);
  if (!first) el.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' }); // a short fade in
  const tip = document.querySelector<HTMLElement>('#landing .tip');
  if (tip) tip.style.display = 'none'; // its row is gone
}

/** The page goes (Join: the game loads behind its cover). */
export function leave() {
  removeEventListener('popstate', onPop);
  document.getElementById('landing')?.remove();
  shown = null;
}

/** The start: Join, Create, Options. */
function intro(why?: string): HTMLElement {
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  buttons.innerHTML = `<button class="join">${TEXT.landing.join}</button><button class="create">${TEXT.landing.create}</button>${why ? '' : `<button class="optionsBtn">${TEXT.menu.options}</button>`}`;
  buttons.querySelector('.join')!.addEventListener('click', () => nav({ v: 'join', tab: 'mine' }));
  buttons.querySelector('.create')!.addEventListener('click', () => nav({ v: 'create' }));
  buttons.querySelector('.optionsBtn')?.addEventListener('click', options);
  return buttons;
}

/** Joining: your games or the public ones (tabs, kept in the history so Back from a lobby comes back to the same one),
 *  the box for a game's code, and back to the start. */
function joinView(start: 'mine' | 'pub', back: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'joinView';
  el.innerHTML = `<div class="seg tabs"><button class="mine">${TEXT.landing.recent}</button><button class="pub">${TEXT.landing.browse}</button></div>
<div class="code"></div><div class="seg sorts"></div><div class="games"></div><div class="buttons"><button class="back">${TEXT.landing.back}</button></div>`;
  el.querySelector('.code')!.replaceWith(codeBox());
  const mine = el.querySelector<HTMLButtonElement>('.mine')!;
  const pub = el.querySelector<HTMLButtonElement>('.pub')!;
  const sorts = el.querySelector<HTMLElement>('.sorts')!;
  const box = el.querySelector<HTMLElement>('.games')!;
  const tab = (t: 'mine' | 'pub') => {
    mine.classList.toggle('on', t === 'mine');
    pub.classList.toggle('on', t === 'pub');
    sorts.replaceChildren();
    sorts.hidden = t !== 'pub';
    box.replaceChildren();
    if (t === 'pub') browse(box, sorts);
    else recent(box);
    if (shown && !shown.why) history.replaceState({ v: 'join', tab: t } satisfies View, '', location.href);
  };
  mine.addEventListener('click', () => tab('mine'));
  pub.addEventListener('click', () => tab('pub'));
  el.querySelector('.back')!.addEventListener('click', back);
  tab(start);
  return el;
}

const RECENT_KEY = 'dadajam.recent';
/** Worlds kept in the list. */
const RECENT_MAX = 8;
type Joined = { id: string; at: number };

function joined(): Joined[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((j) => typeof j?.id === 'string' && typeof j.at === 'number') : [];
  } catch {
    return [];
  }
}

function saveJoined(list: Joined[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {}
}

/** This browser joined the world: to the top of the landing page's list. */
export function rememberWorld(id: string) {
  saveJoined([{ id, at: Date.now() }, ...joined().filter((j) => j.id !== id)]);
}

export const CLOCK_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>`;
export const HOURGLASS_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9s10 4 10 9"/></svg>';
export const GROUP_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="9" cy="8" r="3.4"/><path d="M2.5 20c0-3.6 2.9-6.2 6.5-6.2s6.5 2.6 6.5 6.2z"/><g opacity=".65"><circle cx="16.8" cy="8.8" r="2.7"/><path d="M15 14c.6-.2 1.2-.3 1.8-.3 2.9 0 4.7 2.2 4.7 5.3h-4.6c-.2-2-.8-3.7-1.9-5z"/></g></svg>`;

/** How long the game has been going, by a clock. */
export function uptimeEl(s: WorldStats): HTMLElement {
  const el = document.createElement('span');
  el.className = 'up';
  el.dataset.tip = TEXT.landing.tipUptime;
  el.innerHTML = CLOCK_SVG;
  el.append(TEXT.landing.uptime(Math.max(0, Math.floor((Date.now() - s.created) / 60_000))));
  return el;
}

/** Everyone who has ever played the game: a group and the number, like the clock. */
export function crowdEl(s: WorldStats): HTMLElement {
  const el = document.createElement('span');
  el.className = 'crowd';
  el.dataset.tip = TEXT.landing.players(s.players);
  el.innerHTML = GROUP_SVG;
  el.append(String(s.players));
  return el;
}

/** Your own time played in the game, by the hourglass (as in the Esc menu); exact on hover. */
export function playedEl(ms: number): HTMLElement {
  const min = Math.floor(ms / 60_000);
  const el = document.createElement('span');
  el.className = 'mine';
  el.dataset.tip = TEXT.menu.server.playedTip(min);
  el.innerHTML = HOURGLASS_SVG;
  el.append(TEXT.menu.server.played(min));
  return el;
}

/** The dot between marks on a line. */
export const dot = () => {
  const el = document.createElement('span');
  el.className = 'dot';
  el.textContent = '·';
  return el;
};

/** A bit of text with a hover tip (bindTips, src/options.ts: the Esc menu's own). */
function tipped(text: string, tip: string, cls = ''): HTMLElement {
  const el = document.createElement('span');
  el.textContent = text;
  el.dataset.tip = tip;
  if (cls) el.className = cls;
  return el;
}

/** The lock by a game with a password. */
export const lockMark = () => tipped(TEXT.landing.lockedMark, TEXT.landing.tipLocked, 'lock');

/** Lives, bosses beaten and online now / max (lit when someone's on), each with its hover tip. */
export function statsLine(s: WorldStats, into: HTMLElement) {
  const n = BOSS_KINDS.filter((_, i) => s.beaten & (1 << i)).length;
  const life = s.lives > 0 ? tipped(TEXT.landing.lives(s.lives), TEXT.menu.server.lives(s.lives)) : tipped(TEXT.landing.gameOver, TEXT.landing.gameOver);
  const bosses = tipped('◆'.repeat(n) + '◇'.repeat(BOSS_KINDS.length - n), TEXT.menu.server.bosses(n, BOSS_KINDS.length));
  const seats = tipped(TEXT.landing.seats(s.online, s.max), TEXT.landing.tipSeats, s.online ? 'on' : '');
  into.replaceChildren(life, dot(), bosses, dot(), seats);
}

/** A game in one of the lists: name and how long it's been going; lives, bosses and who's on; with `mine` your name
 *  and time there (the hourglass); in the corner everyone who has played it. */
function gameRow(s: WorldStats, mine = false): HTMLLIElement {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = `?w=${encodeURIComponent(s.id)}`;
  if (s.lives <= 0) a.className = 'dead';
  a.innerHTML = `<span class="id"></span><span class="stats"></span>`;
  const [id, line] = a.querySelectorAll('span');
  id.textContent = s.name;
  if (s.locked) id.append(' ', lockMark());
  id.after(uptimeEl(s));
  // Into its lobby in place; a new tab (Ctrl, middle click) still opens its link.
  a.addEventListener('click', (e) => {
    if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    nav({ v: 'lobby', id: s.id, from: true });
  });
  statsLine(s, line);
  a.append(crowdEl(s));
  if (mine && (s.you || s.played)) {
    const y = document.createElement('span');
    y.className = 'you';
    if (s.you) y.append(s.you, dot());
    y.append(playedEl(s.played ?? 0));
    a.append(y);
  }
  li.append(a);
  return li;
}

/** A list of games, or `empty` if there are none. */
function gameList(box: HTMLElement, rows: HTMLLIElement[], empty: string) {
  if (!rows.length) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = empty;
    return box.replaceChildren(none);
  }
  const ol = document.createElement('ol');
  ol.append(...rows);
  box.replaceChildren(ol);
}

/** The games this browser joined before, once the server says how they're doing; worlds that are gone drop out. */
async function recent(box: HTMLElement) {
  const list = joined().filter((j) => j.id !== WORLD_ID || !shown?.why); // not the game you're in
  if (!list.length) return gameList(box, [], TEXT.landing.noMine);
  let stats: WorldStats[];
  try {
    // Posted: the browser id (who you are in each world, for your name and play time there) stays out of URLs.
    const res = await fetch('api/worlds/mine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: list.map((j) => j.id), browserId: getBrowserId() }),
    });
    if (!res.ok) return;
    stats = await res.json();
  } catch {
    return;
  }
  const byId = new Map(stats.map((s) => [s.id, s]));
  saveJoined(joined().filter((j) => j.id === WORLD_ID || byId.has(j.id)));
  const rows = list.filter((j) => byId.has(j.id));
  if (!box.isConnected) return;
  gameList(
    box,
    rows.map((j) => {
      return gameRow(byId.get(j.id)!, true);
    }),
    TEXT.landing.noMine,
  );
}

type Sort = keyof typeof TEXT.landing.sortBy;
const SORTS: Record<Sort, (a: WorldStats, b: WorldStats) => number> = {
  online: (a, b) => b.online - a.online || b.players - a.players,
  name: (a, b) => a.name.localeCompare(b.name),
  lives: (a, b) => b.lives - a.lives,
};
let sort: Sort = 'online';

/** The public games still being played (server/index.ts /api/browse), in the order picked in `sorts`. */
async function browse(box: HTMLElement, sorts: HTMLElement) {
  let list: WorldStats[];
  try {
    const res = await fetch('api/browse');
    if (!res.ok) return;
    list = await res.json();
  } catch {
    return;
  }
  if (!box.isConnected) return;
  const draw = () => {
    sorts.replaceChildren(
      ...(Object.keys(SORTS) as Sort[]).map((k) => {
        const b = document.createElement('button');
        b.textContent = TEXT.landing.sortBy[k];
        b.classList.toggle('on', k === sort);
        b.addEventListener('click', () => ((sort = k), draw()));
        return b;
      }),
    );
    const again = document.createElement('button');
    again.textContent = TEXT.landing.refresh;
    again.addEventListener('click', () => browse(box, sorts));
    sorts.append(again);
    gameList(box, [...list].sort(SORTS[sort]).map((s) => gameRow(s)), TEXT.landing.noGames);
  };
  draw();
}

/** Join a game by its code (the id in its link; a whole link pasted works too): to its lobby. */
function codeBox(): HTMLElement {
  const form = document.createElement('form');
  form.className = 'link';
  form.innerHTML = `<input autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"><button>${TEXT.landing.join}</button>`;
  const input = form.querySelector('input')!;
  input.placeholder = TEXT.landing.code;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    let id = input.value.trim();
    try {
      id = new URL(id).searchParams.get('w') ?? id;
    } catch {} // not a link: the code itself
    id = id.toLowerCase();
    if (!WORLD_ID_RE.test(id)) return input.classList.add('bad');
    nav({ v: 'lobby', id, from: true });
  });
  input.addEventListener('input', () => input.classList.remove('bad'));
  return form;
}

/** Making a game: name, public or private, most players, a password; then straight to its lobby. */
function make(back: () => void): HTMLElement {
  const form = document.createElement('form');
  form.className = 'make';
  form.innerHTML = `<input class="gname" maxlength="${GAME_NAME.max}" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other">
<div class="seg"><button type="button" class="pub on">${TEXT.landing.public}</button><button type="button" class="priv">${TEXT.landing.private}</button></div>
<div class="seg"><span class="label">${TEXT.landing.maxPlayers}</span><button type="button" class="minus">−</button><span class="n"></span><button type="button" class="plus">+</button></div>
<input class="pw" type="password" maxlength="64" autocomplete="new-password" data-1p-ignore data-lpignore="true" data-bwignore>
<div class="why"></div>
<div class="buttons"><button class="create">${TEXT.landing.create}</button><button type="button" class="back">${TEXT.landing.back}</button></div>`;
  const name = form.querySelector<HTMLInputElement>('.gname')!;
  const pw = form.querySelector<HTMLInputElement>('.pw')!;
  const why = form.querySelector<HTMLElement>('.why')!;
  const n = form.querySelector<HTMLElement>('.n')!;
  const pub = form.querySelector<HTMLButtonElement>('.pub')!;
  const priv = form.querySelector<HTMLButtonElement>('.priv')!;
  const create = form.querySelector<HTMLButtonElement>('.create')!;
  name.placeholder = TEXT.landing.gameName;
  pw.placeholder = TEXT.landing.passwordOptional;
  let max = MAX_PLAYERS.default;
  let isPublic = true;
  const show = () => {
    n.textContent = String(max);
    pub.classList.toggle('on', isPublic);
    priv.classList.toggle('on', !isPublic);
  };
  show();
  pub.addEventListener('click', () => ((isPublic = true), show()));
  priv.addEventListener('click', () => ((isPublic = false), show()));
  form.querySelector('.minus')!.addEventListener('click', () => ((max = Math.max(MAX_PLAYERS.min, max - 1)), show()));
  form.querySelector('.plus')!.addEventListener('click', () => ((max = Math.min(MAX_PLAYERS.max, max + 1)), show()));
  name.addEventListener('input', () => {
    name.classList.remove('bad');
    why.textContent = '';
  });
  form.querySelector('.back')!.addEventListener('click', back);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = checkName(name.value, GAME_NAME);
    if (!c.ok) {
      name.classList.add('bad');
      why.textContent = TEXT.landing.nameWhy[c.why];
      return name.focus();
    }
    create.disabled = true;
    why.textContent = '';
    try {
      const res = await fetch('api/worlds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: c.name, public: isPublic, max, password: pw.value }),
      });
      const out = (await res.json()) as { id?: string; key?: string; error?: string };
      if (!res.ok || !out.id) {
        const bad = out.error === 'short' || out.error === 'long' || out.error === 'chars' || out.error === 'banned';
        why.textContent = bad ? TEXT.landing.nameWhy[out.error as 'short'] : res.status === 429 ? TEXT.landing.busy : TEXT.landing.failed;
        create.disabled = false;
        return;
      }
      setWorldKey(out.id, out.key ?? '');
      nav({ v: 'lobby', id: out.id, from: true }, 'replace'); // its lobby in place of the form: Back goes to the start
    } catch {
      why.textContent = TEXT.landing.failed;
      create.disabled = false;
    }
  });
  queueMicrotask(() => name.focus());
  return form;
}

/** The options over the main menu, to set up before joining: the Esc menu's own view (src/options.ts). */
function options() {
  if (!document.getElementById('menuStyle')) {
    const style = document.createElement('style');
    style.id = 'menuStyle';
    style.textContent = MENU_CSS;
    document.head.appendChild(style);
  }
  const menu = document.createElement('div');
  menu.id = 'menu';
  menu.className = 'open';
  menu.style.zIndex = '50';
  menu.innerHTML = `<div class="panel opts">${optionsHtml()}</div>`;
  document.body.append(menu);
  const unbind = bindOptions(menu, {});
  const close = () => { unbind(); menu.remove(); };
  menu.querySelector('.optBack')!.addEventListener('click', close);
  menu.addEventListener('pointerdown', (e) => e.target === menu && close());
}

/** "Desert ambience" (src/music.ts DESERT_AMBIENCE: exactly 112 s, loops whole) through the music slider,
 * faded in; it fades out if the page goes away without leaving (the victory screen's Play on, the lobby's Join). */
export function music(el: HTMLElement) {
  const LENGTH = 112;
  /** Decoder delay (s) when the browser ignores the LAME header, as in src/music.ts. */
  const MP3_DELAY = 1105 / 44100;
  const buffer = fetch('./audio/desert-ambience.mp3').then((r) => r.arrayBuffer());
  audio.onStart(async (ctx) => {
    const buf = await ctx.decodeAudioData(await buffer);
    if (!el.isConnected || !audio.music) return;
    const lead = buf.duration > LENGTH + 0.001 ? Math.min(buf.duration - LENGTH, MP3_DELAY) : 0;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = lead;
    src.loopEnd = lead + LENGTH;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(0.45, ctx.currentTime, 1.5);
    src.connect(gain).connect(audio.music);
    src.start(ctx.currentTime, lead);
    const gone = new MutationObserver(() => {
      if (el.isConnected) return;
      gone.disconnect();
      gain.gain.setTargetAtTime(0, ctx.currentTime, 0.5);
      src.stop(ctx.currentTime + 3);
    });
    gone.observe(document.body, { childList: true });
  });
}

/** Every boss kind is beaten (shared/bosses.ts allBeaten): say so once per world on this browser, then play on. */
export function victory(world: string) {
  const key = `dadajam.won.${world}`;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
  } catch {}
  if (document.getElementById('landing')) return;
  document.exitPointerLock?.();
  landingStyle();
  const el = document.createElement('div');
  el.id = 'landing';
  el.className = 'over';
  el.innerHTML = `<div class="panel"><h1>${TEXT.game.name}</h1><p>${TEXT.landing.won}</p><button>${TEXT.landing.playOn}</button></div>`;
  document.body.append(el);
  centre(el);
  el.querySelector('button')!.addEventListener('click', () => {
    el.remove();
    Promise.resolve(document.querySelector('canvas')?.requestPointerLock()).catch(() => {});
  });
}
