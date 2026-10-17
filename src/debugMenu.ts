// Debug menu: F3 (or `) toggles a small panel. Opening it frees the mouse so the controls can be clicked.
// Time of day: a slider that holds the sky at that time (local view only), or, with "Apply to all players",
// moves the shared server clock (dev servers only; production ignores it).
import { clockText, timeControl } from './world/dayNight';

const PRESETS: [string, number][] = [['Dawn', 0.27], ['Noon', 0.5], ['Golden hour', 0.7], ['Dusk', 0.77], ['Midnight', 0]];

export class DebugMenu {
  private panel = document.createElement('div');

  /** `currentTod` reads the sky's present time of day (0..1) so the slider starts from it. */
  constructor(currentTod: () => number, shareTod: (tod: number) => void, resetShared: () => void) {
    const style = document.createElement('style');
    style.textContent = `
#debugMenu { position: fixed; top: 48px; right: 12px; width: 230px; padding: 10px 12px; display: none;
  font: 12px system-ui, sans-serif; color: #ffe9cc; background: rgba(20, 10, 5, 0.82); border-radius: 8px;
  box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.18); z-index: 10; }
#debugMenu h4 { margin: 0 0 8px; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; opacity: .7; }
#debugMenu input[type=range] { width: 100%; }
#debugMenu .row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
#debugMenu button { font: inherit; color: inherit; background: rgba(255, 233, 204, 0.12); border: 0; border-radius: 4px;
  padding: 3px 7px; cursor: pointer; }
#debugMenu button:hover { background: rgba(255, 233, 204, 0.25); }
#debugMenu label { display: flex; gap: 6px; align-items: center; margin-top: 8px; }`;
    document.head.append(style);

    const p = this.panel;
    p.id = 'debugMenu';
    p.innerHTML = `<h4>Debug · F3</h4>
<div>Time of day <b id="dbgTime"></b></div>
<input id="dbgTod" type="range" min="0" max="1439" step="1">
<label><input id="dbgLive" type="checkbox"> Follow shared clock</label>
<label><input id="dbgShare" type="checkbox"> Apply to all players (server)</label>
<div class="row"></div>`;
    document.body.append(p);
    const slider = p.querySelector<HTMLInputElement>('#dbgTod')!;
    const live = p.querySelector<HTMLInputElement>('#dbgLive')!;
    const share = p.querySelector<HTMLInputElement>('#dbgShare')!;
    const label = p.querySelector<HTMLElement>('#dbgTime')!;
    const row = p.querySelector<HTMLElement>('.row')!;

    const show = (tod: number) => {
      slider.value = String(Math.round(tod * 1440) % 1440);
      label.textContent = clockText(tod);
    };
    const hold = (tod: number) => {
      if (share.checked) {
        // Move the server's clock instead of holding a local time; the slider then follows the shared clock.
        timeControl.override = null;
        live.checked = true;
        shareTod(((tod % 1) + 1) % 1);
        show(tod);
        return;
      }
      timeControl.override = ((tod % 1) + 1) % 1;
      live.checked = false;
      show(timeControl.override);
    };
    slider.addEventListener('input', () => hold(Number(slider.value) / 1440));
    live.addEventListener('change', () => {
      if (live.checked) timeControl.override = null;
      else hold(currentTod());
    });
    const real = document.createElement('button');
    real.textContent = 'Real time';
    real.title = 'Shared clock back to the real time (needs "Apply to all players")';
    real.addEventListener('click', () => {
      timeControl.override = null;
      live.checked = true;
      if (share.checked) resetShared();
    });
    row.append(real);
    for (const [name, tod] of PRESETS) {
      const b = document.createElement('button');
      b.textContent = name;
      b.addEventListener('click', () => hold(tod));
      row.append(b);
    }

    live.checked = true;
    // While following the clock, keep the slider moving with it.
    setInterval(() => {
      if (p.style.display !== 'none' && live.checked) show(currentTod());
    }, 500);

    addEventListener('keydown', (e) => {
      if (e.code !== 'F3' && e.code !== 'Backquote') return;
      e.preventDefault();
      const open = p.style.display !== 'block';
      p.style.display = open ? 'block' : 'none';
      if (open) {
        document.exitPointerLock();
        if (live.checked) show(currentTod());
      }
    });
  }
}
