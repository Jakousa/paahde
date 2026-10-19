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
  /** Cascades the shadow distance is cut into (1–4). Needs a reload. */
  cascades: number;
  /** Size of each cascade's shadow map. Needs a reload. */
  shadowMap: number;
  /** Taps of the sun-shadow filter: 4, 8 or 16 (src/world/shadowFilter.ts). Needs a reload. */
  shadowFilter: number;
  /** How often the far shadow cascades are redrawn: 0 every frame, 1 some, 2 rarely (src/world/cascades.ts). */
  shadowRefresh: number;
  /** Multisampled edges (the renderer is made with it). Needs a reload. */
  antialias: boolean;
}

export const GRAPHICS_DEFAULTS: GraphicsPrefs = { resScale: 1, dynamicRes: true, minRes: 0.5, fullscreen: true, fpsLimit: 0, shadows: true, shadowDistance: 1600, cascades: 4, shadowMap: 1024, shadowFilter: 16, shadowRefresh: 1, antialias: true };
export const SHADOW_DISTANCE_RANGE = [200, 1600] as const;
export const FPS_LIMITS = [30, 60, 90, 120, 144, 240, 0] as const;
export const SHADOW_FILTERS = [4, 8, 16] as const;
export const SHADOW_MAPS = [512, 1024, 2048] as const;

const KEY = 'dadajam.graphics';

function load(): GraphicsPrefs {
  const g = { ...GRAPHICS_DEFAULTS };
  try {
    const o = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const num = (k: 'resScale' | 'minRes' | 'shadowDistance' | 'cascades' | 'shadowMap', lo: number, hi: number) => {
      if (typeof o[k] === 'number' && Number.isFinite(o[k])) g[k] = Math.min(Math.max(o[k], lo), hi);
    };
    num('resScale', 0.01, 2);
    num('minRes', 0.01, 1);
    num('shadowDistance', SHADOW_DISTANCE_RANGE[0], SHADOW_DISTANCE_RANGE[1]);
    num('cascades', 1, 4);
    if ((FPS_LIMITS as readonly number[]).includes(o.fpsLimit)) g.fpsLimit = o.fpsLimit;
    g.cascades = Math.round(g.cascades);
    num('shadowMap', SHADOW_MAPS[0], SHADOW_MAPS[SHADOW_MAPS.length - 1]);
    if (!(SHADOW_MAPS as readonly number[]).includes(g.shadowMap)) g.shadowMap = GRAPHICS_DEFAULTS.shadowMap;
    if ((SHADOW_FILTERS as readonly number[]).includes(o.shadowFilter)) g.shadowFilter = o.shadowFilter;
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
  return graphics.cascades !== startup.cascades || graphics.shadowMap !== startup.shadowMap || graphics.shadowFilter !== startup.shadowFilter || graphics.antialias !== startup.antialias;
}

/** Far end (m) of each cascade, by cascade count, at the full 1600 m. The nearest is the sharp one around you (a player's long low-sun
 *  shadow stays crisp out to its end), so it is wide; each end is also capped to a share of a shorter shadow distance. */
const CASCADE_BASE: Record<number, number[]> = { 1: [1600], 2: [60, 1600], 3: [40, 300, 1600], 4: [40, 128, 400, 1600] };
const CASCADE_SHARE: Record<number, number[]> = { 1: [1], 2: [0.3, 1], 3: [0.25, 0.7, 1], 4: [0.25, 0.6, 0.9, 1] };

/** Far end of each cascade for these settings. */
export function cascadeEnds(distance: number, count: number): number[] {
  return CASCADE_BASE[count].map((b, i) => (i === count - 1 ? distance : Math.min(b, distance * CASCADE_SHARE[count][i])));
}
