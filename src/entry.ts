// Page entry: a URL with a world (?w=<id>, shared/world.ts) opens its lobby (src/lobby.ts), which plays it; without
// one, the landing page (both the main menu, src/landing.ts). The dev worlds (the lab, the bench), perf runs
// (tools/perf.ts, ?perf=) and joins from another game's lobby (&join) go straight in.
import { BENCH, LAB, WORLD_ID, WORLD_ID_RE } from '../shared/world.ts';
import { prologue } from './prologue';
import { TEXT } from '../shared/text.ts';

document.title = TEXT.game.title;

// The dev test lab (?w=lab, shared/lab.ts) opens with the debug menu (F3) on.
if (LAB && !location.search.includes('debug')) history.replaceState(null, '', `${location.pathname}${location.search}&debug${location.hash}`);

const play = () => {
  prologue.start(); // on the loading cover while the game downloads and builds (src/prologue.ts)
  import('./main');
};

const q = new URLSearchParams(location.search);
if (LAB || BENCH || q.has('perf')) play();
else if (WORLD_ID_RE.test(WORLD_ID) && q.has('join')) {
  // From another game's lobby (src/lobby.ts): the checks are done, straight in. The address is the game's own link again.
  q.delete('join');
  history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);
  play();
} else import('./landing').then((m) => m.landing(undefined, WORLD_ID_RE.test(WORLD_ID) ? { v: 'lobby', id: WORLD_ID } : undefined, play));
