// The build menu (the right mouse with the wrench in hand, src/placing.ts): every building (shared/crafting.ts BUILDS)
// with what it takes of the base materials and what the bag has. Picking one puts its preview on the crosshair to put
// up; picking it again puts the wrench back to just a wrench. The mouse is freed like the inventory (ui.inventoryOpen).
import { BUILDS, countMatching } from '../shared/crafting.ts';
import type { Slots } from '../shared/items.ts';
import { ctl, isBound } from './bindings';
import { ui } from './input';
import { itemIcon, itemLabel } from './inventory';
import { TEXT } from '../shared/text.ts';

const css = `
#buildMenu { position: fixed; inset: 0; z-index: 7; display: none; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.35); font: 13px var(--mono); color: #fff4e4; }
#buildMenu.open { display: flex; }
#buildMenu .panel { min-width: 260px; max-width: min(360px, calc(100vw / var(--ui, 1) - 32px)); padding: 14px; border-radius: 8px; background: rgba(28, 15, 7, 0.94);
  box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.16), 0 8px 30px rgba(0, 0, 0, 0.45); display: flex; flex-direction: column; gap: 6px; }
#buildMenu h3 { margin: 0 0 4px; font: 600 13px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: #ffd9a0; }
#buildMenu button { display: flex; align-items: center; gap: 10px; font: 12px var(--mono); text-align: left; color: #fff4e4;
  background: rgba(255, 240, 220, 0.12); border: 0; border-radius: 4px; padding: 6px 10px 6px 6px; cursor: pointer; }
#buildMenu button:hover:not(:disabled) { background: rgba(255, 240, 220, 0.24); }
#buildMenu button.sel { box-shadow: inset 0 0 0 2px #ffd9a0; }
#buildMenu button:disabled { cursor: default; opacity: 0.75; }
#buildMenu .ico { width: 46px; height: 46px; flex: none; display: flex; align-items: center; justify-content: center; }
#buildMenu .ico img, #buildMenu .ico svg { max-width: 46px; max-height: 46px; pointer-events: none; }
#buildMenu .name { font-weight: 600; }
#buildMenu .need { font-size: 11px; line-height: 1.5; opacity: 0.9; }
#buildMenu .need .short { color: #ff9a7a; }
#buildMenu .need .ok { color: #9ad88a; }
#buildMenu .legend { margin-top: 4px; font: 11px var(--mono); color: #fff4e4; opacity: 0.8; }
#buildMenu .legend kbd { font: bold 11px var(--mono); padding: 0 4px; margin-right: 5px; border-radius: 3px; background: #fff4e4; color: #2a160a; }
`;

export class BuildMenu {
  private el = document.createElement('div');
  private panel: HTMLElement;
  private canvas: HTMLElement;

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    this.el.id = 'buildMenu';
    this.el.innerHTML = '<div class="panel"></div>';
    this.panel = this.el.firstElementChild as HTMLElement;
    document.body.append(this.el);
    // A click beside the menu, Esc or the right mouse again closes it; taking the mouse back (a click on the game) does too.
    // (On a press, not the context menu: that comes on the release on some systems, the release of the press that opened it.)
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el || e.button === 2) this.close();
    });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('keydown', (e) => {
      if (this.isOpen && !e.repeat && (e.code === 'Escape' || isBound('interact', e.code))) this.close();
    });
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement && this.isOpen) this.close(false);
    });
  }

  get isOpen() {
    return this.el.classList.contains('open');
  }

  /** Open it over the game: `bag` for what there is, `chosen` the building picked now (or null), `pick` called with
   *  the one clicked (null: the chosen one again, to put it away). */
  open(bag: Slots, chosen: string | null, pick: (kind: string | null) => void) {
    const p = this.panel;
    p.replaceChildren();
    const title = document.createElement('h3');
    title.textContent = TEXT.prompt.buildMenu;
    p.append(title);
    for (const [kind, r] of Object.entries(BUILDS)) {
      let ready = true;
      const needs = r.needs.map((ing) => {
        const have = countMatching(bag, ing);
        ready &&= have >= ing.n;
        return `<span class="${have >= ing.n ? 'ok' : 'short'}">${ing.label} ${Math.min(have, ing.n)}/${ing.n}</span>`;
      }).join('<br>');
      const b = document.createElement('button');
      b.className = kind === chosen ? 'sel' : '';
      // The chosen one stays clickable, to put it away.
      b.disabled = !ready && kind !== chosen;
      b.innerHTML = `<div class="ico">${itemIcon(kind)}</div><div><div class="name">${itemLabel(kind)}</div><div class="need">${needs}</div></div>`;
      b.addEventListener('click', () => {
        this.close();
        pick(kind === chosen ? null : kind);
      });
      p.append(b);
    }
    // The pad's way out (src/padCursor.ts); the keys' (Esc, F) go unsaid.
    p.insertAdjacentHTML('beforeend', `<div class="legend">${ctl('uiClose', TEXT.inventory.close)}</div>`);
    ui.inventoryOpen = true;
    this.el.classList.add('open');
    document.exitPointerLock();
  }

  close(relock = true) {
    if (!this.isOpen) return;
    this.el.classList.remove('open');
    ui.inventoryOpen = false;
    if (relock && document.pointerLockElement !== this.canvas) Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
  }
}
