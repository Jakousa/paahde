// Scrap HUD: "[F] Pick up …" under the crosshair when looking at a piece in reach, the inventory list
// in the bottom-right corner, and a short "+1 …" toast whenever the server adds something to it.
import { SCRAP_KINDS, type ScrapPiece } from '../shared/scrap.ts';

const TOAST_MS = 1600;

const css = `
#pickup { position: fixed; left: 50%; top: calc(50% + 22px); transform: translateX(-50%); padding: 3px 8px;
  font: 13px system-ui, sans-serif; color: #fff4e4; background: rgba(20, 10, 5, 0.55); border-radius: 4px;
  pointer-events: none; white-space: nowrap; display: none; }
#pickup kbd { font: bold 11px monospace; padding: 0 4px; margin-right: 6px; border-radius: 3px;
  background: #fff4e4; color: #2a160a; }
#inventory { position: fixed; right: 12px; bottom: 12px; min-width: 140px; padding: 6px 10px;
  font: 12px system-ui, sans-serif; color: #fff4e4; background: rgba(20, 10, 5, 0.45); border-radius: 6px;
  box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.15); pointer-events: none; display: none; }
#inventory h3 { margin: 0 0 4px; font: 600 10px system-ui, sans-serif; letter-spacing: 0.08em;
  text-transform: uppercase; opacity: 0.7; }
#inventory .row { display: flex; justify-content: space-between; gap: 16px; line-height: 1.5; }
#inventory .row b { font-variant-numeric: tabular-nums; }
#toasts { position: fixed; left: 50%; top: calc(50% + 52px); transform: translateX(-50%); pointer-events: none;
  display: flex; flex-direction: column; align-items: center; gap: 2px; }
#toasts div { font: 600 13px system-ui, sans-serif; color: #ffd9a0; text-shadow: 0 1px 2px #000;
  animation: toast ${TOAST_MS}ms ease-out forwards; }
@keyframes toast { 0% { opacity: 0; transform: translateY(6px); } 12% { opacity: 1; transform: none; }
  70% { opacity: 1; } 100% { opacity: 0; transform: translateY(-10px); } }
`;

export class InventoryHud {
  private prompt = document.createElement('div');
  private panel = document.createElement('div');
  private toasts = document.createElement('div');
  private shown: ScrapPiece | string | null = null;
  private items: number[] | null = null;

  constructor() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.prompt.id = 'pickup';
    this.panel.id = 'inventory';
    this.toasts.id = 'toasts';
    document.body.append(this.prompt, this.panel, this.toasts);
  }

  /** The piece under the crosshair, or another F action's label (e.g. "Plant seeds"), or null; every frame. */
  setTarget(target: ScrapPiece | string | null) {
    if (target === this.shown) return;
    this.shown = target;
    this.prompt.style.display = target ? 'block' : 'none';
    if (target) this.prompt.innerHTML = `<kbd>F</kbd>${typeof target === 'string' ? target : `Pick up ${SCRAP_KINDS[target.kind].label}`}`;
  }

    /** New inventory from the server; toasts what was added since the last one (not on the first). */
  setItems(items: number[]) {
    if (this.items) {
      items.forEach((n, k) => {
        const added = n - (this.items![k] ?? 0);
        if (added > 0) this.toast(`+${added} ${SCRAP_KINDS[k]?.label ?? '?'}`);
      });
    }
    this.items = items.slice();
    const rows = items.map((n, k) => (n > 0 ? `<div class="row"><span>${SCRAP_KINDS[k]?.label ?? '?'}</span><b>${n}</b></div>` : '')).join('');
    this.panel.style.display = rows ? 'block' : 'none';
    this.panel.innerHTML = `<h3>Junk</h3>${rows}`;
  }

  toast(text: string) {
    const el = document.createElement('div');
    el.textContent = text;
    this.toasts.appendChild(el);
    setTimeout(() => el.remove(), TOAST_MS);
  }
}
