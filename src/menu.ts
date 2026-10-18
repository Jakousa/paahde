// Esc menu: opens whenever the game lets go of the mouse (Esc, alt-tab) unless the inventory or the F3
// panel took it. Resume (or a click on the backdrop) goes back in. Settings: volume and music volume (src/audio.ts) and
// the stats line in the top-left corner; below them the controls, the build/connection line and credits.
// The game keeps running behind it: it's multiplayer, nothing pauses.
import { WORLD_ID } from '../shared/world.ts';
import { audio } from './audio';
import { capture, toggleFullscreen, tools, ui } from './input';

const STATS_KEY = 'dadajam.stats';
const AO_KEY = 'dadajam.ao';

const css = `
#menu { position: fixed; inset: 0; z-index: 30; display: none; align-items: center; justify-content: center;
  background: rgba(12, 6, 2, 0.55); font: 12px var(--mono); color: #fff4e4; user-select: none; -webkit-user-select: none; }
#menu.open { display: flex; }
#menu .panel { width: min(340px, calc(100vw - 32px)); padding: 16px 18px 14px; border-radius: 8px;
  background: rgba(28, 15, 7, 0.92); box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.16), 0 10px 40px rgba(0, 0, 0, 0.5); }
#menu h2 { margin: 0 0 14px; font: 600 15px var(--mono); letter-spacing: 0.18em; text-transform: uppercase; color: #ffd9a0; }
#menu h3 { margin: 16px 0 8px; font: 600 11px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.6; }
#menu button { width: 100%; padding: 8px; font: 600 13px var(--mono); letter-spacing: 0.08em; color: #2a160a;
  background: #ffd9a0; border: 0; border-radius: 5px; cursor: pointer; }
#menu button:hover { background: #ffe6bf; }
#menu .row { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
#menu .row > span:first-child { width: 80px; }
#menu input[type=range] { flex: 1; accent-color: #ffd9a0; }
#menu input[type=checkbox] { accent-color: #ffd9a0; margin: 0; }
#menu .val, #menu .aoval { width: 36px; text-align: right; opacity: 0.8; }
#menu .keys { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; opacity: 0.85; }
#menu kbd { font: 600 11px var(--mono); color: #ffd9a0; }
#menu .foot { margin-top: 16px; padding-top: 10px; border-top: 1px solid rgba(255, 240, 220, 0.12); font-size: 11px;
  opacity: 0.6; line-height: 1.5; word-break: break-all; }
#menu .foot a { color: inherit; }
`;

const KEYS: [string, string][] = [
  ['WASD', 'move'], ['Space', 'jump'], ['Shift', 'sprint'], ['Ctrl / C', 'slide'],
  ['LMB / E', 'dig · use item · throw scrap'], ['RMB / Q', 'pile sand'], ['F', 'pick up · interact'],
  ['1–4', 'hotbar'], ['9', 'motorcycle on · off'], ['Tab', 'inventory'], ['T', 'third person'], ['Enter', 'chat'], ['Esc', 'this menu'],
];

export class Menu {
  private el = document.createElement('div');
  private infoEl = document.getElementById('info')!;
  private footEl!: HTMLElement;
  private stats = false;
  private lastInfo = '';

  constructor(canvas: HTMLElement, onAo: (intensity: number) => void) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    try {
      this.stats = localStorage.getItem(STATS_KEY) === '1';
    } catch {}
    this.infoEl.style.display = this.stats ? 'block' : 'none';

    this.el.id = 'menu';
    this.el.innerHTML = `<div class="panel"><h2>hiekka</h2><button class="resume">Resume</button>
<h3>Settings</h3>
<label class="row"><span>Volume</span><input class="vol" type="range" min="0" max="1" step="0.01"><span class="val"></span></label>
<label class="row"><span>Music</span><input class="music" type="range" min="0" max="1" step="0.01"><span class="val musicVal"></span></label>
<label class="row"><span>Occlusion</span><input class="ao" type="range" min="0" max="1" step="0.01"><span class="aoval"></span></label>
<label class="row"><span>Show stats</span><input class="stats" type="checkbox"></label>
<button class="fs" style="margin-top:8px"></button>
<button class="invite" style="margin-top:8px">Copy invite link</button>
<h3>Controls</h3><div class="keys">${KEYS.map(([k, v]) => `<kbd>${k}</kbd><span>${v}</span>`).join('')}</div>
<div class="foot"><div class="info"></div><a href="./credits.txt" target="_blank" rel="noopener">credits</a></div></div>`;
    document.body.append(this.el);
    this.footEl = this.el.querySelector('.info')!;
    // The world's URL (shared/world.ts), without dev flags: anyone opening it joins this world.
    const invite = this.el.querySelector<HTMLButtonElement>('.invite')!;
    invite.addEventListener('click', () => {
      const url = `${location.origin}${location.pathname}?w=${WORLD_ID}`;
      navigator.clipboard?.writeText(url).then(() => (invite.textContent = 'Copied'), () => (invite.textContent = url));
      setTimeout(() => (invite.textContent = 'Copy invite link'), 2500);
    });

    const vol = this.el.querySelector<HTMLInputElement>('.vol')!;
    const val = this.el.querySelector<HTMLElement>('.val')!;
    const showVol = () => (val.textContent = `${Math.round(audio.volume * 100)}%`);
    vol.value = String(audio.volume);
    showVol();
    vol.addEventListener('input', () => {
      audio.setVolume(parseFloat(vol.value));
      showVol();
    });
    const music = this.el.querySelector<HTMLInputElement>('.music')!;
    const musicVal = this.el.querySelector<HTMLElement>('.musicVal')!;
    const showMusic = () => (musicVal.textContent = `${Math.round(audio.musicVolume * 100)}%`);
    music.value = String(audio.musicVolume);
    showMusic();
    music.addEventListener('input', () => {
      audio.setMusicVolume(parseFloat(music.value));
      showMusic();
    });
    const aoEl = this.el.querySelector<HTMLInputElement>('.ao')!;
    const aoVal = this.el.querySelector<HTMLElement>('.aoval')!;
    let aoLevel = 0.7;
    try {
      const saved = parseFloat(localStorage.getItem(AO_KEY) ?? '');
      if (Number.isFinite(saved)) aoLevel = Math.min(Math.max(saved, 0), 1);
    } catch {}
    aoEl.value = String(aoLevel);
    aoVal.textContent = `${Math.round(aoLevel * 100)}%`;
    onAo(aoLevel);
    aoEl.addEventListener('input', () => {
      aoLevel = parseFloat(aoEl.value);
      aoVal.textContent = `${Math.round(aoLevel * 100)}%`;
      onAo(aoLevel);
      try {
        localStorage.setItem(AO_KEY, String(aoLevel));
      } catch {}
    });
    const stats = this.el.querySelector<HTMLInputElement>('.stats')!;
    stats.checked = this.stats;
    stats.addEventListener('change', () => {
      this.stats = stats.checked;
      this.infoEl.style.display = this.stats ? 'block' : 'none';
      try {
        localStorage.setItem(STATS_KEY, this.stats ? '1' : '0');
      } catch {}
    });
    // Drop focus after using a control, or the arrow keys / space would keep nudging it.
    for (const input of [vol, music, aoEl, stats]) input.addEventListener('change', () => input.blur());

    const fs = this.el.querySelector<HTMLButtonElement>('.fs')!;
    const showFs = () => (fs.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Enter fullscreen');
    showFs();
    document.addEventListener('fullscreenchange', showFs);
    fs.addEventListener('click', () => {
      toggleFullscreen();
      fs.blur();
    });

    const resume = () => {
      this.toggle(false);
      capture(canvas);
    };
    this.el.querySelector('.resume')!.addEventListener('click', resume);
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el) resume();
    });

    // Capture phase, so this sees the inventory still open when its own Esc handler is about to close it.
    addEventListener('keydown', (e) => {
      if (e.code === 'Tab' && this.open) this.toggle(false);
      if (e.code !== 'Escape' || e.repeat || document.pointerLockElement || ui.inventoryOpen || tools.frozen) return; // Esc leaves the disassembly (src/teardown)
      if (document.getElementById('name')) return; // Esc there skips the name (src/name.ts)
      this.toggle(!this.open);
    }, true);
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement) return this.toggle(false);
      if (ui.inventoryOpen) return;
      if (ui.debugFreed) {
        ui.debugFreed = false;
        return;
      }
      this.toggle(true);
    });
  }

  get open() {
    return this.el.classList.contains('open');
  }

  private toggle(open: boolean) {
    this.el.classList.toggle('open', open);
    if (open) this.footEl.textContent = this.lastInfo;
  }

  /** Every frame: the stats line (fps, clock, backend, connection, players, build). */
  setInfo(text: string) {
    if (text === this.lastInfo) return;
    this.lastInfo = text;
    if (this.stats) this.infoEl.textContent = text;
    if (this.open) this.footEl.textContent = text;
  }
}
