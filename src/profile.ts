// You as others see you: your name and colour, chosen on the main menu or a game's lobby (src/landing.ts,
// src/lobby.ts), and your look (shared/look.ts, chosen on the main menu: src/lookView.ts), kept in this browser and
// sent with every join ('hello', src/net.ts). The name must pass
// shared/names.ts checkName, here as you type and again on the server. Also the browser's id (a secret: it is who you
// are to every world) and the keys of the locked games you've given the password for (server/registry.ts).
import { NAME_MAX } from '../shared/protocol.ts';
import { checkName, PLAYER_NAME } from '../shared/names.ts';
import { TEXT } from '../shared/text.ts';
import { isLook } from '../shared/look.ts';

const NAME_KEY = 'dadajam.name';
const LOOK_KEY = 'dadajam.look';
const COLOR_KEY = 'dadajam.color';
const keyOf = (world: string) => `dadajam.key.${world}`;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

export function getBrowserId(): string {
  try {
    let id = localStorage.getItem('dadajam.browserId');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('dadajam.browserId', id);
    }
    return id;
  } catch {
    return crypto.randomUUID(); // storage blocked: play as a fresh guest
  }
}

const randomColor = () => Math.floor(Math.random() * 0x1000000);

/** Your name as last typed ('' none yet; the lobby won't let you in unless it passes nameOk). */
export const myName = () => read(NAME_KEY) ?? '';
/** Your colour, picked at random the first time. */
export function myColor(): number {
  const c = parseInt(read(COLOR_KEY) ?? '', 16);
  if (Number.isInteger(c) && c >= 0 && c <= 0xffffff) return c;
  const n = randomColor();
  write(COLOR_KEY, n.toString(16));
  return n;
}
export const nameOk = () => checkName(myName(), PLAYER_NAME).ok;

/** Your look (shared/look.ts packLook): the plain one until you choose. */
export function myLook(): number {
  const n = Number(read(LOOK_KEY));
  return isLook(n) ? n : 0;
}
export const setMyLook = (look: number) => write(LOOK_KEY, isLook(look) ? String(look) : null);

/** The key to a locked game, if this browser has one ('' none). */
export const worldKey = (world: string) => read(keyOf(world)) ?? '';
export const setWorldKey = (world: string, key: string) => write(keyOf(world), key || null);

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** The name box, colour well and dice; `changed` hears whether the name is fit after every edit. `locked`: the name
 *  and colour you already have in a game (chosen on your first join there), shown and not to be changed. */
export function profileForm(changed?: (ok: boolean) => void, locked?: { name: string; color: number }) {
  const el = document.createElement('div');
  el.className = 'profile';
  el.innerHTML = `<div class="row"><input class="name" maxlength="${NAME_MAX}" autocomplete="off" spellcheck="false"
data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"><input class="color" type="color"><button type="button" class="dice"></button></div><div class="why"></div>`;
  const name = el.querySelector<HTMLInputElement>('.name')!;
  const color = el.querySelector<HTMLInputElement>('.color')!;
  const dice = el.querySelector<HTMLButtonElement>('.dice')!;
  const why = el.querySelector<HTMLElement>('.why')!;
  name.placeholder = TEXT.landing.yourName;
  color.title = TEXT.landing.colour;
  dice.textContent = TEXT.landing.randomColour;
  name.value = myName();
  color.value = hex(myColor());
  if (locked) {
    name.value = locked.name;
    color.value = hex(locked.color);
    name.disabled = color.disabled = true;
    dice.remove();
    el.classList.add('locked');
    return { el, flag: () => true };
  }

  const check = (show: boolean) => {
    const c = checkName(name.value, PLAYER_NAME);
    write(NAME_KEY, c.ok ? c.name : name.value.trim());
    why.textContent = c.ok || !show ? '' : TEXT.landing.nameWhy[c.why];
    name.classList.toggle('bad', !c.ok && show);
    changed?.(c.ok);
    return c.ok;
  };
  name.addEventListener('input', () => check(name.value.length > 0));
  name.addEventListener('blur', () => check(name.value.length > 0));
  color.addEventListener('input', () => write(COLOR_KEY, color.value.slice(1)));
  dice.addEventListener('click', () => {
    const c = randomColor();
    color.value = hex(c);
    write(COLOR_KEY, c.toString(16));
  });
  // Typing here is not playing: keep keys from the game's listeners on window (the end screens sit over the game).
  el.addEventListener('keydown', (e) => e.stopPropagation());
  queueMicrotask(() => check(name.value.length > 0));
  return {
    el,
    /** Say what's wrong with the name, focus it; false if there's something wrong. */
    flag(): boolean {
      const ok = check(true);
      if (!ok) name.focus();
      return ok;
    },
  };
}
