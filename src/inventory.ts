// Items HUD: "[F] Pick up …" under the crosshair when looking at a piece in reach, a short "+1 …" toast
// whenever a pickup lands in the bag, and the Tab inventory: an overlay with the backpack (its first row is
// the hotbar, keys 1–4) and, next to it, every storage box in reach right now (chests in the base, the sand
// bike while riding; shared/storage.ts), appearing and disappearing as you move. Drag a stack onto another
// slot to move, merge or swap it; drag with the right button to move half; shift-click sends it across to
// the other side. Moves go through Net (applied at once, the server confirms).
import { HOTBAR, ITEMS, type Item, type Slots } from '../shared/items.ts';
import { SCRAP_KINDS, type ScrapPiece } from '../shared/scrap.ts';
import type { PlayerState } from '../shared/sim.ts';
import { boxLabel, openBoxes } from '../shared/storage.ts';
import { ui } from './input';
import type { Net } from './net';

const TOAST_MS = 1600;
/** Pointer travel (px) before a press on a slot becomes a drag. */
const DRAG_START = 4;

const css = `
#pickup { position: fixed; left: 50%; top: calc(50% + 22px); transform: translateX(-50%); padding: 3px 8px;
  font: 13px system-ui, sans-serif; color: #fff4e4; background: rgba(20, 10, 5, 0.55); border-radius: 4px;
  pointer-events: none; white-space: nowrap; display: none; }
#pickup kbd, #invHint kbd { font: bold 11px monospace; padding: 0 4px; margin-right: 6px; border-radius: 3px;
  background: #fff4e4; color: #2a160a; }
#invHint { position: fixed; right: 12px; bottom: 12px; font: 12px system-ui, sans-serif; color: #fff4e4;
  opacity: 0.6; pointer-events: none; text-shadow: 0 1px 2px #000; }
#toasts { position: fixed; left: 50%; top: calc(50% + 52px); transform: translateX(-50%); pointer-events: none;
  display: flex; flex-direction: column; align-items: center; gap: 2px; }
#toasts div { font: 600 13px system-ui, sans-serif; color: #ffd9a0; text-shadow: 0 1px 2px #000;
  animation: toast ${TOAST_MS}ms ease-out forwards; }
@keyframes toast { 0% { opacity: 0; transform: translateY(6px); } 12% { opacity: 1; transform: none; }
  70% { opacity: 1; } 100% { opacity: 0; transform: translateY(-10px); } }
#invOverlay { position: fixed; inset: 0; z-index: 15; display: none; align-items: center; justify-content: center;
  flex-direction: column; gap: 10px; background: rgba(12, 6, 2, 0.45); font: 12px system-ui, sans-serif;
  color: #fff4e4; user-select: none; -webkit-user-select: none; }
#invOverlay.open { display: flex; }
#invOverlay .boxes { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; justify-content: center;
  max-width: calc(100vw - 32px); }
#invOverlay .box { padding: 10px 12px 12px; border-radius: 8px; background: rgba(28, 15, 7, 0.88);
  box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.16), 0 8px 30px rgba(0, 0, 0, 0.45); }
#invOverlay .box.storage { box-shadow: 0 0 0 1px rgba(255, 200, 120, 0.35), 0 8px 30px rgba(0, 0, 0, 0.45); }
#invOverlay .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
#invOverlay h3 { margin: 0; font: 600 11px system-ui, sans-serif; letter-spacing: 0.08em; text-transform: uppercase;
  opacity: 0.75; }
#invOverlay button { font: inherit; font-size: 11px; color: inherit; background: rgba(255, 233, 204, 0.12); border: 0;
  border-radius: 4px; padding: 2px 8px; cursor: pointer; }
#invOverlay button:hover { background: rgba(255, 233, 204, 0.25); }
#invOverlay .grid { display: grid; gap: 4px; }
#invOverlay .sep { height: 6px; }
#invOverlay .slot { position: relative; width: 54px; height: 54px; border-radius: 6px; background: rgba(255, 240, 220, 0.06);
  box-shadow: inset 0 0 0 1px rgba(255, 240, 220, 0.12); display: flex; align-items: center; justify-content: center;
  cursor: grab; touch-action: none; }
#invOverlay .slot.empty { cursor: default; }
#invOverlay .slot.hot { background: rgba(255, 240, 220, 0.1); }
#invOverlay .slot.over { box-shadow: inset 0 0 0 2px rgba(255, 210, 140, 0.9); background: rgba(255, 210, 140, 0.14); }
#invOverlay .slot.dragging > :not(.key) { opacity: 0.3; }
#invOverlay .slot .key { position: absolute; left: 4px; top: 2px; font: 600 9px system-ui, sans-serif; opacity: 0.55; }
#invOverlay .slot .n { position: absolute; right: 4px; bottom: 2px; font: 600 11px system-ui, sans-serif;
  font-variant-numeric: tabular-nums; text-shadow: 0 1px 2px #000; }
#invOverlay .slot svg, #invGhost svg { width: 30px; height: 34px; }
#invOverlay .none { width: 190px; padding: 6px 2px; opacity: 0.55; line-height: 1.45; }
#invOverlay .help { opacity: 0.55; font-size: 11px; text-shadow: 0 1px 2px #000; }
#invGhost { position: fixed; z-index: 16; pointer-events: none; width: 54px; height: 54px; display: flex;
  align-items: center; justify-content: center; transform: translate(-50%, -50%); filter: drop-shadow(0 4px 6px #000); }
#invGhost .n { position: absolute; right: 4px; bottom: 2px; font: 600 11px system-ui, sans-serif; color: #fff4e4;
  text-shadow: 0 1px 2px #000; }
`;

// Icons, 22 × 26 like the hotbar's.
export const CANTEEN_SVG = `<svg viewBox="0 0 22 26"><rect x="8" y="0.5" width="6" height="4" rx="1" fill="#6b4a2e"/>
<ellipse cx="11" cy="15" rx="9.5" ry="9.5" fill="#8a8f86" stroke="#2a160a" stroke-width="1"/>
<ellipse cx="11" cy="15" rx="6.5" ry="6.5" fill="none" stroke="#5e6a5a" stroke-width="2.2"/>
<path d="M2 11h18" stroke="#6b4a2e" stroke-width="2"/></svg>`;
export const TELESCOPE_SVG = `<svg viewBox="0 0 22 26"><g stroke="#2a160a" stroke-width="0.8" transform="rotate(-45 11 13)">
<rect x="-1" y="11.6" width="5" height="2.8" rx="0.8" fill="#d4a24c"/><rect x="3.5" y="11" width="5" height="4" fill="#b8873a"/>
<rect x="8.5" y="10.2" width="10" height="5.6" rx="0.6" fill="#6a3626"/><rect x="18" y="9.6" width="4" height="6.8" rx="1" fill="#d4a24c"/></g></svg>`;
const drum = (body: string, band: string) => `<svg viewBox="0 0 22 26"><g stroke="#2a160a" stroke-width="0.9">
<path d="M4 5v16c0 2 14 2 14 0V5" fill="${body}"/><ellipse cx="11" cy="5" rx="7" ry="2" fill="${band}"/>
<path d="M4 10.5c0 1.6 14 1.6 14 0M4 16c0 1.6 14 1.6 14 0" fill="none" stroke="${band}" stroke-width="1.4"/></g></svg>`;
const frame = (bend: string) => `<svg viewBox="0 0 22 26"><path d="M3 6h16v14H3z${bend}" fill="none" stroke="#2a160a" stroke-width="3.6"/>
<path d="M3 6h16v14H3z${bend}" fill="none" stroke="#8d8a82" stroke-width="2"/><path d="M3 13h16" stroke="#6a665e" stroke-width="1.5"/></svg>`;
const sheet = (dent: string) => `<svg viewBox="0 0 22 26"><path d="M3 7l12-3 4 15-12 3z" fill="#9a968c" stroke="#2a160a" stroke-width="0.9"/>
<path d="M6 9l9-2${dent}" fill="none" stroke="#c9c4b8" stroke-width="0.9" opacity="0.8"/></svg>`;
const ICONS: Record<string, string> = {
  canteen: CANTEEN_SVG,
  spyglass: TELESCOPE_SVG,
  oil_drum: drum('#3d6e8a', '#26475a'),
  rusty_drum: drum('#8a4a26', '#5e2f16'),
  gear: `<svg viewBox="0 0 22 26"><g transform="translate(11 13)" stroke="#2a160a" stroke-width="0.9" fill="#8a7f6a">
${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<rect x="-1.8" y="-10" width="3.6" height="4" transform="rotate(${a})"/>`).join('')}
<circle r="7"/><circle r="2.6" fill="#2a160a"/></g></svg>`,
  scrap_frame: frame(''),
  bent_frame: frame('M3 20l8-5'),
  metal_plank: `<svg viewBox="0 0 22 26"><path d="M2 18L18 4l2 2.4L4 20.4z" fill="#7d7a72" stroke="#2a160a" stroke-width="0.9"/>
<circle cx="6" cy="16.6" r="0.9" fill="#2a160a"/><circle cx="16" cy="7.8" r="0.9" fill="#2a160a"/></svg>`,
  metal_sheet: sheet(''),
  dented_sheet: sheet('M8 14c2-2 4 1 6-1'),
  // Carried crash-site machines: a joint with its arm stub, and a cabinet with a door and lamps.
  robot_arm: `<svg viewBox="0 0 22 26"><g stroke="#2a160a" stroke-width="0.9"><rect x="3" y="18" width="16" height="4" rx="1" fill="#6a665e"/>
<rect x="5" y="9" width="9" height="10" rx="2" fill="#d4a24c"/><rect x="12" y="4" width="7" height="4" rx="1" fill="#b8873a" transform="rotate(30 12 6)"/>
<circle cx="9.5" cy="14" r="2.2" fill="#2a160a"/></g></svg>`,
  control_cabinet: `<svg viewBox="0 0 22 26"><g stroke="#2a160a" stroke-width="0.9"><rect x="3" y="3" width="16" height="20" rx="1.5" fill="#7d7a72"/>
<rect x="5" y="5" width="12" height="16" fill="#5e6a5a"/><circle cx="8" cy="8" r="1.1" fill="#ffb050"/><circle cx="12" cy="8" r="1.1" fill="#74d08a"/>
<rect x="7" y="12" width="8" height="5" fill="#2a160a"/></g></svg>`,
  spring: `<svg viewBox="0 0 22 26"><path d="M5 4h12M5 22h12M6 4c10 1 10 3 0 4.5s10 3 0 4.5 10 3 0 4.5 10 3 0 4.5" fill="none"
stroke="#2a160a" stroke-width="2.6"/><path d="M5 4h12M5 22h12M6 4c10 1 10 3 0 4.5s10 3 0 4.5 10 3 0 4.5 10 3 0 4.5" fill="none"
stroke="#a8a294" stroke-width="1.3"/></svg>`,
};
export const itemIcon = (kind: string) => ICONS[kind] ?? `<b>${(ITEMS[kind]?.label ?? kind).slice(0, 3)}</b>`;
export const itemLabel = (kind: string) => ITEMS[kind]?.label ?? kind;

type Drag = { box: string; i: number; half: boolean; x0: number; y0: number; moved: boolean };

export class InventoryHud {
  private prompt = document.createElement('div');
  private toasts = document.createElement('div');
  private hint = document.createElement('div');
  private overlay = document.createElement('div');
  private boxesEl = document.createElement('div');
  private ghost = document.createElement('div');
  private shown: ScrapPiece | string | null = null;
  private net: Net;
  private canvas: HTMLElement;
  /** Storage boxes in reach (shared/storage.ts openBoxes), as last drawn. */
  private storages: string[] = [];
  private drag: Drag | null = null;
  private over: HTMLElement | null = null;

  constructor(net: Net, canvas: HTMLElement) {
    this.net = net;
    this.canvas = canvas;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.prompt.id = 'pickup';
    this.toasts.id = 'toasts';
    this.hint.id = 'invHint';
    this.hint.innerHTML = '<kbd>Tab</kbd>Inventory';
    this.overlay.id = 'invOverlay';
    this.boxesEl.className = 'boxes';
    const help = document.createElement('div');
    help.className = 'help';
    help.textContent = 'Drag to move · right-drag moves half · shift-click sends across · Tab or Esc closes';
    this.overlay.append(this.boxesEl, help);
    this.ghost.id = 'invGhost';
    this.ghost.style.display = 'none';
    document.body.append(this.prompt, this.toasts, this.hint, this.overlay, this.ghost);

    net.onItems = (box, got) => {
      if (got) this.toast(`+1 ${itemLabel(got)}`);
      if (box === 'bag' || this.storages.includes(box)) this.render();
    };

    addEventListener('keydown', (e) => {
      if (e.code === 'Tab') {
        e.preventDefault(); // never the browser's focus cycling
        if (!e.repeat) this.toggle(!ui.inventoryOpen);
      } else if (e.code === 'Escape' && ui.inventoryOpen) this.toggle(false);
    });
    // A click on the dimmed backdrop closes it, back into the game.
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.target === this.overlay || e.target === this.boxesEl) this.toggle(false);
    });
    this.overlay.addEventListener('contextmenu', (e) => e.preventDefault());
    this.boxesEl.addEventListener('pointerdown', (e) => this.press(e));
    addEventListener('pointermove', (e) => this.dragMove(e));
    addEventListener('pointerup', (e) => this.release(e));
    // Taking the mouse back (a click on the game) closes it too.
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement && ui.inventoryOpen) this.toggle(false, false);
    });
  }

  /** Open: free the mouse (staying fullscreen, see src/input.ts) and draw. Close: capture it again. */
  private toggle(open: boolean, relock = true) {
    if (open === ui.inventoryOpen) return;
    ui.inventoryOpen = open;
    this.overlay.classList.toggle('open', open);
    this.cancelDrag();
    if (open) {
      document.exitPointerLock();
      this.render();
    } else if (relock && document.pointerLockElement !== this.canvas) {
      // Can be refused (no user gesture, or too soon after the browser's own Esc): a click then does it.
      Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
    }
  }

  /** The piece under the crosshair, or another F action's label (e.g. "Plant seeds"), or null; every frame. */
  setTarget(target: ScrapPiece | string | null) {
    if (target === this.shown) return;
    this.shown = target;
    this.prompt.style.display = target ? 'block' : 'none';
    if (target) this.prompt.innerHTML = `<kbd>F</kbd>${typeof target === 'string' ? target : `Pick up ${SCRAP_KINDS[target.kind].label}`}`;
  }

  /** Every frame: storage boxes come into and out of reach as the player moves. */
  update(s: PlayerState) {
    if (!ui.inventoryOpen) return;
    const open = openBoxes(s);
    if (open.join() !== this.storages.join()) this.render();
  }

  toast(text: string) {
    const el = document.createElement('div');
    el.textContent = text;
    this.toasts.appendChild(el);
    setTimeout(() => el.remove(), TOAST_MS);
  }

  private render() {
    if (!ui.inventoryOpen) return;
    this.storages = openBoxes(this.net.me).filter((b) => this.net.boxes[b]);
    const bag = this.net.boxes.bag ?? [];
    let html = `<div class="box"><div class="head"><h3>${boxLabel('bag')}</h3><button data-sort="bag" title="Merge stacks and order them (the hotbar stays)">Sort</button></div>`
      + `<div class="grid" style="grid-template-columns: repeat(4, 54px)">${this.slotsHtml('bag', bag, 0, HOTBAR)}</div><div class="sep"></div>`
      + `<div class="grid" style="grid-template-columns: repeat(4, 54px)">${this.slotsHtml('bag', bag, HOTBAR, bag.length)}</div></div>`;
    for (const box of this.storages) {
      const slots = this.net.boxes[box];
      html += `<div class="box storage"><div class="head"><h3>${boxLabel(box)}</h3><button data-sort="${box}" title="Merge stacks and order them">Sort</button></div>`
        + `<div class="grid" style="grid-template-columns: repeat(4, 54px)">${this.slotsHtml(box, slots, 0, slots.length)}</div></div>`;
    }
    if (!this.storages.length) {
      html += `<div class="box"><div class="head"><h3>Storage</h3></div><div class="none">Nothing in reach. Stand by the chest in the base,
        or ride the sand bike, and it opens here.</div></div>`;
    }
    this.boxesEl.innerHTML = html;
    if (this.drag) this.slotEl(this.drag.box, this.drag.i)?.classList.add('dragging');
  }

  private slotsHtml(box: string, slots: Slots, from: number, to: number) {
    let html = '';
    for (let i = from; i < to; i++) {
      const it = slots[i];
      const key = box === 'bag' && i < HOTBAR ? `<span class="key">${i + 1}</span>` : '';
      const cls = `slot${it ? '' : ' empty'}${key ? ' hot' : ''}`;
      html += `<div class="${cls}" data-box="${box}" data-i="${i}"${it ? ` title="${itemLabel(it.kind)}"` : ''}>${key}${it ? this.itemHtml(it) : ''}</div>`;
    }
    return html;
  }

  private itemHtml(it: Item) {
    return `${itemIcon(it.kind)}${it.n > 1 ? `<span class="n">${it.n}</span>` : ''}`;
  }

  private slotEl(box: string, i: number) {
    return this.boxesEl.querySelector<HTMLElement>(`.slot[data-box="${box}"][data-i="${i}"]`);
  }

  private slotAt(x: number, y: number) {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('#invOverlay .slot');
    return el ? { el, box: el.dataset.box!, i: Number(el.dataset.i) } : null;
  }

  private press(e: PointerEvent) {
    const sort = (e.target as HTMLElement).closest<HTMLElement>('[data-sort]');
    if (sort) return this.net.sortBox(sort.dataset.sort!);
    const at = this.slotAt(e.clientX, e.clientY);
    if (!at || !this.net.boxes[at.box]?.[at.i]) return;
    e.preventDefault();
    if (e.shiftKey) {
      // Across: bag → the nearest storage; storage → bag. Without storage, between hotbar and backpack.
      const to = at.box !== 'bag' ? 'bag' : this.storages[0];
      if (to) this.net.moveItem(at.box, at.i, to, -1);
      else this.hotbarSwap(at.i);
      return;
    }
    this.drag = { box: at.box, i: at.i, half: e.button === 2, x0: e.clientX, y0: e.clientY, moved: false };
  }

  /** Shift-click in the bag with no storage open: hotbar ↔ first free backpack slot (or the first free hotbar slot). */
  private hotbarSwap(i: number) {
    const bag = this.net.boxes.bag;
    if (!bag) return;
    const range = i < HOTBAR ? [HOTBAR, bag.length] : [0, HOTBAR];
    for (let j = range[0]; j < range[1]; j++) {
      if (!bag[j]) return this.net.moveItem('bag', i, 'bag', j);
    }
  }

  private dragMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_START) return;
    if (!d.moved) {
      const it = this.net.boxes[d.box]?.[d.i];
      if (!it) return this.cancelDrag();
      d.moved = true;
      const n = d.half ? Math.ceil(it.n / 2) : it.n;
      this.ghost.innerHTML = `${itemIcon(it.kind)}${n > 1 ? `<span class="n">${n}</span>` : ''}`;
      this.ghost.style.display = 'flex';
      this.slotEl(d.box, d.i)?.classList.add('dragging');
    }
    this.ghost.style.left = `${e.clientX}px`;
    this.ghost.style.top = `${e.clientY}px`;
    const at = this.slotAt(e.clientX, e.clientY);
    if (this.over !== (at?.el ?? null)) {
      this.over?.classList.remove('over');
      this.over = at?.el ?? null;
      this.over?.classList.add('over');
    }
  }

  private release(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    this.cancelDrag();
    if (!d.moved) return;
    const at = this.slotAt(e.clientX, e.clientY);
    if (!at || (at.box === d.box && at.i === d.i)) return;
    const it = this.net.boxes[d.box]?.[d.i];
    if (!it) return;
    this.net.moveItem(d.box, d.i, at.box, at.i, d.half ? Math.ceil(it.n / 2) : undefined);
  }

  private cancelDrag() {
    if (this.drag) this.slotEl(this.drag.box, this.drag.i)?.classList.remove('dragging');
    this.drag = null;
    this.ghost.style.display = 'none';
    this.over?.classList.remove('over');
    this.over = null;
  }
}
