// A game's lobby: what a game's link (?w=<id>) opens before the game loads (src/entry.ts). Its name, lives left,
// bosses beaten and who's on, its code (click to copy, to share), your name and colour (src/profile.ts; Join waits for
// a name that will do; locked once you've joined the game: they're yours there for good), and the password if it has one and this browser has no key for it yet (server/index.ts /api/worlds/<id>/key). Join loads
// the game. A game that turned us away (src/net.ts onEnded: locked, full, our name) comes back here saying why.
import { BOSS_KINDS } from '../shared/bosses.ts';
import type { WorldStats } from '../shared/protocol.ts';
import { TEXT } from '../shared/text.ts';
import { WORLD_ID } from '../shared/world.ts';
import { copies } from './copy';
import { landing, landingStyle, music } from './landing';
import { getBrowserId, nameOk, profileForm, setWorldKey, worldKey } from './profile';

/** Your name and colour in this game if you've joined it before (they're kept: server/world.ts join), else null. */
async function yours(): Promise<{ name: string; color: number } | null> {
  try {
    const res = await fetch('api/worlds/mine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [WORLD_ID], browserId: getBrowserId() }),
    });
    const [s] = (await res.json()) as WorldStats[];
    return s?.you && s.color !== undefined ? { name: s.you, color: s.color } : null;
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

/** Show the lobby; `play` loads the game once Join is pressed. */
export async function lobby(play: () => void) {
  let s: WorldStats;
  try {
    const res = await fetch(`api/worlds/${encodeURIComponent(WORLD_ID)}`);
    if (res.status === 404) return landing('missing');
    if (!res.ok) throw new Error(String(res.status));
    s = await res.json();
  } catch {
    return play(); // can't ask: try the game itself, which says if something's wrong
  }
  const me = await yours();
  let why: Refused | null = null;
  try {
    why = sessionStorage.getItem(REFUSED_KEY) as Refused | null;
    sessionStorage.removeItem(REFUSED_KEY);
  } catch {}

  landingStyle();
  const el = document.createElement('div');
  el.id = 'landing';
  el.innerHTML = `<div class="bg"></div><div class="shade"></div><div class="panel"><h1>${TEXT.game.name}</h1><p class="gname"></p><p class="stats"></p><button class="codeChip"></button></div>`;
  const code = el.querySelector<HTMLButtonElement>('.codeChip')!;
  code.textContent = TEXT.landing.codeOf(WORLD_ID);
  copies(code, () => WORLD_ID);
  document.body.append(el);
  music(el);
  const panel = el.querySelector<HTMLElement>('.panel')!;
  el.querySelector('.gname')!.textContent = s.locked ? `${s.name} ${TEXT.landing.lockedMark}` : s.name;
  const n = BOSS_KINDS.filter((_, i) => s.beaten & (1 << i)).length;
  const life = s.lives > 0 ? TEXT.landing.lives(s.lives) : TEXT.landing.gameOver;
  el.querySelector('.stats')!.textContent = [life, '◆'.repeat(n) + '◇'.repeat(BOSS_KINDS.length - n), TEXT.landing.seats(s.online, s.max), TEXT.landing.players(s.players), s.public ? TEXT.landing.public : TEXT.landing.private].join('  ·  ');

  const join = document.createElement('button');
  const profile = profileForm((ok) => (join.disabled = !ok || !open), me ?? undefined);
  panel.append(profile.el);
  const pw = document.createElement('input');
  pw.type = 'password';
  pw.placeholder = TEXT.landing.password;
  pw.autocomplete = 'current-password';
  pw.maxLength = 64;
  const needsPw = s.locked && !worldKey(WORLD_ID);
  if (needsPw) panel.append(pw);
  const note = document.createElement('div');
  note.className = 'why';
  panel.append(note);
  const open = s.lives > 0 && s.online < s.max;
  if (s.online >= s.max || why === 'full') note.textContent = TEXT.landing.full;
  if (why === 'locked') note.textContent = TEXT.landing.wrongPassword;
  join.textContent = TEXT.landing.join;
  join.disabled = !open || (!me && !nameOk());
  const back = document.createElement('button');
  back.textContent = TEXT.landing.menu;
  back.addEventListener('click', () => location.assign(location.pathname));
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  buttons.append(join, back);
  panel.append(buttons);
  if (why === 'name') profile.flag();
  else (needsPw ? pw : join).focus();

  const go = async () => {
    if (join.disabled || !profile.flag()) return;
    if (needsPw && !worldKey(WORLD_ID)) {
      join.disabled = true;
      try {
        const res = await fetch(`api/worlds/${encodeURIComponent(WORLD_ID)}/key`, {
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
        setWorldKey(WORLD_ID, ((await res.json()) as { key: string }).key);
      } catch {
        join.disabled = false;
        note.textContent = TEXT.landing.failed;
        return;
      }
    }
    el.remove();
    play();
  };
  join.addEventListener('click', go);
  pw.addEventListener('input', () => pw.classList.remove('bad'));
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && go());
}
