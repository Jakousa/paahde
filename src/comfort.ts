/** Camera, input and readability preferences. These change presentation, never the shared simulation. */
const KEY = 'dadajam.comfort';
export const COMFORT_RANGES = {
  mouseX: [0.2, 3], mouseY: [0.2, 3], padX: [0.2, 3], padY: [0.2, 3],
  fov: [60, 100], motion: [0, 1], glare: [0, 1], grain: [0, 1],
  hudScale: [0.75, 2], subtitleScale: [0.75, 2], subtitleOpacity: [0, 1], subtitleDuration: [1, 3],
} as const;
export type Comfort = Record<keyof typeof COMFORT_RANGES, number> & { invertY: boolean; instantText: boolean };
export const comfort: Comfort = {
  mouseX: 1, mouseY: 1, padX: 1, padY: 1, invertY: false,
  fov: 72, motion: 1, glare: 1, grain: 1, hudScale: 1, subtitleScale: 1,
  subtitleOpacity: 0.45, subtitleDuration: 1, instantText: false,
};

/** Validate persisted and UI values through the same path. */
export function comfortValue<K extends keyof Comfort>(key: K, value: unknown): Comfort[K] {
  if (key === 'invertY' || key === 'instantText') return (typeof value === 'boolean' ? value : comfort[key]) as Comfort[K];
  const range = COMFORT_RANGES[key as keyof typeof COMFORT_RANGES];
  return (typeof value === 'number' && Number.isFinite(value)
    ? Math.min(range[1], Math.max(range[0], value)) : comfort[key]) as Comfort[K];
}

try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  for (const key of Object.keys(comfort) as (keyof Comfort)[]) Object.assign(comfort, { [key]: comfortValue(key, saved?.[key]) });
} catch { /* Defaults also work when storage is blocked. */ }

const listeners = new Set<() => void>();
export function onComfort(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function setComfort<K extends keyof Comfort>(key: K, value: Comfort[K]) {
  comfort[key] = comfortValue(key, value);
  try { localStorage.setItem(KEY, JSON.stringify(comfort)); } catch {}
  applyComfort();
  for (const fn of listeners) fn();
}

function applyComfort() {
  const style = document.documentElement.style;
  style.setProperty('--hud-scale', String(comfort.hudScale));
  style.setProperty('--subtitle-scale', String(comfort.subtitleScale));
  style.setProperty('--subtitle-opacity', String(comfort.subtitleOpacity));
}
applyComfort();

// CSS zoom preserves fixed anchors and enlarges text and hit targets together. Viewport widths compensate for zoom.
const style = document.createElement('style');
style.textContent = `
#survival, #heat, #env, #lives, #locator, #pickup, #toasts, #waterPrompt, #waterToast, #chat, #bossBar { zoom: var(--hud-scale, 1); }
#locator { max-width: calc(80vw / var(--hud-scale, 1)); }
#chat { max-width: calc(100vw / var(--hud-scale, 1) - 32px); }
#bossBar { max-width: calc(80vw / var(--hud-scale, 1)); }
#pickup, #waterPrompt, #waterToast, #toasts { max-width: calc(90vw / var(--hud-scale, 1)); }
`;
document.head.append(style);
