// Into the game once it has loaded (nameGate().loaded(), src/main.ts). Your name and colour were chosen before joining
// (src/profile.ts, sent in 'hello'); until this says ready the server keeps us invisible and mortal-proof: net.ready().
import type { Net } from './net';
import { capture } from './input';

/** Returns the gate main.ts opens with `loaded()` when the world is drawn and the loading cover is leaving. */
export function nameGate(net: Net, canvas: HTMLElement) {
  /** The Esc menu or the minigame is open: the loading screen ending must not take the mouse from them. */
  const busy = () => !!document.querySelector('#menu.open, #play');
  return { loaded };
  function loaded() {
    net.ready();
    if (!busy()) capture(canvas); // straight into the game (works while the last click is fresh)
  }
}
