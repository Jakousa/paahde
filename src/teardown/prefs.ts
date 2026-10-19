// Disassembly settings (the Esc menu): whether the big indicators show on every step that can be worked now. The small
// glint on a workable fastener is always there.
const KEY = 'dadajam.tdMarkers';

export const tdPrefs = { markers: true };

try {
  tdPrefs.markers = localStorage.getItem(KEY) !== '0';
} catch {}

export function setMarkers(on: boolean) {
  tdPrefs.markers = on;
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {}
}
