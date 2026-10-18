// Page entry: a URL with a world (?w=<id>, shared/world.ts) plays it; without one, the landing page.
import { WORLD_ID, WORLD_ID_RE } from '../shared/world.ts';
import { prologue } from './prologue';
import { TEXT } from '../shared/text.ts';

document.title = TEXT.game.title;

if (WORLD_ID_RE.test(WORLD_ID)) {
  prologue.start(); // on the loading cover while the game downloads and builds (src/prologue.ts)
  import('./main');
} else import('./landing').then((m) => m.landing());
