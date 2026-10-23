// Esc menu: opens whenever the game lets go of the mouse (Esc, alt-tab) unless the inventory or the F3
// panel took it. Resume (or a click on the backdrop) goes back in. Options (src/options.ts: gameplay, graphics, audio,
// controls), fullscreen, back to the main menu, credits. Over it a bubble with the game itself, laid out like its row on
// the main menu (src/landing.ts): its name and how long it's been going; lives, bosses beaten, who's on, and everyone who
// has played (by the name; your own time there by the hourglass); its code and invite link to copy; each mark explained on hover. The build and connection are in
// the stats (src/statsGraph.ts). The game keeps running behind it: it's multiplayer, nothing pauses.
import { copies } from './copy';
import { WORLD_ID } from '../shared/world.ts';
import { BOSS_KINDS } from '../shared/bosses.ts';
import type { WorldStats } from '../shared/protocol.ts';
import { kbd } from './bindings';
import { CLOCK_SVG, GROUP_SVG, HOURGLASS_SVG as HOURGLASS } from './landing';
import { getBrowserId } from './profile';
import { capture, setFullscreen, tools, ui } from './input';
import { openMinigame } from './minigameMenu';
import { TEXT } from '../shared/text.ts';
import { MENU_CSS, bindOptions, optionsHtml, statsPref } from './options';
import { graphics, onGraphics, setGraphics } from './graphics';

const css = `${MENU_CSS}
#menu.game { flex-direction: column; gap: 10px; }
#menu .server { order: -1; width: min(340px, calc(100vw - 32px)); padding: 10px 18px; border-radius: 8px;
  background: rgba(28, 15, 7, 0.92); box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.16), 0 10px 40px rgba(0, 0, 0, 0.5); }
#menu .panel.opts ~ .server { display: none; }
#menu .server { display: grid; grid-template-columns: 1fr auto; gap: 8px 12px; align-items: center; }
#menu .server .title { display: flex; align-items: center; gap: 12px; min-width: 0; }
#menu .server .sname { min-width: 0; font: 600 13px var(--mono); color: #ffd9a0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#menu .server .times { display: flex; gap: 12px; justify-self: end; }
#menu .server .up, #menu .server .mine { display: inline-flex; gap: 5px; align-items: center; font-size: 12px; opacity: 0.8; }
#menu .server .mine svg { width: 13px; height: 13px; }
#menu .server .chips { display: flex; flex-wrap: wrap; gap: 6px; }
#menu .server .crowd { display: inline-flex; flex: none; gap: 5px; align-items: center; font-size: 12px; color: #ffd9a0; }
#menu .server .crowd svg { width: 16px; height: 16px; }
#menu .server .crowd b { font-weight: 600; }
#menu .server .copy { display: flex; gap: 6px; justify-self: end; }
#menu .server .chip { display: inline-flex; align-items: center; gap: 5px; width: auto; height: 24px; padding: 0 9px; border-radius: 12px;
  font: 600 12px var(--mono); letter-spacing: 0; color: #ffd9a0; background: rgba(255, 217, 160, 0.1); box-sizing: border-box; }
#menu .server .chip svg { width: 13px; height: 13px; fill: currentColor; }
#menu .server button.chip { cursor: pointer; }
#menu .server button.chip:hover { background: rgba(255, 217, 160, 0.24); }
#menu .server .chip.code i { font-style: normal; opacity: 0.5; }
#menu .server .bosses { letter-spacing: 2px; }
#menu .server.bare .stat { display: none !important; }
`;

/** The marks' icons, in the chips' colour. */
const HEART = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 14.2S1.5 10.3 1.5 5.6A3.4 3.4 0 0 1 8 4a3.4 3.4 0 0 1 6.5 1.6c0 4.7-6.5 8.6-6.5 8.6z"/></svg>';
const PERSON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5" r="3"/><path d="M2 15c0-3.6 2.7-5.6 6-5.6s6 2 6 5.6z"/></svg>';
const LINK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.6 9.4a.9.9 0 0 1 0-1.3l2.9-2.9a.9.9 0 1 1 1.3 1.3L7.9 9.4a.9.9 0 0 1-1.3 0z"/><path d="M9 3.2a3.3 3.3 0 0 1 4.7 4.7l-1.6 1.6a.9.9 0 0 1-1.3-1.3l1.6-1.6a1.5 1.5 0 0 0-2.1-2.1L8.7 6.1a.9.9 0 0 1-1.3-1.3zM7 12.8a3.3 3.3 0 0 1-4.7-4.7l1.6-1.6a.9.9 0 0 1 1.3 1.3L3.6 9.4a1.5 1.5 0 0 0 2.1 2.1l1.6-1.6a.9.9 0 0 1 1.3 1.3z"/></svg>';


/** One of the minigame's machines (src/loadingRunner.ts): a rust crate with an accent stripe, a rarity tag and two screws. */
const MACHINE_ICON = `<svg viewBox="2 13 40 28" aria-hidden="true">
<rect x="4" y="15" width="36" height="25" rx="4" fill="#251509" stroke="#3b2616" stroke-width="2"/>
<g class="lid"><rect x="6" y="16" width="32" height="21" rx="3" fill="#7a5238" stroke="#3b2616" stroke-width="2"/>
<rect x="10" y="23" width="24" height="5" fill="#a04a20"/><rect class="tag" x="10" y="23" width="5" height="5" fill="#3ff0ff"/>
<circle cx="10" cy="20" r="2" fill="#8a8f93" stroke="#3b2616"/><circle cx="34" cy="33" r="2" fill="#8a8f93" stroke="#3b2616"/>
<path d="M17 33h2M22 33h2M27 33h2" stroke="#3b2616" stroke-width="1.4"/></g></svg>`;

/** Esc presses in a row that didn't get back into the game before the note says why. */
const ESC_TRIES = 4;

export class Menu {
  private el = document.createElement('div');
  private serverEl!: HTMLElement;
  private stats = false;

  constructor(canvas: HTMLElement, onAo: (intensity: number) => void) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.stats = statsPref();

    this.el.id = 'menu';
    this.el.className = 'game';
    this.el.innerHTML = `<div class="panel"><div class="main"><h2>${TEXT.game.name}</h2><button class="resume">${kbd('menu')}${TEXT.menu.resume}</button>
<button class="opt" style="margin-top:12px">${TEXT.menu.options}</button>
<button class="fs" style="margin-top:8px"></button>
<button class="leaveGame" style="margin-top:8px">${TEXT.menu.mainMenu}</button>
<div class="foot"><a href="./credits.txt" target="_blank" rel="noopener">${TEXT.menu.credits}</a></div></div>
${optionsHtml()}</div>
<div class="server bare"><div class="title"><div class="sname"></div><span class="crowd stat">${GROUP_SVG}<b></b></span></div><div class="times"><span class="mine stat">${HOURGLASS}<b></b></span><span class="up stat" data-tip="${TEXT.menu.server.uptime}">${CLOCK_SVG}<b></b></span></div>
<div class="chips stat"><span class="chip stat lives">${HEART}<b></b></span><span class="chip stat bosses"></span><span class="chip stat online" data-tip="${TEXT.landing.tipSeats}">${PERSON}<b></b></span></div>
<div class="copy"><button class="chip code" data-tip="${TEXT.menu.server.code}"><i>#</i>${WORLD_ID}</button>
<button class="chip invite" data-tip="${TEXT.menu.copyInvite}" aria-label="${TEXT.menu.copyInvite}">${LINK}</button></div></div>
<div class="fsNote"></div>
<button class="mini" title="${TEXT.menu.minigame}" aria-label="${TEXT.menu.minigame}">${MACHINE_ICON}</button>`;
    document.body.append(this.el);
    this.serverEl = this.el.querySelector('.server')!;
    this.serverEl.querySelector('.sname')!.textContent = WORLD_ID;
    // The world's URL (shared/world.ts), without dev flags: anyone opening it joins this world.
    // It opens the world's lobby (src/lobby.ts). The code alone is for the main menu's Join box.
    copies(this.el.querySelector<HTMLButtonElement>('.invite')!, () => `${location.origin}${location.pathname}?w=${WORLD_ID}`);
    copies(this.el.querySelector<HTMLButtonElement>('.code')!, () => WORLD_ID);

    bindOptions(this.el, {
      onAo,
      onStats: (on) => (this.stats = on),
    });
    const panel = this.el.querySelector<HTMLElement>('.panel')!;
    this.el.querySelector('.opt')!.addEventListener('click', () => panel.classList.add('opts'));
    this.el.querySelector('.optBack')!.addEventListener('click', () => panel.classList.remove('opts'));
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

    // Resume closes the menu once the mouse is the game's again (pointerlockchange below); refused, the menu stays and
    // Resume pulses: click it.
    // After ESC_TRIES refused Esc presses in a row (windowed), the box beside Go fullscreen says why.
    const resumeButton = this.el.querySelector<HTMLElement>('.resume')!;
    let escRefused = 0;
    const resume = (byEsc = false) => {
      void capture(canvas).then((ok) => {
        if (ok || !this.open) return;
        resumeButton.classList.remove('nudge');
        void resumeButton.offsetWidth; // (restarts the animation)
        resumeButton.classList.add('nudge');
        if (byEsc && ++escRefused >= ESC_TRIES && !document.fullscreenElement) this.showFsNote(TEXT.menu.escNote);
      });
    };
    this.el.querySelector('.resume')!.addEventListener('click', () => resume());
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el) resume();
      escRefused = 0;
    });

    // Capture phase, so this sees the inventory still open when its own Esc handler is about to close it.
    addEventListener('keydown', (e) => {
      if (e.code === 'Tab' && this.open) this.toggle(false);
      if (e.code === 'Escape' && ui.inventoryOpen) ui.escClosedAt = performance.now(); // the inventory, chest or workbench takes this Esc
      if (e.code !== 'Escape' || e.repeat || document.pointerLockElement || ui.inventoryOpen || performance.now() - ui.escClosedAt < 400 || tools.frozen) return; // Esc leaves the disassembly (src/teardown)
      if (document.getElementById('name') || document.getElementById('play')) return; // Esc there skips the name (src/name.ts) or leaves the minigame
      if (!this.open) return this.toggle(true);
      // Options: back to the menu first. The menu: back into the game, grabbing the mouse when the key comes up (see below).
      const panel = this.el.querySelector<HTMLElement>('.panel')!;
      if (panel.classList.contains('opts')) return panel.classList.remove('opts');
      escResume = true;
    }, true);
    // Esc resumes on its release, after the key event: Chrome lets go of a lock taken while it handles an Esc (press
    // or release) at once. Windowed, its own Esc took the mouse, and it won't give it back without a click: Resume pulses.
    let escResume = false;
    addEventListener('keyup', (e) => {
      if (e.code !== 'Escape' || !escResume) return;
      escResume = false;
      setTimeout(() => this.open && resume(true), 0);
    }, true);
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement) {
        escRefused = 0;
        return this.toggle(false);
      }
      if (ui.inventoryOpen || performance.now() - ui.escClosedAt < 400) return;
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

  get open() {
    return this.el.classList.contains('open');
  }

  /** "Show stats" is ticked (src/statsGraph.ts is drawn). */
  get statsOn() {
    return this.stats;
  }

  private toggle(open: boolean) {
    if (open && !this.open) void this.showServer();
    this.el.classList.toggle('open', open);
    // Opened by the leave-site prompt (src/input.ts): say why it came and how fullscreen avoids it, this once.
    this.el.classList.remove('closeAsked');
    if (open && ui.closeAsked) this.showFsNote(TEXT.menu.ctrlWNote);
    if (!open) ui.closeAsked = false;
  }

  /** A note in its own box beside Go fullscreen, a line pointing at it (under the panel if there's no room), until the
   *  menu closes: why the tab almost closed (Ctrl+W), or why Esc doesn't get back in. Both: fullscreen avoids it. */
  private showFsNote(text: string) {
    const note = this.el.querySelector<HTMLElement>('.fsNote')!;
    note.textContent = text;
    this.el.classList.add('closeAsked');
    const b = this.el.querySelector('.fs')!.getBoundingClientRect();
    const beside = b.right + 22 + 220 + 16 <= innerWidth;
    note.classList.toggle('below', !beside);
    const p = this.el.querySelector('.panel')!.getBoundingClientRect();
    note.style.left = `${beside ? b.right + 22 : p.left}px`;
    note.style.top = `${beside ? b.top + b.height / 2 : p.bottom + 10}px`;
  }

  /** The game's bubble, fresh each time the menu opens (server/index.ts, as the main menu's list asks: with our browser
   *  id, so with our own time there). Without an answer (the lab, the server away) only the code and the invite. */
  private async showServer() {
    let w: WorldStats | undefined;
    try {
      const res = await fetch('api/worlds/mine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [WORLD_ID], browserId: getBrowserId() }),
      });
      if (!res.ok) throw new Error(String(res.status));
      [w] = (await res.json()) as WorldStats[];
    } catch {}
    if (!w) return this.serverEl.classList.add('bare');
    const q = (c: string) => this.serverEl.querySelector<HTMLElement>(c)!;
    q('.up b').textContent = TEXT.landing.uptime(Math.max(0, Math.floor((Date.now() - w.created) / 60_000)));
    q('.crowd b').textContent = String(w.players);
    q('.crowd').dataset.tip = TEXT.landing.players(w.players);
    const mine = Math.floor((w.played ?? 0) / 60_000);
    q('.mine b').textContent = TEXT.menu.server.played(mine);
    q('.mine').dataset.tip = TEXT.menu.server.playedTip(mine);
    q('.sname').textContent = w.locked ? `${w.name} ${TEXT.landing.lockedMark}` : w.name;
    q('.lives b').textContent = String(w.lives);
    q('.lives').dataset.tip = TEXT.menu.server.lives(w.lives);
    const n = BOSS_KINDS.filter((_, i) => w.beaten & (1 << i)).length;
    q('.bosses').textContent = '◆'.repeat(n) + '◇'.repeat(BOSS_KINDS.length - n);
    q('.bosses').dataset.tip = TEXT.menu.server.bosses(n, BOSS_KINDS.length);
    q('.online b').textContent = `${w.online}/${w.max}`;
    this.serverEl.classList.remove('bare');
  }
}
