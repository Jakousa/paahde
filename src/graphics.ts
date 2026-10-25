// Graphics options (Esc → Options → Graphics), kept in localStorage. Read once at startup by whatever builds
// the thing (shadow cascades: src/world/sky.ts), and pushed live through `onGraphics` for what can change at runtime.
export interface GraphicsPrefs {
  /** Choose live settings from measured CPU cost and the resolution controller's GPU probes. */
  autoQuality: boolean;
  occlusion: number;
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
  /** Shadow quality, 0 low .. 3 ultra: how many cascades, how big their maps and how soft the filter (SHADOW_QUALITY). Needs a reload. */
  shadowQuality: number;
  /** How far out the small sand ripples are drawn (0 low .. 3 ultra: down to a few pixels a ripple). Live. */
  sandDetail: number;
  /** How often the far shadow cascades are redrawn: 0 every frame, 1 some, 2 rarely (src/world/cascades.ts). */
  shadowRefresh: number;
  /** Multisampled edges (the renderer is made with it). Needs a reload. */
  antialias: boolean;
}

export const GRAPHICS_DEFAULTS: GraphicsPrefs = { autoQuality: false, occlusion: 0.7, resScale: 1, dynamicRes: true, minRes: 0.5, fullscreen: true, fpsLimit: 0, shadows: true, shadowDistance: 1600, shadowQuality: 2, sandDetail: 2, shadowRefresh: 1, antialias: true };
export const PRESET_NAMES = ['low', 'medium', 'high', 'ultra'] as const;
export type GraphicsPreset = typeof PRESET_NAMES[number];
type Preset = Omit<GraphicsPrefs, 'fullscreen' | 'autoQuality'>;
const { fullscreen: _fullscreen, autoQuality: _autoQuality, ...high } = GRAPHICS_DEFAULTS;
/** Display mode is a preference, not a quality setting. All other controls belong to the preset. */
export const GRAPHICS_PRESETS: Record<GraphicsPreset, Preset> = {
  low: { ...high, resScale: 0.65, fpsLimit: 60, shadows: false, shadowDistance: 400, shadowQuality: 0, shadowRefresh: 2, sandDetail: 0, antialias: false, occlusion: 0 },
  medium: { ...high, resScale: 0.85, fpsLimit: 60, shadowDistance: 800, shadowQuality: 1, shadowRefresh: 2, sandDetail: 1 },
  high,
  ultra: { ...high, dynamicRes: false, shadowDistance: 4500, shadowQuality: 3, shadowRefresh: 0, sandDetail: 3 },
};

/** Start with modest shadow maps; live adaptation never rebuilds the renderer or asks for another reload. */
function autoSettings(): Partial<GraphicsPrefs> {
  const cores = typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency || 4;
  return { ...GRAPHICS_PRESETS.medium, autoQuality: true, resScale: 1, shadowRefresh: cores <= 4 ? 2 : 1 };
}
export const SHADOW_DISTANCE_RANGE = [200, 4500] as const;
export const FPS_LIMITS = [30, 60, 90, 120, 144, 240, 0] as const;
/** What each shadow quality means. Shadow maps (players, wrecks, the pod, bosses): cascades (at least two: the first is the sharp one round
 *  you), the size of each one's map, and the taps of the edge filter in the first cascade and the others (src/world/shadowFilter.ts).
 *  Dune shadows (src/world/heightShadow.ts): the grids round the player (width in m, texels). */
export const SHADOW_QUALITY = [
  { cascades: 2, map: 2048, filter: 8, farFilter: 4, height: { levels: [{ size: 1024, res: 1024 }, { size: 9216, res: 512 }] } },
  { cascades: 3, map: 2048, filter: 12, farFilter: 4, height: { levels: [{ size: 1024, res: 2048 }, { size: 9216, res: 1024 }] } },
  { cascades: 4, map: 2048, filter: 16, farFilter: 6, height: { levels: [{ size: 1024, res: 2048 }, { size: 4096, res: 1024 }, { size: 9216, res: 1024 }] } },
  // Ultra: everything big casts a shadow out to the terrain's edge (set the shadow distance up), the dunes' grid is 0.25 m round you. ~0.6 GB of GPU memory.
  { cascades: 5, map: 4096, filter: 16, farFilter: 8, height: { levels: [{ size: 512, res: 2048 }, { size: 2048, res: 2048 }, { size: 9216, res: 2048 }] } },
] as const;

const KEY = 'dadajam.graphics';

function load(): GraphicsPrefs {
  const g = { ...GRAPHICS_DEFAULTS };
  try {
    const saved = localStorage.getItem(KEY);
    const oldAo = localStorage.getItem('dadajam.ao');
    if (saved === null && oldAo === null) return { ...g, ...autoSettings() };
    const o = JSON.parse(saved ?? '{}') ?? {};
    const num = (k: 'resScale' | 'minRes' | 'shadowDistance' | 'occlusion', lo: number, hi: number) => {
      if (typeof o[k] === 'number' && Number.isFinite(o[k])) g[k] = Math.min(Math.max(o[k], lo), hi);
    };
    // The old occlusion slider lived in its own key. Read it until the settings have been saved in the new format.
    if (oldAo !== null && Number.isFinite(Number(oldAo))) g.occlusion = Math.max(0, Math.min(1, Number(oldAo)));
    num('occlusion', 0, 1);
    num('resScale', 0.01, 2);
    num('minRes', 0.01, 1);
    num('shadowDistance', SHADOW_DISTANCE_RANGE[0], SHADOW_DISTANCE_RANGE[1]);
    if ((FPS_LIMITS as readonly number[]).includes(o.fpsLimit)) g.fpsLimit = o.fpsLimit;
    if ([0, 1, 2, 3].includes(o.shadowQuality)) g.shadowQuality = o.shadowQuality;
    if ([0, 1, 2, 3].includes(o.sandDetail)) g.sandDetail = o.sandDetail;
    if ([0, 1, 2].includes(o.shadowRefresh)) g.shadowRefresh = o.shadowRefresh;
    for (const k of ['autoQuality', 'dynamicRes', 'fullscreen', 'shadows', 'antialias'] as const) if (typeof o[k] === 'boolean') g[k] = o[k];
  } catch { return { ...g, ...autoSettings() }; }
  return g;
}

/** The current settings. Change them with `setGraphics`. */
export const graphics: GraphicsPrefs = load();
/** What the page started with: settings that need a reload differ from this until then. */
export const startup: GraphicsPrefs = { ...graphics };

const listeners: ((g: GraphicsPrefs, changed: keyof GraphicsPrefs) => void)[] = [];

export function onGraphics(fn: (g: GraphicsPrefs, changed: keyof GraphicsPrefs) => void) {
  listeners.push(fn);
  return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
}

export function setGraphics<K extends keyof GraphicsPrefs>(key: K, value: GraphicsPrefs[K]) {
  updateGraphics({ [key]: value, ...(key !== 'fullscreen' && key !== 'autoQuality' ? { autoQuality: false } : {}) });
}

/** Apply the complete change before notifying the renderer and menu. Save once per change, not once per field. */
function updateGraphics(values: Partial<GraphicsPrefs>) {
  const changed = (Object.keys(values) as (keyof GraphicsPrefs)[]).filter((k) => graphics[k] !== values[k]);
  if (!changed.length) return;
  Object.assign(graphics, values);
  try {
    localStorage.setItem(KEY, JSON.stringify(graphics));
  } catch {}
  for (const key of changed) for (const fn of listeners) fn(graphics, key);
}

export function applyGraphicsPreset(preset: GraphicsPreset | 'auto') {
  updateGraphics(preset === 'auto' ? autoSettings() : { ...GRAPHICS_PRESETS[preset], autoQuality: false });
}

/** Auto may only change controls that can take effect live. Manual changes stop it immediately. */
export function adaptGraphics(values: Pick<GraphicsPrefs, 'shadows' | 'shadowDistance' | 'shadowRefresh' | 'sandDetail' | 'occlusion'>) {
  if (graphics.autoQuality) updateGraphics(values);
}

/** Derived from the actual settings, so a manual edit or a reload cannot leave a misleading preset label. */
export function currentGraphicsPreset(): GraphicsPreset | 'auto' | 'custom' {
  if (graphics.autoQuality) return 'auto';
  return PRESET_NAMES.find((name) => (Object.keys(GRAPHICS_PRESETS[name]) as (keyof Preset)[])
    .every((key) => graphics[key] === GRAPHICS_PRESETS[name][key])) ?? 'custom';
}

/** Does a setting that only applies on a fresh page differ from the running one? */
export function needsReload(): boolean {
  return graphics.shadowQuality !== startup.shadowQuality || graphics.antialias !== startup.antialias;
}

/** Far end (m) of each cascade, by cascade count, at the full 1600 m. The nearest is the sharp one around you (a player's long low-sun
 *  shadow stays crisp out to its end), so it is wide; each end is also capped to a share of a shorter shadow distance. */
const CASCADE_BASE: Record<number, number[]> = { 2: [60, 1600], 3: [40, 300, 1600], 4: [40, 128, 400, 1600], 5: [40, 128, 400, 1300, 4500] };
const CASCADE_SHARE: Record<number, number[]> = { 2: [0.3, 1], 3: [0.25, 0.7, 1], 4: [0.25, 0.6, 0.9, 1], 5: [0.2, 0.4, 0.7, 0.9, 1] };

/** Far end of each cascade for these settings. */
export function cascadeEnds(distance: number, count: number): number[] {
  return CASCADE_BASE[count].map((b, i) => (i === count - 1 ? distance : Math.min(b, distance * CASCADE_SHARE[count][i])));
}
