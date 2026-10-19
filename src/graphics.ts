// Graphics options (Esc → Options → Graphics), kept in localStorage. Read once at startup by whatever builds
// the thing (shadow cascades: src/world/sky.ts), and pushed live through `onGraphics` for what can change at runtime.
export interface GraphicsPrefs {
  /** Render pixels per CSS pixel, at most (src/resolution.ts); below 1 the canvas is stretched to the window. */
  resScale: number;
  /** Resolution follows the frame time (below the scale); off holds it at the scale. */
  dynamicRes: boolean;
  /** Lowest render scale adaptive resolution may go to. */
  minRes: number;
  /** Clicking into the game goes fullscreen (and locks the keyboard); off, the game stays in its window. */
  fullscreen: boolean;
  /** Frames per second the game draws at most; 0 = as fast as the screen goes. Adaptive resolution aims at it (60 when 0). */
  fpsLimit: number;
  shadows: boolean;
  /** Metres out to which the sun casts shadows. */
  shadowDistance: number;
  /** Shadow quality, 0 low .. 2 high: how many cascades, how big their maps and how soft the filter (SHADOW_QUALITY). Needs a reload. */
  shadowQuality: number;
  /** How often the far shadow cascades are redrawn: 0 every frame, 1 some, 2 rarely (src/world/cascades.ts). */
  shadowRefresh: number;
  /** Multisampled edges (the renderer is made with it). Needs a reload. */
  antialias: boolean;
}

export const GRAPHICS_DEFAULTS: GraphicsPrefs = { resScale: 1, dynamicRes: true, minRes: 0.5, fullscreen: true, fpsLimit: 0, shadows: true, shadowDistance: 1600, shadowQuality: 2, shadowRefresh: 1, antialias: true };
export const SHADOW_DISTANCE_RANGE = [200, 1600] as const;
export const FPS_LIMITS = [30, 60, 90, 120, 144, 240, 0] as const;
/** What each shadow quality means: cascades (at least two: the first is the sharp one round you, a single one over the whole distance is too coarse
 *  to show anything small), the size of each one's map, and the taps of the edge filter (src/world/shadowFilter.ts). */
export const SHADOW_QUALITY = [
  { cascades: 2, map: 1024, filter: 4 },
  { cascades: 3, map: 1024, filter: 8 },
  { cascades: 4, map: 1024, filter: 16 },
] as const;

const KEY = 'dadajam.graphics';

function load(): GraphicsPrefs {
  const g = { ...GRAPHICS_DEFAULTS };
  try {
    const o = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const num = (k: 'resScale' | 'minRes' | 'shadowDistance', lo: number, hi: number) => {
      if (typeof o[k] === 'number' && Number.isFinite(o[k])) g[k] = Math.min(Math.max(o[k], lo), hi);
    };
    num('resScale', 0.01, 2);
    num('minRes', 0.01, 1);
    num('shadowDistance', SHADOW_DISTANCE_RANGE[0], SHADOW_DISTANCE_RANGE[1]);
    if ((FPS_LIMITS as readonly number[]).includes(o.fpsLimit)) g.fpsLimit = o.fpsLimit;
    if ([0, 1, 2].includes(o.shadowQuality)) g.shadowQuality = o.shadowQuality;
    if ([0, 1, 2].includes(o.shadowRefresh)) g.shadowRefresh = o.shadowRefresh;
    for (const k of ['dynamicRes', 'fullscreen', 'shadows', 'antialias'] as const) if (typeof o[k] === 'boolean') g[k] = o[k];
  } catch {}
  return g;
}

/** The current settings. Change them with `setGraphics`. */
export const graphics: GraphicsPrefs = load();
/** What the page started with: settings that need a reload differ from this until then. */
export const startup: GraphicsPrefs = { ...graphics };

const listeners: ((g: GraphicsPrefs, changed: keyof GraphicsPrefs) => void)[] = [];

export function onGraphics(fn: (g: GraphicsPrefs, changed: keyof GraphicsPrefs) => void) {
  listeners.push(fn);
}

export function setGraphics<K extends keyof GraphicsPrefs>(key: K, value: GraphicsPrefs[K]) {
  graphics[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(graphics));
  } catch {}
  for (const fn of listeners) fn(graphics, key);
}

/** Does a setting that only applies on a fresh page differ from the running one? */
export function needsReload(): boolean {
  return graphics.shadowQuality !== startup.shadowQuality || graphics.antialias !== startup.antialias;
}

/** Far end (m) of each cascade, by cascade count, at the full 1600 m. The nearest is the sharp one around you (a player's long low-sun
 *  shadow stays crisp out to its end), so it is wide; each end is also capped to a share of a shorter shadow distance. */
const CASCADE_BASE: Record<number, number[]> = { 2: [60, 1600], 3: [40, 300, 1600], 4: [40, 128, 400, 1600] };
const CASCADE_SHARE: Record<number, number[]> = { 2: [0.3, 1], 3: [0.25, 0.7, 1], 4: [0.25, 0.6, 0.9, 1] };

/** Far end of each cascade for these settings. */
export function cascadeEnds(distance: number, count: number): number[] {
  return CASCADE_BASE[count].map((b, i) => (i === count - 1 ? distance : Math.min(b, distance * CASCADE_SHARE[count][i])));
}
