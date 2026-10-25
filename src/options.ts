// The options (Esc menu → Options, and the main menu's Options before joining): tabs for gameplay, graphics, audio and
// the controls (src/rebind.ts). Shared
// markup and wiring: the page that hosts it provides a `#menu` element (the styles are scoped to it, `MENU_CSS`) and the Back button.
import { setCounts, setMarkers, tdPrefs } from './teardown/prefs.ts';
import { audio } from './audio';
import { TEXT } from '../shared/text.ts';
import { FPS_LIMITS, PRESET_NAMES, SHADOW_DISTANCE_RANGE, SHADOW_QUALITY, applyGraphicsPreset, currentGraphicsPreset, graphics, needsReload, onGraphics, setGraphics } from './graphics';
import { setFullscreen } from './input';
import { bindRebind, controlsHtml } from './rebind';
import { UI_SIZE_RANGE, setUiSize, uiScale, uiSize } from './uiScale';
import { comfort, COMFORT_RANGES, onComfort, setComfort, type Comfort } from './comfort';
import './uiNavigation';

const STATS_KEY = 'dadajam.stats';

export const MENU_CSS = `
#menu { position: fixed; inset: 0; z-index: 30; display: none; align-items: center; justify-content: center;
  background: rgba(12, 6, 2, 0.55); font: 12px var(--mono); color: #fff4e4; user-select: none; -webkit-user-select: none; }
#menu.open { display: flex; }
#menu .panel { width: min(340px, calc(100vw / var(--ui, 1) - 32px)); padding: 16px 18px 14px; border-radius: 8px;
  background: rgba(28, 15, 7, 0.92); box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.16), 0 10px 40px rgba(0, 0, 0, 0.5); }
#menu h2 { margin: 0 0 14px; font: 15px var(--title); letter-spacing: 0.18em; text-transform: uppercase; color: #ffd9a0; }
#menu h3 { margin: 16px 0 8px; font: 600 11px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.6; }
#menu button { width: 100%; padding: 8px; font: 600 13px var(--mono); letter-spacing: 0.08em; color: #2a160a;
  background: #ffd9a0; border: 0; border-radius: 5px; cursor: pointer; }
#menu .resume.nudge { animation: menuNudge .7s ease-out; }
@keyframes menuNudge { 0%, 100% { transform: none; box-shadow: none; } 15%, 45% { transform: translateX(-4px); } 30%, 60% { transform: translateX(4px); }
  20% { box-shadow: 0 0 0 3px rgba(255, 217, 160, 0.55); } }
@media (prefers-reduced-motion: reduce) { #menu .resume.nudge { animation: none; } }
#menu .resume kbd { font: bold 11px var(--mono); padding: 0 4px; margin-right: 8px; border-radius: 3px; background: #2a160a; color: #ffd9a0; letter-spacing: 0; }
#menu button:hover { background: #ffe6bf; }
#menu .row { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
#menu .row > span:first-child { width: 80px; }
#menu input[type=range] { flex: 1; accent-color: #ffd9a0; }
#menu select { flex: 1; padding: 3px; font: 12px var(--mono); color: #ffd9a0; background: rgba(255, 217, 160, 0.14); border: 0; border-radius: 4px; }
#menu select option { background: #2a160a; }
#menu input[type=checkbox] { accent-color: #ffd9a0; margin: 0; }
#menu .val, #menu .aoval { width: 52px; text-align: right; opacity: 0.8; }
#menu .panel { max-height: calc(100vh / var(--ui, 1) - 32px); overflow-y: auto; }
#menu .keys { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; opacity: 0.85; }
#menu .binds { display: grid; grid-template-columns: 1fr 64px 64px; gap: 4px 6px; align-items: center; }
#menu .binds button { padding: 3px 0; font: 600 11px var(--mono); letter-spacing: 0; background: rgba(255, 217, 160, 0.14); color: #ffd9a0; }
#menu .binds button:hover { background: rgba(255, 217, 160, 0.28); }
#menu .binds button.listening { background: #ffd9a0; color: #2a160a; }
#menu .tip { position: fixed; display: none; padding: 6px 8px; border-radius: 5px; pointer-events: none; font-size: 11px; line-height: 1.4;
  background: rgba(20, 10, 4, 0.96); box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.2), 0 6px 18px rgba(0, 0, 0, 0.5); }
#menu .note { min-height: 16px; margin-top: 6px; opacity: 0.7; font-size: 11px; }
#menu .fsNote { position: fixed; display: none; width: 220px; padding: 8px 10px; border-radius: 6px; font-size: 11px; line-height: 1.45;
  color: #ffe6bf; background: rgba(255, 217, 160, 0.12); box-shadow: 0 0 0 1.5px rgba(255, 217, 160, 0.7); transform: translateY(-50%); }
#menu .fsNote::before { content: ''; position: absolute; right: 100%; top: 50%; width: 22px; border-top: 1.5px solid rgba(255, 217, 160, 0.7); }
#menu .fsNote.below { transform: none; }
#menu .fsNote.below::before { display: none; }
#menu.closeAsked .fsNote { display: block; }
#menu .panel.opts ~ .fsNote { display: none !important; }
#menu .options { display: none; }
#menu .panel.opts .options { display: block; }
#menu .panel.opts .main { display: none; }
#menu .panel.opts ~ button.mini { display: none; }
#menu .tabs { display: flex; gap: 6px; margin: 14px 0 6px; }
#menu .tabs button { padding: 5px 0; font: 600 11px var(--mono); letter-spacing: 0.04em; text-transform: uppercase; background: rgba(255, 217, 160, 0.14); color: #ffd9a0; }
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

/** The options view: a `.options` block with its Back button (`.optBack`, the host binds it). */
export function optionsHtml(): string {
  return `<div class="options"><h2>${TEXT.menu.options}</h2><button class="optBack">${TEXT.controls.back}</button>
<div class="tabs"><button class="tab on" data-tab="gameplay">${TEXT.menu.gameplay}</button><button class="tab" data-tab="graphics">${TEXT.menu.graphics}</button><button class="tab" data-tab="audio">${TEXT.menu.audio}</button><button class="tab" data-tab="controls">${TEXT.menu.controls}</button></div>
<div class="pane" data-pane="gameplay">
<label class="row" data-tip="${TEXT.menu.tips.interfaceSize}"><span>${TEXT.menu.interfaceSize}</span><input class="uiSize" type="range" min="${UI_SIZE_RANGE[0]}" max="${UI_SIZE_RANGE[1]}" step="0.05"><span class="val uiSizeVal"></span></label>
<label class="row"><span>${TEXT.menu.showGuides}</span><input class="guides" type="checkbox"></label>
<label class="row"><span>${TEXT.menu.showCounts}</span><input class="counts" type="checkbox"></label>
<label class="row"><span>${TEXT.menu.showStats}</span><input class="stats" type="checkbox"></label>
<h3>${TEXT.menu.camera}</h3>${comfortHtml(['mouseX', 'mouseY', 'padX', 'padY', 'invertY', 'fov', 'motion', 'glare', 'grain'])}
<h3>${TEXT.menu.readability}</h3>${comfortHtml(['hudScale', 'subtitleScale', 'subtitleOpacity', 'subtitleDuration', 'instantText'])}</div>
<div class="pane" data-pane="graphics">
<label class="row" data-tip="${TEXT.menu.tips.graphicsPreset}"><span>${TEXT.menu.graphicsPreset}</span><select class="gPreset"><option value="auto">${TEXT.menu.automatic}</option>${PRESET_NAMES.map((name, i) => `<option value="${name}">${TEXT.menu.shadowQualities[i]}</option>`).join('')}<option value="custom" disabled>${TEXT.menu.custom}</option></select></label>
<label class="row" data-tip="${TEXT.menu.tips.display}"><span>${TEXT.menu.display}</span><select class="gDisplay"><option value="1">${TEXT.menu.fullscreen}</option><option value="0">${TEXT.menu.windowed}</option></select></label>
<label class="row" data-tip="${TEXT.menu.tips.fpsTarget}"><span>${TEXT.menu.fpsTarget}</span><input class="gFps" type="range" min="0" max="${FPS_LIMITS.length - 1}" step="1"><span class="val gFpsVal"></span></label>
<label class="row" data-tip="${TEXT.menu.tips.resolution}"><span>${TEXT.menu.resolution}</span><input class="gRes" type="range" min="0.01" max="1" step="0.01"><span class="val gResVal"></span></label>
<label class="row" data-tip="${TEXT.menu.tips.dynamicRes}"><span>${TEXT.menu.dynamicRes}</span><input class="gDyn" type="checkbox"></label>
<label class="row" data-tip="${TEXT.menu.tips.minRes}"><span>${TEXT.menu.minRes}</span><input class="gMin" type="range" min="0.01" max="1" step="0.01"><span class="val gMinVal"></span></label>
<label class="row" data-tip="${TEXT.menu.tips.occlusion}"><span>${TEXT.menu.occlusion}</span><input class="ao" type="range" min="0" max="1" step="0.01"><span class="aoval"></span></label>
<label class="row" data-tip="${TEXT.menu.tips.shadows}"><span>${TEXT.menu.shadows}</span><input class="gShadows" type="checkbox"></label>
<label class="row" data-tip="${TEXT.menu.tips.shadowDistance}"><span>${TEXT.menu.shadowDistance}</span><input class="gDist" type="range" min="${SHADOW_DISTANCE_RANGE[0]}" max="${SHADOW_DISTANCE_RANGE[1]}" step="50"><span class="val gDistVal"></span></label>
<label class="row" data-tip="${TEXT.menu.tips.shadowQuality}"><span>${TEXT.menu.shadowQuality}</span><input class="gQual" type="range" min="0" max="3" step="1"><span class="val gQualVal"></span></label>
<label class="row" data-tip="${TEXT.menu.tips.shadowRefresh}"><span>${TEXT.menu.shadowRefresh}</span><input class="gRefresh" type="range" min="0" max="2" step="1"><span class="val gRefreshVal"></span></label>
<label class="row" data-tip="${TEXT.menu.tips.sandDetail}"><span>${TEXT.menu.sandDetail}</span><input class="gSand" type="range" min="0" max="3" step="1"><span class="val gSandVal"></span></label>
<label class="row" data-tip="${TEXT.menu.tips.antialias}"><span>${TEXT.menu.antialias}</span><input class="gAa" type="checkbox"></label>
<div class="note gNote"></div></div>
<div class="pane" data-pane="audio">
<label class="row"><span>${TEXT.menu.volume}</span><input class="vol" type="range" min="0" max="1" step="0.01"><span class="val volVal"></span></label>
<label class="row"><span>${TEXT.menu.music}</span><input class="music" type="range" min="0" max="1" step="0.01"><span class="val musicVal"></span></label></div>
${controlsHtml()}</div>
`;
}

/** Wire every control in `root`. `onAo`: called with the occlusion level now and when it changes; `onStats`: the stats checkbox. */
export function bindOptions(root: HTMLElement, hooks: { onAo?: (level: number) => void; onStats?: (on: boolean) => void }) {
  const unbindComfort = bindComfort(root);
  const vol = root.querySelector<HTMLInputElement>('.vol')!;
  const val = root.querySelector<HTMLElement>('.volVal')!;
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
  hooks.onAo?.(graphics.occlusion);
  const unbindAo = onGraphics((g, changed) => changed === 'occlusion' && hooks.onAo?.(g.occlusion));
  const unbindGraphics = bindGraphics(root, !!hooks.onAo);
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
  // Applied on release: the menu growing under the pointer mid-drag would throw the slider about.
  const size = root.querySelector<HTMLInputElement>('.uiSize')!;
  const sizeVal = root.querySelector<HTMLElement>('.uiSizeVal')!;
  const showSize = () => (sizeVal.textContent = `${Math.round(parseFloat(size.value) * 100)}%`);
  size.value = String(uiSize());
  showSize();
  size.addEventListener('input', showSize);
  size.addEventListener('change', () => setUiSize(parseFloat(size.value)));

  // Options: a sub-view with a tab for each group of settings.
  const rebind = bindRebind(root);
  const tab = (name: string) => {
    rebind.leave();
    for (const b of root.querySelectorAll<HTMLElement>('.tab')) b.classList.toggle('on', b.dataset.tab === name);
    for (const p of root.querySelectorAll<HTMLElement>('.pane')) p.style.display = p.dataset.pane === name ? '' : 'none';
  };
  tab('gameplay');
  for (const b of root.querySelectorAll<HTMLElement>('.tab')) b.addEventListener('click', () => tab(b.dataset.tab!));
  bindTips(root);
  return () => { unbindAo(); unbindGraphics(); unbindComfort(); rebind.unbind(); };
}

function comfortHtml(keys: (keyof Comfort)[]): string {
  return keys.map((key) => {
    const range = COMFORT_RANGES[key as keyof typeof COMFORT_RANGES];
    return `<label class="row"><span>${TEXT.menu.comfort[key]}</span><input data-comfort="${key}" type="${range ? 'range' : 'checkbox'}"${range ? ` min="${range[0]}" max="${range[1]}" step="${key === 'fov' ? 1 : 0.05}"` : ''}>${range ? `<span class="val" data-comfort-value="${key}"></span>` : ''}</label>`;
  }).join('');
}

function bindComfort(root: HTMLElement) {
  const controls = [...root.querySelectorAll<HTMLInputElement>('[data-comfort]')];
  const sync = () => {
    for (const input of controls) {
      const key = input.dataset.comfort as keyof Comfort;
      const value = comfort[key];
      if (typeof value === 'boolean') input.checked = value;
      else {
        input.value = String(value);
        const label = root.querySelector<HTMLElement>(`[data-comfort-value="${key}"]`)!;
        label.textContent = key === 'fov' ? `${Math.round(value)}°` : `${Math.round(value * 100)}%`;
      }
    }
  };
  sync();
  for (const input of controls) input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => {
    const key = input.dataset.comfort as keyof Comfort;
    setComfort(key, input.type === 'checkbox' ? input.checked : Number(input.value));
  });
  return onComfort(sync);
}

/** The same controls serve the landing page and the running game. Sync every control after a preset or Auto change. */
function bindGraphics(root: HTMLElement, inGame: boolean) {
  const q = (c: string) => root.querySelector<HTMLInputElement>(c)!;
  const text = (c: string, t: string) => (root.querySelector<HTMLElement>(c)!.textContent = t);
  const preset = root.querySelector<HTMLSelectElement>('.gPreset')!;
  const display = root.querySelector<HTMLSelectElement>('.gDisplay')!;
  const note = root.querySelector<HTMLElement>('.gNote')!;
  const fps = q('.gFps'), res = q('.gRes'), dyn = q('.gDyn'), min = q('.gMin'), ao = q('.ao');
  const shadows = q('.gShadows'), dist = q('.gDist'), qual = q('.gQual'), refresh = q('.gRefresh'), sandDetail = q('.gSand'), aa = q('.gAa');
  res.max = String(Math.max(1, Math.min(devicePixelRatio, 2)));
  const sync = () => {
    preset.value = currentGraphicsPreset();
    display.value = graphics.fullscreen ? '1' : '0';
    fps.value = String(FPS_LIMITS.indexOf(graphics.fpsLimit as never));
    text('.gFpsVal', graphics.fpsLimit ? String(graphics.fpsLimit) : TEXT.menu.unlimited);
    res.value = String(graphics.resScale);
    text('.gResVal', `${Math.round(graphics.resScale * 100)}%`);
    dyn.checked = graphics.dynamicRes;
    min.value = String(graphics.minRes);
    min.disabled = !graphics.dynamicRes;
    text('.gMinVal', `${Math.round(graphics.minRes * 100)}%`);
    ao.value = String(graphics.occlusion);
    text('.aoval', `${Math.round(graphics.occlusion * 100)}%`);
    shadows.checked = graphics.shadows;
    dist.value = String(graphics.shadowDistance);
    text('.gDistVal', `${graphics.shadowDistance} m`);
    qual.value = String(graphics.shadowQuality);
    text('.gQualVal', TEXT.menu.shadowQualities[graphics.shadowQuality]);
    refresh.value = String(graphics.shadowRefresh);
    text('.gRefreshVal', TEXT.menu.shadowRefreshes[graphics.shadowRefresh]);
    sandDetail.value = String(graphics.sandDetail);
    text('.gSandVal', TEXT.menu.shadowQualities[graphics.sandDetail]);
    aa.checked = graphics.antialias;
    for (const input of [dist, qual, refresh]) input.disabled = !graphics.shadows;
    const reload = inGame && needsReload();
    note.textContent = reload ? TEXT.menu.needsReload : '';
    note.style.cursor = reload ? 'pointer' : '';
    note.style.textDecoration = reload ? 'underline' : '';
  };
  sync();
  const unbind = onGraphics(sync);
  preset.addEventListener('change', () => {
    const name = preset.value;
    if (name === 'auto' || PRESET_NAMES.some((p) => p === name)) applyGraphicsPreset(name as typeof PRESET_NAMES[number] | 'auto');
  });
  note.addEventListener('click', () => inGame && needsReload() && location.reload());
  display.addEventListener('change', () => {
    setGraphics('fullscreen', display.value === '1');
    setFullscreen(graphics.fullscreen);
  });
  fps.addEventListener('input', () => setGraphics('fpsLimit', FPS_LIMITS[parseInt(fps.value)]));
  res.addEventListener('input', () => setGraphics('resScale', parseFloat(res.value)));
  dyn.addEventListener('change', () => setGraphics('dynamicRes', dyn.checked));
  min.addEventListener('input', () => setGraphics('minRes', parseFloat(min.value)));
  ao.addEventListener('input', () => setGraphics('occlusion', parseFloat(ao.value)));
  shadows.addEventListener('change', () => setGraphics('shadows', shadows.checked));
  dist.addEventListener('input', () => setGraphics('shadowDistance', parseFloat(dist.value)));
  qual.addEventListener('input', () => {
    setGraphics('shadowQuality', parseInt(qual.value));
    if (graphics.shadowQuality === SHADOW_QUALITY.length - 1) setGraphics('shadowDistance', SHADOW_DISTANCE_RANGE[1]);
  });
  refresh.addEventListener('input', () => setGraphics('shadowRefresh', parseInt(refresh.value)));
  sandDetail.addEventListener('input', () => setGraphics('sandDetail', parseInt(sandDetail.value)));
  aa.addEventListener('change', () => setGraphics('antialias', aa.checked));
  return unbind;
}

/** Hover tips: native `title` tooltips don't show in fullscreen or over this overlay, so one of our own follows the pointer. */
export function bindTips(root: HTMLElement) {
  const tip = document.createElement('div');
  tip.className = 'tip';
  root.append(tip);
  root.addEventListener('pointermove', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
    tip.style.display = row ? 'block' : 'none';
    if (!row) return;
    tip.textContent = row.dataset.tip!;
    // Worked out in screen px, set in the menu's own (src/uiScale.ts).
    const z = uiScale();
    const w = Math.min(260 * z, innerWidth - 16);
    tip.style.width = `${w / z}px`;
    tip.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, e.clientX + 14)) / z}px`;
    tip.style.top = `${Math.min(innerHeight - tip.offsetHeight * z - 8, e.clientY + 18) / z}px`;
  });
  root.addEventListener('pointerleave', () => (tip.style.display = 'none'));
}

