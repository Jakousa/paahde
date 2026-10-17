// Items HUD: "[F] Pick up …" under the crosshair when looking at a piece in reach, a short "+1 …" toast
// whenever a pickup lands in the bag, and the Tab inventory: an overlay with your equipment (back, wrist,
// belt, vehicle: shared/gear.ts), the bag (its first row is the hotbar, keys 1–4; below it a grid with as many
// rows as the backpack you wear opens) and, next to it, every box in reach right now (the workbench in the base,
// chests, the motorcycle while riding; shared/storage.ts), appearing and disappearing as you move. Grids are
// Tarkov-like: every item takes w × h cells by its size (shared/items.ts). Drag an item to move it (the cells it
// would take light up green, or red where it doesn't fit; R turns it) or onto another to swap the two; shift-click
// sends it across to the other side; drag it out of the panels
// to drop it on the sand in front of you (shared/loot.ts; anyone can pick it up again). At the workbench, put
// broken gear on it and drag parts onto its part slots to repair it, or a better part onto a filled slot to
// upgrade it (the old one comes back); its recipes (shared/crafting.ts) are listed there too. Moves go through
// Net (applied at once, the server confirms).
import { bagShape, boxShape, EQUIP_LABELS, EQUIP_SLOTS, fitsSlot, GEAR, isGear, partsOf, quality, repaired, slotLabel, tryMove, type Boxes } from '../shared/gear.ts';
import { findSpot, HOTBAR, ITEMS, sizeOf, strandedAt, type Item, type Shape, type Slots } from '../shared/items.ts';
import { partOf } from '../shared/parts.ts';
import { RARITY, SALVAGE, TIERS } from '../shared/salvage.ts';
import { countMatching, RECIPES } from '../shared/crafting.ts';
import { SCRAP_KINDS, type ScrapPiece } from '../shared/scrap.ts';
import type { PlayerState } from '../shared/sim.ts';
import { boxLabel, openBoxes } from '../shared/storage.ts';
import { canDropAt } from '../shared/loot.ts';
import { takePickup, ui } from './input';
import type { Net } from './net';

const TOAST_MS = 1600;
/** Pointer travel (px) before a press on a slot becomes a drag. */
const DRAG_START = 4;
/** A grid cell (px) and the gap between cells: one step is CELL + GAP. */
const CELL = 54;
const GAP = 4;
/** Size (px) of an item w × h cells big. */
const span = (n: number) => n * CELL + (n - 1) * GAP;
/** Icon scale for an item w × h cells big: by its short side, and a little more for long ones (SVGs; images stay square). */
const iconScale = (w: number, h: number) => `--s: ${Math.min(w, h)}; --sv: ${Math.min(w, h) + (w !== h ? 0.4 : 0)}`;

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
/* Chests grow without end (shared/storage.ts growChest): past ~6 rows they scroll. */
#invOverlay .box.storage .grid { max-height: 346px; overflow-y: auto; scrollbar-width: thin; padding-right: 2px; }
#invOverlay .cell { width: 54px; height: 54px; border-radius: 6px; background: rgba(255, 240, 220, 0.06);
  box-shadow: inset 0 0 0 1px rgba(255, 240, 220, 0.12); }
#invOverlay .cell.dead { background: rgba(222, 62, 34, 0.12); box-shadow: inset 0 0 0 1px rgba(222, 62, 34, 0.5); }
/* Items in a grid span their cells, over the empty-cell backdrop. */
#invOverlay .slot.item { width: auto; height: auto; z-index: 1; background: rgba(66, 44, 26, 0.96); }
#invOverlay .slot.item svg, #invGhost svg { width: calc(30px * var(--sv, 1)); height: calc(34px * var(--sv, 1)); }
#invOverlay .slot.item img, #invGhost img { width: calc(46px * var(--s, 1)); height: calc(46px * var(--s, 1)); }
#invOverlay .slot.turned > svg, #invOverlay .slot.turned > img, #invGhost.turned > svg, #invGhost.turned > img { transform: rotate(90deg); }
#invOverlay .hint { z-index: 2; pointer-events: none; border-radius: 6px; }
#invOverlay .hint.ok { background: rgba(140, 220, 150, 0.22); box-shadow: inset 0 0 0 2px rgba(140, 220, 150, 0.85); }
#invOverlay .hint.no { background: rgba(222, 62, 34, 0.22); box-shadow: inset 0 0 0 2px rgba(222, 62, 34, 0.85); }
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
#invGhost { position: fixed; z-index: 16; pointer-events: none; display: flex; align-items: center; justify-content: center;
  border-radius: 6px; background: rgba(66, 44, 26, 0.55); filter: drop-shadow(0 4px 6px #000); }
#invGhost.drop::after { content: 'Drop'; position: absolute; top: 100%; font: 600 11px var(--mono); color: #fff4e4;
  text-shadow: 0 1px 2px #000; }
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
  // The scrap fields' starter machines: a winch drum with its crank, a valve in a pipe with its coil, a beacon with its mast.
  winch: `<svg viewBox="0 0 22 26"><g stroke="#2a160a" stroke-width="0.9"><rect x="2" y="19" width="18" height="3" fill="#6a665e"/>
<rect x="4" y="10" width="3" height="9" fill="#7a5238"/><rect x="15" y="7" width="3" height="12" fill="#7a5238"/>
<rect x="6" y="11" width="10" height="7" rx="1.5" fill="#56705e"/><path d="M7 12.5h8M7 14.5h8M7 16.5h8" stroke="#2a160a" stroke-width="0.6"/>
<path d="M18 8h2v-4" fill="none"/><circle cx="20" cy="4" r="1.2" fill="#b02a20"/></g></svg>`,
  solenoid_valve: `<svg viewBox="0 0 22 26"><g stroke="#2a160a" stroke-width="0.9"><rect x="1" y="15" width="20" height="4" fill="#7d7a72"/>
<rect x="6" y="13" width="1.6" height="8" fill="#55575a"/><rect x="14.4" y="13" width="1.6" height="8" fill="#55575a"/>
<rect x="8" y="12" width="6" height="9" rx="1" fill="#d4a24c"/><rect x="8.5" y="4" width="5" height="7" rx="1" fill="#c87a44"/>
<path d="M13.5 6c4 0 5 2 5 6" fill="none" stroke="#6b3f1e"/></g></svg>`,
  beacon: `<svg viewBox="0 0 22 26"><g stroke="#2a160a" stroke-width="0.9"><rect x="3" y="12" width="16" height="10" rx="1.5" fill="#e0c060"/>
<path d="M3 15h16M3 19h16" stroke="#2a160a" stroke-width="0.6"/><rect x="9" y="8" width="4" height="4" fill="#7d7a72"/>
<path d="M11 8V2" stroke-width="1.2"/><circle cx="11" cy="2.5" r="1.4" fill="#ff5a3a"/></g></svg>`,
  // Laser rifle, muzzle up-right: wood stock, grip and handguard, grey receiver, scope, energy cell, glowing emitter.
  laser_rifle: `<svg viewBox="0 0 22 26"><g transform="translate(11 13.5) rotate(-48) scale(0.8)" stroke="#2a160a" stroke-width="0.8"
stroke-linejoin="round"><path d="M-13 5Q-3 10 6 1.5" fill="none" stroke="#6e6444" stroke-width="1"/>
<path d="M-15.5 -0.6L-6.6 -1.7V1.4L-15.5 4.6z" fill="#8e4426"/><path d="M-4.4 1.2L-6 5.6H-3.8L-2.6 1.2z" fill="#7e3a20"/>
<path d="M-0.6 1.2H2.4L3.3 5.4H0.4z" fill="#6a6648"/><path d="M1 2.2L1.6 4.5" stroke="#ff6a2a" stroke-width="0.9"/>
<rect x="-7" y="-2.1" width="9.6" height="3.5" rx="0.6" fill="#8d8f8a"/><rect x="2.4" y="-1.7" width="6.4" height="3" rx="1.1" fill="#8e4426"/>
<rect x="8.6" y="-0.75" width="3" height="1.3" fill="#55575a"/><rect x="11.4" y="-2" width="3.4" height="3.8" rx="0.5" fill="#3a3a38"/>
<path d="M12.3 -1.6V1.4M13.4 -1.6V1.4" stroke="#ff6a2a" stroke-width="0.6"/><circle cx="15.6" cy="-0.1" r="1.6" fill="#ff7a32" stroke="none" opacity="0.45"/>
<circle cx="15.2" cy="-0.1" r="0.9" fill="#ffb066" stroke="none"/><rect x="-1.6" y="-3.2" width="1.2" height="1.2" fill="#2e2a26"/>
<rect x="-5.6" y="-5" width="7.4" height="2" rx="1" fill="#4a4a48"/><path d="M-11 0.3L-10 2.8" stroke="#3a3a36" stroke-width="1.4"/></g></svg>`,
  // Laser pistol, muzzle right: black upper with the silver bolt cap and cell tube, raked brown grip, ribbed shroud, red tip.
  laser_pistol: `<svg viewBox="0 0 22 26"><g transform="translate(11 13) scale(0.85)" stroke="#120c08" stroke-width="0.7" stroke-linejoin="round">
<path d="M-6.5 -1.2L-1.6 -1.2L-3.6 9.2Q-4 10.4 -5.4 10.2L-8.6 9.6Q-9.6 9.3 -9.2 8.2z" fill="#6a3a22"/>
<path d="M-7 1.2L-4.6 1.6M-7.6 4L-5 4.4M-8.2 6.8L-5.6 7.2" stroke="#3a1e10" stroke-width="0.5"/>
<path d="M-1.4 -0.6Q-1 3.2 2.2 3.2Q3.4 3.2 3.4 -0.6" fill="none" stroke="#2a2a2a" stroke-width="0.9"/>
<rect x="-9" y="-4.4" width="12.6" height="4.2" rx="0.7" fill="#2e2f31"/><rect x="-10.6" y="-3.6" width="1.8" height="2.6" rx="0.6" fill="#a9aaa6"/>
<rect x="-7" y="-6" width="8" height="1.5" rx="0.7" fill="#c4c5c0"/><rect x="3.4" y="-3" width="2.4" height="1.6" fill="#2e2f31"/>
<rect x="5.6" y="-3.6" width="4.4" height="2.8" rx="0.4" fill="#1e1c1b"/><path d="M6.6 -3.6V-0.8M7.7 -3.6V-0.8M8.8 -3.6V-0.8" stroke="#3a3836" stroke-width="0.5"/>
<rect x="9.8" y="-3.5" width="1.4" height="2.6" rx="0.4" fill="#ff3a1a" stroke="none"/><circle cx="11" cy="-2.2" r="1.8" fill="#ff5a2a" stroke="none" opacity="0.35"/>
<rect x="-3.6" y="-3" width="3" height="0.9" fill="#ff3a1a" stroke="none" opacity="0.85"/></g></svg>`,
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
/** Carried salvage wrecks use their Blender-rendered icons, public/icons/salvage/<id>.png (tools/blender/salvage). */
const salvageIcon = (kind: string) => `<img src="./icons/salvage/${kind}.png" alt="" draggable="false">`;
export const itemIcon = (kind: string) =>
  ICONS[kind] ?? (partOf(kind) ? partIcon(kind) : kind in SALVAGE ? salvageIcon(kind) : `<b>${(ITEMS[kind]?.label ?? kind).slice(0, 3)}</b>`);
export const itemLabel = (kind: string) => ITEMS[kind]?.label ?? kind;

/** Quality as a rarity name (rounded down: three Scrap parts and one Quality is still Scrap... ish). */
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
    return `${itemLabel(it.kind)} (broken)\nNeeds: ${missing.join(', ')}`;
  }
  return `${itemLabel(it.kind)} · ${qualityName(quality(it))} (${quality(it).toFixed(1)} / 3)\n${spec.use}`;
}

/**
 * An item being dragged: from where, half the stack (right button), turned (R), and where the pointer holds it
 * (px from its top-left corner, as drawn now).
 */
type Drag = { box: string; i: number; half: boolean; x0: number; y0: number; moved: boolean; r: boolean; gx: number; gy: number };
/** Where a drag would land: a slot (free slot, workbench part slot) or a grid cell for the item's top-left corner. */
type Target = { box: string; i: number; el?: HTMLElement; grid?: HTMLElement };

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
  /** The cells a drag would take, lit green or red. */
  private hint = document.createElement('div');
  private hintAt = '';

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
    this.overlay.append(this.boxesEl);
    this.ghost.id = 'invGhost';
    this.ghost.style.display = 'none';
    document.body.append(this.prompt, this.toasts, this.overlay, this.ghost);

    net.onItems = (box, got) => {
      // The disassembly mode shows its own "+ Motor · Quality" flying to the hotbar.
      if (got && !document.body.classList.contains('teardown')) this.toast(`+1 ${itemLabel(got)}`);
      if (box === 'bag' || box === 'equip' || this.storages.includes(box)) this.render();
    };

    addEventListener('keydown', (e) => {
      if (e.code === 'Tab') {
        e.preventDefault(); // never the browser's focus cycling
        if (!e.repeat) this.toggle(!ui.inventoryOpen);
      } else if (e.code === 'Escape' && ui.inventoryOpen) this.toggle(false);
      else if (e.code === 'KeyF' && !e.repeat && ui.inventoryOpen) {
        // F closes it too (the workbench opens with F); the same press doesn't open it again.
        takePickup();
        this.toggle(false);
      }
      else if (e.code === 'KeyR' && !e.repeat && this.drag?.moved) this.turn();
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
    const shape = bagShape(equip);
    // Equipment, then the bag: hotbar row, the backpack's grid (with any rows it no longer opens), and overflow.
    let html = `<div class="box"><div class="head"><h3>${boxLabel('equip')}</h3></div>`
      + `<div class="grid" style="grid-template-columns: repeat(4, 54px)">${this.slotsHtml('equip', equip, 0, EQUIP_SLOTS.length)}</div>`
      + `<div class="sep"></div><div class="head"><h3>${boxLabel('bag')}</h3><button data-sort="bag" title="Pack it tight, biggest first (the hotbar stays)">Sort</button></div>`
      + `<div class="grid" style="grid-template-columns: repeat(4, 54px)">${this.slotsHtml('bag', bag, 0, HOTBAR)}</div><div class="sep"></div>`;
    if (!shape.rows) html += `<div class="none">No backpack</div>`;
    html += this.gridHtml('bag', bag, shape) + '</div>';
    for (const box of this.storages) {
      const slots = this.net.boxes[box];
      if (box === 'bench') {
        html += this.benchHtml(slots[0] ?? null);
        continue;
      }
      html += `<div class="box storage"><div class="head"><h3>${boxLabel(box)}</h3><button data-sort="${box}">Sort</button></div>`
        + `${this.gridHtml(box, slots, boxShape(box, this.net.boxes))}</div>`;
    }
    if (!this.storages.length) {
      html += `<div class="box"><div class="head"><h3>Storage</h3></div><div class="none">Nothing in reach</div></div>`;
    }
    // Re-rendering resets scrolling: keep each long chest where it was.
    const scrolled = new Map<string, number>();
    for (const el of this.boxesEl.querySelectorAll<HTMLElement>('[data-grid]')) scrolled.set(el.dataset.grid!, el.scrollTop);
    this.boxesEl.innerHTML = html;
    for (const el of this.boxesEl.querySelectorAll<HTMLElement>('[data-grid]')) {
      const top = scrolled.get(el.dataset.grid!);
      if (top) el.scrollTop = top;
    }
    this.hintAt = '';
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
      return html + `<div class="state">Broken gear</div></div>`;
    }
    const ok = repaired(it);
    const spec = GEAR[it.kind];
    const parts = partsOf(it);
    const missing = spec.slots.filter((_, i) => !parts[i]).map(slotLabel);
    html += `<div><div class="name">${itemLabel(it.kind)}</div><div class="state ${ok ? 'ok' : 'no'}">`
      + (ok ? `Works · ${qualityName(quality(it))}` : `Needs ${missing.join(', ')}`)
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
    return html;
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

  /**
   * A box's grid: a backdrop of empty cells (red in rows a smaller backpack no longer opens, shown only while
   * something lies there), the items on top spanning their cells, then anything past the end as single slots.
   */
  private gridHtml(box: string, slots: Slots, shape: Shape) {
    const end = shape.free + shape.cols * shape.grid;
    let rows = shape.rows;
    for (let i = shape.free; i < Math.min(end, slots.length); i++) {
      const it = slots[i];
      if (it) rows = Math.max(rows, Math.floor((i - shape.free) / shape.cols) + sizeOf(it.kind, it.r)[1]);
    }
    rows = Math.min(rows, shape.grid);
    let html = '';
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < shape.cols; x++) html += `<div class="cell${y >= shape.rows ? ' dead' : ''}" style="grid-area: ${y + 1} / ${x + 1}"></div>`;
    }
    for (let i = shape.free; i < Math.min(end, slots.length); i++) {
      const it = slots[i];
      if (!it) continue;
      const [w, h] = sizeOf(it.kind, it.r);
      const x = (i - shape.free) % shape.cols, y = Math.floor((i - shape.free) / shape.cols);
      html += this.slotHtml(box, i, it, `grid-area: ${y + 1} / ${x + 1} / span ${h} / span ${w}; ${iconScale(w, h)}`,
        strandedAt(slots, shape, i));
    }
    html = rows ? `<div class="grid" data-grid="${box}" data-free="${shape.free}" data-cols="${shape.cols}" data-rows="${rows}" style="grid-template-columns: repeat(${shape.cols}, ${CELL}px); grid-auto-rows: ${CELL}px">${html}</div>` : '';
    if (slots.length > end && slots.slice(end).some((it) => it)) {
      html += `<div class="sep"></div><div class="none">No room</div>`
        + `<div class="grid" style="grid-template-columns: repeat(4, 54px)">${this.slotsHtml(box, slots, end, slots.length, true)}</div>`;
    }
    return html;
  }

  /** One item lying in a grid, spanning its cells (`style`). */
  private slotHtml(box: string, i: number, it: Item, style: string, dead: boolean) {
    const broken = isGear(it.kind) && !repaired(it);
    const c = rarityColor(it.kind);
    const cls = `slot item${broken ? ' broken' : ''}${dead ? ' dead' : ''}${c ? ' rare' : ''}${it.r ? ' turned' : ''}`;
    return `<div class="${cls}" data-box="${box}" data-i="${i}" style="${style}${c ? `; --c:${c}` : ''}" title="${itemTitle(it)}">${this.itemHtml(it)}</div>`;
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

  /**
   * Where the drag would land: over a grid, the cell under the dragged item's top-left corner (so it goes where
   * the ghost shows it); elsewhere the slot under the pointer.
   */
  private targetAt(x: number, y: number, d: Drag): Target | null {
    const under = document.elementFromPoint(x, y);
    const grid = under?.closest<HTMLElement>('[data-grid]');
    if (grid) {
      const rect = grid.getBoundingClientRect();
      const cx = Math.round((x - d.gx - rect.left) / (CELL + GAP));
      const cy = Math.round((y - d.gy - rect.top + grid.scrollTop) / (CELL + GAP));
      const cols = Number(grid.dataset.cols);
      if (cx < 0 || cy < 0 || cx >= cols) return { box: grid.dataset.grid!, i: -2, grid };
      return { box: grid.dataset.grid!, i: Number(grid.dataset.free) + cy * cols + cx, grid };
    }
    const at = this.slotAt(x, y);
    return at && { box: at.box, i: at.i, el: at.el };
  }

  /** The dragged item as it would land (turned or not). */
  private dragged(d: Drag): Item | null {
    const it = this.itemAt(d.box, d.i);
    return it && { ...it, r: d.r };
  }

  /** Light the cells the drag would take over a grid: green if the move would go through, red if not. */
  private showHint(t: Target | null, d: Drag) {
    const it = this.dragged(d);
    const key = t?.grid && it ? `${t.box}:${t.i}:${d.r}` : '';
    if (key === this.hintAt) return;
    this.hintAt = key;
    if (!key || !t?.grid || !it) return void this.hint.remove();
    const cols = Number(t.grid.dataset.cols), rows = Number(t.grid.dataset.rows), free = Number(t.grid.dataset.free);
    const [w, h] = sizeOf(it.kind, d.r);
    // Off an edge: shown clamped inside the grid (it never grows it), red.
    const c = Math.max(0, t.i - free);
    const x = t.i < 0 ? 0 : c % cols, y = Math.min(rows - 1, t.i < 0 ? 0 : Math.floor(c / cols));
    this.hint.style.gridArea = `${y + 1} / ${x + 1} / span ${Math.min(h, rows - y)} / span ${Math.min(w, cols - x)}`;
    this.hint.className = `hint ${t.i >= 0 && this.wouldMove(d, t) ? 'ok' : 'no'}`;
    t.grid.appendChild(this.hint);
  }

  /** Would dropping here go through? Tried on copies of the boxes involved. */
  private wouldMove(d: Drag, t: Target): boolean {
    const b: Boxes = { ...this.net.boxes };
    for (const id of new Set([d.box, t.box])) b[id] = b[id]?.map((it) => it && { ...it });
    if (d.box === 'part') return true;
    const it = this.itemAt(d.box, d.i);
    return !!it && tryMove(b, d.box, d.i, t.box, t.i, d.half ? Math.ceil(it.n / 2) : undefined, () => -1, d.r);
  }

  /** Draw the ghost for the dragged item at its size, turned or not. */
  private drawGhost(d: Drag, it: Item) {
    const n = d.half ? Math.ceil(it.n / 2) : it.n;
    const [w, h] = sizeOf(it.kind, d.r);
    this.ghost.innerHTML = `${itemIcon(it.kind)}${n > 1 ? `<span class="n">${n}</span>` : ''}`;
    this.ghost.setAttribute('style', `${iconScale(w, h)}; --c: ${rarityColor(it.kind) ?? '#fff4e4'}`);
    this.ghost.style.width = `${span(w)}px`;
    this.ghost.style.height = `${span(h)}px`;
    this.ghost.classList.toggle('turned', d.r);
    this.ghost.style.display = 'flex';
  }

  /** R while dragging: turn the item 90°, held by its top-left cell. */
  private turn() {
    const d = this.drag;
    const it = d && this.itemAt(d.box, d.i);
    if (!d || !it) return;
    d.r = !d.r;
    d.gx = d.gy = CELL / 2;
    this.drawGhost(d, it);
    this.ghost.style.left = `${d.x0 - d.gx}px`;
    this.ghost.style.top = `${d.y0 - d.gy}px`;
    this.hintAt = '';
    this.showHint(this.targetAt(d.x0, d.y0, d), d);
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
    if (sort) return void (this.net.sortBox(sort.dataset.sort!) || this.toast("Can't pack it any tighter"));
    const craft = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-craft]');
    if (craft) return void (craft.disabled || this.net.craft(craft.dataset.craft!));
    const at = this.slotAt(e.clientX, e.clientY);
    if (!at || !this.itemAt(at.box, at.i)) return;
    e.preventDefault();
    if (e.shiftKey) return this.shiftClick(at.box, at.i);
    // Held where it was grabbed when it lies in a grid; by its first cell's middle from a single slot.
    const rect = at.el.getBoundingClientRect();
    const inGrid = at.el.classList.contains('item');
    const it = this.itemAt(at.box, at.i)!;
    this.drag = {
      box: at.box, i: at.i, half: e.button === 2, x0: e.clientX, y0: e.clientY, moved: false, r: !!it.r,
      gx: inGrid ? e.clientX - rect.left : CELL / 2, gy: inGrid ? e.clientY - rect.top : CELL / 2,
    };
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

  /** Shift-click in the bag with no storage open: hotbar ↔ the first spot it fits in the backpack (or the first free hotbar slot). */
  private hotbarSwap(i: number) {
    const bag = this.net.boxes.bag;
    const it = bag?.[i];
    if (!bag || !it) return;
    if (i < HOTBAR) {
      const spot = findSpot(bag, bagShape(this.net.boxes.equip), it.kind, !!it.r, [i], false);
      if (spot) this.net.moveItem('bag', i, 'bag', spot.i, undefined, spot.r);
      else this.toast('No room');
      return;
    }
    for (let j = 0; j < HOTBAR; j++) {
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
      this.drawGhost(d, it);
      this.ghost.style.display = 'flex';
      this.slotEl(d.box, d.i)?.classList.add('dragging');
      // Light up the workbench slots this part fits.
      const target = this.net.boxes.bench?.[0];
      if (target && this.storages.includes('bench')) {
        GEAR[target.kind].slots.forEach((s, j) => this.slotEl('part', j)?.classList.toggle('fits', fitsSlot(s, it.kind)));
      }
    }
    // Remembered for R, which turns it where the pointer is.
    d.x0 = e.clientX;
    d.y0 = e.clientY;
    this.ghost.style.left = `${e.clientX - d.gx}px`;
    this.ghost.style.top = `${e.clientY - d.gy}px`;
    const at = this.targetAt(e.clientX, e.clientY, d);
    this.showHint(at, d);
    this.ghost.classList.toggle('drop', this.outside(e.clientX, e.clientY));
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
    if (this.outside(e.clientX, e.clientY)) return this.drop(d.box, d.i);
    const at = this.targetAt(e.clientX, e.clientY, d);
    const it = this.itemAt(d.box, d.i);
    if (!at || !it || (at.box === d.box && at.i === d.i && d.r === !!it.r)) return;
    let ok: boolean;
    if (at.i < 0) ok = false;
    else if (d.box === 'part') ok = at.box !== 'part' && this.net.unfit(d.i, at.box, at.i);
    else if (at.box === 'part') ok = this.net.fit(d.box, d.i, at.i);
    else ok = this.net.moveItem(d.box, d.i, at.box, at.i, d.half ? Math.ceil(it.n / 2) : undefined, d.r);
    if (!ok) this.refuse(d.box, it, at.box);
  }

  /** Off every panel: on the dimmed backdrop (or out of the window). */
  private outside(x: number, y: number) {
    const el = document.elementFromPoint(x, y);
    return !el || el === this.overlay || el === this.boxesEl;
  }

  /** Dragged out of the panels: drop it on the sand in front of you. */
  private drop(box: string, i: number) {
    if (box === 'part') return this.toast('Take it off');
    if (box === 'equip' || box === 'bench') return this.toast('Take it off');
    if (!canDropAt(this.net.me.x, this.net.me.z)) return this.toast("Can't drop here");
    this.net.dropItem(box, i);
  }

  /** Say why a drop didn't go through. */
  private refuse(from: string, it: Item, to: string) {
    if (to === 'equip') this.toast(isGear(it.kind) && GEAR[it.kind].equip ? (repaired(it) ? 'Wrong slot' : 'Broken') : "Can't wear");
    else if (to === 'bench') this.toast(isGear(it.kind) ? 'Bench in use' : 'Gear only');
    else if (to === 'part') this.toast("That part doesn't go there");
    else if (from === 'equip' && it.kind === 'backpack') this.toast('Empty the backpack first');
    else this.toast("Doesn't fit there");
  }

  private cancelDrag() {
    if (this.drag) this.slotEl(this.drag.box, this.drag.i)?.classList.remove('dragging');
    this.drag = null;
    this.ghost.style.display = 'none';
    this.ghost.classList.remove('drop');
    this.hint.remove();
    this.hintAt = '';
    this.over?.classList.remove('over');
    this.over = null;
    for (const el of this.boxesEl.querySelectorAll('.slot.fits')) el.classList.remove('fits');
  }
}
