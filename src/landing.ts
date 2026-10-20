// The landing page (no world in the URL) and the end screens over the game (game over, unknown world):
// a title and one button that makes a new world (server/index.ts /api/worlds) and shows its link to copy
// and share, and to join from. Also the victory screen (every boss beaten), which goes away again: the
// world plays on. The landing page plays the desert guitar (the game's outdoor music, src/music.ts) once
// the browser lets it, after the first click or key. Under the button, the worlds this browser joined (kept in
// localStorage when the server says hello), newest first, each with how it's doing (server/index.ts GET api/worlds).
import { audio } from './audio';
import { BOSS_KINDS } from '../shared/bosses.ts';
import type { WorldStats } from '../shared/protocol.ts';
import { TEXT } from '../shared/text.ts';
import { WORLD_ID } from '../shared/world.ts';
import { MENU_CSS, bindOptions, optionsHtml } from './options';

const css = `
#landing { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; color: #e8d2ae;
  background: #4a2414; font-family: var(--mono); overflow: hidden; }
#landing .bg { position: absolute; inset: -3%; background: url(./landing.svg) 72% bottom / cover; animation: landing-drift 60s ease-in-out infinite alternate; }
#landing .shade { position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(ellipse 80% 70% at 50% 55%, transparent 60%, rgba(30, 14, 8, .45) 100%); }
#landing.over .bg, #landing.over .shade { display: none; }
#landing.over { background: rgba(17, 10, 6, 0.82); }
#landing .panel { position: relative; display: grid; justify-items: center; gap: 30px; text-align: center; padding: 16px;
  transform: translateY(-18vh); animation: landing-in 1.6s ease-out both; }
#landing h1 { margin: 0; font: clamp(40px, 7vw, 88px) var(--title); letter-spacing: .3em;
  margin-right: -.3em; color: #fff4d0;
  text-shadow: 0 0 40px rgba(255, 179, 71, .45), 0 0 12px rgba(140, 50, 10, .5), 0 2px 3px rgba(60, 20, 5, .45); }
#landing p { margin: 0; font: 14px var(--title); letter-spacing: .2em; color: #fff4d0; text-shadow: 0 1px 2px rgba(60, 20, 5, .6); }
#landing .link { display: flex; gap: 0; }
#landing input { font: 14px var(--mono); width: min(64vw, 380px); padding: 12px 14px; border: 1px solid rgba(255, 244, 208, .5);
  border-right: 0; border-radius: 2px 0 0 2px; color: #2a120a; background: rgba(255, 244, 208, .92); outline: none; }
#landing .link button { border-radius: 0 2px 2px 0; }
#landing button { font: 13px var(--mono); padding: 12px 30px; color: #fff4d0; background: rgba(42, 18, 10, .55);
  border: 1px solid rgba(255, 244, 208, .45); border-radius: 2px; cursor: pointer; letter-spacing: .3em;
  text-transform: uppercase; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  transition: background .25s, border-color .25s, color .25s; }
#landing button:hover { background: rgba(255, 244, 208, .92); border-color: #fff4d0; color: #2a120a; }
#landing button:disabled { opacity: .5; cursor: default; }
#landing .recent { display: grid; gap: 8px; width: min(88vw, 440px); }
#landing .recent h2 { margin: 0 0 2px; font: 12px var(--title); letter-spacing: .25em; text-transform: uppercase; color: rgba(255, 244, 208, .75); }
#landing .recent ol { display: grid; gap: 6px; margin: 0; padding: 0 2px; list-style: none; max-height: 30vh; overflow-y: auto; }
#landing .recent a { display: grid; grid-template-columns: 1fr auto; gap: 2px 16px; padding: 10px 14px; text-align: left;
  color: #fff4d0; text-decoration: none; background: rgba(42, 18, 10, .55); border: 1px solid rgba(255, 244, 208, .25);
  border-radius: 2px; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); transition: background .25s, border-color .25s, color .25s; }
#landing .recent a:hover { background: rgba(255, 244, 208, .92); border-color: #fff4d0; color: #2a120a; }
#landing .recent a.dead { opacity: .55; }
#landing .recent .id { font: 14px var(--mono); letter-spacing: .1em; }
#landing .recent .when, #landing .recent .stats { font: 12px var(--mono); opacity: .8; }
#landing .recent .when { text-align: right; }
#landing .recent .on { color: #9fe39a; }
#landing .recent a:hover .on { color: #2f6b2a; }
@keyframes landing-drift { from { transform: scale(1) translateX(0); } to { transform: scale(1.06) translateX(-1.5%); } }
@keyframes landing-in { from { opacity: 0; transform: translateY(calc(-18vh + 12px)); } }
@media (prefers-reduced-motion: reduce) { #landing .bg, #landing .panel { animation: none; } }
`;

/** Show the page; `why` puts it over the game as an end screen. */
export function landing(why?: 'over' | 'missing') {
  if (document.getElementById('landing')) return;
  document.exitPointerLock?.();
  document.getElementById('cover')?.remove();
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const el = document.createElement('div');
  el.id = 'landing';
  if (why) el.className = 'over';
  const line = why === 'over' ? TEXT.landing.gameOver : why === 'missing' ? TEXT.landing.noSuchWorld : '';
  el.innerHTML = `${why ? '' : '<div class="bg"></div><div class="shade"></div>'}<div class="panel"><h1>${TEXT.game.name}</h1>${line ? `<p>${line}</p>` : ''}<button class="start">${TEXT.landing.start}</button><button class="optionsBtn">${TEXT.menu.options}</button></div>`;
  document.body.append(el);
  if (!why) music(el);
  recent(el.querySelector('.panel')!);
  const button = el.querySelector<HTMLButtonElement>('.start')!;
  if (!why) el.querySelector('.optionsBtn')!.addEventListener('click', options);
  else el.querySelector('.optionsBtn')!.remove();
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const res = await fetch('api/worlds', { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      const { id } = (await res.json()) as { id: string };
      shareLink(el, `${location.origin}${location.pathname}?w=${id}`);
    } catch {
      button.disabled = false;
    }
  });
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

/** The list of worlds joined before, once the server says how they're doing; worlds that are gone drop out. */
async function recent(panel: HTMLElement) {
  const list = joined().filter((j) => j.id !== WORLD_ID);
  if (!list.length) return;
  let stats: WorldStats[];
  try {
    const res = await fetch(`api/worlds?ids=${list.map((j) => j.id).join(',')}`);
    if (!res.ok) return;
    stats = await res.json();
  } catch {
    return;
  }
  const byId = new Map(stats.map((s) => [s.id, s]));
  saveJoined(joined().filter((j) => j.id === WORLD_ID || byId.has(j.id)));
  const rows = list.filter((j) => byId.has(j.id));
  if (!rows.length || !panel.isConnected) return;
  const box = document.createElement('div');
  box.className = 'recent';
  box.innerHTML = `<h2>${TEXT.landing.recent}</h2><ol></ol>`;
  const ol = box.querySelector('ol')!;
  for (const j of rows) {
    const s = byId.get(j.id)!;
    const n = BOSS_KINDS.filter((_, i) => s.beaten & (1 << i)).length;
    const bosses = '◆'.repeat(n) + '◇'.repeat(BOSS_KINDS.length - n);
    const life = s.lives > 0 ? `♥ ${s.lives}` : TEXT.landing.gameOver;
    const parts = [life, bosses, TEXT.landing.players(s.players)];
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `?w=${encodeURIComponent(j.id)}`;
    if (s.lives <= 0) a.className = 'dead';
    a.innerHTML = `<span class="id"></span><span class="when"></span><span class="stats"></span><span class="when on"></span>`;
    const [id, when, line, on] = a.querySelectorAll('span');
    id.textContent = j.id;
    when.textContent = TEXT.landing.ago(Math.floor((Date.now() - j.at) / 60_000));
    line.textContent = parts.join('  ·  ');
    if (s.online) on.textContent = TEXT.landing.online(s.online);
    li.append(a);
    ol.append(li);
  }
  // Below the buttons, which stay where they are when the list comes in.
  panel.append(box);
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
  bindOptions(menu, {});
  const close = () => menu.remove();
  menu.querySelector('.optBack')!.addEventListener('click', close);
  menu.addEventListener('pointerdown', (e) => e.target === menu && close());
}

/** "Desert ambience" (src/music.ts DESERT_AMBIENCE: exactly 112 s, loops whole) through the music slider,
 * faded in; it fades out if the page goes away without leaving (the victory screen's Play on). */
function music(el: HTMLElement) {
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

/** The new world's link in place of the button: copy it to share, Join to go there yourself. */
function shareLink(el: HTMLElement, url: string) {
  el.querySelector('p')?.remove();
  const row = document.createElement('div');
  row.className = 'link';
  row.innerHTML = `<input readonly><button>${TEXT.landing.copy}</button>`;
  const join = document.createElement('button');
  join.textContent = TEXT.landing.join;
  // In the button's place: the end screens have no Options button to go before.
  el.querySelector('.start')!.replaceWith(row, join);
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
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const el = document.createElement('div');
  el.id = 'landing';
  el.className = 'over';
  el.innerHTML = `<div class="panel"><h1>${TEXT.game.name}</h1><p>${TEXT.landing.won}</p><button>${TEXT.landing.playOn}</button></div>`;
  document.body.append(el);
  el.querySelector('button')!.addEventListener('click', () => {
    el.remove();
    style.remove();
    Promise.resolve(document.querySelector('canvas')?.requestPointerLock()).catch(() => {});
  });
}
