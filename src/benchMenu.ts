// The disassembly table's menu (F at the table): with a machine on it, scrap it (click twice); with the table
// free, every machine carried in the bag to put on it. The mouse is freed like the inventory (ui.inventoryOpen).
import { ui } from './input';
import { ctl, isBound } from './bindings';
import { TEXT } from '../shared/text.ts';

const SURE_MS = 3000;

const css = `
#benchMenu { position: fixed; inset: 0; z-index: 7; display: none; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.35); font: 13px var(--mono); color: #fff4e4; }
#benchMenu.open { display: flex; }
#benchMenu .panel { min-width: 240px; max-width: min(360px, calc(100vw - 32px)); padding: 14px; border-radius: 8px; background: rgba(28, 15, 7, 0.94);
  box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.16), 0 8px 30px rgba(0, 0, 0, 0.45); display: flex; flex-direction: column; gap: 6px; }
#benchMenu h3 { margin: 0 0 4px; font: 600 13px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: #ffd9a0; }
#benchMenu button { font: 600 12px var(--mono); text-align: left; color: #fff4e4; background: rgba(255, 240, 220, 0.12); border: 0;
  border-radius: 4px; padding: 7px 10px; cursor: pointer; }
#benchMenu button:hover { background: rgba(255, 240, 220, 0.24); }
#benchMenu button.sure { background: #ff9c86; color: #2a160a; }
#benchMenu .legend { margin-top: 4px; font: 11px var(--mono); color: #fff4e4; opacity: 0.8; }
#benchMenu .legend kbd { font: bold 11px var(--mono); padding: 0 4px; margin-right: 5px; border-radius: 3px; background: #fff4e4; color: #2a160a; }
`;

export interface BenchChoices {
  /** The machine on the table (its name), or null when the table is free. */
  job: string | null;
  /** Carried machines that can be put on the free table: item kind and name. */
  kinds: { kind: string; label: string }[];
  place(kind: string): void;
  scrap(): void;
}

export class BenchMenu {
  private el = document.createElement('div');
  private panel: HTMLElement;
  private canvas: HTMLElement;
  private sureTimer = 0;

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    this.el.id = 'benchMenu';
    this.el.innerHTML = '<div class="panel"></div>';
    this.panel = this.el.firstElementChild as HTMLElement;
    document.body.append(this.el);
    // A click beside the menu, Esc or the use key closes it; taking the mouse back (a click on the game) does too.
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el) this.close();
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

  open(c: BenchChoices) {
    const p = this.panel;
    p.replaceChildren();
    const title = document.createElement('h3');
    title.textContent = c.job ?? TEXT.prompt.useTable;
    p.append(title);
    const add = (text: string, onClick: (b: HTMLButtonElement) => void) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.addEventListener('click', () => onClick(b));
      p.append(b);
    };
    if (c.job) {
      // Scrapping throws the machine away: the first click asks, a second within a few seconds does it.
      add(TEXT.teardown.scrap, (b) => {
        if (b.classList.contains('sure')) {
          this.close();
          c.scrap();
          return;
        }
        b.classList.add('sure');
        b.textContent = TEXT.teardown.scrapSure;
        clearTimeout(this.sureTimer);
        this.sureTimer = window.setTimeout(() => {
          b.classList.remove('sure');
          b.textContent = TEXT.teardown.scrap;
        }, SURE_MS);
      });
    } else {
      for (const k of c.kinds) add(TEXT.prompt.putOnTable(k.label), () => {
        this.close();
        c.place(k.kind);
      });
    }
    // The pad's way out (src/padCursor.ts); the keys' (Esc, F) go unsaid.
    p.insertAdjacentHTML('beforeend', `<div class="legend">${ctl('uiClose', TEXT.inventory.close)}</div>`);
    ui.inventoryOpen = true;
    this.el.classList.add('open');
    document.exitPointerLock();
  }

  close(relock = true) {
    if (!this.isOpen) return;
    clearTimeout(this.sureTimer);
    this.el.classList.remove('open');
    ui.inventoryOpen = false;
    if (relock && document.pointerLockElement !== this.canvas) Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
  }
}
