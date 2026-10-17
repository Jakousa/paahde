// Survival on the client (shared/water.ts, server/water.ts): the hotbar (the bag's first slots,
// shared/items.ts: the water bottle, telescope (src/telescope.ts), shovel and metal detector (src/detector.ts),
// all found broken and repaired, shared/gear.ts), drinking and refilling, and the HUD: the body heat meter
// (bottom left, glowing while heat builds), the clock and felt temperature with a sun/shade icon (top right,
// shared/temperature.ts; only with the wrist computer equipped), a heat vignette when it's nearly full, and the
// death screen.
//
// The server owns the numbers; this only plays the actions and asks. Keys 1–4 take out what's in that
// hotbar slot or put it away; items can be rearranged in the Tab inventory (src/inventory.ts). With it out, holding left mouse / E for DRINK_MS drinks one sip
// (no digging while your hands are full, see `tools` in src/input.ts), and F at the base's pump refills it.
import { atPump } from '../shared/base.ts';
import { DRINK_MS, FILL_MS, HEAT_HIGH, HEAT_MAX } from '../shared/water.ts';
import { equipped, repaired } from '../shared/gear.ts';
import { HOTBAR } from '../shared/items.ts';
import { isPlaceable } from '../shared/placed.ts';
import { tools, useHeld } from './input';
import { itemIcon, itemLabel } from './inventory';
import type { Net } from './net';
import type { DeathCause } from '../shared/protocol.ts';
import { DOWN_MS } from '../shared/ragdoll.ts';

/**
 * What the first-person hands are doing, for the viewmodel (src/viewmodel.ts). `drinking` / `filling`
 * are true for the whole sip / refill action. Digging is the DIG input bit, as before.
 */
export type Held = 'none' | 'canteen' | 'telescope';
/** `looking`: spyglass being raised or at the eye; `scoped`: at the eye, view zoomed (hands hidden).
 *  `tool`: a hand tool with no viewmodel of its own (the hands stay empty): the metal detector or the shovel. */
export const playerHands = {
  held: 'none' as Held, tool: 'none' as 'none' | 'shovel' | 'detector', drinking: false, filling: false, looking: false, scoped: false,
};

/** Heat meter colours: cool, warming up, nearly heatstroke. */
const BLUE = [78, 170, 255];
const AMBER = [236, 158, 52];
const RED = [222, 62, 34];
/** Thermometer colours by felt °C: cool blue up to TEMP_COOL, amber at TEMP_WARM, red from TEMP_HOT. */
const TEMP_BLUE = [120, 196, 255];
const TEMP_AMBER = [255, 184, 77];
const TEMP_RED = [255, 92, 60];
const TEMP_COOL = 18, TEMP_WARM = 34, TEMP_HOT = 50;
const DEATH_TEXT: Record<DeathCause, string> = {
  heat: 'You died of heatstroke<small>The sun got you. Back at the base, water bottle refilled.</small>',
  guardian: 'A guardian crushed you<small>It walked right over you. Keep your distance from the giants.</small>',
  crawler: 'Eaten by crawlers<small>The little ones swarm the crash sites. Sprint — they can\'t keep up.</small>',
  missile: 'Shelled<small>A drone had you in its light and called the guardians\' missiles down. Keep moving, get out of the beam.</small>',
  laser: 'Shot by a guardian<small>Its cannon found you. Dodge the bolts, or break its line of sight.</small>',
};
const TOAST_MS = 1800;
/** Walking this far (m) out of the pump's reach cancels a refill. Under the server's FILL_SLACK. */
const FILL_CANCEL_SLACK = 0.5;

const css = `
#survival { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); pointer-events: none;
  font: 12px var(--mono); color: #fff4e4; }
#heat { position: fixed; left: 16px; bottom: 16px; width: 230px; padding: 8px 10px 9px; border-radius: 6px;
  pointer-events: none; font: 12px var(--mono); color: #fff4e4; background: rgba(20, 10, 5, 0.5);
  box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.15); }
#heat .head { display: flex; align-items: center; gap: 6px; }
#heat .icon { width: 14px; height: 14px; opacity: 0.6; transition: opacity .4s, filter .4s; }
#heat.rising .icon { opacity: 1; filter: drop-shadow(0 0 3px #ffb347) drop-shadow(0 0 6px #ff7a1a); }
#heat .label { flex: 1; font-weight: 600; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; opacity: 0.8; }
#heat .trend { width: 10px; font-size: 9px; text-align: center; }
#heat .num { width: 40px; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
#heat .bar { position: relative; height: 10px; margin-top: 6px; border-radius: 2px; overflow: hidden;
  background: rgba(255, 244, 228, 0.1); }
/* Danger zone (HEAT_HIGH and up): hatched red at the end of the track. */
#heat .bar::before { content: ''; position: absolute; top: 0; bottom: 0; right: 0; width: 20%;
  background: repeating-linear-gradient(-45deg, rgba(222, 62, 34, 0.35) 0 3px, rgba(222, 62, 34, 0.12) 3px 6px); }
#heat .fill { position: absolute; inset: 0; transform-origin: left; }
/* Ten segments, like a thermometer scale. */
#heat .bar::after { content: ''; position: absolute; inset: 0;
  background: repeating-linear-gradient(90deg, transparent 0 calc(10% - 1px), rgba(20, 10, 5, 0.7) calc(10% - 1px) 10%); }
#heat.high { animation: heatGlow 1.1s ease-in-out infinite; }
@keyframes heatGlow { 0%, 100% { box-shadow: 0 0 0 1px rgba(255, 90, 40, 0.3); }
  50% { box-shadow: 0 0 0 2px rgba(255, 90, 40, 0.85); } }
#env { position: fixed; top: 12px; right: 12px; display: flex; align-items: center; gap: 10px; padding: 6px 11px;
  border-radius: 6px; pointer-events: none; font: 600 14px var(--mono); color: #fff4e4; background: rgba(20, 10, 5, 0.5);
  box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.15); font-variant-numeric: tabular-nums; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6); }
#env .temp { display: flex; align-items: center; gap: 5px; padding-left: 10px; border-left: 1px solid rgba(255, 240, 220, 0.15); }
#env .temp svg { width: 16px; height: 16px; }
#env .temp .shadeIcon, #env .temp.shade .sunIcon { display: none; }
#env .temp.shade .shadeIcon { display: block; }
#env .deg { min-width: 44px; transition: color .6s; }
#hotbar { display: flex; gap: 4px; }
#hotbar .slot { position: relative; width: 44px; height: 44px; border-radius: 6px; background: rgba(20, 10, 5, 0.45);
  box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.15); display: flex; align-items: center; justify-content: center; }
#hotbar .slot.sel { background: rgba(60, 34, 16, 0.6); box-shadow: 0 0 0 2px rgba(255, 233, 204, 0.75); }
#hotbar .slot.broken svg { opacity: 0.45; filter: grayscale(0.8); }
#hotbar .key { position: absolute; left: 4px; top: 2px; font: 600 9px var(--mono); opacity: 0.6; }
#hotbar svg { width: 22px; height: 26px; margin-top: -4px; }
#hotbar img { width: 36px; height: 36px; margin-top: -2px; }
#hotbar .pips { position: absolute; bottom: 4px; left: 6px; right: 6px; display: flex; gap: 2px; }
#hotbar .pips i { flex: 1; height: 3px; border-radius: 1px; background: rgba(255, 244, 228, 0.18); }
#hotbar .pips i.on { background: #5cb8ff; }
#hotbar .n { position: absolute; right: 4px; bottom: 2px; font: 600 10px var(--mono); text-shadow: 0 1px 2px #000; }
#waterPrompt { position: fixed; left: 50%; top: calc(50% + 22px); transform: translateX(-50%); padding: 3px 8px;
  font: 13px var(--mono); color: #fff4e4; background: rgba(20, 10, 5, 0.55); border-radius: 4px;
  pointer-events: none; white-space: nowrap; display: none; }
#waterPrompt kbd { font: bold 11px var(--mono); padding: 0 4px; margin-right: 6px; border-radius: 3px;
  background: #fff4e4; color: #2a160a; }
#waterPrompt .prog { display: block; height: 2px; margin-top: 3px; background: #5cb8ff; transform-origin: left; }
#waterToast { position: fixed; left: 50%; top: calc(50% + 52px); transform: translateX(-50%); pointer-events: none;
  font: 600 13px var(--mono); color: #ffd9a0; text-shadow: 0 1px 2px #000; opacity: 0;
  transition: opacity .25s; white-space: nowrap; }
#heatVignette { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity .6s;
  box-shadow: inset 0 0 18vmin 4vmin rgba(150, 30, 0, 0.75);
  background: radial-gradient(ellipse closest-side, rgba(0, 0, 0, 0) 70%, rgba(170, 45, 10, 0.3) 100%); }
#heatVignette.pulse { animation: heatPulse 1.6s ease-in-out infinite; }
@keyframes heatPulse { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.6); } }
#deathScreen { position: fixed; inset: 0; z-index: 20; pointer-events: none; display: none; flex-direction: column;
  align-items: center; justify-content: flex-start; padding-top: 14vh; gap: 10px; background: radial-gradient(ellipse
  closest-side, rgba(40, 8, 2, 0) 55%, rgba(40, 8, 2, 0.75) 100%); color: #ffe2c4; font: 600 34px var(--mono);
  letter-spacing: 0.04em; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.8); animation: deathIn 0.6s ease-out; }
#deathScreen small { font: 13px var(--mono); letter-spacing: 0.02em; opacity: 0.7; }
@keyframes deathIn { from { opacity: 0; } to { opacity: 1; } }
`;

/** Thermometer for the body heat meter. */
const THERMO_SVG = `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="#ffc46b" stroke-width="1.4" stroke-linecap="round">
<path d="M6.2 9.4V3a1.8 1.8 0 0 1 3.6 0v6.4a3.4 3.4 0 1 1-3.6 0z"/><circle cx="8" cy="12.2" r="1.7" fill="#ff7a3a" stroke="none"/>
<path d="M8 11V5.5" stroke="#ff7a3a" stroke-width="1.6"/><path d="M11.8 4h1.6M11.8 6.5h1.6" stroke-width="1.1"/></svg>`;
/** Direct sun, and shade (the sun behind a dune). */
const SUN_ICON = `<svg class="sunIcon" viewBox="0 0 16 16" fill="none" stroke="#ffc46b" stroke-width="1.6" stroke-linecap="round">
<circle cx="8" cy="8" r="3" fill="#ffc46b"/><path d="M8 1.2v1.5M8 13.3v1.5M1.2 8h1.5M13.3 8h1.5M3.2 3.2l1 1M11.8 11.8l1 1M3.2 12.8l1-1M11.8 4.2l1-1"/></svg>`;
const SHADE_ICON = `<svg class="shadeIcon" viewBox="0 0 16 16"><title>In shade</title>
<circle cx="10" cy="6.5" r="3" fill="#ffc46b" opacity="0.45"/><path d="M10 1.4v1.3M14.6 6.5h-1.3M13.3 3.2l-.9.9M6.7 3.2l.9.9" stroke="#ffc46b" stroke-width="1.4" stroke-linecap="round" opacity="0.45"/>
<path d="M0.5 14.5C3 8.5 6 7 9 8.6c2.2 1.2 4.4 3.6 6.5 5.9z" fill="#7a5a3e" stroke="#2a160a" stroke-width="0.8"/></svg>`;
export class Survival {
  private net: Net;
  private root = document.createElement('div');
  private heat = document.createElement('div');
  private env = document.createElement('div');
  private fillEl!: HTMLElement;
  private numEl!: HTMLElement;
  private trendEl!: HTMLElement;
  private clockEl!: HTMLElement;
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
  private lastTrend = '';
  private lastClock = '';
  private shownTemp = NaN; // eased felt temperature
  private lastDeg = NaN;
  private lastShade: boolean | null = null;

  constructor(net: Net) {
    this.net = net;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    this.root.id = 'survival';
    this.heat.id = 'heat';
    this.heat.innerHTML = `<div class="head">${THERMO_SVG}<span class="label">Heat</span><span class="trend"></span>`
      + `<span class="num"></span></div><div class="bar"><div class="fill"></div></div>`;
    this.env.id = 'env';
    this.env.innerHTML = `<span class="clock" title="Time of day"></span>`
      + `<span class="temp" title="Felt temperature">${SUN_ICON}${SHADE_ICON}<span class="deg"></span></span>`;
    this.fillEl = this.heat.querySelector('.fill')!;
    this.numEl = this.heat.querySelector('.num')!;
    this.trendEl = this.heat.querySelector('.trend')!;
    this.clockEl = this.env.querySelector('.clock')!;
    this.tempEl = this.env.querySelector('.temp')!;
    this.degEl = this.env.querySelector('.deg')!;
    const hotbar = document.createElement('div');
    hotbar.id = 'hotbar';
    for (let i = 0; i < HOTBAR; i++) {
      const s = document.createElement('div');
      s.className = 'slot';
      this.slots.push(s);
      hotbar.append(s);
    }
    this.root.append(hotbar);
    this.prompt.id = 'waterPrompt';
    this.toastEl.id = 'waterToast';
    this.vignette.id = 'heatVignette';
    this.death.id = 'deathScreen';
    this.death.innerHTML = DEATH_TEXT.heat;
    document.body.append(this.vignette, this.root, this.heat, this.env, this.prompt, this.toastEl, this.death);

    addEventListener('keydown', (e) => {
      if (e.repeat || !/^Digit[1-9]$/.test(e.code)) return;
      const n = Number(e.code.slice(5)) - 1;
      if (n >= HOTBAR) return;
      this.select(this.selected === n ? -1 : n);
    });
    net.onDied = (cause) => {
      this.death.innerHTML = DEATH_TEXT[cause];
      this.deadUntil = performance.now() + DOWN_MS;
      this.cancel();
      this.shown = 0;
    };
    this.select(-1);
  }

  /** The selected hotbar slot, -1 for empty hands. */
  get slot() {
    return this.selected;
  }

  private select(slot: number) {
    if (slot !== this.selected) this.cancel();
    this.selected = slot;
    tools.slot = slot;
    this.slots.forEach((s, i) => s.classList.toggle('sel', i === slot));
    this.hold();
  }

  /** Hands follow the item in the selected slot, also when it's moved away in the inventory. */
  private hold() {
    const it = this.net.boxes.bag?.[this.selected];
    const kind = it?.kind;
    // A broken telescope is just junk in the hand; a broken bottle still shows (it holds no water).
    const held = kind === 'canteen' ? 'canteen' : kind === 'spyglass' && repaired(it) ? 'telescope' : 'none';
    if (held !== playerHands.held) this.cancel();
    playerHands.held = held;
    playerHands.tool = repaired(it) && (kind === 'shovel' || kind === 'metal_detector') ? (kind === 'shovel' ? 'shovel' : 'detector') : 'none';
  }

  /** Redraw the hotbar slots whose item changed. */
  private drawHotbar() {
    const bag = this.net.boxes.bag;
    let changed = false;
    this.slots.forEach((s, i) => {
      const it = bag?.[i];
      const max = this.net.water.maxSips;
      const broken = !!it?.parts && !repaired(it);
      const sig = it ? `${it.kind}:${it.n}:${broken}:${max}` : '';
      if (s.dataset.sig === sig) return;
      changed = true;
      s.dataset.sig = sig;
      s.classList.toggle('broken', broken);
      s.title = !it ? '' : broken ? `${itemLabel(it.kind)} (broken)`
        : itemLabel(it.kind);
      s.innerHTML = `<span class="key">${i + 1}</span>${it ? itemIcon(it.kind) : ''}`
        + (it?.kind === 'canteen' && !broken ? `<div class="pips">${'<i></i>'.repeat(max)}</div>` : it && it.n > 1 ? `<span class="n">${it.n}</span>` : '');
    });
    if (changed) this.pips = [...this.root.querySelectorAll<HTMLElement>('#hotbar .pips i')];
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
   * owns the crosshair (and F), `interact` a fresh F press that scrap pickup didn't take, `clock` the time of day.
   */
  update(dt: number, pos: { x: number; y: number; z: number }, scrapTargeted: boolean, interact: boolean, clock: string) {
    const now = performance.now();
    if (clock !== this.lastClock) this.clockEl.textContent = this.lastClock = clock;
    const w = this.net.water;
    const dead = now < this.deadUntil;
    this.hold();
    this.drawHotbar();
    // The clock and thermometer come with the wrist computer.
    this.env.style.display = equipped(this.net.boxes.equip, 'wrist') ? '' : 'none';
    const holding = playerHands.held === 'canteen';
    const bottle = w.maxSips > 0;
    const atBase = atPump(pos.x, pos.y, pos.z);
    // A placeable in hand (src/placing.ts) takes the use button too.
    tools.blocked = playerHands.held !== 'none' || isPlaceable(this.net.boxes.bag?.[this.selected]?.kind);

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
      if (!bottle) this.toast('Broken');
      else if (w.sips <= 0) this.toast('Empty');
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
    } else if (interact && holding && bottle && atBase && !playerHands.drinking && !dead) {
      if (w.sips >= w.maxSips) this.toast('Full');
      else {
        playerHands.filling = true;
        this.actionAt = now;
      }
    }

    // Prompt under the crosshair (the scrap prompt wins when a piece is targeted).
    let html = '';
    if (!scrapTargeted && holding && !dead) {
      if (!bottle) html = 'Broken';
      else if (playerHands.filling) html = `<span class="prog"></span>`;
      else if (playerHands.drinking) html = `<span class="prog"></span>`;
      else if (atBase) html = `<kbd>F</kbd>Fill`;
      else if (w.sips <= 0) html = 'Empty';
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

    // Heat meter: ease towards the server's value (updates come at ~2 Hz while it moves). A sip drains
    // it visibly over about a second; only a big jump up (joining with saved heat) snaps.
    const drop = this.shown - w.heat;
    this.shown = drop < -10 ? w.heat : this.shown + (w.heat - this.shown) * (1 - Math.exp(-dt * (drop > 10 ? 4 : 3)));
    const f = Math.max(0, Math.min(1, this.shown / HEAT_MAX));
    this.fillEl.style.transform = `scaleX(${f})`;
    // Cool blue while there's little heat, warming through amber to red as it fills.
    const warm = Math.max(0, Math.min(1, (f - 0.4) / 0.6));
    const [a, b, t] = warm < 0.5 ? [BLUE, AMBER, warm * 2] : [AMBER, RED, warm * 2 - 1];
    this.fillEl.style.background = `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * t)).join(',')})`;
    const num = Math.floor(this.shown);
    if (num !== this.lastNum) {
      this.lastNum = num;
      this.numEl.textContent = `${num}%`;
    }
    // Thermometer: ease towards the server's felt temperature, cool blue → amber → red.
    this.shownTemp = Number.isNaN(this.shownTemp) ? w.temp : this.shownTemp + (w.temp - this.shownTemp) * (1 - Math.exp(-dt * 2));
    const deg = Math.round(this.shownTemp);
    if (deg !== this.lastDeg) {
      this.lastDeg = deg;
      this.degEl.textContent = `${deg}°C`;
      const [c0, c1, k] = deg < TEMP_WARM
        ? [TEMP_BLUE, TEMP_AMBER, Math.max(0, (deg - TEMP_COOL) / (TEMP_WARM - TEMP_COOL))]
        : [TEMP_AMBER, TEMP_RED, Math.min(1, (deg - TEMP_WARM) / (TEMP_HOT - TEMP_WARM))];
      this.degEl.style.color = `rgb(${c0.map((c, i) => Math.round(c + (c1[i] - c) * k)).join(',')})`;
    }
    if (w.shade !== this.lastShade) {
      this.lastShade = w.shade;
      this.tempEl.classList.toggle('shade', w.shade);
      this.tempEl.title = w.shade ? 'Shade' : 'Sun';
    }
    const high = this.shown > HEAT_HIGH && !dead;
    this.heat.classList.toggle('rising', w.rising && !dead);
    this.heat.classList.toggle('high', high);
    // ▲ red while heat builds, ▼ blue while it drains.
    const trend = dead ? '' : w.rising ? 'up' : this.shown >= 1 ? 'down' : '';
    if (trend !== this.lastTrend) {
      this.lastTrend = trend;
      this.trendEl.textContent = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '';
      this.trendEl.style.color = trend === 'up' ? '#ff7a4a' : '#7cc4ff';
      this.heat.title = 'Heat: collapse at 100%';
    }
    this.vignette.style.opacity = high ? String(0.35 + 0.65 * (this.shown - HEAT_HIGH) / (HEAT_MAX - HEAT_HIGH)) : '0';
    this.vignette.classList.toggle('pulse', high && w.rising);
    this.pips.forEach((p, i) => p.classList.toggle('on', i < w.sips));
    this.death.style.display = dead ? 'flex' : 'none';
  }
}
