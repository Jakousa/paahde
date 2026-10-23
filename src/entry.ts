// Page entry: a URL with a world (?w=<id>, shared/world.ts) opens its lobby (src/lobby.ts), which plays it; without
// one, the landing page. The dev worlds (the lab, the bench) and perf runs (tools/perf.ts, ?perf=) go straight in.
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

if (LAB || BENCH || new URLSearchParams(location.search).has('perf')) play();
else if (WORLD_ID_RE.test(WORLD_ID)) import('./lobby').then((m) => m.lobby(play));
else import('./landing').then((m) => m.landing());
