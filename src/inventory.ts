// Items HUD: "[F] Pick up …" under the crosshair when looking at a piece in reach, a short "+1 …" toast
// whenever a pickup lands in the bag, and the Tab inventory: an overlay with your equipment (back, wrist,
// belt, vehicle: shared/gear.ts), the bag (its first row is the hotbar, keys 1–4; the rest is as big as the
// backpack you wear) and, next to it, every box in reach right now (the workbench in the base, chests, the
// motorcycle while riding; shared/storage.ts), appearing and disappearing as you move. Drag an item onto another
// slot to move it there or swap the two; shift-click sends it across to the other side. At the workbench, put
// broken gear on it and drag parts onto its part slots to repair it, or a better part onto a filled slot to
// upgrade it (the old one comes back); its recipes (shared/crafting.ts) are listed there too. Moves go through
// Net (applied at once, the server confirms).
import { bagSize, EQUIP_LABELS, EQUIP_SLOTS, fitsSlot, GEAR, isGear, partsOf, quality, repaired, slotLabel } from '../shared/gear.ts';
import { HOTBAR, ITEMS, type Item, type Slots } from '../shared/items.ts';
import { partOf } from '../shared/parts.ts';
import { RARITY, TIERS } from '../shared/salvage.ts';
import { countMatching, RECIPES } from '../shared/crafting.ts';
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
  font: 13px var(--mono); color: #fff4e4; background: rgba(20, 10, 5, 0.55); border-radius: 4px;
  pointer-events: none; white-space: nowrap; display: none; }
#pickup kbd { font: bold 11px var(--mono); padding: 0 4px; margin-right: 6px; border-radius: 3px;
  background: #fff4e4; color: #2a160a; }
#pickup * + kbd { margin-left: 10px; }
#pickup .bad { color: #ffb08a; }
#toasts { position: fixed; left: 50%; top: calc(50% + 52px); transform: translateX(-50%); pointer-events: none;
  display: flex; flex-direction: column; align-items: center; gap: 2px; }
#toasts div { font: 600 13px var(--mono); color: #ffd9a0; text-shadow: 0 1px 2px #000;
  animation: toast ${TOAST_MS}ms ease-out forwards; }
@keyframes toast { 0% { opacity: 0; transform: translateY(6px); } 12% { opacity: 1; transform: none; }
  70% { opacity: 1; } 100% { opacity: 0; transform: translateY(-10px); } }
#invOverlay { position: fixed; inset: 0; z-index: 15; display: none; align-items: center; justify-content: center;
  flex-direction: column; gap: 10px; background: rgba(12, 6, 2, 0.45); font: 12px var(--mono);
  color: #fff4e4; user-select: none; -webkit-user-select: none; }
#invOverlay.open { display: flex; }
#invOverlay .boxes { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; justify-content: center;
  max-width: calc(100vw - 32px); }
#invOverlay .box { padding: 10px 12px 12px; border-radius: 8px; background: rgba(28, 15, 7, 0.88);
  box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.16), 0 8px 30px rgba(0, 0, 0, 0.45); }
#invOverlay .box.storage { box-shadow: 0 0 0 1px rgba(255, 200, 120, 0.35), 0 8px 30px rgba(0, 0, 0, 0.45); }
#invOverlay .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
#invOverlay h3 { margin: 0; font: 600 11px var(--mono); letter-spacing: 0.08em; text-transform: uppercase;
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
#invOverlay .slot .key { position: absolute; left: 4px; top: 2px; font: 600 9px var(--mono); opacity: 0.55; }
#invOverlay .slot .n { position: absolute; right: 4px; bottom: 2px; font: 600 11px var(--mono);
  font-variant-numeric: tabular-nums; text-shadow: 0 1px 2px #000; }
#invOverlay .slot svg, #invGhost svg { width: 30px; height: 34px; }
#invOverlay .slot img, #invGhost img, #invOverlay .recipe .ico img { width: 46px; height: 46px; pointer-events: none; }
#invOverlay .slot .tile, #invGhost .tile { font: 700 18px var(--mono); color: var(--c); }
#invOverlay .slot.rare { box-shadow: inset 0 0 0 1px rgba(255, 240, 220, 0.12), inset 0 -3px 0 var(--c);
  background: radial-gradient(circle at 50% 60%, color-mix(in srgb, var(--c) 22%, transparent), rgba(255, 240, 220, 0.04) 70%); }
#invOverlay .none { width: 190px; padding: 6px 2px; opacity: 0.55; line-height: 1.45; }
#invOverlay .recipe { display: flex; align-items: center; gap: 10px; padding: 6px 4px; width: 230px; }
#invOverlay .recipe + .recipe { border-top: 1px solid rgba(255, 240, 220, 0.1); }
#invOverlay .recipe .ico { width: 46px; height: 46px; flex: none; display: flex; align-items: center; justify-content: center;
  border-radius: 6px; background: rgba(255, 240, 220, 0.06); }
#invOverlay .recipe .what { flex: 1; line-height: 1.5; }
#invOverlay .recipe .name { font-weight: 600; }
#invOverlay .recipe .need { font-size: 11px; opacity: 0.85; }
#invOverlay .recipe .need .short { color: #ff9a7a; }
#invOverlay .recipe .need .ok { color: #9ad88a; }
#invOverlay button:disabled { opacity: 0.35; cursor: default; }
#invOverlay .help { opacity: 0.55; font-size: 11px; text-shadow: 0 1px 2px #000; }
#invGhost { position: fixed; z-index: 16; pointer-events: none; width: 54px; height: 54px; display: flex;
  align-items: center; justify-content: center; transform: translate(-50%, -50%); filter: drop-shadow(0 4px 6px #000); }
#invGhost .n { position: absolute; right: 4px; bottom: 2px; font: 600 11px var(--mono); color: #fff4e4;
  text-shadow: 0 1px 2px #000; }
#invOverlay .slot .bad { position: absolute; right: 3px; top: 1px; font: 700 10px var(--mono); color: #ff8a66; }
#invOverlay .slot.broken > svg, #invOverlay .slot.broken > img { opacity: 0.5; filter: grayscale(0.8); }
#invOverlay .slot .ph { font: 600 9px var(--mono); letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.4; }
#invOverlay .slot.dead { background: rgba(222, 62, 34, 0.12); box-shadow: inset 0 0 0 1px rgba(222, 62, 34, 0.5); }
#invOverlay .slot.fits { box-shadow: inset 0 0 0 1px rgba(140, 220, 150, 0.7); }
#invOverlay .box.bench { box-shadow: 0 0 0 1px rgba(160, 220, 140, 0.35), 0 8px 30px rgba(0, 0, 0, 0.45); }
#invOverlay .bench { display: flex; flex-direction: column; gap: 8px; width: 238px; }
#invOverlay .bench .top { display: flex; gap: 10px; align-items: center; }
#invOverlay .bench .name { font-weight: 600; }
#invOverlay .bench .state { font-size: 11px; opacity: 0.8; line-height: 1.4; }
#invOverlay .bench .state.ok { color: #8fe0a0; opacity: 1; }
#invOverlay .bench .state.no { color: #ff9a76; opacity: 1; }
#invOverlay .bench .parts { display: grid; grid-template-columns: repeat(4, 54px); gap: 4px; }
#invOverlay .bench .pl { font-size: 9px; line-height: 1.15; text-align: center; opacity: 0.6; margin-top: 2px; width: 54px; }
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
const g = (body: string) => `<svg viewBox="0 0 22 26"><g stroke="#2a160a" stroke-width="0.9">${body}</g></svg>`;
const ICONS: Record<string, string> = {
  canteen: CANTEEN_SVG,
  spyglass: TELESCOPE_SVG,
  motorcycle: g(`<circle cx="5" cy="18" r="4" fill="#3a2a1e"/><circle cx="17" cy="18" r="4" fill="#3a2a1e"/>
<circle cx="5" cy="18" r="1.4" fill="#8a8f86"/><circle cx="17" cy="18" r="1.4" fill="#8a8f86"/>
<path d="M5 18l4-7h6l2 7M9 11l-1-3h3M15 11l2-4h2" fill="none" stroke-width="1.6"/><rect x="9" y="10" width="7" height="3.4" rx="1" fill="#c0563a"/>`),
  backpack: g(`<rect x="4" y="5" width="14" height="18" rx="4" fill="#8a6a3e"/><path d="M4 11c4 2 10 2 14 0v4c-4 2-10 2-14 0z" fill="#6b4a2e"/>
<rect x="8" y="16" width="6" height="4" rx="1" fill="#a8844e"/><path d="M8 5c0-3 6-3 6 0" fill="none" stroke-width="1.6"/>`),
  storm_detector: g(`<rect x="4" y="8" width="14" height="15" rx="2" fill="#7d7a72"/><path d="M14 8V2" stroke-width="1.4"/>
<circle cx="14" cy="2" r="1.2" fill="#ffb050"/><rect x="6.5" y="11" width="9" height="5" fill="#2a3a2e"/>
<path d="M7.5 14.5c2-3 4 1 6-2" fill="none" stroke="#ffb050" stroke-width="1"/><circle cx="8" cy="19.5" r="1.2" fill="#e05a3a"/>`),
  wristpad: g(`<rect x="8" y="1" width="6" height="24" rx="2" fill="#5e4a36"/><rect x="4" y="7" width="14" height="12" rx="2.5" fill="#6a665e"/>
<rect x="6" y="9" width="10" height="8" rx="1" fill="#2a3a3e"/><path d="M7.5 15l2-3 2 2 3-4" fill="none" stroke="#6ef0c8" stroke-width="1"/>`),
  metal_detector: g(`<path d="M15 2L9 19" stroke-width="2.4"/><path d="M15 2L9 19" stroke="#a8a294" stroke-width="1.2"/>
<rect x="12.5" y="5" width="5" height="4" rx="1" fill="#3a3a3a" transform="rotate(20 15 7)"/><ellipse cx="7" cy="21.5" rx="6" ry="2.6" fill="#d4a24c"/>
<ellipse cx="7" cy="21.5" rx="3" ry="1.2" fill="#2a160a"/>`),
  shovel: g(`<path d="M15.5 2l-6 13" stroke-width="2.6"/><path d="M15.5 2l-6 13" stroke="#8a6a3e" stroke-width="1.4"/>
<path d="M13 1h5" stroke-width="2.4"/><path d="M7 14l5 2.3-2.5 6.2c-1 2-4.5.5-5.5-1-1-1.5-.3-3.5 3-7.5z" fill="#9a968c"/>`),
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
// Rendered icons (public/icons/items/<kind>.png, tools/blender/placeables.py) for the crafted placeables.
const png = (kind: string) => `<img src="./icons/items/${kind}.png" alt="" draggable="false">`;
ICONS.plant_bed = png('plant_bed');
ICONS.uv_lamp = png('uv_lamp');
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
/** Parts (shared/parts.ts) use their rendered icons, public/icons/items/<part>_<tier>.png (tools/blender/items.py); a lettered tile in the rarity colour if one fails. */
function partIcon(kind: string) {
  const letter = (ITEMS[kind]?.label.split(' ').pop() ?? '?')[0].toUpperCase();
  return `<img src="./icons/items/${kind}.png" alt="" draggable="false" onerror="this.outerHTML='<b class=&quot;tile&quot;>${letter}</b>'">`;
}
export const itemIcon = (kind: string) => ICONS[kind] ?? (partOf(kind) ? partIcon(kind) : `<b>${(ITEMS[kind]?.label ?? kind).slice(0, 3)}</b>`);
export const itemLabel = (kind: string) => ITEMS[kind]?.label ?? kind;

/** Quality as a rarity name (rounded down: three Common parts and one Rare is still Common... ish). */
function qualityName(q: number) {
  return RARITY[TIERS[Math.max(0, Math.min(3, Math.floor(q + 1e-6)))]].name;
}

/** Rarity colour (shared/salvage.ts RARITY) of an item with a tier, as CSS, or null. */
const rarityColor = (kind: string) => {
  const t = ITEMS[kind]?.tier;
  return t ? hex(RARITY[t].color) : null;
};

/** Tooltip for an item: the rarity for items with a tier; gear says what it needs or how good it is. */
export function itemTitle(it: Item): string {
  const t = ITEMS[it.kind]?.tier;
  if (t) return `${itemLabel(it.kind)} · ${RARITY[t].name}`;
  if (!isGear(it.kind)) return itemLabel(it.kind);
  const spec = GEAR[it.kind];
  const parts = partsOf(it);
  if (!repaired(it)) {
    const missing = spec.slots.filter((_, i) => !parts[i]).map(slotLabel);
    return `${itemLabel(it.kind)} (broken)\nNeeds: ${missing.join(', ')}\nRepair it at the workbench in the base.`;
  }
  return `${itemLabel(it.kind)} · ${qualityName(quality(it))} (${quality(it).toFixed(1)} / 3)\n${spec.use}\nBetter parts: ${spec.better}.`
    + (spec.equip ? `\nEquip it on your ${EQUIP_LABELS[spec.equip].toLowerCase()} (Tab).` : '');
}

type Drag = { box: string; i: number; half: boolean; x0: number; y0: number; moved: boolean };

export class InventoryHud {
  private prompt = document.createElement('div');
  private toasts = document.createElement('div');
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
    this.overlay.id = 'invOverlay';
    this.boxesEl.className = 'boxes';
    const help = document.createElement('div');
    help.className = 'help';
    help.textContent = 'Drag to move · shift-click sends across · Tab or Esc closes';
    this.overlay.append(this.boxesEl, help);
    this.ghost.id = 'invGhost';
    this.ghost.style.display = 'none';
    document.body.append(this.prompt, this.toasts, this.overlay, this.ghost);

    net.onItems = (box, got) => {
      // The disassembly mode shows its own "+ Motor · Rare" flying to the hotbar.
      if (got && !document.body.classList.contains('teardown')) this.toast(`+1 ${itemLabel(got)}`);
      if (box === 'bag' || box === 'equip' || this.storages.includes(box)) this.render();
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
    // A label that starts with markup brings its own keys (e.g. "[G] Pick up" alone).
    if (target) this.prompt.innerHTML = typeof target === 'string' && target.startsWith('<') ? target
      : `<kbd>F</kbd>${typeof target === 'string' ? target : `Pick up ${SCRAP_KINDS[target.kind].label}`}`;
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

  /** Open the inventory from outside (F at the workbench). */
  open() {
    this.toggle(true);
  }

  private render() {
    if (!ui.inventoryOpen) return;
    this.storages = openBoxes(this.net.me).filter((b) => this.net.boxes[b]);
    const bag = this.net.boxes.bag ?? [];
    const equip = this.net.boxes.equip ?? [];
    const size = bagSize(equip);
    // Equipment, then the bag: hotbar row, backpack rows, and anything stranded past a smaller backpack.
    let html = `<div class="box"><div class="head"><h3>${boxLabel('equip')}</h3></div>`
      + `<div class="grid" style="grid-template-columns: repeat(4, 54px)">${this.slotsHtml('equip', equip, 0, EQUIP_SLOTS.length)}</div>`
      + `<div class="sep"></div><div class="head"><h3>${boxLabel('bag')}</h3><button data-sort="bag" title="Merge stacks and order them (the hotbar stays)">Sort</button></div>`
      + `<div class="grid" style="grid-template-columns: repeat(4, 54px)">${this.slotsHtml('bag', bag, 0, HOTBAR)}</div><div class="sep"></div>`;
    if (size > HOTBAR) html += `<div class="grid" style="grid-template-columns: repeat(4, 54px)">${this.slotsHtml('bag', bag, HOTBAR, size)}</div>`;
    else html += `<div class="none">No backpack: just the hotbar. Find one, repair it at the workbench and wear it for more slots.</div>`;
    const stranded = bag.some((it, i) => it && i >= size);
    if (stranded) {
      html += `<div class="sep"></div><div class="none">Doesn't fit your backpack any more: move these out.</div>`
        + `<div class="grid" style="grid-template-columns: repeat(4, 54px)">${this.slotsHtml('bag', bag, size, bag.length, true)}</div>`;
    }
    html += '</div>';
    for (const box of this.storages) {
      const slots = this.net.boxes[box];
      if (box === 'bench') {
        html += this.benchHtml(slots[0] ?? null);
        continue;
      }
      html += `<div class="box storage"><div class="head"><h3>${boxLabel(box)}</h3><button data-sort="${box}" title="Merge stacks and order them">Sort</button></div>`
        + `<div class="grid" style="grid-template-columns: repeat(4, 54px)">${this.slotsHtml(box, slots, 0, slots.length)}</div></div>`;
    }
    if (!this.storages.length) {
      html += `<div class="box"><div class="head"><h3>Storage</h3></div><div class="none">Nothing in reach. Stand by the workbench or the
        chest in the base, or ride the motorcycle, and it opens here.</div></div>`;
    }
    this.boxesEl.innerHTML = html;
    if (this.drag) this.slotEl(this.drag.box, this.drag.i)?.classList.add('dragging');
  }

  /** The workbench: the item being repaired, its part slots and what it still needs, then the recipes. */
  private benchHtml(it: Item | null) {
    return `<div class="box bench"><div class="head"><h3>${boxLabel('bench')}</h3></div>${this.repairHtml(it)}`
      + `<div class="sep"></div><div class="head"><h3>Craft</h3></div>${this.recipesHtml(this.net.boxes.bag ?? [])}</div>`;
  }

  private repairHtml(it: Item | null) {
    let html = `<div class="top">` + this.slotsHtml('bench', [it], 0, 1);
    if (!it) {
      return html + `<div class="state">Put broken gear here, then drag parts onto its slots. A better part on a filled slot upgrades it.</div></div>`;
    }
    const ok = repaired(it);
    const spec = GEAR[it.kind];
    const parts = partsOf(it);
    const missing = spec.slots.filter((_, i) => !parts[i]).map(slotLabel);
    html += `<div><div class="name">${itemLabel(it.kind)}</div><div class="state ${ok ? 'ok' : 'no'}">`
      + (ok ? `Works · ${qualityName(quality(it))}<br><span style="color:#fff4e4;opacity:.7">Better parts: ${spec.better}</span>` : `Needs ${missing.join(', ')}`)
      + `</div></div></div><div class="parts">`;
    const held = this.drag ? this.net.boxes[this.drag.box]?.[this.drag.i] : null;
    spec.slots.forEach((slot, i) => {
      const kind = parts[i];
      const fits = held && fitsSlot(slot, held.kind) ? ' fits' : '';
      const c = kind && rarityColor(kind);
      html += `<div><div class="slot${kind ? '' : ' empty'}${fits}${c ? ' rare' : ''}" data-box="part" data-i="${i}"${c ? ` style="--c:${c}"` : ''} title="${kind ? itemLabel(kind) : `Needs a ${slotLabel(slot).toLowerCase()}`}">`
        + (kind ? itemIcon(kind) : `<span class="ph">+</span>`) + `</div><div class="pl">${slotLabel(slot)}</div></div>`;
    });
    return html + '</div>';
  }

  /** The workbench's recipes (shared/crafting.ts): what each needs, what you have, and a Craft button. */
  private recipesHtml(bag: Slots) {
    let html = '';
    for (const [id, r] of Object.entries(RECIPES)) {
      let ready = true;
      const needs = r.needs.map((ing) => {
        const have = countMatching(bag, ing);
        ready &&= have >= ing.n;
        return `<span class="${have >= ing.n ? 'ok' : 'short'}">${ing.label} ${Math.min(have, ing.n)}/${ing.n}</span>`;
      }).join('<br>');
      html += `<div class="recipe"><div class="ico">${itemIcon(r.makes)}</div><div class="what"><div class="name">${itemLabel(r.makes)}</div>`
        + `<div class="need">${needs}</div></div><button data-craft="${id}"${ready ? '' : ' disabled'}>Craft</button></div>`;
    }
    return `${html}<div class="none" style="width:230px">Crafted things go in the bag. Put one in the hotbar (1–4) to place it on the floor here.</div>`;
  }

  private slotsHtml(box: string, slots: Slots, from: number, to: number, dead = false) {
    let html = '';
    for (let i = from; i < to; i++) {
      const it = slots[i];
      const key = box === 'bag' && i < HOTBAR ? `<span class="key">${i + 1}</span>` : '';
      const ph = box === 'equip' && !it ? `<span class="ph">${EQUIP_LABELS[EQUIP_SLOTS[i]]}</span>` : '';
      const broken = it && isGear(it.kind) && !repaired(it);
      const c = it && rarityColor(it.kind);
      const cls = `slot${it ? '' : ' empty'}${key ? ' hot' : ''}${broken ? ' broken' : ''}${dead ? ' dead' : ''}${c ? ' rare' : ''}`;
      html += `<div class="${cls}" data-box="${box}" data-i="${i}"${c ? ` style="--c:${c}"` : ''}${it ? ` title="${itemTitle(it)}"` : ''}>${key}${ph}${it ? this.itemHtml(it) : ''}</div>`;
    }
    return html;
  }

  private itemHtml(it: Item) {
    const broken = isGear(it.kind) && !repaired(it);
    return `${itemIcon(it.kind)}${it.n > 1 ? `<span class="n">${it.n}</span>` : ''}${broken ? '<span class="bad">✕</span>' : ''}`;
  }

  private slotEl(box: string, i: number) {
    return this.boxesEl.querySelector<HTMLElement>(`.slot[data-box="${box}"][data-i="${i}"]`);
  }

  private slotAt(x: number, y: number) {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('#invOverlay .slot');
    return el ? { el, box: el.dataset.box!, i: Number(el.dataset.i) } : null;
  }

  /** What's in a slot; 'part' slots are the workbench item's fitted parts. */
  private itemAt(box: string, i: number): Item | null {
    if (box === 'part') {
      const kind = this.net.boxes.bench?.[0] && partsOf(this.net.boxes.bench[0])[i];
      return kind ? { id: 0, kind, n: 1 } : null;
    }
    return this.net.boxes[box]?.[i] ?? null;
  }

  private press(e: PointerEvent) {
    const sort = (e.target as HTMLElement).closest<HTMLElement>('[data-sort]');
    if (sort) return this.net.sortBox(sort.dataset.sort!);
    const craft = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-craft]');
    if (craft) return void (craft.disabled || this.net.craft(craft.dataset.craft!));
    const at = this.slotAt(e.clientX, e.clientY);
    if (!at || !this.itemAt(at.box, at.i)) return;
    e.preventDefault();
    if (e.shiftKey) return this.shiftClick(at.box, at.i);
    this.drag = { box: at.box, i: at.i, half: e.button === 2, x0: e.clientX, y0: e.clientY, moved: false };
  }

  /**
   * Shift-click sends an item where it most likely goes: a part out of the workbench item into the bag; at the
   * workbench, gear onto it and parts into the first slot they fit (an empty one first); gear to its equipment
   * slot and back; else across to the nearest storage, or between hotbar and backpack.
   */
  private shiftClick(box: string, i: number) {
    const net = this.net;
    if (box === 'part') return void net.unfit(i, 'bag', -1);
    const it = net.boxes[box]?.[i];
    if (!it) return;
    const bench = this.storages.includes('bench');
    const target = net.boxes.bench?.[0];
    if (bench && box !== 'bench' && target && !isGear(it.kind)) {
      const slots = GEAR[target.kind].slots;
      const parts = partsOf(target);
      const fit = slots.findIndex((s, j) => !parts[j] && fitsSlot(s, it.kind));
      const swap = fit >= 0 ? fit : slots.findIndex((s, j) => fitsSlot(s, it.kind) && parts[j] !== it.kind);
      if (swap >= 0 && net.fit(box, i, swap)) return;
    }
    if (bench && box !== 'bench' && isGear(it.kind) && net.moveItem(box, i, 'bench', 0)) return;
    if (box === 'equip' || box === 'bench') return void net.moveItem(box, i, 'bag', -1);
    if (isGear(it.kind) && GEAR[it.kind].equip && repaired(it) && net.moveItem(box, i, 'equip', -1)) return;
    // Across: bag → the nearest storage; storage → bag. Without storage, between hotbar and backpack.
    const to = box !== 'bag' ? 'bag' : this.storages.find((b) => b !== 'bench');
    if (to) net.moveItem(box, i, to, -1);
    else this.hotbarSwap(i);
  }

  /** Shift-click in the bag with no storage open: hotbar ↔ first free backpack slot (or the first free hotbar slot). */
  private hotbarSwap(i: number) {
    const bag = this.net.boxes.bag;
    if (!bag) return;
    const range = i < HOTBAR ? [HOTBAR, bagSize(this.net.boxes.equip)] : [0, HOTBAR];
    for (let j = range[0]; j < range[1]; j++) {
      if (!bag[j]) return void this.net.moveItem('bag', i, 'bag', j);
    }
  }

  private dragMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_START) return;
    if (!d.moved) {
      const it = this.itemAt(d.box, d.i);
      if (!it) return this.cancelDrag();
      d.moved = true;
      const n = d.half ? Math.ceil(it.n / 2) : it.n;
      this.ghost.innerHTML = `${itemIcon(it.kind)}${n > 1 ? `<span class="n">${n}</span>` : ''}`;
      this.ghost.style.setProperty('--c', rarityColor(it.kind) ?? '#fff4e4');
      this.ghost.style.display = 'flex';
      this.slotEl(d.box, d.i)?.classList.add('dragging');
      // Light up the workbench slots this part fits.
      const target = this.net.boxes.bench?.[0];
      if (target && this.storages.includes('bench')) {
        GEAR[target.kind].slots.forEach((s, j) => this.slotEl('part', j)?.classList.toggle('fits', fitsSlot(s, it.kind)));
      }
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
    const it = this.itemAt(d.box, d.i);
    if (!it) return;
    let ok: boolean;
    if (d.box === 'part') ok = at.box !== 'part' && this.net.unfit(d.i, at.box, at.i);
    else if (at.box === 'part') ok = this.net.fit(d.box, d.i, at.i);
    else ok = this.net.moveItem(d.box, d.i, at.box, at.i, d.half ? Math.ceil(it.n / 2) : undefined);
    if (!ok) this.refuse(d.box, it, at.box);
  }

  /** Say why a drop didn't go through. */
  private refuse(from: string, it: Item, to: string) {
    if (to === 'equip') this.toast(isGear(it.kind) && GEAR[it.kind].equip ? (repaired(it) ? 'That slot is for something else' : 'Repair it first') : 'Not something you wear');
    else if (to === 'bench') this.toast(isGear(it.kind) ? 'Take the item on the bench off first' : 'Only gear goes on the workbench');
    else if (to === 'part') this.toast("That part doesn't go there");
    else if (from === 'equip' && it.kind === 'backpack') this.toast('Empty the backpack first');
    else if (to === 'bag') this.toast('No room there');
  }

  private cancelDrag() {
    if (this.drag) this.slotEl(this.drag.box, this.drag.i)?.classList.remove('dragging');
    this.drag = null;
    this.ghost.style.display = 'none';
    this.over?.classList.remove('over');
    this.over = null;
    for (const el of this.boxesEl.querySelectorAll('.slot.fits')) el.classList.remove('fits');
  }
}
