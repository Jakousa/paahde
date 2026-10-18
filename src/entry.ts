// Page entry: a URL with a world (?w=<id>, shared/world.ts) plays it; without one, the landing page.
import { WORLD_ID, WORLD_ID_RE } from '../shared/world.ts';
import { loading } from './loadingGame';
import { TEXT } from '../shared/text.ts';

document.title = TEXT.game.title;

if (WORLD_ID_RE.test(WORLD_ID)) {
  loading.start(); // something to play on the loading cover while the game downloads and builds (src/loadingGame.ts)
  import('./main');
} else import('./landing').then((m) => m.landing());
