// Esc menu: opens whenever the game lets go of the mouse (Esc, alt-tab) unless the inventory or the F3
// panel took it. Resume (or a click on the backdrop) goes back in. Settings: volume and music volume (src/audio.ts) and
// the stats line in the top-left corner; below them the controls, the build/connection line and credits.
// The game keeps running behind it: it's multiplayer, nothing pauses.
import { WORLD_ID } from '../shared/world.ts';
import { ACTIONS, bind, keyName, onChange, resetAll, slots } from './bindings';
import { capture, setFullscreen, tools, ui } from './input';
import { openMinigame } from './minigameMenu';
import { TEXT } from '../shared/text.ts';
import { MENU_CSS, bindOptions, optionsHtml, statsPref } from './options';
import { graphics, onGraphics, setGraphics } from './graphics';

const css = MENU_CSS;


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
    this.stats = statsPref();
    this.infoEl.style.display = this.stats ? 'block' : 'none';

    this.el.id = 'menu';
    this.el.innerHTML = `<div class="panel"><div class="main"><h2>${TEXT.game.name}</h2><button class="resume">${TEXT.menu.resume}</button>
<button class="opt" style="margin-top:12px">${TEXT.menu.options}</button>
<button class="fs" style="margin-top:8px"></button>
<button class="invite" style="margin-top:8px">${TEXT.menu.copyInvite}</button>
<button class="ctl" style="margin-top:8px">${TEXT.menu.controls}</button>
<button class="leaveGame" style="margin-top:8px">${TEXT.menu.mainMenu}</button>
<div class="foot"><div class="info"></div><a href="./credits.txt" target="_blank" rel="noopener">${TEXT.menu.credits}</a></div></div>
${optionsHtml()}
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

    bindOptions(this.el, {
      onAo,
      onStats: (on) => {
        this.stats = on;
        this.infoEl.style.display = on ? 'block' : 'none';
      },
    });
    const panel = this.el.querySelector<HTMLElement>('.panel')!;
    this.el.querySelector('.opt')!.addEventListener('click', () => panel.classList.add('opts'));
    this.el.querySelector('.optBack')!.addEventListener('click', () => panel.classList.remove('opts'));
    this.bindControls();
    this.el.querySelector('.mini')!.addEventListener('click', () => this.playMinigame());

    // Fullscreen on/off in one click (the Display option does the same): easy to get out to other windows and tabs.
    const fs = this.el.querySelector<HTMLButtonElement>('.fs')!;
    const showFs = () => (fs.textContent = graphics.fullscreen ? TEXT.menu.goWindowed : TEXT.menu.goFullscreen);
    showFs();
    onGraphics((_g, changed) => changed === 'fullscreen' && showFs());
    fs.addEventListener('click', () => {
      setGraphics('fullscreen', !graphics.fullscreen);
      setFullscreen(graphics.fullscreen);
      fs.blur();
    });
    // Back to the main menu (the page without a world in its address).
    this.el.querySelector('.leaveGame')!.addEventListener('click', () => location.assign(location.pathname));

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

  /** "Show stats" is ticked (src/statsGraph.ts is drawn). */
  get statsOn() {
    return this.stats;
  }

  private toggle(open: boolean) {
    this.el.classList.toggle('open', open);
    if (open) this.footEl.textContent = this.lastInfo;
  }

  /** Every frame: the stats line under the graphs (render scale, clock, backend, connection, players, build). */
  setInfo(text: string) {
    if (text === this.lastInfo) return;
    this.lastInfo = text;
    if (this.stats) this.infoEl.textContent = text;
    if (this.open) this.footEl.textContent = text;
  }
}
