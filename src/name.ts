// Your name, asked once per world, once the game has loaded (nameGate().loaded(), src/main.ts): a small box over the
// blurred game, filled with the name you gave last time anywhere. Enter or the button keeps it, Esc or Skip goes
// without one; either way the server stores the answer and doesn't ask again. Names show in chat (src/chat.ts).
// Until that answer (or at once, if the world already has one) the server keeps us invisible and mortal-proof: net.ready().
import { NAME_MAX } from '../shared/protocol.ts';
import type { Net } from './net';
import { capture } from './input';
import { TEXT } from '../shared/text.ts';

const NAME_KEY = 'dadajam.name';

const css = `
#name { position: fixed; inset: 0; z-index: 35; display: grid; place-items: center; background: rgba(17, 10, 6, 0.35);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); font-family: var(--mono); }
#name form { display: grid; gap: 10px; justify-items: center; }
#name .link { display: flex; }
#name input { font: 15px var(--mono); width: min(64vw, 260px); padding: 10px 12px; border: 0; border-radius: 2px 0 0 2px;
  color: #2a120a; background: #fff4d0; outline: none; }
#name button { font: 15px var(--mono); padding: 10px 22px; color: #fff4d0; background: #2a120a; border: 0;
  border-radius: 0 2px 2px 0; cursor: pointer; letter-spacing: .1em; }
#name button:hover { background: #4a2414; }
#name .skip { background: none; border-radius: 2px; font-size: 12px; padding: 4px 10px; opacity: .7;
  text-shadow: 0 1px 2px rgba(60, 20, 5, .6); }
#name .skip:hover { background: none; opacity: 1; }
`;

/** Returns the gate main.ts opens with `loaded()` when the world is drawn and the loading cover is leaving. */
export function nameGate(net: Net, canvas: HTMLElement) {
  return { loaded };
  /** The Esc menu or the minigame is open: the loading screen ending must not take the mouse or put a box over them. */
  const busy = () => !!document.querySelector('#menu.open, #play');
  function loaded() {
    if (!net.nameAsked) {
      net.ready();
      if (!busy()) capture(canvas); // straight into the game (works while the last click is fresh)
      return;
    }
    if (busy()) return void setTimeout(loaded, 250); // ask once they've closed it; until the answer nobody sees or can hurt them
    if (document.getElementById('name')) return;
    const style = document.createElement('style');
    style.textContent = css;
    const el = document.createElement('div');
    el.id = 'name';
    el.innerHTML = `<form><div class="link"><input placeholder="${TEXT.name.placeholder}" maxlength="${NAME_MAX}" autocomplete="off"
data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"
spellcheck="false"><button>${TEXT.name.go}</button></div><button type="button" class="skip">${TEXT.name.skip}</button></form>`;
    document.head.append(style);
    document.body.append(el);
    document.exitPointerLock?.();
    const input = el.querySelector('input')!;
    try {
      input.value = localStorage.getItem(NAME_KEY) ?? '';
    } catch {}
    input.focus();
    input.select();

    const done = (name: string) => {
      name = name.trim();
      net.setName(name);
      net.ready();
      if (name) {
        try {
          localStorage.setItem(NAME_KEY, name);
        } catch {}
      }
      el.remove();
      style.remove();
      capture(canvas);
    };
    el.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      done(input.value);
    });
    el.querySelector('.skip')!.addEventListener('click', () => done(''));
    // Every key stays in the box: the game's own listeners are on window, past this one.
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Escape') {
        e.preventDefault();
        done('');
      }
    });
  }
}
