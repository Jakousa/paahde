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
}

export const GRAPHICS_DEFAULTS: GraphicsPrefs = { resScale: 1, dynamicRes: true, minRes: 0.5, fullscreen: true, fpsLimit: 0, shadows: true, shadowDistance: 1600, cascades: 4, shadowMap: 1024 };
export const SHADOW_DISTANCE_RANGE = [200, 1600] as const;
export const FPS_LIMITS = [30, 60, 90, 120, 144, 240, 0] as const;
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
    for (const k of ['dynamicRes', 'fullscreen', 'shadows'] as const) if (typeof o[k] === 'boolean') g[k] = o[k];
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
  return graphics.cascades !== startup.cascades || graphics.shadowMap !== startup.shadowMap;
}

/** Shadow cascade ends as fractions of the shadow distance, by cascade count (the last is the distance itself). */
const CASCADE_FRACTIONS: Record<number, number[]> = { 1: [1], 2: [0.12, 1], 3: [0.02, 0.2, 1], 4: [0.0125, 0.05, 0.2, 1] };

/** Far end (m) of each cascade for these settings. */
export function cascadeEnds(distance: number, count: number): number[] {
  return CASCADE_FRACTIONS[count].map((f) => f * distance);
}
