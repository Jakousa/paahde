// The menus and the inventory drawn bigger on big screens: one scale, `--ui` on the root, that each panel takes as CSS
// `zoom` (PANELS; the HUD over the world keeps its size). Automatic from the window's size, so the panels always have
// at least BASE_W × BASE_H of their own px to lay out in, never below 1, times the player's Interface size
// (Options → Gameplay).
// Inside a zoomed panel, viewport units aren't zoomed back: write `calc(100vw / var(--ui))`, not `100vw`. Pointer
// coordinates and getBoundingClientRect are in screen px, but `left`/`top`/`offsetWidth` in the panel's own: convert
// with `uiScale()`.

const KEY = 'dadajam.uiSize';
const BASE_W = 1100;
const BASE_H = 680;
const AUTO_MAX = 3;
/** The Interface size slider's range. */
export const UI_SIZE_RANGE: [number, number] = [0.7, 1.5];

const PANELS = ['#menu', '#invOverlay', '#invGhost', '#invTip', '#buildMenu', '#benchMenu', '#play', '#debugMenu'];

let size = 1;
try {
  const v = parseFloat(localStorage.getItem(KEY) ?? '');
  if (v >= UI_SIZE_RANGE[0] && v <= UI_SIZE_RANGE[1]) size = v;
} catch {}
let scale = 1;

function apply() {
  const auto = Math.min(AUTO_MAX, Math.max(1, Math.min(innerWidth / BASE_W, innerHeight / BASE_H)));
  scale = Math.round(auto * size * 100) / 100;
  document.documentElement.style.setProperty('--ui', String(scale));
}

const style = document.createElement('style');
style.textContent = `${PANELS.join(', ')} { zoom: var(--ui, 1); }`;
document.head.append(style);
apply();
addEventListener('resize', apply);

/** Screen px per panel px, now. */
export const uiScale = () => scale;

/** The player's Interface size, a factor on the automatic scale. */
export const uiSize = () => size;

export function setUiSize(v: number) {
  size = Math.min(UI_SIZE_RANGE[1], Math.max(UI_SIZE_RANGE[0], v));
  apply();
  try {
    localStorage.setItem(KEY, String(size));
  } catch {}
}
