// Page entry: a URL with a world (?w=<id>, shared/world.ts) plays it; without one, the landing page.
import { WORLD_ID, WORLD_ID_RE } from '../shared/world.ts';

if (WORLD_ID_RE.test(WORLD_ID)) import('./main');
else import('./landing').then((m) => m.landing());
