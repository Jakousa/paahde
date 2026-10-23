// Items HUD: "[F] Pick up …" under the crosshair when looking at a piece in reach, a short "+1 …" toast
// whenever a pickup lands in the bag, and the Tab inventory: an overlay with your equipment (back, wrist,
// belt, armor: shared/gear.ts), the bag (its first row is the hotbar, keys 1–5; below it a grid with as many
// rows as the backpack you wear opens) and, next to it, every box in reach right now (the workbench in the base,
// chests, a motorcycle's cargo; shared/storage.ts), appearing and disappearing as you move. Grids are
// Tarkov-like: every item takes w × h cells by its size (shared/items.ts). Drag an item to move it (the cells it
// would take light up green, or red where it doesn't fit; R turns it) or onto another to swap the two; shift-click
// sends it across to the other side, Take all empties a storage box into the bag and Store all
// fills it from the bag (all but tools and placeables); drag it out of the panels
// to drop it on the sand in front of you (shared/loot.ts; anyone can pick it up again). At the workbench, put
// broken gear on it and drag parts onto its part slots to repair it, or a better part onto a filled slot to
// upgrade it (the old one comes back); its recipes (shared/crafting.ts) are listed there too. A building in reach (the
// windmill, the battery station: shared/gear.ts buildingBox) shows its part slots the same way, to fit its parts
// where it stands (it goes up with them empty: src/placing.ts). F on a broken motorcycle (shared/vehicles.ts) opens it
// alone next to the bag, its part slots to fill, and Repair stands it up once they're full; F on a working one's back
// opens its cargo with its part slots beside it, to swap in better parts. Loot lying in reach (shared/loot.ts lootReach) shows as one more panel, On the ground: click,
// shift-click or drag a piece into the bag to pick it up, or drag something onto the panel to drop it. Moves go through
// Net (applied at once, the server confirms). Picking up, putting down and moving plop (src/uiSound.ts), once per item.
import { bagShape, boxShape, buildingId, cargoId, EQUIP_LABELS, EQUIP_SLOTS, fitsSlot, fittedBox, GEAR, holdsCargo, isGear, partsOf, quality, repaired, slotLabel, tierOf, tryMove, vehicleBox, vehicleId, type Boxes } from '../shared/gear.ts';
import { chargeOf, findSpot, HOTBAR, ITEMS, partAt, scrapItem, setData, withData, TOOLS, sizeOf, strandedAt, type Item, type Shape, type Slots } from '../shared/items.ts';
import { partOf } from '../shared/parts.ts';
import { COMPONENTS, RARITY, SALVAGE, TIERS } from '../shared/salvage.ts';
import { countMatching, RECIPES } from '../shared/crafting.ts';
import { capacity, cells } from '../shared/power.ts';
import type { ScrapPiece } from '../shared/scrap.ts';
import { Hints } from './hints';
import type { PlayerState } from '../shared/sim.ts';
import { boxLabel, openBoxes } from '../shared/storage.ts';
import { isCorpseBox } from '../shared/corpse.ts';
import { canDropAt, lootReach, type Loot } from '../shared/loot.ts';
import { isPlaceable } from '../shared/placed.ts';
import { vehicleById } from '../shared/vehicles.ts';
import { ctl, hintKeys, isBound, kbd } from './bindings';
import { takePickup, ui } from './input';
import type { Net } from './net';
import { uiScale } from './uiScale';
import { uiSound } from './uiSound';
import { TEXT } from '../shared/text.ts';

const TOAST_MS = 1600;
/** Pointer travel (px) before a press on a slot becomes a drag. */
const DRAG_START = 4;
/** A grid cell (px) and the gap between cells: one step is CELL + GAP. */
const CELL = 54;
const GAP = 4;
/** Size (px) of an item w × h cells big. */
const span = (n: number) => n * CELL + (n - 1) * GAP;
/** Icon scale for an item w × h cells big: by its short side, and a little more for long ones (SVGs; images stay square). */
const iconScale = (w: number, h: number) => `--s: ${Math.min(w, h)}; --sv: ${Math.min(w, h) + (w !== h ? 0.4 : 0)}; --pw: ${span(w)}px; --ph: ${span(h)}px`;

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
/* Taller than the window (a big bag at a big Interface size): it scrolls, from the top, rather than losing both ends. */
#invOverlay { position: fixed; inset: 0; z-index: 15; display: none; align-items: center; justify-content: safe center;
  overflow-y: auto; padding: 16px 0; box-sizing: border-box;
  flex-direction: column; gap: 10px; background: rgba(12, 6, 2, 0.45); font: 12px var(--mono);
  color: #fff4e4; user-select: none; -webkit-user-select: none; }
#invOverlay.open { display: flex; }
#invOverlay .boxes { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; justify-content: center;
  max-width: calc(100vw / var(--ui, 1) - 32px); }
#invOverlay .box { padding: 10px 12px 12px; border-radius: 8px; background: rgba(28, 15, 7, 0.88);
  box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.16), 0 8px 30px rgba(0, 0, 0, 0.45); }
#invOverlay .box.storage { box-shadow: 0 0 0 1px rgba(255, 200, 120, 0.35), 0 8px 30px rgba(0, 0, 0, 0.45); }
/* Chests grow without end (shared/storage.ts growChest): past ~10 rows they scroll. */
#invOverlay .box.storage .grid { max-height: min(578px, calc(100vh / var(--ui, 1) - 120px)); overflow-y: auto; scrollbar-width: thin; padding-right: 2px; }
#invOverlay .cell { width: 54px; height: 54px; border-radius: 6px; background: rgba(255, 240, 220, 0.06);
  box-shadow: inset 0 0 0 1px rgba(255, 240, 220, 0.12); }
#invOverlay .cell.dead { background: rgba(222, 62, 34, 0.12); box-shadow: inset 0 0 0 1px rgba(222, 62, 34, 0.5); }
/* Junk to take apart at the disassembly table (carried machines, wrecks): a dashed inner frame with bolted corners. */
#invOverlay .slot.item.junk { box-shadow: inset 0 0 0 2px rgba(20, 12, 6, 0.9), inset 0 0 0 3px rgba(190, 170, 140, 0.55);
  background: linear-gradient(135deg, rgba(88, 74, 58, 0.96), rgba(56, 42, 30, 0.96)); }
#invOverlay .slot.item.junk::before { content: ''; position: absolute; inset: 5px; border-radius: 3px; pointer-events: none;
  border: 1px dashed rgba(190, 170, 140, 0.4); }
#invOverlay .slot.item.junk::after { content: ''; position: absolute; inset: 2px; pointer-events: none; border-radius: 4px;
  background:
    radial-gradient(circle at 4px 4px, rgba(210, 190, 160, 0.85) 1.5px, transparent 2px),
    radial-gradient(circle at calc(100% - 4px) 4px, rgba(210, 190, 160, 0.85) 1.5px, transparent 2px),
    radial-gradient(circle at 4px calc(100% - 4px), rgba(210, 190, 160, 0.85) 1.5px, transparent 2px),
    radial-gradient(circle at calc(100% - 4px) calc(100% - 4px), rgba(210, 190, 160, 0.85) 1.5px, transparent 2px); }
/* Items in a grid span their cells, over the empty-cell backdrop. */
#invOverlay .slot.item { width: auto; height: auto; z-index: 1; background: rgba(66, 44, 26, 0.96); }
#invOverlay .slot.item svg, #invGhost svg { width: calc(30px * var(--sv, 1)); height: calc(34px * var(--sv, 1)); }
#invOverlay .slot.item img, #invGhost img { width: calc(46px * var(--s, 1)); height: calc(46px * var(--s, 1)); }
img.fit { object-fit: contain; }
#invOverlay .slot.item img.fit, #invGhost img.fit { width: calc(var(--pw, 54px) - 6px); height: calc(var(--ph, 54px) - 6px); }
#invOverlay .slot.item.turned > img.fit, #invGhost.turned > img.fit { width: calc(var(--ph, 54px) - 6px); height: calc(var(--pw, 54px) - 6px); }
#invOverlay .slot.turned > svg, #invOverlay .slot.turned > img, #invGhost.turned > svg, #invGhost.turned > img { transform: rotate(90deg); }
#invOverlay .hint { z-index: 2; pointer-events: none; border-radius: 6px; }
#invOverlay .hint.ok { background: rgba(140, 220, 150, 0.22); box-shadow: inset 0 0 0 2px rgba(140, 220, 150, 0.85); }
#invOverlay .hint.no { background: rgba(222, 62, 34, 0.22); box-shadow: inset 0 0 0 2px rgba(222, 62, 34, 0.85); }
#invOverlay .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
#invOverlay h3 { margin: 0; font: 600 11px var(--mono); letter-spacing: 0.08em; text-transform: uppercase;
  opacity: 0.75; }
#invOverlay button { font: inherit; font-size: 11px; color: inherit; background: rgba(255, 233, 204, 0.12); border: 0;
  border-radius: 4px; padding: 2px 8px; cursor: pointer; }
#invOverlay .head .btns { display: flex; gap: 6px; }
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
body.pad #invOverlay .slot .key { display: none; }
#invOverlay .legend { display: flex; gap: 14px; opacity: 0.8; }
#invOverlay .legend kbd { font: bold 11px var(--mono); padding: 0 4px; margin-right: 5px; border-radius: 3px; background: #fff4e4; color: #2a160a; }
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
#invTip { position: fixed; z-index: 17; pointer-events: none; display: none; max-width: 280px; padding: 7px 10px;
  border-radius: 6px; background: rgba(20, 10, 4, 0.95); box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.2), 0 6px 18px rgba(0, 0, 0, 0.5);
  font: 12px var(--mono); color: #fff4e4; line-height: 1.45; }
#invTip .name { font-weight: 600; }
#invTip .sub { opacity: 0.7; }
#invTip .parts { margin-top: 4px; display: grid; grid-template-columns: auto auto; gap: 0 10px; }
#invTip .parts .k { opacity: 0.6; }
#invTip .miss { color: #ff8a66; }
#invTip .use { margin-top: 4px; opacity: 0.85; }
#invTip .level { display: flex; align-items: center; gap: 8px; }
#invTip .level .charge { position: static; width: 90px; }
/* A battery's charge (shared/items.ts chargeOf): a bar along the bottom of its icon, green full to red empty. */
.charge { position: absolute; left: 6px; right: 6px; bottom: 4px; height: 4px; border-radius: 2px; pointer-events: none;
  background: rgba(20, 10, 4, 0.7); box-shadow: 0 0 0 1px rgba(255, 244, 228, 0.25); }
.charge i { display: block; height: 100%; width: calc(var(--q) * 100%); border-radius: 2px; background: hsl(calc(var(--q) * 110deg) 70% 52%); }
#invGhost { position: fixed; z-index: 16; pointer-events: none; display: flex; align-items: center; justify-content: center;
  border-radius: 6px; background: rgba(66, 44, 26, 0.55); filter: drop-shadow(0 4px 6px #000); }
#invGhost.drop::after { content: '${TEXT.inventory.drop}'; position: absolute; top: 100%; font: 600 11px var(--mono); color: #fff4e4;
  text-shadow: 0 1px 2px #000; }
#invGhost .n { position: absolute; right: 4px; bottom: 2px; font: 600 11px var(--mono); color: #fff4e4;
  text-shadow: 0 1px 2px #000; }
#invOverlay .slot .bad { position: absolute; right: 3px; top: 1px; font: 700 10px var(--mono); color: #ff8a66; }
#invOverlay .slot.broken > svg, #invOverlay .slot.broken > img { opacity: 0.5; filter: grayscale(0.8); }
#invOverlay .slot.broken:not(.over) { background: rgba(200, 52, 30, 0.22); box-shadow: inset 0 0 0 1px rgba(230, 80, 50, 0.45); }
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
#invOverlay .bench button.repair { font-size: 13px; font-weight: 600; padding: 7px; background: rgba(140, 220, 150, 0.25); }
#invOverlay .bench button.repair:hover:not(:disabled) { background: rgba(140, 220, 150, 0.4); }
`;

// Icons, 22 × 26 like the hotbar's.
// Scrap: a dented sheet with a plank across it and a cog on top, a little heap of junk.
const SCRAP_SVG = `<svg viewBox="0 0 22 26"><g stroke="#2a160a" stroke-width="0.9"><path d="M2 10l12-3 4 13-12 3z" fill="#9a968c"/>
<path d="M5 12l9-2c-1 2 1 3-1 4" fill="none" stroke="#c9c4b8" opacity="0.8"/><path d="M3 21L17 9l1.8 2.2L4.8 23z" fill="#7d7a72"/>
<g transform="translate(14 7.5)" fill="#8a7f6a">${[0, 60, 120, 180, 240, 300].map((a) => `<rect x="-1.4" y="-5.6" width="2.8" height="2.6" transform="rotate(${a})"/>`).join('')}
<circle r="3.8"/><circle r="1.4" fill="#2a160a"/></g></g></svg>`;
// Cloth: a folded tarp, tied with a cord.
const CLOTH_SVG = `<svg viewBox="0 0 22 26"><g stroke="#2a160a" stroke-width="0.9" stroke-linejoin="round">
<path d="M3 9c3-2 13-2 16 0v9c-3 2-13 2-16 0z" fill="#b89a6a"/><path d="M3 13.5c3 2 13 2 16 0" fill="none" stroke="#7a6040"/>
<path d="M5 9.4c0 3 1 6 0 9.4M17 9.4c0 3-1 6 0 9.4" fill="none" stroke="#8a7048" stroke-width="0.7"/>
<path d="M11 7.6v12.8" stroke="#5a3a1e" stroke-width="1.6"/><path d="M11 7.6c-2-2-4-1-3 0.6M11 7.6c2-2 4-1 3 0.6" fill="none" stroke="#5a3a1e" stroke-width="1"/></g></svg>`;
// The wrench: a combination spanner lying across, the open jaw up top, the ring below.
const WRENCH_SVG = `<svg viewBox="0 0 22 26"><g stroke="#2a160a" stroke-width="0.9">
<path d="M4.5 21.5L16.5 9.5" stroke-width="4.8" stroke-linecap="round"/><path d="M4.5 21.5L16.5 9.5" stroke="#a4a8ab" stroke-width="2.9" stroke-linecap="round"/>
<circle cx="17" cy="8.5" r="4.6" fill="#a4a8ab"/><path d="M17 8.5l4.6-4.6" stroke-width="3.2"/>
<circle cx="4.5" cy="21.5" r="3.3" fill="#a4a8ab"/><circle cx="4.5" cy="21.5" r="1.5" fill="#2a160a"/></g></svg>`;
const ICONS: Record<string, string> = {
  scrap: SCRAP_SVG,
  cloth: CLOTH_SVG,
  wrench: WRENCH_SVG,
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
  spring: `<svg viewBox="0 0 22 26"><path d="M5 4h12M5 22h12M6 4c10 1 10 3 0 4.5s10 3 0 4.5 10 3 0 4.5 10 3 0 4.5" fill="none"
stroke="#2a160a" stroke-width="2.6"/><path d="M5 4h12M5 22h12M6 4c10 1 10 3 0 4.5s10 3 0 4.5 10 3 0 4.5 10 3 0 4.5" fill="none"
stroke="#a8a294" stroke-width="1.3"/></svg>`,
};
// Rendered icons (public/icons/items/<kind>.png, tools/blender/placeables.py) for the crafted placeables.
const png = (kind: string) => `<img src="./icons/items/${kind}.png" alt="" draggable="false">`;
ICONS.plant_bed = png('plant_bed');
ICONS.uv_lamp = png('uv_lamp');
ICONS.power_pole = png('power_pole');
// Wiring is what a wiring coil comes out as (shared/parts.ts UNTIERED): the coil's render.
ICONS.wiring = png('coil_basic');
// The enemies' and bosses' own parts (tools/blender/relics.py).
for (const k of ['drone_transponder', 'brood_gland', 'servo_heart', 'hive_core', 'queen_eye', 'furnace_heart']) ICONS[k] = png(k);
// Gear (shared/gear.ts) icons are rendered at the item's grid shape (tools/blender/finds.py): `fit` stretches them
// over the item's cells (--pw/--ph from iconScale), or keeps their shape inside a single slot.
for (const k of [...Object.keys(GEAR), 'grinder']) ICONS[k] = `<img class="fit" src="./icons/items/${k}.png" alt="" draggable="false">`;
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
/** "180 W", "1.2 kW". */
const watts = (w: number) => (w < 1000 ? `${Math.round(w)} W` : `${(w / 1000).toFixed(1)} kW`);
/** Kilowatt-hours: two decimals under one, one above. */
const kwh = (x: number) => x.toFixed(x < 1 ? 2 : 1);
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
/** A battery's charge bar to lay over its icon (in a positioned slot), '' for anything else. */
export function chargeBar(it: Item): string {
  const q = chargeOf(it);
  return q === null ? '' : `<div class="charge" style="--q:${q.toFixed(3)}"><i></i></div>`;
}

/** Quality as a rarity name (rounded down: three Scrap parts and one Quality is still Scrap... ish). */
function qualityName(q: number) {
  return RARITY[TIERS[Math.max(0, Math.min(3, Math.floor(q + 1e-6)))]].name;
}

/** Rarity colour (shared/salvage.ts RARITY) of an item with a tier, as CSS, or null. */
const rarityColor = (kind: string) => {
  const t = ITEMS[kind]?.tier;
  return t ? hex(RARITY[t].color) : null;
};

/** An item's rarity colour: a part's tier, or repaired gear's (shared/gear.ts tierOf: what it looks like, src/tierLook.ts). */
const itemColor = (it: Item) => (isGear(it.kind) && repaired(it) ? hex(RARITY[TIERS[tierOf(it)]].color) : rarityColor(it.kind));

/** Tooltip for an item: its name in its rarity colour; gear says how good it is, the part in each slot (or what's
 *  missing) and how to use it. */
function tipHtml(it: Item): string {
  const c = itemColor(it);
  let html = `<div class="name"${c ? ` style="color:${c}"` : ''}>${itemLabel(it.kind)}${it.n > 1 ? ` ×${it.n}` : ''}</div>`;
  const q = chargeOf(it);
  if (q !== null) html += `<div class="sub level">${chargeBar(it)}${Math.round(q * 100)}%</div>`;
  if (!isGear(it.kind)) return html;
  const ok = repaired(it);
  const parts = partsOf(it);
  html += `<div class="sub">${ok ? qualityName(quality(it)) : `<span class="miss">${TEXT.inventory.broken}</span>`}</div><div class="parts">`;
  GEAR[it.kind].slots.forEach((slot, i) => {
    const p = parts[i];
    const pc = p && rarityColor(p);
    html += `<span class="k">${slotLabel(slot)}</span>`
      + (p ? `<span${pc ? ` style="color:${pc}"` : ''}>${itemLabel(p)}</span>` : `<span class="miss">${TEXT.inventory.missing}</span>`);
  });
  html += '</div>';
  if (ok) html += `<div class="use">${GEAR[it.kind].use(hintKeys())}</div>`;
  return html;
}

/**
 * An item being dragged: from where, half the stack (right button), turned (R), and where the pointer holds it
 * (px from its top-left corner, as drawn now).
 */
type Drag = { box: string; i: number; half: boolean; x0: number; y0: number; moved: boolean; r: boolean; gx: number; gy: number };
/** Where a drag would land: a slot (free slot, workbench part slot) or a grid cell for the item's top-left corner. */
type Target = { box: string; i: number; el?: HTMLElement; grid?: HTMLElement };

/** The part slots of the item in box `at` (the workbench, a building's box) are slots of the box `part:<at>`. */
const partBox = (at: string) => `part:${at}`;
/** The box whose item's part slots these are, or null for any other box. */
const partsIn = (box: string) => (box.startsWith('part:') ? box.slice(5) : null);
/** The loot in reach, as a box of its own: slot i is the i-th piece (InventoryHud.ground). */
const GROUND = 'ground';

export class InventoryHud {
  private prompt = document.createElement('div');
  private toasts = document.createElement('div');
  private overlay = document.createElement('div');
  private boxesEl = document.createElement('div');
  private ghost = document.createElement('div');
  private tip = document.createElement('div');
  /** The slot the tooltip is for, and the pointer, for redrawing it after a render. */
  private tipAt: HTMLElement | null = null;
  private pointer = { x: 0, y: 0 };
  private shown: ScrapPiece | string | null = null;
  private net: Net;
  private canvas: HTMLElement;
  /** Storage boxes in reach (shared/storage.ts openBoxes), as last drawn (one building of those in reach). */
  private storages: string[] = [];
  /** Loot in reach, as last drawn (the GROUND panel), and its ids. */
  private ground: Loot[] = [];
  private groundIds = '';
  /** Every box in reach, as last drawn. */
  private reachable = '';
  /** Within reach of the workbench last frame. */
  private atBench = false;
  /** The building to show when more than one is in reach: the one F was pressed on; or the vehicle F was pressed on (its
   *  box: alone, to repair it; its cargo: with its part slots). */
  private focus: string | null = null;
  private drag: Drag | null = null;
  private over: HTMLElement | null = null;
  /** The cells a drag would take, lit green or red. */
  private hint = document.createElement('div');
  private hintAt = '';
  private hints = new Hints();

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
    // The moves that aren't plain drags (and, with the pad, the cursor's buttons: src/padCursor.ts).
    const legend = document.createElement('div');
    legend.className = 'legend';
    legend.innerHTML = ctl('uiDrag', TEXT.inventory.move) + ctl('uiSend', TEXT.inventory.sendAcross) + ctl('uiHalf', TEXT.inventory.half)
      + ctl('uiTurn', TEXT.prompt.turn) + ctl('uiClose', TEXT.inventory.close);
    this.overlay.append(this.boxesEl, legend);
    this.ghost.id = 'invGhost';
    this.ghost.style.display = 'none';
    this.tip.id = 'invTip';
    document.body.append(this.prompt, this.toasts, this.overlay, this.ghost, this.tip);

    net.onItems = (box, got) => {
      // The disassembly mode shows its own "+ Motor · Quality" flying to the hotbar.
      if (got && !document.body.classList.contains('teardown')) this.toast(TEXT.notice.got(1, itemLabel(got)));
      this.hints.onItems(net.boxes, box, got);
      if (box === 'bag' || box === 'equip' || this.storages.includes(box)) this.render();
    };

    addEventListener('keydown', (e) => {
      if (isBound('inventory', e.code)) {
        e.preventDefault(); // never the browser's focus cycling
        if (!e.repeat) this.toggle(!ui.inventoryOpen);
      } else if (e.code === 'Escape' && ui.inventoryOpen) this.toggle(false);
      else if (isBound('interact', e.code) && !e.repeat && ui.inventoryOpen) {
        // F closes it too (the workbench opens with F); the same press doesn't open it again.
        takePickup();
        this.toggle(false);
      }
      else if (isBound('rotate', e.code) &&!e.repeat && this.drag?.moved) this.turn();
    });
    // A click on the dimmed backdrop closes it, back into the game.
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.target === this.overlay || e.target === this.boxesEl) this.toggle(false);
    });
    this.overlay.addEventListener('contextmenu', (e) => e.preventDefault());
    this.boxesEl.addEventListener('pointerdown', (e) => this.press(e));
    addEventListener('pointermove', (e) => {
      this.pointer = { x: e.clientX, y: e.clientY };
      this.dragMove(e);
      this.showTip();
    });
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
    this.showTip();
    this.cancelDrag();
    if (open) {
      document.exitPointerLock();
      this.render();
      return;
    }
    // A vehicle is shown only from F on it (Tab near it shows its cargo like a chest's).
    if (this.focus && (vehicleId(this.focus) >= 0 || cargoId(this.focus) >= 0)) this.focus = null;
    if (relock && document.pointerLockElement !== this.canvas) {
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
      : `${kbd('interact')}${typeof target === 'string' ? target : TEXT.prompt.pickUp(itemLabel(scrapItem(target.kind)))}`;
  }

  /** Every frame: storage boxes come into and out of reach as the player moves. Walking away from the workbench
   *  takes the item on it back into the bag. */
  update(s: PlayerState) {
    const open = openBoxes(s);
    const atBench = open.includes('bench');
    if (this.atBench && !atBench && this.net.boxes.bench?.[0]) this.toBag('bench', 0);
    this.atBench = atBench;
    if (!ui.inventoryOpen) return;
    if (open.join() !== this.reachable || this.groundNow().map((l) => l.id).join() !== this.groundIds) this.render();
  }

  /** Loot lying in reach, oldest first. */
  private groundNow(): Loot[] {
    const me = this.net.me;
    return [...this.net.loot.values()].filter((l) => lootReach(me, l)).sort((a, b) => a.id - b.id);
  }

  toast(text: string) {
    const el = document.createElement('div');
    el.textContent = text;
    this.toasts.appendChild(el);
    setTimeout(() => el.remove(), TOAST_MS);
  }

  /** Open the inventory from outside (F at the workbench, a chest, a building or a vehicle: `focus`, its box). */
  open(focus?: string) {
    if (focus) this.focus = focus;
    this.toggle(true);
    if (focus) this.render();
  }

  /** The boxes whose item's part slots are open (the workbench, the one building or vehicle shown), the workbench first. */
  private fitTargets(): string[] {
    return this.storages.filter((b) => b === 'bench' || fittedBox(b));
  }

  /** The vehicles changed (one stood up, got on, moved): what's shown follows. */
  vehiclesChanged() {
    if (ui.inventoryOpen && !this.drag) this.render();
  }

  private render() {
    if (!ui.inventoryOpen) return;
    // One building at a time: the one F was pressed on while it's in reach, else the nearest.
    const open: string[] = openBoxes(this.net.me).filter((b) => this.net.boxes[b]);
    this.reachable = openBoxes(this.net.me).join();
    const near = open.filter((b) => buildingId(b) >= 0);
    const shown = this.focus && near.includes(this.focus) ? this.focus : near[0];
    // A vehicle F was pressed on: a broken one alone (to repair it), a working one's cargo with its part slots.
    const vehicle = this.focus && vehicleId(this.focus) >= 0 && open.includes(this.focus) ? this.focus : null;
    const cargoOf = this.focus && cargoId(this.focus) >= 0 ? vehicleBox(cargoId(this.focus)) : null;
    this.storages = vehicle ? [vehicle]
      : open.filter((b) => (vehicleId(b) >= 0 ? b === cargoOf : buildingId(b) < 0 || b === shown));
    const bag = this.net.boxes.bag ?? [];
    const equip = this.net.boxes.equip ?? [];
    const shape = bagShape(equip);
    // Equipment, then the bag: hotbar row, the backpack's grid (with any rows it no longer opens), and overflow.
    let html = `<div class="box"><div class="head"><h3>${boxLabel('equip')}</h3></div>`
      + `<div class="grid" style="grid-template-columns: repeat(${EQUIP_SLOTS.length}, 54px)">${this.slotsHtml('equip', equip, 0, EQUIP_SLOTS.length)}</div>`
      + `<div class="sep"></div><div class="head"><h3>${boxLabel('bag')}</h3><button data-sort="bag" title="${TEXT.inventory.sortTip}">${TEXT.inventory.sort}</button></div>`
      + `<div class="grid" style="grid-template-columns: repeat(5, 54px)">${this.slotsHtml('bag', bag, 0, HOTBAR)}</div><div class="sep"></div>`;
    if (!shape.rows) html += `<div class="none">${TEXT.inventory.noBackpack}</div>`;
    html += this.gridHtml('bag', bag, shape) + '</div>';
    for (const box of this.storages) {
      const slots = this.net.boxes[box];
      if (box === 'bench') {
        html += this.benchHtml(slots[0] ?? null);
        continue;
      }
      if (fittedBox(box)) {
        html += `<div class="box bench"><div class="head"><h3>${boxLabel(box)}</h3></div>${this.repairHtml(slots[0] ?? null, box)}`
          + `${this.standHtml(slots[0] ?? null, box)}</div>`;
        continue;
      }
      html += `<div class="box storage"><div class="head"><h3>${boxLabel(box)}</h3><span class="btns">${isCorpseBox(box) ? '' : `<button data-store="${box}">${TEXT.inventory.storeAll}</button>`}<button data-all="${box}">${TEXT.inventory.takeAll}</button><button data-sort="${box}">${TEXT.inventory.sort}</button></span></div>`
        + `${this.gridHtml(box, slots, boxShape(box, this.net.boxes))}</div>`;
    }
    this.ground = vehicle ? [] : this.groundNow();
    this.groundIds = this.ground.map((l) => l.id).join();
    if (vehicle) {
      // (The repair view: the bag and the vehicle, nothing else.)
    } else if (this.ground.length) {
      const items = this.ground.map((l) => ({ id: 0, kind: l.kind, n: 1, parts: l.parts, data: l.data }));
      html += `<div class="box storage" data-ground><div class="head"><h3>${TEXT.boxes.ground}</h3><button data-all="${GROUND}">${TEXT.inventory.takeAll}</button></div>`
        + `<div class="grid" style="grid-template-columns: repeat(5, 54px)">${this.slotsHtml(GROUND, items, 0, items.length)}</div></div>`;
    } else if (!this.storages.length) {
      html += `<div class="box"><div class="head"><h3>${TEXT.boxes.storage}</h3></div><div class="none">${TEXT.inventory.nothingInReach}</div></div>`;
    }
    // Re-rendering resets scrolling: keep each long chest where it was.
    const scrolled = new Map<string, number>();
    for (const el of this.boxesEl.querySelectorAll<HTMLElement>('[data-grid]')) scrolled.set(el.dataset.grid!, el.scrollTop);
    this.boxesEl.innerHTML = html;
    this.tipAt = null;
    this.showTip();
    for (const el of this.boxesEl.querySelectorAll<HTMLElement>('[data-grid]')) {
      const top = scrolled.get(el.dataset.grid!);
      if (top) el.scrollTop = top;
    }
    this.hintAt = '';
    if (this.drag) this.slotEl(this.drag.box, this.drag.i)?.classList.add('dragging');
  }

  /** The workbench: the item being repaired, its part slots and what it still needs, then the recipes. */
  private benchHtml(it: Item | null) {
    return `<div class="box bench"><div class="head"><h3>${boxLabel('bench')}</h3></div>${this.repairHtml(it, 'bench')}`
      + `<div class="sep"></div><div class="head"><h3>${TEXT.inventory.craft}</h3></div>${this.recipesHtml(this.net.boxes.bag ?? [])}</div>`;
  }

  /** The item in box `at` (the workbench, a building's box), its part slots and what it still needs. */
  private repairHtml(it: Item | null, at: string) {
    let html = `<div class="top">` + this.slotsHtml(at, [it], 0, 1);
    if (!it) {
      return html + `<div class="state">${TEXT.inventory.brokenGear}</div></div>`;
    }
    const ok = repaired(it);
    const spec = GEAR[it.kind];
    const parts = partsOf(it);
    const missing = spec.slots.filter((_, i) => !parts[i]).map(slotLabel);
    html += `<div><div class="name">${itemLabel(it.kind)}</div><div class="state ${ok ? 'ok' : 'no'}">`
      + (ok ? TEXT.inventory.works(qualityName(quality(it))) : TEXT.inventory.needs(missing))
      + `</div>${this.powerHtml(it, at)}</div></div><div class="parts">`;
    const held = this.drag ? this.net.boxes[this.drag.box]?.[this.drag.i] : null;
    spec.slots.forEach((slot, i) => {
      const kind = parts[i];
      const part = this.fittedAt(at, i);
      const fits = held && fitsSlot(slot, held.kind) ? ' fits' : '';
      const c = kind && rarityColor(kind);
      html += `<div><div class="slot${kind ? '' : ' empty'}${fits}${c ? ' rare' : ''}" data-box="${partBox(at)}" data-i="${i}"${c ? ` style="--c:${c}"` : ''} data-tip="${kind ? '' : TEXT.inventory.needsA(slotLabel(slot))}">`
        + (part ? itemIcon(part.kind) + chargeBar(part) : `<span class="ph">+</span>`) + `</div><div class="pl">${slotLabel(slot)}</div></div>`;
    });
    return html + '</div>';
  }

  /** Under a broken vehicle's part slots: Repair, which stands it up once they're all filled. */
  private standHtml(it: Item | null, at: string): string {
    const v = vehicleById(vehicleId(at));
    if (!v || v.up) return '';
    return `<div class="sep"></div><button class="repair" data-repair="${v.id}"${repaired(it) ? '' : ' disabled'}>${TEXT.inventory.repair}</button>`;
  }

  /** A building's electricity (shared/power.ts), under its state: what a windmill makes now; what a station holds of
   *  what it can, and what it is taking in. */
  private powerHtml(it: Item, at: string): string {
    const id = buildingId(at);
    if (id < 0) return '';
    const p = this.net.power;
    if (it.kind === 'windmill') return `<div class="state">${watts(p.gen[id] ?? 0)}</div>`;
    if (it.kind !== 'battery_station') return '';
    const s = p.store[id];
    const held = (s?.charge ?? []).reduce((a, b) => a + b, 0);
    return `<div class="state">${kwh(held)} / ${kwh(capacity(it.parts))} kWh${s?.w ? ` · +${watts(s.w)}` : ''}</div>`;
  }

  /** The power came in: a building's panel shows it. */
  powerChanged() {
    if (ui.inventoryOpen && !this.drag && this.storages.some((b) => buildingId(b) >= 0)) this.render();
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
        + `<div class="need">${needs}</div></div><button data-craft="${id}"${ready ? '' : ' disabled'}>${TEXT.inventory.craft}</button></div>`;
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
      const c = it && itemColor(it);
      const cls = `slot${it ? '' : ' empty'}${key ? ' hot' : ''}${broken ? ' broken' : ''}${dead ? ' dead' : ''}${c ? ' rare' : ''}`;
      html += `<div class="${cls}" data-box="${box}" data-i="${i}"${c ? ` style="--c:${c}"` : ''}>${key}${ph}${it ? this.itemHtml(it) : ''}</div>`;
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
      html += `<div class="sep"></div><div class="none">${TEXT.inventory.noRoom}</div>`
        + `<div class="grid" style="grid-template-columns: repeat(4, 54px)">${this.slotsHtml(box, slots, end, slots.length, true)}</div>`;
    }
    return html;
  }

  /** One item lying in a grid, spanning its cells (`style`). */
  private slotHtml(box: string, i: number, it: Item, style: string, dead: boolean) {
    const broken = isGear(it.kind) && !repaired(it);
    const c = itemColor(it);
    const cls = `slot item${broken ? ' broken' : ''}${dead ? ' dead' : ''}${c ? ' rare' : ''}${it.kind in SALVAGE || it.kind in COMPONENTS ? ' junk' : ''}${it.r ? ' turned' : ''}`;
    return `<div class="${cls}" data-box="${box}" data-i="${i}" style="${style}${c ? `; --c:${c}` : ''}">${this.itemHtml(it)}</div>`;
  }

  private itemHtml(it: Item) {
    const broken = isGear(it.kind) && !repaired(it);
    return `${itemIcon(it.kind)}${chargeBar(it)}${it.n > 1 ? `<span class="n">${it.n}</span>` : ''}${broken ? '<span class="bad">✕</span>' : ''}`;
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
      // The pointer and the rect in screen px, the grid's cells and scroll in its own (src/uiScale.ts).
      const rect = grid.getBoundingClientRect(), z = uiScale();
      const cx = Math.round((x - d.gx - rect.left) / z / (CELL + GAP));
      const cy = Math.round(((y - d.gy - rect.top) / z + grid.scrollTop) / (CELL + GAP));
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
    if (partsIn(d.box)) return true;
    if (d.box === GROUND) return t.box === 'bag';
    const it = this.itemAt(d.box, d.i);
    return !!it && tryMove(b, d.box, d.i, t.box, t.i, d.half ? Math.ceil(it.n / 2) : undefined, () => -1, d.r);
  }

  /** Draw the ghost for the dragged item at its size, turned or not. */
  private drawGhost(d: Drag, it: Item) {
    const n = d.half ? Math.ceil(it.n / 2) : it.n;
    const [w, h] = sizeOf(it.kind, d.r);
    this.ghost.innerHTML = `${itemIcon(it.kind)}${chargeBar(it)}${n > 1 ? `<span class="n">${n}</span>` : ''}`;
    this.ghost.setAttribute('style', `${iconScale(w, h)}; --c: ${rarityColor(it.kind) ?? '#fff4e4'}`);
    this.ghost.style.width = `${span(w)}px`;
    this.ghost.style.height = `${span(h)}px`;
    this.ghost.classList.toggle('turned', d.r);
    this.ghost.style.display = 'flex';
  }

  /** The ghost held at the pointer by the point it was grabbed at (both screen px), set in its own (src/uiScale.ts). */
  private placeGhost(x: number, y: number, d: Drag) {
    const z = uiScale();
    this.ghost.style.left = `${(x - d.gx) / z}px`;
    this.ghost.style.top = `${(y - d.gy) / z}px`;
  }

  /** R while dragging: turn the item 90°, held by its top-left cell. */
  private turn() {
    const d = this.drag;
    const it = d && this.itemAt(d.box, d.i);
    if (!d || !it) return;
    d.r = !d.r;
    d.gx = d.gy = CELL / 2 * uiScale();
    this.drawGhost(d, it);
    this.placeGhost(d.x0, d.y0, d);
    this.hintAt = '';
    this.showHint(this.targetAt(d.x0, d.y0, d), d);
  }

  /** The part fitted in slot `i` of the item in box `at`, as an item with its data; a battery station's batteries
   *  with the charge they hold now (the server's power state, kept live there). */
  private fittedAt(at: string, i: number): Item | null {
    const it = this.net.boxes[at]?.[0];
    const p = it && partAt(it, i);
    if (!p) return null;
    const out: Item = { id: 0, kind: p.kind, n: 1, ...withData(p.data) };
    const cell = it.kind === 'battery_station' ? cells(it.parts)[i] : null;
    const live = this.net.power.store[buildingId(at)]?.charge[i];
    if (cell && live !== undefined) setData(out, 'charge', live < cell.kwh ? live / cell.kwh : undefined);
    return out;
  }

  /** What's in a slot; 'part:<box>' slots are the fitted parts of the item in that box (workbench, building, vehicle). */
  private itemAt(box: string, i: number): Item | null {
    const at = partsIn(box);
    if (at) return this.fittedAt(at, i);
    if (box === GROUND) {
      const l = this.ground[i];
      return l && this.net.loot.has(l.id) ? { id: 0, kind: l.kind, n: 1, parts: l.parts, data: l.data } : null;
    }
    return this.net.boxes[box]?.[i] ?? null;
  }

  private press(e: PointerEvent) {
    const sort = (e.target as HTMLElement).closest<HTMLElement>('[data-sort]');
    if (sort) return void (this.net.sortBox(sort.dataset.sort!) || this.toast(TEXT.notice.cantPackTighter));
    const all = (e.target as HTMLElement).closest<HTMLElement>('[data-all]');
    if (all) return this.takeAll(all.dataset.all!);
    const store = (e.target as HTMLElement).closest<HTMLElement>('[data-store]');
    if (store) return this.storeAll(store.dataset.store!);
    const craft = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-craft]');
    if (craft) return void (craft.disabled || this.net.craft(craft.dataset.craft!));
    const repair = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-repair]');
    if (repair) {
      if (repair.disabled) return;
      // Back into the game to see it stand up; how to ride it, once.
      this.net.repairVehicle(Number(repair.dataset.repair));
      uiSound.plop();
      this.toggle(false);
      return this.hints.show('motorcycle');
    }
    const at = this.slotAt(e.clientX, e.clientY);
    // A building's or vehicle's own item stays in it (its parts come and go).
    if (!at || !this.itemAt(at.box, at.i) || fittedBox(at.box)) return;
    e.preventDefault();
    if (e.shiftKey) return void (this.shiftClick(at.box, at.i) ? uiSound.plop() : uiSound.full());
    // Held where it was grabbed when it lies in a grid; by its first cell's middle from a single slot.
    const rect = at.el.getBoundingClientRect();
    const inGrid = at.el.classList.contains('item');
    const it = this.itemAt(at.box, at.i)!;
    this.drag = {
      box: at.box, i: at.i, half: e.button === 2, x0: e.clientX, y0: e.clientY, moved: false, r: !!it.r,
      gx: inGrid ? e.clientX - rect.left : CELL / 2 * uiScale(), gy: inGrid ? e.clientY - rect.top : CELL / 2 * uiScale(),
    };
  }

  /**
   * Shift-click sends an item where it most likely goes: a part out of the workbench item into the bag; at the
   * workbench, gear onto it and parts into the first slot they fit (an empty one first); gear to its equipment
   * slot and back; else across to the nearest storage (from it, gear into a free equipment slot and a tool onto a free
   * hotbar slot), or between hotbar and backpack.
   */
  private shiftClick(box: string, i: number): boolean {
    const net = this.net;
    const from = partsIn(box);
    if (from) return net.unfit(i, 'bag', -1, from);
    if (box === GROUND) return this.pickUp(i);
    const it = net.boxes[box]?.[i];
    if (!it) return false;
    const bench = this.storages.includes('bench');
    // A part into the workbench item, else the building or vehicle shown: an empty slot it fits first, else a swap.
    for (const at of this.fitTargets()) {
      const target = net.boxes[at]?.[0];
      if (box === at || !target || isGear(it.kind)) continue;
      const slots = GEAR[target.kind].slots;
      const parts = partsOf(target);
      const fit = slots.findIndex((s, j) => !parts[j] && fitsSlot(s, it.kind));
      const swap = fit >= 0 ? fit : slots.findIndex((s, j) => fitsSlot(s, it.kind) && parts[j] !== it.kind);
      if (swap >= 0 && net.fit(box, i, swap, at)) return true;
    }
    if (bench && box !== 'bench' && isGear(it.kind) && net.moveItem(box, i, 'bench', 0)) return true;
    if (box !== 'bag') return this.toBag(box, i);
    if (isGear(it.kind) && GEAR[it.kind].equip && repaired(it) && net.moveItem(box, i, 'equip', -1)) return true;
    // Across: bag → the nearest storage. Without storage, between hotbar and backpack.
    const to = this.storages.find((b) => b !== 'bench' && !fittedBox(b));
    return to ? net.moveItem(box, i, to, -1) : this.hotbarSwap(i);
  }

  /** Onto you from another box: repaired gear into its equipment slot and a tool into the first free hotbar slot,
   *  if that's open; else anywhere in the bag. */
  private toBag(box: string, i: number): boolean {
    const { bag, equip } = this.net.boxes;
    const it = this.net.boxes[box]?.[i];
    if (!it) return false;
    const slot = box !== 'equip' && repaired(it) ? GEAR[it.kind]?.equip : undefined;
    if (slot && equip && !equip[EQUIP_SLOTS.indexOf(slot)] && this.net.moveItem(box, i, 'equip', -1)) return true;
    const j = TOOLS.has(it.kind) && bag ? bag.findIndex((s, k) => k < HOTBAR && !s) : -1;
    return (j >= 0 && this.net.moveItem(box, i, 'bag', j)) || this.net.moveItem(box, i, 'bag', -1);
  }

  /** Pick up the i-th piece of loot in reach (it goes wherever it fits in the bag). */
  private pickUp(i: number): boolean {
    const l = this.ground[i];
    return !!l && this.net.loot.has(l.id) && this.net.lootTake(l.id);
  }

  /** Take all: everything in a storage box (or on the ground) into the bag, as far as it fits; a plop per item moved. */
  private takeAll(box: string) {
    if (box === GROUND) {
      let moved = 0;
      for (let i = 0; i < this.ground.length; i++) if (this.pickUp(i)) moved++;
      if (moved) uiSound.plop(moved);
      if (moved < this.ground.length) this.noRoom();
      return this.render();
    }
    const slots = this.net.boxes[box];
    if (!slots) return;
    let moved = 0;
    for (let i = slots.length - 1; i >= 0; i--) if (slots[i] && this.toBag(box, i)) moved++;
    if (moved) uiSound.plop(moved);
    if (this.net.boxes[box]?.some((it) => it)) this.noRoom();
  }

  /** Store all: everything in the bag but tools, placeables and a carrier with things in it into a storage box, as far
   *  as it fits. */
  private storeAll(box: string) {
    const stays = (i: number) => {
      const it = this.net.boxes.bag?.[i];
      return !it || TOOLS.has(it.kind) || isPlaceable(it.kind) || holdsCargo(this.net.boxes, 'bag', i);
    };
    const bag = this.net.boxes.bag;
    if (!bag) return;
    let moved = 0;
    for (let i = bag.length - 1; i >= 0; i--) if (!stays(i) && this.net.moveItem('bag', i, box, -1)) moved++;
    if (moved) uiSound.plop(moved);
    if (this.net.boxes.bag?.some((_, i) => !stays(i))) this.noRoom();
  }

  private noRoom() {
    this.toast(TEXT.notice.noRoom);
    uiSound.full();
  }

  /** Shift-click in the bag with no storage open: hotbar ↔ the first spot it fits in the backpack (or the first free hotbar slot). */
  private hotbarSwap(i: number): boolean {
    const bag = this.net.boxes.bag;
    const it = bag?.[i];
    if (!bag || !it) return false;
    if (i < HOTBAR) {
      const spot = findSpot(bag, bagShape(this.net.boxes.equip), it.kind, !!it.r, [i], false);
      if (spot) return this.net.moveItem('bag', i, 'bag', spot.i, undefined, spot.r);
      this.toast(TEXT.notice.noRoom);
      return false;
    }
    for (let j = 0; j < HOTBAR; j++) {
      if (!bag[j]) return this.net.moveItem('bag', i, 'bag', j);
    }
    return false;
  }

  /** The custom tooltip, at once, for the slot under the pointer (none while dragging or closed). */
  private showTip() {
    const hit = ui.inventoryOpen && !this.drag?.moved ? document.elementFromPoint(this.pointer.x, this.pointer.y) : null;
    const el = hit?.closest<HTMLElement>('[data-box][data-i]') ?? null;
    // Nothing under the pointer always hides it: a render resets tipAt to null with the tip maybe still up.
    if (el !== this.tipAt || !el) {
      this.tipAt = el;
      const it = el && this.itemAt(el.dataset.box!, +el.dataset.i!);
      const html = it ? tipHtml(it) : el?.dataset.tip ? `<div class="sub">${el.dataset.tip}</div>` : '';
      this.tip.innerHTML = html;
      this.tip.style.display = html ? 'block' : 'none';
    }
    if (this.tip.style.display === 'none') return;
    // Below-right of the pointer, flipped to stay on screen.
    // Worked out in screen px, set in the tip's own (src/uiScale.ts).
    const z = uiScale();
    const w = this.tip.offsetWidth * z, h = this.tip.offsetHeight * z;
    let x = this.pointer.x + 14, y = this.pointer.y + 18;
    if (x + w > innerWidth - 8) x = this.pointer.x - w - 10;
    if (y + h > innerHeight - 8) y = this.pointer.y - h - 10;
    this.tip.style.left = `${Math.max(8, x) / z}px`;
    this.tip.style.top = `${Math.max(8, y) / z}px`;
  }

  private dragMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_START) return;
    if (!d.moved) {
      const it = this.itemAt(d.box, d.i);
      if (!it) return this.cancelDrag();
      d.moved = true;
      uiSound.plop();
      this.drawGhost(d, it);
      this.ghost.style.display = 'flex';
      this.slotEl(d.box, d.i)?.classList.add('dragging');
      // Light up the workbench's (and the building's or vehicle's) slots this part fits.
      for (const at of this.fitTargets()) {
        const target = this.net.boxes[at]?.[0];
        if (target) GEAR[target.kind].slots.forEach((s, j) => this.slotEl(partBox(at), j)?.classList.toggle('fits', fitsSlot(s, it.kind)));
      }
    }
    // Remembered for R, which turns it where the pointer is.
    d.x0 = e.clientX;
    d.y0 = e.clientY;
    this.placeGhost(e.clientX, e.clientY, d);
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
    // From the ground: a click or a drag anywhere but back onto the ground picks it up.
    if (d.box === GROUND) {
      if (d.moved && (this.outside(e.clientX, e.clientY) || this.onGround(e.clientX, e.clientY))) return;
      if (this.pickUp(d.i)) uiSound.plop();
      else this.noRoom();
      return this.render();
    }
    if (!d.moved) return;
    if (this.outside(e.clientX, e.clientY) || this.onGround(e.clientX, e.clientY)) return this.drop(d.box, d.i);
    const at = this.targetAt(e.clientX, e.clientY, d);
    const it = this.itemAt(d.box, d.i);
    if (!at || !it || (at.box === d.box && at.i === d.i && d.r === !!it.r)) return;
    let ok: boolean;
    const from = partsIn(d.box), into = partsIn(at.box);
    if (at.i < 0) ok = false;
    else if (from) ok = !into && this.net.unfit(d.i, at.box, at.i, from);
    else if (into) ok = this.net.fit(d.box, d.i, at.i, into);
    else ok = this.net.moveItem(d.box, d.i, at.box, at.i, d.half ? Math.ceil(it.n / 2) : undefined, d.r);
    if (ok) uiSound.plop();
    else this.refuse(d.box, d.i, it, at.box);
  }

  /** Off every panel: on the dimmed backdrop (or out of the window). */
  private outside(x: number, y: number) {
    const el = document.elementFromPoint(x, y);
    return !el || el === this.overlay || el === this.boxesEl;
  }

  /** Over the On the ground panel. */
  private onGround(x: number, y: number) {
    return !!document.elementFromPoint(x, y)?.closest('[data-ground]');
  }

  /** Dragged out of the panels (or onto the ground): drop it on the sand in front of you. */
  private drop(box: string, i: number) {
    if (partsIn(box)) return this.toast(TEXT.notice.takeItOff);
    if (holdsCargo(this.net.boxes, box, i)) return this.toast(TEXT.notice.emptyItFirst);
    if (!canDropAt(this.net.me.x, this.net.me.z)) return this.toast(TEXT.notice.cantDropHere);
    this.net.dropItem(box, i);
  }

  /** Say why a drop didn't go through. */
  private refuse(from: string, fi: number, it: Item, to: string) {
    const fittedIn = partsIn(from);
    if (fittedIn && vehicleById(vehicleId(fittedIn))?.up) this.toast(TEXT.notice.swapOnly);
    else if (holdsCargo(this.net.boxes, from, fi)) this.toast(TEXT.notice.emptyItFirst);
    else if (to === 'equip') this.toast(isGear(it.kind) && GEAR[it.kind].equip ? (repaired(it) ? TEXT.notice.wrongSlot : TEXT.notice.broken) : TEXT.notice.cantWear);
    else if (to === 'bench') this.toast(isGear(it.kind) ? TEXT.notice.benchInUse : TEXT.notice.gearOnly);
    else if (partsIn(to)) this.toast(TEXT.notice.partDoesntGo);
    else {
      this.toast(TEXT.notice.doesntFit);
      uiSound.full();
    }
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
