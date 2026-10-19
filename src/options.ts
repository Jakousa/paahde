// The options (Esc menu → Options, and the main menu's Options before joining): tabs for gameplay, graphics and audio. Shared
// markup and wiring: the page that hosts it provides a `#menu` element (the styles are scoped to it, `MENU_CSS`) and the Back button.
import { setCounts, setMarkers, tdPrefs } from './teardown/prefs.ts';
import { audio } from './audio';
import { TEXT } from '../shared/text.ts';
import { FPS_LIMITS, SHADOW_FILTERS, SHADOW_DISTANCE_RANGE, SHADOW_MAPS, graphics, needsReload, onGraphics, setGraphics } from './graphics';
import { setFullscreen } from './input';

const STATS_KEY = 'dadajam.stats';
const AO_KEY = 'dadajam.ao';

export const MENU_CSS = `
#menu { position: fixed; inset: 0; z-index: 30; display: none; align-items: center; justify-content: center;
  background: rgba(12, 6, 2, 0.55); font: 12px var(--mono); color: #fff4e4; user-select: none; -webkit-user-select: none; }
#menu.open { display: flex; }
#menu .panel { width: min(340px, calc(100vw - 32px)); padding: 16px 18px 14px; border-radius: 8px;
  background: rgba(28, 15, 7, 0.92); box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.16), 0 10px 40px rgba(0, 0, 0, 0.5); }
#menu h2 { margin: 0 0 14px; font: 15px var(--title); letter-spacing: 0.18em; text-transform: uppercase; color: #ffd9a0; }
#menu h3 { margin: 16px 0 8px; font: 600 11px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.6; }
#menu button { width: 100%; padding: 8px; font: 600 13px var(--mono); letter-spacing: 0.08em; color: #2a160a;
  background: #ffd9a0; border: 0; border-radius: 5px; cursor: pointer; }
#menu button:hover { background: #ffe6bf; }
#menu .row { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
#menu .row > span:first-child { width: 80px; }
#menu input[type=range] { flex: 1; accent-color: #ffd9a0; }
#menu select { flex: 1; padding: 3px; font: 12px var(--mono); color: #ffd9a0; background: rgba(255, 217, 160, 0.14); border: 0; border-radius: 4px; }
#menu select option { background: #2a160a; }
#menu input[type=checkbox] { accent-color: #ffd9a0; margin: 0; }
#menu .val, #menu .aoval { width: 52px; text-align: right; opacity: 0.8; }
#menu .panel { max-height: calc(100vh - 32px); overflow-y: auto; }
#menu .keys { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; opacity: 0.85; }
#menu .binds { display: grid; grid-template-columns: 1fr 64px 64px; gap: 4px 6px; align-items: center; }
#menu .binds button { padding: 3px 0; font: 600 11px var(--mono); letter-spacing: 0; background: rgba(255, 217, 160, 0.14); color: #ffd9a0; }
#menu .binds button:hover { background: rgba(255, 217, 160, 0.28); }
#menu .binds button.listening { background: #ffd9a0; color: #2a160a; }
#menu .tip { position: fixed; display: none; padding: 6px 8px; border-radius: 5px; pointer-events: none; font-size: 11px; line-height: 1.4;
  background: rgba(20, 10, 4, 0.96); box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.2), 0 6px 18px rgba(0, 0, 0, 0.5); }
#menu .note { min-height: 16px; margin-top: 6px; opacity: 0.7; font-size: 11px; }
#menu .controls, #menu .options { display: none; }
#menu .panel.sub .controls, #menu .panel.opts .options { display: block; }
#menu .panel.sub .main, #menu .panel.opts .main { display: none; }
#menu .panel.opts ~ button.mini { display: none; }
#menu .tabs { display: flex; gap: 6px; margin: 14px 0 6px; }
#menu .tabs button { padding: 5px 0; font: 600 11px var(--mono); letter-spacing: 0.1em; text-transform: uppercase; background: rgba(255, 217, 160, 0.14); color: #ffd9a0; }
#menu .tabs button:hover { background: rgba(255, 217, 160, 0.28); }
#menu .tabs button.on { background: #ffd9a0; color: #2a160a; }
#menu .tabs button { flex: 1; }
#menu .pane { min-height: 96px; }
#menu .options .row > span:first-child { width: 140px; }
#menu button.reset { margin-top: 8px; background: transparent; color: #ffd9a0; box-shadow: 0 0 0 1px rgba(255, 217, 160, 0.3); }
#menu kbd { font: 600 11px var(--mono); color: #ffd9a0; }
#menu .foot { margin-top: 16px; padding-top: 10px; border-top: 1px solid rgba(255, 240, 220, 0.12); font-size: 11px;
  opacity: 0.6; line-height: 1.5; word-break: break-all; }
#menu .foot a { color: inherit; }
/* The minigame: just the machine, in the corner, with an even glow all round it that swells now and then. */
#menu button.mini { position: absolute; right: 26px; bottom: 26px; width: 72px; height: 54px; padding: 0; border-radius: 0;
  display: grid; place-items: center; background: none; box-shadow: none; transition: transform .15s; }
#menu button.mini:hover { background: none; transform: scale(1.08); }
#menu .panel.sub ~ button.mini { display: none; }
#menu button.mini svg { position: relative; width: 72px; height: 50px; overflow: visible; }
#menu button.mini svg * { transform-box: fill-box; transform-origin: center; }
#menu button.mini svg { filter: drop-shadow(0 0 4px rgba(255, 170, 70, 0.55)) drop-shadow(0 0 9px rgba(255, 140, 50, 0.35)); animation: miniShine 3.4s ease-in-out infinite; }
#menu button.mini .lid { animation: miniLid 3.4s ease-in-out infinite; }
#menu button.mini .tag { animation: miniTag 1.6s ease-in-out infinite; }
@keyframes miniShine {
  0%, 100% { filter: drop-shadow(0 0 4px rgba(255, 170, 70, 0.5)) drop-shadow(0 0 9px rgba(255, 140, 50, 0.3)); }
  40% { filter: drop-shadow(0 0 6px rgba(255, 205, 110, 1)) drop-shadow(0 0 16px rgba(255, 160, 60, 0.85)); }
}
@keyframes miniLid { 0%, 36%, 100% { transform: none; } 48% { transform: translateY(-2.5px) rotate(-1.5deg); } 60% { transform: none; } }
@keyframes miniTag { 50% { opacity: 0.4; } }
@media (prefers-reduced-motion: reduce) { #menu button.mini svg, #menu button.mini * { animation: none !important; } }
`;

export function statsPref(): boolean {
  try {
    return localStorage.getItem(STATS_KEY) === '1';
  } catch {
    return false;
  }
}

export function aoPref(): number {
  try {
    const saved = parseFloat(localStorage.getItem(AO_KEY) ?? '');
    if (Number.isFinite(saved)) return Math.min(Math.max(saved, 0), 1);
  } catch {}
  return 0.7;
}

/** The options view: a `.options` block with its Back button (`.optBack`, the host binds it). */
export function optionsHtml(): string {
  return `<div class="options"><h2>${TEXT.menu.options}</h2><button class="optBack">${TEXT.controls.back}</button>
<div class="tabs"><button class="tab on" data-tab="gameplay">${TEXT.menu.gameplay}</button><button class="tab" data-tab="graphics">${TEXT.menu.graphics}</button><button class="tab" data-tab="audio">${TEXT.menu.audio}</button></div>
<div class="pane" data-pane="gameplay">
<label class="row"><span>${TEXT.menu.showGuides}</span><input class="guides" type="checkbox"></label>
<label class="row"><span>${TEXT.menu.showCounts}</span><input class="counts" type="checkbox"></label>
<label class="row"><span>${TEXT.menu.showStats}</span><input class="stats" type="checkbox"></label></div>
<div class="pane" data-pane="graphics">
<label class="row" data-tip="${TEXT.menu.tips.display}"><span>${TEXT.menu.display}</span><select class="gDisplay"><option value="1">${TEXT.menu.fullscreen}</option><option value="0">${TEXT.menu.windowed}</option></select></label>
<label class="row" data-tip="${TEXT.menu.tips.fpsTarget}"><span>${TEXT.menu.fpsTarget}</span><input class="gFps" type="range" min="0" max="${FPS_LIMITS.length - 1}" step="1"><span class="val gFpsVal"></span></label>
<label class="row" data-tip="${TEXT.menu.tips.resolution}"><span>${TEXT.menu.resolution}</span><input class="gRes" type="range" min="0.01" max="1" step="0.01"><span class="val gResVal"></span></label>
<label class="row" data-tip="${TEXT.menu.tips.dynamicRes}"><span>${TEXT.menu.dynamicRes}</span><input class="gDyn" type="checkbox"></label>
<label class="row" data-tip="${TEXT.menu.tips.minRes}"><span>${TEXT.menu.minRes}</span><input class="gMin" type="range" min="0.01" max="1" step="0.01"><span class="val gMinVal"></span></label>
<label class="row" data-tip="${TEXT.menu.tips.occlusion}"><span>${TEXT.menu.occlusion}</span><input class="ao" type="range" min="0" max="1" step="0.01"><span class="aoval"></span></label>
<label class="row" data-tip="${TEXT.menu.tips.shadows}"><span>${TEXT.menu.shadows}</span><input class="gShadows" type="checkbox"></label>
<label class="row" data-tip="${TEXT.menu.tips.shadowDistance}"><span>${TEXT.menu.shadowDistance}</span><input class="gDist" type="range" min="${SHADOW_DISTANCE_RANGE[0]}" max="${SHADOW_DISTANCE_RANGE[1]}" step="50"><span class="val gDistVal"></span></label>
<label class="row" data-tip="${TEXT.menu.tips.cascades}"><span>${TEXT.menu.cascades}</span><input class="gCas" type="range" min="1" max="4" step="1"><span class="val gCasVal"></span></label>
<label class="row" data-tip="${TEXT.menu.tips.shadowDetail}"><span>${TEXT.menu.shadowDetail}</span><input class="gMap" type="range" min="0" max="${SHADOW_MAPS.length - 1}" step="1"><span class="val gMapVal"></span></label>
<label class="row" data-tip="${TEXT.menu.tips.shadowFilter}"><span>${TEXT.menu.shadowFilter}</span><input class="gFilt" type="range" min="0" max="${SHADOW_FILTERS.length - 1}" step="1"><span class="val gFiltVal"></span></label>
<label class="row" data-tip="${TEXT.menu.tips.shadowRefresh}"><span>${TEXT.menu.shadowRefresh}</span><input class="gRefresh" type="range" min="0" max="2" step="1"><span class="val gRefreshVal"></span></label>
<label class="row" data-tip="${TEXT.menu.tips.antialias}"><span>${TEXT.menu.antialias}</span><input class="gAa" type="checkbox"></label>
<div class="note gNote"></div></div>
<div class="pane" data-pane="audio">
<label class="row"><span>${TEXT.menu.volume}</span><input class="vol" type="range" min="0" max="1" step="0.01"><span class="val"></span></label>
<label class="row"><span>${TEXT.menu.music}</span><input class="music" type="range" min="0" max="1" step="0.01"><span class="val musicVal"></span></label></div></div>
`;
}

/** Wire every control in `root`. `onAo`: called with the occlusion level now and when it changes; `onStats`: the stats checkbox. */
export function bindOptions(root: HTMLElement, hooks: { onAo?: (level: number) => void; onStats?: (on: boolean) => void }) {
  const vol = root.querySelector<HTMLInputElement>('.vol')!;
  const val = root.querySelector<HTMLElement>('.val')!;
  const showVol = () => (val.textContent = `${Math.round(audio.volume * 100)}%`);
  vol.value = String(audio.volume);
  showVol();
  vol.addEventListener('input', () => {
    audio.setVolume(parseFloat(vol.value));
    showVol();
  });
  const music = root.querySelector<HTMLInputElement>('.music')!;
  const musicVal = root.querySelector<HTMLElement>('.musicVal')!;
  const showMusic = () => (musicVal.textContent = `${Math.round(audio.musicVolume * 100)}%`);
  music.value = String(audio.musicVolume);
  showMusic();
  music.addEventListener('input', () => {
    audio.setMusicVolume(parseFloat(music.value));
    showMusic();
  });
  const aoEl = root.querySelector<HTMLInputElement>('.ao')!;
  const aoVal = root.querySelector<HTMLElement>('.aoval')!;
  let aoLevel = aoPref();
  aoEl.value = String(aoLevel);
  aoVal.textContent = `${Math.round(aoLevel * 100)}%`;
  hooks.onAo?.(aoLevel);
  aoEl.addEventListener('input', () => {
    aoLevel = parseFloat(aoEl.value);
    aoVal.textContent = `${Math.round(aoLevel * 100)}%`;
    hooks.onAo?.(aoLevel);
    try {
      localStorage.setItem(AO_KEY, String(aoLevel));
    } catch {}
  });
  const gInputs = bindGraphics(root);
  const stats = root.querySelector<HTMLInputElement>('.stats')!;
  stats.checked = statsPref();
  stats.addEventListener('change', () => {
    hooks.onStats?.(stats.checked);
    try {
      localStorage.setItem(STATS_KEY, stats.checked ? '1' : '0');
    } catch {}
  });
  const guides = root.querySelector<HTMLInputElement>('.guides')!;
  guides.checked = tdPrefs.markers;
  guides.addEventListener('change', () => setMarkers(guides.checked));
  const counts = root.querySelector<HTMLInputElement>('.counts')!;
  counts.checked = tdPrefs.counts;
  counts.addEventListener('change', () => setCounts(counts.checked));

  // Options: a sub-view like the controls, with a tab for each group of settings.
  const tab = (name: string) => {
    for (const b of root.querySelectorAll<HTMLElement>('.tab')) b.classList.toggle('on', b.dataset.tab === name);
    for (const p of root.querySelectorAll<HTMLElement>('.pane')) p.style.display = p.dataset.pane === name ? '' : 'none';
  };
  tab('gameplay');
  for (const b of root.querySelectorAll<HTMLElement>('.tab')) b.addEventListener('click', () => (tab(b.dataset.tab!), b.blur()));
  bindTips(root);
  // Drop focus after using a control, or the arrow keys / space would keep nudging it.
  for (const input of [vol, music, aoEl, stats, guides, counts, ...gInputs]) input.addEventListener('change', () => input.blur());
}

/** The Graphics tab (src/graphics.ts): each control shows and sets one setting. Returns the inputs. */
function bindGraphics(root: HTMLElement): HTMLInputElement[] {
  const q = (c: string) => root.querySelector<HTMLInputElement>(c)!;
  const text = (c: string, t: string) => (root.querySelector<HTMLElement>(c)!.textContent = t);
  const note = root.querySelector<HTMLElement>('.gNote')!;
  const showNote = () => (note.textContent = needsReload() ? TEXT.menu.needsReload : '');
  const display = root.querySelector<HTMLSelectElement>('.gDisplay')!;
  display.value = graphics.fullscreen ? '1' : '0';
  onGraphics((g, changed) => changed === 'fullscreen' && (display.value = g.fullscreen ? '1' : '0'));
  display.addEventListener('change', () => {
    setGraphics('fullscreen', display.value === '1');
    setFullscreen(graphics.fullscreen); // this change is the click the browser wants
    display.blur();
  });
  const fps = q('.gFps');
  fps.value = String(FPS_LIMITS.indexOf(graphics.fpsLimit as never));
  const showFps = () => text('.gFpsVal', graphics.fpsLimit ? String(graphics.fpsLimit) : TEXT.menu.unlimited);
  showFps();
  fps.addEventListener('input', () => (setGraphics('fpsLimit', FPS_LIMITS[parseInt(fps.value)]), showFps()));
  const res = q('.gRes');
  // Over 1 only on screens that have more pixels per CSS pixel than that.
  res.max = String(Math.max(1, Math.min(devicePixelRatio, 2)));
  res.value = String(graphics.resScale);
  const showRes = () => text('.gResVal', `${Math.round(graphics.resScale * 100)}%`);
  showRes();
  res.addEventListener('input', () => (setGraphics('resScale', parseFloat(res.value)), showRes()));
  const dyn = q('.gDyn');
  dyn.checked = graphics.dynamicRes;
  dyn.addEventListener('change', () => setGraphics('dynamicRes', dyn.checked));
  const min = q('.gMin');
  min.value = String(graphics.minRes);
  const showMin = () => text('.gMinVal', `${Math.round(graphics.minRes * 100)}%`);
  showMin();
  min.addEventListener('input', () => (setGraphics('minRes', parseFloat(min.value)), showMin()));
  min.disabled = !graphics.dynamicRes;
  dyn.addEventListener('change', () => (min.disabled = !dyn.checked));
  const shadows = q('.gShadows');
  shadows.checked = graphics.shadows;
  const dist = q('.gDist');
  dist.value = String(graphics.shadowDistance);
  const showDist = () => text('.gDistVal', `${graphics.shadowDistance} m`);
  showDist();
  dist.addEventListener('input', () => (setGraphics('shadowDistance', parseFloat(dist.value)), showDist()));
  const cas = q('.gCas');
  cas.value = String(graphics.cascades);
  const showCas = () => text('.gCasVal', String(graphics.cascades));
  showCas();
  cas.addEventListener('input', () => (setGraphics('cascades', parseInt(cas.value)), showCas(), showNote()));
  const map = q('.gMap');
  map.value = String(SHADOW_MAPS.indexOf(graphics.shadowMap as never));
  const showMap = () => text('.gMapVal', TEXT.menu.shadowDetails[SHADOW_MAPS.indexOf(graphics.shadowMap as never)]);
  showMap();
  map.addEventListener('input', () => (setGraphics('shadowMap', SHADOW_MAPS[parseInt(map.value)]), showMap(), showNote()));
  const filt = q('.gFilt');
  filt.value = String(SHADOW_FILTERS.indexOf(graphics.shadowFilter as never));
  const showFilt = () => text('.gFiltVal', TEXT.menu.shadowDetails[SHADOW_FILTERS.indexOf(graphics.shadowFilter as never)]);
  showFilt();
  filt.addEventListener('input', () => (setGraphics('shadowFilter', SHADOW_FILTERS[parseInt(filt.value)]), showFilt(), showNote()));
  const refresh = q('.gRefresh');
  refresh.value = String(graphics.shadowRefresh);
  const showRefresh = () => text('.gRefreshVal', TEXT.menu.shadowRefreshes[graphics.shadowRefresh]);
  showRefresh();
  refresh.addEventListener('input', () => (setGraphics('shadowRefresh', parseInt(refresh.value)), showRefresh()));
  const aa = q('.gAa');
  aa.checked = graphics.antialias;
  aa.addEventListener('change', () => (setGraphics('antialias', aa.checked), showNote()));
  const dependent = [dist, cas, map, filt, refresh];
  const enable = () => dependent.forEach((i) => (i.disabled = !graphics.shadows));
  enable();
  shadows.addEventListener('change', () => (setGraphics('shadows', shadows.checked), enable()));
  return [aa, filt, refresh, fps, res, dyn, min, shadows, dist, cas, map];
}


/** Hover tips: native `title` tooltips don't show in fullscreen or over this overlay, so one of our own follows the pointer. */
function bindTips(root: HTMLElement) {
  const tip = document.createElement('div');
  tip.className = 'tip';
  root.append(tip);
  root.addEventListener('pointermove', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
    tip.style.display = row ? 'block' : 'none';
    if (!row) return;
    tip.textContent = row.dataset.tip!;
    const w = Math.min(260, innerWidth - 16);
    tip.style.width = `${w}px`;
    tip.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, e.clientX + 14))}px`;
    tip.style.top = `${Math.min(innerHeight - tip.offsetHeight - 8, e.clientY + 18)}px`;
  });
  root.addEventListener('pointerleave', () => (tip.style.display = 'none'));
}

