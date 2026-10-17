// DOM for the disassembly mode: a full-screen overlay that takes the pointer (so clicks never reach the game
// canvas and re-capture the mouse), an info card, a leave button and the parts tray. The tray keeps what you
// have taken apart so far (kept in this browser only for now).
import { RARITY, type PartId, type Tier } from '../../shared/salvage.ts';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const NAMES: Record<PartId, string> = {
  battery: 'Battery', motor: 'Motor', heatsink: 'Heatsink', compute: 'Compute unit', antimatter: 'Antimatter cell', coil: 'Coil',
  impeller: 'Impeller', bearing: 'Bearing', gear: 'Gear', valve: 'Valve', relay: 'Relay',
};
const STORE_KEY = 'dadajam.tray';
const KEYS_SMALL = 'Left: click screws &amp; clips, circle big bolts, swipe wires, drag pry tabs · Right-drag: carry a freed part to the tray, or move the machine · Middle-drag / arrows: turn it over (R resets) · W S A D: step closer, further, around · Check every side · Esc: leave';
const KEYS_LARGE = 'Left: click screws &amp; clips, circle big bolts, swipe wires, drag pry tabs, hold lifting eyes (two players) · Right-drag: carry a freed part to the tray · W S A D: closer, further, around it (too heavy to turn) · Middle-drag: look around (R recentres) · Walk too far to leave · Esc: leave';

export class TeardownUi {
  readonly overlay = document.createElement('div');
  private tray: HTMLElement;
  private trayList: HTMLElement;
  private card: HTMLElement;
  private hint: HTMLElement;
  private bar: HTMLElement;
  private counts = new Map<string, number>();

  constructor(onLeave: () => void) {
    const style = document.createElement('style');
    style.textContent = `
#tdOverlay { position: fixed; inset: 0; z-index: 5; display: none; touch-action: none; user-select: none;
  font: 12px system-ui, sans-serif; color: #ffe9cc; }
#tdOverlay .panel { position: absolute; background: rgba(20, 10, 5, 0.82); border-radius: 8px; padding: 10px 12px;
  box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.18); }
#tdOverlay h4 { margin: 0 0 8px; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; opacity: .7; }
#tdBar { top: 12px; left: 50%; transform: translateX(-50%); display: flex; gap: 10px; align-items: center; }
#tdBar button { font: inherit; color: inherit; background: rgba(255, 233, 204, 0.12); border: 0; border-radius: 4px;
  padding: 5px 9px; cursor: pointer; }
#tdBar button:hover { background: rgba(255, 233, 204, 0.25); }
#tdCard { top: 48px; left: 12px; min-width: 190px; line-height: 1.5; }
#tdCard b { font-size: 14px; }
#tdTray { top: 12px; right: 12px; bottom: 12px; width: 200px; display: flex; flex-direction: column;
  outline: 2px dashed transparent; transition: outline-color .12s, background .12s; }
#tdTray.over { outline-color: #ffd9a0; background: rgba(70, 36, 16, 0.9); }
#tdList { overflow-y: auto; flex: 1; }
#tdList .empty { opacity: .55; line-height: 1.4; }
#tdList .row { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; padding: 4px; border-radius: 6px;
  background: rgba(255, 233, 204, 0.07); border-left: 3px solid var(--c); }
#tdList img, #tdList .tile { width: 36px; height: 36px; flex: none; }
#tdList .tile { display: grid; place-items: center; font: 700 16px system-ui, sans-serif; color: var(--c);
  background: rgba(255, 233, 204, 0.1); border-radius: 4px; }
#tdList .t { font-size: 11px; color: var(--c); }
#tdList .n { margin-left: auto; font-size: 14px; font-weight: 600; }
#tdHint { bottom: 12px; left: 50%; transform: translateX(-50%); text-align: center; line-height: 1.5; max-width: 62vw; pointer-events: none; }
#tdHint .now { font-size: 14px; color: #fff4e4; min-height: 1.2em; }
#tdHint .keys { opacity: .65; }`;
    document.head.append(style);

    const o = this.overlay;
    o.id = 'tdOverlay';
    o.innerHTML = `<div class="panel" id="tdBar"><span id="tdTitle"></span><button id="tdLeave">Leave (Esc)</button></div>
<div class="panel" id="tdCard"></div>
<div class="panel" id="tdTray"><h4>Parts tray</h4><div id="tdList"></div></div>
<div class="panel" id="tdHint"><div class="now"></div><div class="keys">Left: click screws &amp; clips, circle big bolts, swipe wires, drag pry tabs, hold lifting eyes · Right-drag: carry a freed part to the tray · Middle-drag / arrows: turn the machine over (R resets) · Check every side · Esc: leave</div></div>`;
    document.body.append(o);
    this.tray = o.querySelector('#tdTray')!;
    this.trayList = o.querySelector('#tdList')!;
    this.card = o.querySelector('#tdCard')!;
    this.hint = o.querySelector('#tdHint')!;
    this.bar = o.querySelector('#tdBar')!;
    o.querySelector('#tdLeave')!.addEventListener('click', onLeave);

    try {
      for (const [k, n] of Object.entries(JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, number>)) if (n > 0) this.counts.set(k, n);
    } catch {}
    this.setPhase('off', '');
    this.renderTray();
  }

  /** 'walk': the character is walking up, only a hint shows. 'work': all the panels. */
  setPhase(phase: 'off' | 'walk' | 'work', label: string, movable = true) {
    this.overlay.style.display = phase === 'off' ? 'none' : 'block';
    const work = phase === 'work';
    for (const el of [this.tray, this.card]) el.style.display = work ? '' : 'none';
    const keys = this.hint.querySelector<HTMLElement>('.keys')!;
    keys.style.display = work ? '' : 'none';
    keys.innerHTML = movable ? KEYS_SMALL : KEYS_LARGE;
    this.bar.querySelector('#tdTitle')!.textContent = work ? label : '';
    if (phase === 'walk') this.setHint(`Walking up to the ${label.toLowerCase()}…`);
  }

  /** The tray's screen rect, for dropping parts on it. */
  trayRect() {
    return this.tray.getBoundingClientRect();
  }
  trayHot(on: boolean) {
    this.tray.classList.toggle('over', on);
  }

  setHint(text: string) {
    this.hint.querySelector('.now')!.textContent = text;
  }

  setCard(label: string, tier: Tier, left: number, total: number, steps: number, shared: boolean) {
    const r = RARITY[tier];
    this.card.innerHTML = `<h4>${shared ? 'Shared site' : 'On the bench'}</h4><b>${label}</b><br><span style="color:${hex(r.color)}">${r.name}</span> · parts left ${left}/${total}<br>steps left ${steps}${shared ? '<br>others here can help' : ''}`;
  }

  addItem(part: PartId, tier: Tier) {
    const k = `${part}_${tier}`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(this.counts)));
    } catch {}
    this.renderTray();
  }

  private renderTray() {
    if (!this.counts.size) {
      this.trayList.innerHTML = '<div class="empty">Open it up, free a part, then right-drag it in here.</div>';
      return;
    }
    // Best first.
    const rows = [...this.counts].sort((a, b) => tierOf(b[0]) - tierOf(a[0]));
    this.trayList.innerHTML = rows
      .map(([k, n]) => {
        const [part, tier] = k.split('_') as [PartId, Tier];
        const r = RARITY[tier];
        // Icons exist for the Blender-modelled items; the code-built parts get a lettered tile.
        const icon = `<img src="./icons/items/${k}.png" alt="" onerror="this.outerHTML='<div class=&quot;tile&quot;>${NAMES[part][0]}</div>'">`;
        return `<div class="row" style="--c:${hex(r.color)}">${icon}<div>${NAMES[part]}<div class="t">${r.name}</div></div><span class="n">×${n}</span></div>`;
      })
      .join('');
  }
}

const ORDER = ['scrap', 'basic', 'quality', 'space'];
const tierOf = (key: string) => ORDER.indexOf(key.split('_')[1]);
