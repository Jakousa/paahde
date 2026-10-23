// The landing page (no world in the URL) and the end screens over the game (game over, unknown world), in views:
// the start (Join, Create, Options); Join, with tabs for the games this browser joined (kept in localStorage when the
// server says hello, with how each is doing, your name there and how long you've played) and the public games
// (sortable), and in both a box to join a game by its code; Create, a new game's settings (name, public or private,
// most players, a password: server/index.ts /api/worlds), then its link to copy and share, and to join from. Every
// game's link opens its lobby (src/lobby.ts), where your name and colour are chosen. Also the victory screen (every boss beaten), which goes away again: the world plays on. The landing
// page plays the desert guitar (the game's outdoor music, src/music.ts) once the browser lets it, after the first
// click or key.
import { audio } from './audio';
import { BOSS_KINDS } from '../shared/bosses.ts';
import { checkName, GAME_NAME, MAX_PLAYERS } from '../shared/names.ts';
import type { WorldStats } from '../shared/protocol.ts';
import { TEXT } from '../shared/text.ts';
import { WORLD_ID, WORLD_ID_RE } from '../shared/world.ts';
import { MENU_CSS, bindOptions, optionsHtml } from './options';
import { getBrowserId, setWorldKey } from './profile';

export const LANDING_CSS = `
#landing { position: fixed; inset: 0; z-index: 40; display: grid; place-items: safe center; color: #e8d2ae;
  background: #4a2414; font-family: var(--mono); overflow: hidden auto; }
#landing .bg { position: fixed; inset: -3%; background: url(./landing.svg) 72% bottom / cover; animation: landing-drift 60s ease-in-out infinite alternate; }
#landing .shade { position: fixed; inset: 0; pointer-events: none;
  background: radial-gradient(ellipse 80% 70% at 50% 55%, transparent 60%, rgba(30, 14, 8, .45) 100%); }
#landing.over .bg, #landing.over .shade { display: none; }
#landing.over { background: rgba(17, 10, 6, 0.82); }
#landing .panel { position: relative; display: grid; justify-items: center; gap: 22px; text-align: center; padding: 6vh 16px;
  animation: landing-in 1.6s ease-out both; }
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
#landing .games .when, #landing .games .stats, #landing .games .you { font: 12px var(--mono); opacity: .8; }
#landing .games .when { text-align: right; }
#landing .games .you { grid-column: 1 / -1; }
#landing .games .on { color: #9fe39a; }
#landing .games a:hover .on { color: #2f6b2a; }
@keyframes landing-drift { from { transform: scale(1) translateX(0); } to { transform: scale(1.06) translateX(-1.5%); } }
@keyframes landing-in { from { opacity: 0; transform: translateY(12px); } }
@media (prefers-reduced-motion: reduce) { #landing .bg, #landing .panel { animation: none; } }
`;

/** The page's style, once. */
export function landingStyle() {
  if (document.getElementById('landingStyle')) return;
  const style = document.createElement('style');
  style.id = 'landingStyle';
  style.textContent = LANDING_CSS;
  document.head.appendChild(style);
}

/** A game's own page (its lobby, src/lobby.ts). */
const gameUrl = (id: string) => `${location.origin}${location.pathname}?w=${encodeURIComponent(id)}`;

/** Show the page; `why` puts it over the game as an end screen. */
export function landing(why?: 'over' | 'missing') {
  if (document.getElementById('landing')) return;
  document.exitPointerLock?.();
  document.getElementById('cover')?.remove();
  landingStyle();
  const el = document.createElement('div');
  el.id = 'landing';
  if (why) el.className = 'over';
  const line = why === 'over' ? TEXT.landing.gameOver : why === 'missing' ? TEXT.landing.noSuchWorld : '';
  el.innerHTML = `${why ? '' : '<div class="bg"></div><div class="shade"></div>'}<div class="panel"><h1>${TEXT.game.name}</h1>${line ? `<p>${line}</p>` : ''}</div>`;
  // Typing here is not playing: the end screens sit over the game, whose listeners are on window.
  el.addEventListener('keydown', (e) => e.stopPropagation());
  document.body.append(el);
  if (!why) music(el);
  const view = document.createElement('div');
  view.className = 'view';
  el.querySelector('.panel')!.append(view);
  const show = (v: HTMLElement) => view.replaceChildren(v);
  const intro = () => {
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    buttons.innerHTML = `<button class="join">${TEXT.landing.join}</button><button class="create">${TEXT.landing.create}</button>${why ? '' : `<button class="optionsBtn">${TEXT.menu.options}</button>`}`;
    buttons.querySelector('.join')!.addEventListener('click', () => show(joinView(() => show(intro()))));
    buttons.querySelector('.create')!.addEventListener('click', () => show(make(() => show(intro()))));
    buttons.querySelector('.optionsBtn')?.addEventListener('click', options);
    return buttons;
  };
  show(intro());
}

/** Joining: your games or the public ones (tabs), the box for a game's code, and back to the start. */
function joinView(back: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'joinView';
  el.innerHTML = `<div class="seg tabs"><button class="mine">${TEXT.landing.recent}</button><button class="pub">${TEXT.landing.browse}</button></div>
<div class="code"></div><div class="seg sorts"></div><div class="games"></div><div class="buttons"><button class="back">${TEXT.landing.back}</button></div>`;
  el.querySelector('.code')!.replaceWith(codeBox());
  const mine = el.querySelector<HTMLButtonElement>('.mine')!;
  const pub = el.querySelector<HTMLButtonElement>('.pub')!;
  const sorts = el.querySelector<HTMLElement>('.sorts')!;
  const box = el.querySelector<HTMLElement>('.games')!;
  const tab = (isPublic: boolean) => {
    mine.classList.toggle('on', !isPublic);
    pub.classList.toggle('on', isPublic);
    sorts.replaceChildren();
    sorts.hidden = !isPublic;
    box.replaceChildren();
    if (isPublic) browse(box, sorts);
    else recent(box);
  };
  mine.addEventListener('click', () => tab(false));
  pub.addEventListener('click', () => tab(true));
  el.querySelector('.back')!.addEventListener('click', back);
  tab(false);
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

/** A game in one of the lists: its name, lives, bosses beaten and players; on the right `when` and who's on now. */
function gameRow(s: WorldStats, when: string, you?: string): HTMLLIElement {
  const n = BOSS_KINDS.filter((_, i) => s.beaten & (1 << i)).length;
  const bosses = '◆'.repeat(n) + '◇'.repeat(BOSS_KINDS.length - n);
  const life = s.lives > 0 ? TEXT.landing.lives(s.lives) : TEXT.landing.gameOver;
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = `?w=${encodeURIComponent(s.id)}`;
  if (s.lives <= 0) a.className = 'dead';
  a.innerHTML = `<span class="id"></span><span class="when"></span><span class="stats"></span><span class="when on"></span>`;
  const [id, right, line, on] = a.querySelectorAll('span');
  id.textContent = s.locked ? `${s.name} ${TEXT.landing.lockedMark}` : s.name;
  right.textContent = when;
  line.textContent = [life, bosses, TEXT.landing.players(s.players)].join('  ·  ');
  if (s.online) on.textContent = TEXT.landing.online(s.online);
  if (you) {
    const y = document.createElement('span');
    y.className = 'you';
    y.textContent = you;
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
  const list = joined().filter((j) => j.id !== WORLD_ID);
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
      const s = byId.get(j.id)!;
      const played = Math.floor((s.played ?? 0) / 60_000);
      const you = s.you || played ? TEXT.landing.you(s.you ?? '', played) : undefined;
      return gameRow(s, TEXT.landing.ago(Math.floor((Date.now() - j.at) / 60_000)), you);
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
    gameList(box, [...list].sort(SORTS[sort]).map((s) => gameRow(s, TEXT.landing.seats(s.online, s.max))), TEXT.landing.noGames);
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
    location.assign(gameUrl(id));
  });
  input.addEventListener('input', () => input.classList.remove('bad'));
  return form;
}

/** Making a game: name, public or private, most players, a password; then its link to share and join. */
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
      shareLink(form, gameUrl(out.id));
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

/** The new game's link in place of `what`: copy it to share, Join to go there yourself. */
function shareLink(what: HTMLElement, url: string) {
  what.parentElement?.querySelector('p')?.remove();
  const row = document.createElement('div');
  row.className = 'link';
  row.innerHTML = `<input readonly><button>${TEXT.landing.copy}</button>`;
  const join = document.createElement('button');
  join.textContent = TEXT.landing.join;
  what.replaceWith(row, join);
  const input = row.querySelector('input')!;
  const copy = row.querySelector('button')!;
  input.value = url;
  input.addEventListener('focus', () => input.select());
  input.focus();
  copy.addEventListener('click', async () => {
    input.select();
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      document.execCommand('copy');
    }
    copy.textContent = TEXT.landing.copied;
  });
  join.addEventListener('click', () => location.assign(url));
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
  el.querySelector('button')!.addEventListener('click', () => {
    el.remove();
    Promise.resolve(document.querySelector('canvas')?.requestPointerLock()).catch(() => {});
  });
}
