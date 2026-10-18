// Esc menu: opens whenever the game lets go of the mouse (Esc, alt-tab) unless the inventory or the F3
// panel took it. Resume (or a click on the backdrop) goes back in. Settings: volume and music volume (src/audio.ts) and
// the stats line in the top-left corner; below them the controls, the build/connection line and credits.
// The game keeps running behind it: it's multiplayer, nothing pauses.
import { WORLD_ID } from '../shared/world.ts';
import { audio } from './audio';
import { ACTIONS, bind, keyName, onChange, resetAll, slots } from './bindings';
import { capture, toggleFullscreen, tools, ui } from './input';
import { openMinigame } from './minigameMenu';
import { TEXT } from '../shared/text.ts';

const STATS_KEY = 'dadajam.stats';
const AO_KEY = 'dadajam.ao';

const css = `
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
#menu input[type=checkbox] { accent-color: #ffd9a0; margin: 0; }
#menu .val, #menu .aoval { width: 36px; text-align: right; opacity: 0.8; }
#menu .panel { max-height: calc(100vh - 32px); overflow-y: auto; }
#menu .keys { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; opacity: 0.85; }
#menu .binds { display: grid; grid-template-columns: 1fr 64px 64px; gap: 4px 6px; align-items: center; }
#menu .binds button { padding: 3px 0; font: 600 11px var(--mono); letter-spacing: 0; background: rgba(255, 217, 160, 0.14); color: #ffd9a0; }
#menu .binds button:hover { background: rgba(255, 217, 160, 0.28); }
#menu .binds button.listening { background: #ffd9a0; color: #2a160a; }
#menu .note { min-height: 16px; margin-top: 6px; opacity: 0.7; font-size: 11px; }
#menu .controls { display: none; }
#menu .panel.sub .controls { display: block; }
#menu .panel.sub .main { display: none; }
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

/** One of the minigame's machines (src/loadingRunner.ts): a rust crate with an accent stripe, a rarity tag and two screws. */
const MACHINE_ICON = `<svg viewBox="2 13 40 28" aria-hidden="true">
<rect x="4" y="15" width="36" height="25" rx="4" fill="#251509" stroke="#3b2616" stroke-width="2"/>
<g class="lid"><rect x="6" y="16" width="32" height="21" rx="3" fill="#7a5238" stroke="#3b2616" stroke-width="2"/>
<rect x="10" y="23" width="24" height="5" fill="#a04a20"/><rect class="tag" x="10" y="23" width="5" height="5" fill="#3ff0ff"/>
<circle cx="10" cy="20" r="2" fill="#8a8f93" stroke="#3b2616"/><circle cx="34" cy="33" r="2" fill="#8a8f93" stroke="#3b2616"/>
<path d="M17 33h2M22 33h2M27 33h2" stroke="#3b2616" stroke-width="1.4"/></g></svg>`;

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
    this.el.innerHTML = `<div class="panel"><div class="main"><h2>${TEXT.game.name}</h2><button class="resume">${TEXT.menu.resume}</button>
<h3>${TEXT.menu.settings}</h3>
<label class="row"><span>${TEXT.menu.volume}</span><input class="vol" type="range" min="0" max="1" step="0.01"><span class="val"></span></label>
<label class="row"><span>${TEXT.menu.music}</span><input class="music" type="range" min="0" max="1" step="0.01"><span class="val musicVal"></span></label>
<label class="row"><span>${TEXT.menu.occlusion}</span><input class="ao" type="range" min="0" max="1" step="0.01"><span class="aoval"></span></label>
<label class="row"><span>${TEXT.menu.showStats}</span><input class="stats" type="checkbox"></label>
<button class="fs" style="margin-top:8px"></button>
<button class="invite" style="margin-top:8px">${TEXT.menu.copyInvite}</button>
<button class="ctl" style="margin-top:8px">${TEXT.menu.controls}</button>
<div class="foot"><div class="info"></div><a href="./credits.txt" target="_blank" rel="noopener">${TEXT.menu.credits}</a></div></div>
<div class="controls"><h2>${TEXT.controls.title}</h2><button class="back">${TEXT.controls.back}</button>
<h3>${TEXT.controls.how}</h3><div class="binds"></div><div class="note"></div>
<button class="reset">${TEXT.controls.reset}</button><div class="foot">${TEXT.controls.fixed}</div></div></div>
<button class="mini" title="${TEXT.menu.minigame}" aria-label="${TEXT.menu.minigame}">${MACHINE_ICON}</button>`;
    document.body.append(this.el);
    this.footEl = this.el.querySelector('.info')!;
    // The world's URL (shared/world.ts), without dev flags: anyone opening it joins this world.
    const invite = this.el.querySelector<HTMLButtonElement>('.invite')!;
    invite.addEventListener('click', () => {
      const url = `${location.origin}${location.pathname}?w=${WORLD_ID}`;
      navigator.clipboard?.writeText(url).then(() => (invite.textContent = TEXT.menu.copied), () => (invite.textContent = url));
      setTimeout(() => (invite.textContent = TEXT.menu.copyInvite), 2500);
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
    this.bindControls();
    this.el.querySelector('.mini')!.addEventListener('click', () => this.playMinigame());
    // Drop focus after using a control, or the arrow keys / space would keep nudging it.
    for (const input of [vol, music, aoEl, stats]) input.addEventListener('change', () => input.blur());

    const fs = this.el.querySelector<HTMLButtonElement>('.fs')!;
    const showFs = () => (fs.textContent = document.fullscreenElement ? TEXT.menu.exitFullscreen : TEXT.menu.enterFullscreen);
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
      if (document.getElementById('name') || document.getElementById('play')) return; // Esc there skips the name (src/name.ts) or leaves the minigame
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

  /** The teardown minigame (src/minigameMenu.ts) over the world, which stays visible behind it. */
  private playMinigame() {
    this.el.style.visibility = 'hidden';
    openMinigame(() => (this.el.style.visibility = ''));
  }

  /** The rebinding rows: click a key, press the new one (Esc cancels, Backspace clears). */
  private bindControls() {
    const grid = this.el.querySelector<HTMLElement>('.binds')!;
    grid.innerHTML = ACTIONS.map((a) => `<span>${TEXT.controls.actions[a.id]}</span><button data-a="${a.id}" data-s="0"></button><button data-a="${a.id}" data-s="1"></button>`).join('')
      ;
    const note = this.el.querySelector<HTMLElement>('.controls .note')!;
    const panel = this.el.querySelector<HTMLElement>('.panel')!;
    const sub = (on: boolean) => {
      panel.classList.toggle('sub', on);
      listening = undefined;
      note.textContent = '';
      show();
    };
    this.el.querySelector('.ctl')!.addEventListener('click', () => sub(true));
    this.el.querySelector('.back')!.addEventListener('click', () => sub(false));
    const buttons = [...grid.querySelectorAll<HTMLButtonElement>('button')];
    let listening: HTMLButtonElement | undefined;
    const show = () => {
      for (const b of buttons) {
        const s = slots(b.dataset.a as never);
        b.textContent = b === listening ? '…' : keyName(s[Number(b.dataset.s)]);
        b.classList.toggle('listening', b === listening);
      }
    };
    onChange(show);
    show();
    // Capture phase on window and registered first: while listening, no other handler sees the key.
    addEventListener('keydown', (e) => {
      if (!listening) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      // Modifier keys bind on release, so a chord isn't taken as the modifier alone.
      if (/^(Shift|Control|Alt)/.test(e.code)) {
        pendingMod = e.code;
        return;
      }
      pendingMod = '';
      finish(e.code);
    }, true);
    let pendingMod = '';
    let ignoreClick = false;
    // A mouse button binds too; the click that follows must not toggle the button again.
    addEventListener('mousedown', (e) => {
      if (!listening) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ignoreClick = true;
      setTimeout(() => (ignoreClick = false), 0);
      finish(`Mouse${e.button}`);
    }, true);
    addEventListener('keyup', (e) => {
      if (!listening || e.code !== pendingMod) return;
      e.stopImmediatePropagation();
      pendingMod = '';
      finish(e.code);
    }, true);
    const finish = (code: string) => {
      const b = listening!;
      listening = undefined;
      note.textContent = '';
      if (code === 'Escape') return show();
      const a = b.dataset.a as never;
      const slot = Number(b.dataset.s) as 0 | 1;
      note.textContent = (code === 'Backspace' || code === 'Delete' ? bind(a, slot, '') : bind(a, slot, code)) ?? '';
      show();
    };
    grid.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b || ignoreClick) return;
      b.blur();
      listening = listening === b ? undefined : b;
      note.textContent = listening ? TEXT.controls.listening : '';
      show();
    });
    this.el.querySelector('.reset')!.addEventListener('click', (e) => {
      listening = undefined;
      note.textContent = '';
      resetAll();
      (e.currentTarget as HTMLElement).blur();
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
