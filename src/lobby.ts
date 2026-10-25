// A game's lobby, a view of the main menu (src/landing.ts): what a game's link (?w=<id>) opens, and where picking a
// game in the lists or typing its code leads, without loading a page. Its name, lives left, bosses beaten and who's on,
// its code (click to copy, to share), your name and colour there once you've joined it (src/profile.ts, locked: they're
// yours there for good), and the password if it has one and this browser has no key for it yet (server/index.ts
// /api/worlds/<id>/key). Join on your first time in a game goes through character creation (src/lookView.ts: your
// look, name and colour) first. Join loads the game: here if the page is the game's own,
// else its page with &join (src/entry.ts goes straight in). Back goes to the view you came from. A game that turned
// us away (src/net.ts onEnded: locked, full, our name) comes back here saying why.
import type { WorldStats } from '../shared/protocol.ts';
import { TEXT } from '../shared/text.ts';
import { WORLD_ID } from '../shared/world.ts';
import { copies } from './copy';
import { crowdEl, dot, leave, lockMark, playedEl, statsLine, uptimeEl } from './landing';
import { lookView } from './lookView';
import { getBrowserId, profileForm, setWorldKey, worldKey } from './profile';

/** Your name and colour in game `id` if you've joined it before (they're kept: server/world.ts join), else null. */
async function yours(id: string): Promise<{ name: string; color: number; played: number } | null> {
  try {
    const res = await fetch('api/worlds/mine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], browserId: getBrowserId() }),
    });
    const [s] = (await res.json()) as WorldStats[];
    return s?.you && s.color !== undefined ? { name: s.you, color: s.color, played: s.played ?? 0 } : null;
  } catch {
    return null;
  }
}

const REFUSED_KEY = 'dadajam.refused';
type Refused = 'locked' | 'full' | 'name';

/** The game turned us away (src/main.ts net.onEnded): back to the lobby, which says why. */
export function refused(why: Refused) {
  if (why === 'locked') setWorldKey(WORLD_ID, ''); // a stale key (the password changed): ask again
  try {
    sessionStorage.setItem(REFUSED_KEY, why);
  } catch {}
  location.reload();
}

/** The lobby of game `id`, filled in once the server says how it is; `play` loads the game in this page (only when
 *  the page is that game's own). */
export function lobbyView(id: string, back: () => void, play?: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'view';
  const backBtn = document.createElement('button');
  backBtn.dataset.uiBack = '';
  backBtn.textContent = TEXT.landing.back;
  backBtn.addEventListener('click', back);
  fill(el, id, backBtn, play);
  return el;
}

async function fill(el: HTMLElement, id: string, backBtn: HTMLButtonElement, play?: () => void) {
  let s: WorldStats;
  try {
    const res = await fetch(`api/worlds/${encodeURIComponent(id)}`);
    if (res.status === 404) {
      const p = document.createElement('p');
      p.textContent = TEXT.landing.noSuchWorld;
      return el.replaceChildren(p, backBtn);
    }
    if (!res.ok) throw new Error(String(res.status));
    s = await res.json();
  } catch {
    if (play) return play(); // can't ask: try the game itself, which says if something's wrong
    const p = document.createElement('p');
    p.textContent = TEXT.landing.failed;
    return el.replaceChildren(p, backBtn);
  }
  const me = await yours(id);
  if (!el.isConnected) return; // gone on to another view meanwhile
  let why: Refused | null = null;
  if (play) {
    try {
      why = sessionStorage.getItem(REFUSED_KEY) as Refused | null;
      sessionStorage.removeItem(REFUSED_KEY);
    } catch {}
  }

  const gname = document.createElement('p');
  gname.className = 'gname';
  gname.textContent = s.name;
  if (s.locked) gname.append(' ', lockMark());
  const stats = document.createElement('p');
  stats.className = 'stats';
  const line = document.createElement('span');
  statsLine(s, line);
  // As the Esc menu's: your time there by the hourglass (once you've played), the game's by the clock.
  stats.replaceChildren(line, dot(), ...(me ? [playedEl(me.played), dot()] : []), uptimeEl(s), dot(), crowdEl(s), dot(), s.public ? TEXT.landing.public : TEXT.landing.private);
  const code = document.createElement('button');
  code.className = 'codeChip';
  code.dataset.tip = TEXT.menu.server.code;
  code.textContent = TEXT.landing.codeOf(id);
  copies(code, () => id);

  const join = document.createElement('button');
  const open = s.lives > 0 && s.online < s.max;
  const parts: HTMLElement[] = [gname, stats, code];
  if (me) parts.push(profileForm(undefined, me).el);
  const pw = document.createElement('input');
  pw.type = 'password';
  pw.placeholder = TEXT.landing.password;
  pw.autocomplete = 'current-password';
  pw.maxLength = 64;
  const needsPw = s.locked && !worldKey(id);
  if (needsPw) parts.push(pw);
  const note = document.createElement('div');
  note.className = 'why';
  parts.push(note);
  if (s.online >= s.max || why === 'full') note.textContent = TEXT.landing.full;
  if (why === 'locked') note.textContent = TEXT.landing.wrongPassword;
  join.textContent = TEXT.landing.join;
  join.disabled = !open;
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  buttons.append(join, backBtn);
  parts.push(buttons);
  const lobby = () => {
    el.replaceChildren(...parts);
    (needsPw && !worldKey(id) ? pw : join).focus();
  };
  lobby();

  const enter = () => {
    // The world is chosen when the page loads (shared/world.ts): a game other than the page's own needs its page.
    if (!play) return location.assign(`${location.pathname}?w=${encodeURIComponent(id)}&join`);
    leave();
    play();
  };
  /** Character creation, on a first join (and again if the game turned the name away). */
  const create = (flag = false) => el.replaceChildren(lookView(lobby, { go: enter, flag }));
  if (why === 'name' && !me) create(true);

  const go = async () => {
    if (join.disabled) return;
    if (needsPw && !worldKey(id)) {
      join.disabled = true;
      try {
        const res = await fetch(`api/worlds/${encodeURIComponent(id)}/key`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw.value }),
        });
        join.disabled = false;
        if (!res.ok) {
          note.textContent = res.status === 429 ? TEXT.landing.busy : TEXT.landing.wrongPassword;
          pw.classList.add('bad');
          return pw.select();
        }
        setWorldKey(id, ((await res.json()) as { key: string }).key);
      } catch {
        join.disabled = false;
        note.textContent = TEXT.landing.failed;
        return;
      }
    }
    if (me) enter();
    else create();
  };
  join.addEventListener('click', go);
  pw.addEventListener('input', () => pw.classList.remove('bad'));
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && go());
}
