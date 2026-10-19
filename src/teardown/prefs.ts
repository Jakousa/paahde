// Disassembly settings (the Esc menu, Gameplay): whether the big indicators show on every step that can be worked now, and whether
// the steps and parts left show near a machine. The small shimmer on a workable part is always there.
const KEY = 'dadajam.tdMarkers';
const COUNTS_KEY = 'dadajam.tdCounts';

export const tdPrefs = { markers: true, counts: true };
/** Called when a setting changes (what is drawn from it is redrawn). */
export const tdListeners = new Set<() => void>();

try {
  tdPrefs.markers = localStorage.getItem(KEY) !== '0';
  tdPrefs.counts = localStorage.getItem(COUNTS_KEY) !== '0';
} catch {}

export function setMarkers(on: boolean) {
  tdPrefs.markers = on;
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {}
}

export function setCounts(on: boolean) {
  tdPrefs.counts = on;
  try {
    localStorage.setItem(COUNTS_KEY, on ? '1' : '0');
  } catch {}
  for (const f of tdListeners) f();
}
