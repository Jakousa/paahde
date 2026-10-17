// Survival on the client (shared/water.ts, server/water.ts): the hotbar (slot 1 = canteen, 2 = binoculars
// in src/binoculars.ts), drinking and refilling, and the HUD: heat meter with a sun light while heat builds,
// the felt temperature with a sun/shade icon (shared/temperature.ts), a heat vignette when it's nearly full,
// and the death screen.
//
// The server owns the numbers; this only plays the actions and asks. Key 1 takes the canteen out or puts
// it away (2 the binoculars, 3–4 select the empty slots). With it out, holding left mouse / E for DRINK_MS drinks one sip
// (no digging while your hands are full, see `tools` in src/input.ts), and F at the base's pump refills it.
import { atPump } from '../shared/base.ts';
import { CANTEEN_SIPS, DRINK_MS, FILL_MS, HEAT_HIGH, HEAT_MAX } from '../shared/water.ts';
import { tools, useHeld } from './input';
import type { Net } from './net';

/**
 * What the first-person hands are doing, for the viewmodel (src/viewmodel.ts). `drinking` / `filling`
 * are true for the whole sip / refill action. Digging is the DIG input bit, as before.
 */
export type Held = 'none' | 'canteen' | 'binoculars';
/** `looking`: binoculars being raised or at the eyes; `scoped`: at the eyes, view zoomed (hands hidden). */
export const playerHands = { held: 'none' as Held, drinking: false, filling: false, looking: false, scoped: false };

const SLOTS = 4;
/** Heat meter colours: cool, warming up, nearly heatstroke. */
const BLUE = [78, 170, 255];
const AMBER = [236, 158, 52];
const RED = [222, 62, 34];
/** Thermometer colours by felt °C: cool blue up to TEMP_COOL, amber at TEMP_WARM, red from TEMP_HOT. */
const TEMP_BLUE = [120, 196, 255];
const TEMP_AMBER = [255, 184, 77];
const TEMP_RED = [255, 92, 60];
const TEMP_COOL = 18, TEMP_WARM = 34, TEMP_HOT = 50;
const DEATH_MS = 3000;
const TOAST_MS = 1800;
/** Walking this far (m) out of the pump's reach cancels a refill. Under the server's FILL_SLACK. */
const FILL_CANCEL_SLACK = 0.5;

const css = `
#survival { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); display: flex;
  flex-direction: column; align-items: center; gap: 6px; pointer-events: none; font: 12px system-ui, sans-serif;
  color: #fff4e4; }
#thirst { display: flex; align-items: center; gap: 8px; padding: 5px 10px 5px 7px; border-radius: 6px;
  background: rgba(20, 10, 5, 0.45); box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.15); }
#thirst .sun { width: 16px; height: 16px; opacity: 0.35; transition: opacity .4s, filter .4s; }
#thirst.heat .sun { opacity: 1; filter: drop-shadow(0 0 4px #ffb347) drop-shadow(0 0 8px #ff7a1a); }
#thirst .bar { position: relative; width: 210px; height: 8px; border-radius: 4px; overflow: hidden;
  background: rgba(255, 244, 228, 0.12); }
#thirst .fill { position: absolute; inset: 0; transform-origin: left; border-radius: 4px; }
#thirst .num { width: 26px; text-align: right; font-variant-numeric: tabular-nums; opacity: 0.85; }
#thirst .temp { display: flex; align-items: center; gap: 4px; margin-left: 2px; padding-left: 8px;
  border-left: 1px solid rgba(255, 240, 220, 0.15); }
#thirst .temp svg { width: 15px; height: 15px; }
#thirst .temp .shadeIcon, #thirst .temp.shade .sunIcon { display: none; }
#thirst .temp.shade .shadeIcon { display: block; }
#thirst .deg { min-width: 36px; font-weight: 600; font-variant-numeric: tabular-nums; transition: color .6s;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6); }
#thirst.high .bar { animation: thirstPulse 1.1s ease-in-out infinite; }
@keyframes thirstPulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(255, 90, 40, 0); }
  50% { box-shadow: 0 0 0 2px rgba(255, 90, 40, 0.75); } }
#hotbar { display: flex; gap: 4px; }
#hotbar .slot { position: relative; width: 44px; height: 44px; border-radius: 6px; background: rgba(20, 10, 5, 0.45);
  box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.15); display: flex; align-items: center; justify-content: center; }
#hotbar .slot.sel { background: rgba(60, 34, 16, 0.6); box-shadow: 0 0 0 2px rgba(255, 233, 204, 0.75); }
#hotbar .key { position: absolute; left: 4px; top: 2px; font: 600 9px system-ui, sans-serif; opacity: 0.6; }
#hotbar svg { width: 22px; height: 26px; margin-top: -4px; }
#hotbar .pips { position: absolute; bottom: 4px; left: 6px; right: 6px; display: flex; gap: 2px; }
#hotbar .pips i { flex: 1; height: 3px; border-radius: 1px; background: rgba(255, 244, 228, 0.18); }
#hotbar .pips i.on { background: #5cb8ff; }
#waterPrompt { position: fixed; left: 50%; top: calc(50% + 22px); transform: translateX(-50%); padding: 3px 8px;
  font: 13px system-ui, sans-serif; color: #fff4e4; background: rgba(20, 10, 5, 0.55); border-radius: 4px;
  pointer-events: none; white-space: nowrap; display: none; }
#waterPrompt kbd { font: bold 11px monospace; padding: 0 4px; margin-right: 6px; border-radius: 3px;
  background: #fff4e4; color: #2a160a; }
#waterPrompt .prog { display: block; height: 2px; margin-top: 3px; background: #5cb8ff; transform-origin: left; }
#waterToast { position: fixed; left: 50%; top: calc(50% + 52px); transform: translateX(-50%); pointer-events: none;
  font: 600 13px system-ui, sans-serif; color: #ffd9a0; text-shadow: 0 1px 2px #000; opacity: 0;
  transition: opacity .25s; white-space: nowrap; }
#heatVignette { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity .6s;
  box-shadow: inset 0 0 18vmin 4vmin rgba(150, 30, 0, 0.75);
  background: radial-gradient(ellipse closest-side, rgba(0, 0, 0, 0) 70%, rgba(170, 45, 10, 0.3) 100%); }
#heatVignette.pulse { animation: heatPulse 1.6s ease-in-out infinite; }
@keyframes heatPulse { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.6); } }
#deathScreen { position: fixed; inset: 0; z-index: 20; pointer-events: none; display: none; flex-direction: column;
  align-items: center; justify-content: center; gap: 10px; background: radial-gradient(ellipse at center,
  rgba(60, 14, 4, 0.82), rgba(15, 4, 0, 0.95)); color: #ffe2c4; font: 600 34px Georgia, serif;
  letter-spacing: 0.04em; animation: deathIn 0.6s ease-out; }
#deathScreen small { font: 13px system-ui, sans-serif; letter-spacing: 0.02em; opacity: 0.7; }
@keyframes deathIn { from { opacity: 0; } to { opacity: 1; } }
`;

const SUN_SVG = `<svg class="sun" viewBox="0 0 16 16" fill="none" stroke="#ffc46b" stroke-width="1.6" stroke-linecap="round">
<circle cx="8" cy="8" r="3.2" fill="#ffc46b"/><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9 13 13M3 13l1.1-1.1M11.9 4.1 13 3"/></svg>`;
/** Direct sun, and shade (the sun behind a dune). */
const SUN_ICON = `<svg class="sunIcon" viewBox="0 0 16 16" fill="none" stroke="#ffc46b" stroke-width="1.6" stroke-linecap="round">
<circle cx="8" cy="8" r="3" fill="#ffc46b"/><path d="M8 1.2v1.5M8 13.3v1.5M1.2 8h1.5M13.3 8h1.5M3.2 3.2l1 1M11.8 11.8l1 1M3.2 12.8l1-1M11.8 4.2l1-1"/></svg>`;
const SHADE_ICON = `<svg class="shadeIcon" viewBox="0 0 16 16"><title>In shade</title>
<circle cx="10" cy="6.5" r="3" fill="#ffc46b" opacity="0.45"/><path d="M10 1.4v1.3M14.6 6.5h-1.3M13.3 3.2l-.9.9M6.7 3.2l.9.9" stroke="#ffc46b" stroke-width="1.4" stroke-linecap="round" opacity="0.45"/>
<path d="M0.5 14.5C3 8.5 6 7 9 8.6c2.2 1.2 4.4 3.6 6.5 5.9z" fill="#7a5a3e" stroke="#2a160a" stroke-width="0.8"/></svg>`;
const CANTEEN_SVG = `<svg viewBox="0 0 22 26"><rect x="8" y="0.5" width="6" height="4" rx="1" fill="#6b4a2e"/>
<ellipse cx="11" cy="15" rx="9.5" ry="9.5" fill="#8a8f86" stroke="#2a160a" stroke-width="1"/>
<ellipse cx="11" cy="15" rx="6.5" ry="6.5" fill="none" stroke="#5e6a5a" stroke-width="2.2"/>
<path d="M2 11h18" stroke="#6b4a2e" stroke-width="2"/></svg>`;
const BINOCULARS_SVG = `<svg viewBox="0 0 22 26"><g stroke="#2a160a" stroke-width="0.8">
<rect x="2.6" y="3.5" width="5.8" height="4" rx="1.4" fill="#b8873a"/><rect x="13.6" y="3.5" width="5.8" height="4" rx="1.4" fill="#b8873a"/>
<rect x="1" y="7" width="9" height="15.5" rx="2" fill="#6a3626"/><rect x="12" y="7" width="9" height="15.5" rx="2" fill="#6a3626"/>
<rect x="9.5" y="9.5" width="3" height="4.5" fill="#d4a24c"/>
<rect x="0.5" y="19" width="10" height="4.5" rx="1.2" fill="#d4a24c"/><rect x="11.5" y="19" width="10" height="4.5" rx="1.2" fill="#d4a24c"/></g>
<path d="M1.5 12h8M12.5 12h8" stroke="#d4a24c" stroke-width="1"/></svg>`;

export class Survival {
  private net: Net;
  private root = document.createElement('div');
  private thirst = document.createElement('div');
  private fillEl!: HTMLElement;
  private numEl!: HTMLElement;
  private tempEl!: HTMLElement;
  private degEl!: HTMLElement;
  private slots: HTMLElement[] = [];
  private pips: HTMLElement[] = [];
  private prompt = document.createElement('div');
  private toastEl = document.createElement('div');
  private vignette = document.createElement('div');
  private death = document.createElement('div');

  private selected = -1; // hotbar slot, -1 = empty hands
  private shown = 0; // eased meter value
  private actionAt = 0; // performance.now() when the current sip / refill started
  private needRelease = false; // one sip per press: let go before the next
  private deadUntil = 0;
  private toastUntil = 0;
  private promptHtml = '';
  private lastNum = -1;
  private shownTemp = NaN; // eased felt temperature
  private lastDeg = NaN;
  private lastShade: boolean | null = null;

  constructor(net: Net) {
    this.net = net;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    this.root.id = 'survival';
    this.thirst.id = 'thirst';
    this.thirst.title = 'Heat — drink to cool down';
    this.thirst.innerHTML = `${SUN_SVG}<div class="bar"><div class="fill"></div></div><span class="num"></span>`
      + `<span class="temp" title="Felt temperature">${SUN_ICON}${SHADE_ICON}<span class="deg"></span></span>`;
    this.fillEl = this.thirst.querySelector('.fill')!;
    this.numEl = this.thirst.querySelector('.num')!;
    this.tempEl = this.thirst.querySelector('.temp')!;
    this.degEl = this.thirst.querySelector('.deg')!;
    const hotbar = document.createElement('div');
    hotbar.id = 'hotbar';
    for (let i = 0; i < SLOTS; i++) {
      const s = document.createElement('div');
      s.className = 'slot';
      s.innerHTML = `<span class="key">${i + 1}</span>`;
      if (i === 0) {
        s.title = 'Canteen';
        s.insertAdjacentHTML('beforeend', `${CANTEEN_SVG}<div class="pips">${'<i></i>'.repeat(CANTEEN_SIPS)}</div>`);
        this.pips = [...s.querySelectorAll<HTMLElement>('.pips i')];
      } else if (i === 1) {
        s.title = 'Binoculars — hold the mouse button to look, wheel to zoom';
        s.insertAdjacentHTML('beforeend', BINOCULARS_SVG);
      }
      this.slots.push(s);
      hotbar.append(s);
    }
    this.root.append(this.thirst, hotbar);
    this.prompt.id = 'waterPrompt';
    this.toastEl.id = 'waterToast';
    this.vignette.id = 'heatVignette';
    this.death.id = 'deathScreen';
    this.death.innerHTML = 'You died of heatstroke<small>The sun got you. Back at the base, canteen refilled.</small>';
    document.body.append(this.vignette, this.root, this.prompt, this.toastEl, this.death);

    addEventListener('keydown', (e) => {
      if (e.repeat || !/^Digit[1-9]$/.test(e.code)) return;
      const n = Number(e.code.slice(5)) - 1;
      if (n >= SLOTS) return;
      this.select(this.selected === n ? -1 : n);
    });
    net.onDied = () => {
      this.deadUntil = performance.now() + DEATH_MS;
      this.cancel();
      this.shown = 0;
    };
    this.select(-1);
  }

  private select(slot: number) {
    if (slot !== this.selected) this.cancel();
    this.selected = slot;
    playerHands.held = slot === 0 ? 'canteen' : slot === 1 ? 'binoculars' : 'none';
    this.slots.forEach((s, i) => s.classList.toggle('sel', i === slot));
  }

  private cancel() {
    playerHands.drinking = playerHands.filling = false;
  }

  private toast(text: string) {
    this.toastEl.textContent = text;
    this.toastEl.style.opacity = '1';
    this.toastUntil = performance.now() + TOAST_MS;
  }

  /**
   * Every render frame. `pos` is the predicted player position, `scrapTargeted` whether the scrap prompt
   * owns the crosshair (and F), `interact` a fresh F press that scrap pickup didn't take.
   */
  update(dt: number, pos: { x: number; y: number; z: number }, scrapTargeted: boolean, interact: boolean) {
    const now = performance.now();
    const w = this.net.water;
    const dead = now < this.deadUntil;
    const holding = playerHands.held === 'canteen';
    const atBase = atPump(pos.x, pos.y, pos.z);
    tools.blocked = playerHands.held !== 'none';

    // Drinking: hold the use button for DRINK_MS; letting go early spills nothing and costs nothing.
    const use = useHeld();
    if (!use) this.needRelease = false;
    if (playerHands.drinking) {
      if (!use || !holding || dead) this.cancel();
      else if (now - this.actionAt >= DRINK_MS) {
        this.cancel();
        this.net.drink();
        this.needRelease = true;
      }
    } else if (holding && use && !this.needRelease && !playerHands.filling && !dead) {
      this.needRelease = true;
      if (w.sips <= 0) this.toast(atBase ? 'Canteen empty — press F to fill it' : 'Canteen empty — fill it at the pump in the base');
      else {
        playerHands.drinking = true;
        this.actionAt = now;
      }
    }

    // Refilling: one F press at the pump, takes FILL_MS; walking out or putting the canteen away cancels.
    if (playerHands.filling) {
      if (!holding || dead || !atPump(pos.x, pos.y, pos.z, FILL_CANCEL_SLACK)) this.cancel();
      else if (now - this.actionAt >= FILL_MS) {
        this.cancel();
        this.net.fill();
      }
    } else if (interact && holding && atBase && !playerHands.drinking && !dead) {
      if (w.sips >= CANTEEN_SIPS) this.toast('Canteen is already full');
      else {
        playerHands.filling = true;
        this.actionAt = now;
      }
    }

    // Prompt under the crosshair (the scrap prompt wins when a piece is targeted).
    let html = '';
    if (!scrapTargeted && holding && !dead) {
      if (playerHands.filling) html = `Filling canteen…<span class="prog"></span>`;
      else if (playerHands.drinking) html = `Drinking…<span class="prog"></span>`;
      else if (atBase) html = `<kbd>F</kbd>Fill canteen`;
      else if (w.sips <= 0) html = 'Canteen empty — fill it at the pump in the base';
    }
    if (html !== this.promptHtml) {
      this.promptHtml = html;
      this.prompt.innerHTML = html;
      this.prompt.style.display = html ? 'block' : 'none';
    }
    const prog = this.prompt.querySelector<HTMLElement>('.prog');
    if (prog) prog.style.transform = `scaleX(${Math.min(1, (now - this.actionAt) / (playerHands.filling ? FILL_MS : DRINK_MS))})`;
    if (this.toastUntil && now > this.toastUntil) {
      this.toastUntil = 0;
      this.toastEl.style.opacity = '0';
    }

    // Heat meter: ease towards the server's value (updates come at ~2 Hz while it moves); jump on sips.
    this.shown = Math.abs(w.heat - this.shown) > 10 ? w.heat : this.shown + (w.heat - this.shown) * (1 - Math.exp(-dt * 3));
    const f = Math.max(0, Math.min(1, this.shown / HEAT_MAX));
    this.fillEl.style.transform = `scaleX(${f})`;
    // Cool blue while there's little heat, warming through amber to red as it fills.
    const warm = Math.max(0, Math.min(1, (f - 0.4) / 0.6));
    const [a, b, t] = warm < 0.5 ? [BLUE, AMBER, warm * 2] : [AMBER, RED, warm * 2 - 1];
    this.fillEl.style.background = `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * t)).join(',')})`;
    const num = Math.floor(this.shown);
    if (num !== this.lastNum) {
      this.lastNum = num;
      this.numEl.textContent = String(num);
    }
    // Thermometer: ease towards the server's felt temperature, cool blue → amber → red.
    this.shownTemp = Number.isNaN(this.shownTemp) ? w.temp : this.shownTemp + (w.temp - this.shownTemp) * (1 - Math.exp(-dt * 2));
    const deg = Math.round(this.shownTemp);
    if (deg !== this.lastDeg) {
      this.lastDeg = deg;
      this.degEl.textContent = `${deg} °C`;
      const [c0, c1, k] = deg < TEMP_WARM
        ? [TEMP_BLUE, TEMP_AMBER, Math.max(0, (deg - TEMP_COOL) / (TEMP_WARM - TEMP_COOL))]
        : [TEMP_AMBER, TEMP_RED, Math.min(1, (deg - TEMP_WARM) / (TEMP_HOT - TEMP_WARM))];
      this.degEl.style.color = `rgb(${c0.map((c, i) => Math.round(c + (c1[i] - c) * k)).join(',')})`;
    }
    if (w.shade !== this.lastShade) {
      this.lastShade = w.shade;
      this.tempEl.classList.toggle('shade', w.shade);
      this.tempEl.title = w.shade ? 'Felt temperature — out of the sun' : 'Felt temperature — in direct sun';
    }
    const high = this.shown > HEAT_HIGH && !dead;
    this.thirst.classList.toggle('heat', w.rising && !dead);
    this.thirst.classList.toggle('high', high);
    this.vignette.style.opacity = high ? String(0.35 + 0.65 * (this.shown - HEAT_HIGH) / (HEAT_MAX - HEAT_HIGH)) : '0';
    this.vignette.classList.toggle('pulse', high && w.rising);
    this.pips.forEach((p, i) => p.classList.toggle('on', i < w.sips));
    this.death.style.display = dead ? 'flex' : 'none';
  }
}
