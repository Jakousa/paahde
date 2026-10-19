// Debug menu: F3 (or `) toggles a small panel. Opening it frees the mouse so the controls can be clicked.
// Time of day: a slider that holds the sky at that time (local view only), or, with "Apply to all players",
// moves the shared server clock for everyone, production included. "Sandstorm here" summons one on you
// (for everyone, after the usual warning); "Local sandstorm" sends one at you from just upwind at once, seen only by you.
// "Guardian here" / "Drone here" bring the nearest guardian, or a drone (by day too), to you, for everyone; "Jet here"
// sends a fixed-wing drone over you; "Crawlers here" sets a pack of crawlers on you.
// "Tone" switches the tone curve live (post.ts toneControl); "white" is the filmic curve's white point.
// "Trophies" shows the boss trophies at the base (src/world/trophies.ts) for the kinds beaten, all or none (local
// view, looks only: walking into them still follows the kinds beaten).
// "Give gear" puts one of every piece of gear (shared/gear.ts), repaired with Scrap parts, and a laser rifle, pistol and jammer in your bag and equipment.
import { isBound } from './bindings';
import { ui } from './input';
import { BOSS_KINDS, BOSSES, type BossKind } from '../shared/bosses.ts';
import { TONE_CURVES, toneControl, type ToneCurve } from './post';
import { summonLocalStorm } from './storm';
import { clockText, timeControl } from './world/dayNight';
import type { TrophyShow } from './world/trophies';

const PRESETS: [string, number][] = [['Dawn', 0.27], ['Noon', 0.5], ['Golden hour', 0.7], ['Dusk', 0.77], ['Midnight', 0]];

export class DebugMenu {
  private panel = document.createElement('div');

  /** `currentTod` reads the sky's present time of day (0..1) so the slider starts from it. */
  constructor(currentTod: () => number, shareTod: (tod: number) => void, resetShared: () => void, summonStorm: () => void, giveGear: (tier: number) => void, hit: () => void, summonBot: (what: 'guardian' | 'drone' | 'jet' | 'crawlers' | BossKind) => void,
    showTrophies: (mode: TrophyShow) => void, resetYard: (all: boolean) => void = () => {}, noHeat: (off: boolean) => void = () => {}) {
    const style = document.createElement('style');
    style.textContent = `
#debugMenu { position: fixed; top: 48px; right: 12px; width: 230px; padding: 10px 12px; display: none;
  font: 12px var(--mono); color: #ffe9cc; background: rgba(20, 10, 5, 0.82); border-radius: 8px;
  box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.18); z-index: 10; }
#debugMenu h4 { margin: 0 0 8px; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; opacity: .7; }
#debugMenu input[type=range] { width: 100%; }
#debugMenu label input[type=range] { flex: 1; width: auto; }
#debugMenu select { font: inherit; color: inherit; background: rgba(255, 233, 204, 0.12); border: 0; border-radius: 4px; }
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
<div class="row"></div>
<div class="row"><button id="dbgStorm" title="A sandstorm on you, for everyone, after the 20 s warning">Sandstorm here</button>
<button id="dbgLocalStorm" title="A sandstorm rolling in from upwind right now, only you see it (no heat)">Local sandstorm</button></div>
<div class="row"><button id="dbgGuardian" title="The nearest guardian, brought 90 m from you (for everyone)">Guardian here</button>
<button id="dbgDrone" title="A searchlight drone over you for a minute, even by day (for everyone)">Drone here</button>
<button id="dbgJet" title="A fixed-wing drone flying over you in about 15 s (for everyone)">Jet here</button>
<button id="dbgCrawlers" title="A pack of six crawlers 30 m off, coming for you (for everyone)">Crawlers here</button></div>
<div class="row">${BOSS_KINDS.map((k) => `<button data-boss="${k}" title="The ${k} boss near you for ten minutes (for everyone)">${BOSSES[k].label}</button>`).join('')}</div>
<label title="Boss trophies at the base, local view (walking into them still follows the bosses beaten)">Trophies <select id="dbgTrophies"><option value="won">as won</option><option value="all">all</option><option value="none">none</option></select></label>
<label>Tone <select id="dbgTone">${TONE_CURVES.map((c) => `<option>${c}</option>`).join('')}</select></label>
<label id="dbgWhiteRow">White <input id="dbgWhite" type="range" min="1" max="8" step="0.25"> <b id="dbgWhiteVal"></b></label>
<div class="row">Give gear ${['Scrap', 'Basic', 'Quality', 'Space'].map((n, i) => `<button data-gear="${i}" title="One of every piece of gear, repaired with ${n} parts (what doesn't fit is skipped)">${n}</button>`).join('')}</div>
<div class="row">Yard <button id="dbgYard" title="Put the nearest yard machine back together (npm run dev:yard)">Reset near</button><button id="dbgYardAll" title="Put every yard machine back together">Reset all</button></div>
<label title="No heat build-up for you (the meter drops to zero)"><input id="dbgNoHeat" type="checkbox"> Disable heat</label>
<div class="row"><button id="dbgHit"title="A killing blow (a guardian's laser): try the shield plate">Hit me</button></div>`;
    document.body.append(p);
    const slider = p.querySelector<HTMLInputElement>('#dbgTod')!;
    const live = p.querySelector<HTMLInputElement>('#dbgLive')!;
    const share = p.querySelector<HTMLInputElement>('#dbgShare')!;
    const label = p.querySelector<HTMLElement>('#dbgTime')!;
    const row = p.querySelector<HTMLElement>('.row')!;
    p.querySelector('#dbgStorm')!.addEventListener('click', summonStorm);
    p.querySelector('#dbgLocalStorm')!.addEventListener('click', summonLocalStorm);
    for (const b of p.querySelectorAll<HTMLElement>('[data-gear]')) b.addEventListener('click', () => giveGear(Number(b.dataset.gear)));
    p.querySelector('#dbgHit')!.addEventListener('click', hit);
    const noHeatBox = p.querySelector<HTMLInputElement>('#dbgNoHeat')!;
    noHeatBox.addEventListener('change', () => noHeat(noHeatBox.checked));
    p.querySelector('#dbgYard')!.addEventListener('click', () => resetYard(false));
    p.querySelector('#dbgYardAll')!.addEventListener('click', () => resetYard(true));
    p.querySelector('#dbgGuardian')!.addEventListener('click', () => summonBot('guardian'));
    p.querySelector('#dbgDrone')!.addEventListener('click', () => summonBot('drone'));
    p.querySelector('#dbgJet')!.addEventListener('click', () => summonBot('jet'));
    p.querySelector('#dbgCrawlers')!.addEventListener('click', () => summonBot('crawlers'));
    for (const b of p.querySelectorAll<HTMLElement>('[data-boss]')) b.addEventListener('click', () => summonBot(b.dataset.boss as BossKind));

    const trophies = p.querySelector<HTMLSelectElement>('#dbgTrophies')!;
    trophies.addEventListener('change', () => showTrophies(trophies.value as TrophyShow));

    const tone = p.querySelector<HTMLSelectElement>('#dbgTone')!;
    const white = p.querySelector<HTMLInputElement>('#dbgWhite')!;
    const whiteRow = p.querySelector<HTMLElement>('#dbgWhiteRow')!;
    const whiteVal = p.querySelector<HTMLElement>('#dbgWhiteVal')!;
    const showTone = () => {
      tone.value = toneControl.curve;
      white.value = String(toneControl.white);
      whiteVal.textContent = toneControl.white.toFixed(2);
      whiteRow.style.display = toneControl.curve === 'filmic' ? '' : 'none';
    };
    tone.addEventListener('change', () => { toneControl.set(tone.value as ToneCurve); showTone(); });
    white.addEventListener('input', () => { toneControl.set(toneControl.curve, Number(white.value)); showTone(); });
    showTone();

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
      if (!isBound('debug', e.code)) return;
      e.preventDefault();
      const open = p.style.display !== 'block';
      p.style.display = open ? 'block' : 'none';
      if (open) {
        if (document.pointerLockElement) ui.debugFreed = true;
        document.exitPointerLock();
        if (live.checked) show(currentTod());
      }
    });
  }
}
