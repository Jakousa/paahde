// DOM for the disassembly mode: a full-screen overlay that takes the pointer (so clicks never reach the game
// canvas and re-capture the mouse). On it, styled like the Esc menu (src/menu.ts):
//   top panel    the machine, its rarity, steps and parts progress, Scrap (the table: click twice), Leave;
//                "3 on another side" when stuck
//   tip          next to the pointer: what is under it and a terse action ("×3", "circle"),
//                or what it waits on ("after lid screw ×4")
//   ring         radial progress drawn around the step being worked (and the guide circle for bolts)
//   tags         a label over every part that is free to take
//   message      a short line for events ("Bag full"), fading out
//   fly          "+ Motor · Quality" flying from the part to the hotbar when a part is taken
import { kbd } from '../bindings';
import { RARITY, type PartId, type Tier } from '../../shared/salvage.ts';
import { TEXT } from '../../shared/text.ts';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
export const partName = (part: PartId, tier: Tier) => TEXT.partTaken(TEXT.parts[part], RARITY[tier].name);
export const rarityColor = (tier: Tier) => hex(RARITY[tier].color);

const MSG_MS = 2600;
const RING_R = 30;
const RING_C = 2 * Math.PI * RING_R;

const css = `
#tdOverlay { position: fixed; inset: 0; z-index: 5; display: none; pointer-events: none; touch-action: none; user-select: none;
  -webkit-user-select: none; font: 12px var(--mono); color: #fff4e4; }
#tdOverlay .panel { position: absolute; background: rgba(28, 15, 7, 0.88); border-radius: 8px;
  box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.16), 0 8px 30px rgba(0, 0, 0, 0.35); }
#tdOverlay kbd { font: 600 10px var(--mono); padding: 0 4px; border-radius: 3px; background: #ffd9a0; color: #2a160a; }
#tdTop { top: 12px; left: 50%; transform: translateX(-50%); width: min(460px, calc(100vw - 32px)); padding: 10px 14px 9px; }
#tdTop .head { display: flex; align-items: baseline; gap: 10px; }
#tdTop .name { font: 600 13px var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: #ffd9a0; }
#tdTop .tier { font-weight: 600; }
#tdTop .who { opacity: 0.6; }
#tdTop button { margin-left: auto; font: 600 11px var(--mono); color: #2a160a; background: #ffd9a0; border: 0;
  border-radius: 4px; padding: 3px 8px; cursor: pointer; }
#tdTop button:hover { background: #ffe6bf; }
#tdTop .who { margin-right: auto; }
#tdTop .head button { margin-left: 0; }
#tdTop button.scrap { background: rgba(255, 240, 220, 0.12); color: #fff4e4; }
#tdTop button.scrap:hover { background: rgba(255, 240, 220, 0.22); }
#tdTop button.scrap.sure { background: #ff9c86; color: #2a160a; }
#tdTop .meters { display: grid; grid-template-columns: auto 1fr auto; gap: 4px 8px; align-items: center; margin: 9px 0 7px; }
#tdTop .meters span { opacity: 0.7; }
#tdTop .meters b { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
#tdTop .bar { height: 5px; border-radius: 3px; background: rgba(255, 240, 220, 0.12); overflow: hidden; }
#tdTop .bar i { display: block; height: 100%; width: 0; background: #ffd9a0; transition: width .25s; }
#tdTop .bar.parts i { background: var(--c, #ffd9a0); }
#tdTop .next { color: #fff4e4; }
#tdTop .next:empty, #tdTip .a:empty { display: none; }
#tdTop .next::before { content: '▸ '; color: #ffd9a0; }
#tdTip { position: absolute; padding: 5px 8px; border-radius: 5px; background: rgba(28, 15, 7, 0.92); pointer-events: none;
  box-shadow: 0 0 0 1px rgba(255, 240, 220, 0.16); white-space: nowrap; display: none; line-height: 1.5; }
#tdTip .t { font-weight: 600; }
#tdTip .a { color: #ffd9a0; }
#tdTip .a kbd { margin-right: 5px; }
#tdTip.locked .a { color: #ff9c86; }
#tdTip.locked .a::before { content: '⨯ '; }
#tdRing { position: absolute; width: ${RING_R * 2 + 12}px; height: ${RING_R * 2 + 12}px; margin: -${RING_R + 6}px 0 0 -${RING_R + 6}px;
  pointer-events: none; display: none; overflow: visible; }
#tdRing circle { fill: none; stroke-width: 5; }
#tdRing .bg { stroke: rgba(28, 15, 7, 0.55); }
#tdRing .fg { stroke: #ffd9a0; stroke-linecap: round; transform: rotate(-90deg); transform-origin: 50% 50%; transition: stroke-dashoffset .06s; }
#tdRing.guide .bg { stroke: rgba(255, 217, 160, 0.35); stroke-dasharray: 4 6; }
#tdTags div { position: absolute; transform: translate(-50%, -100%); padding: 2px 7px; border-radius: 4px; font-weight: 600;
  background: rgba(28, 15, 7, 0.88); color: var(--c); box-shadow: 0 0 0 1px var(--c); pointer-events: none; white-space: nowrap; }
#tdMsg { position: absolute; left: 50%; bottom: 120px; transform: translateX(-50%); pointer-events: none; display: flex;
  flex-direction: column; align-items: center; gap: 3px; }
#tdMsg div { font: 600 13px var(--mono); color: #ffd9a0; text-shadow: 0 1px 2px #000; animation: tdMsg ${MSG_MS}ms ease-out forwards; }
#tdMsg div.bad { color: #ff9c86; }
@keyframes tdMsg { 0% { opacity: 0; transform: translateY(6px); } 8% { opacity: 1; transform: none; } 75% { opacity: 1; } 100% { opacity: 0; } }
.tdFly { position: fixed; z-index: 6; pointer-events: none; font: 600 13px var(--mono); padding: 3px 8px; border-radius: 4px;
  background: rgba(28, 15, 7, 0.92); color: var(--c); box-shadow: 0 0 0 1px var(--c); white-space: nowrap;
  transform: translate(-50%, -50%); transition: left .75s cubic-bezier(.5,0,.8,.4), top .75s cubic-bezier(.4,-0.6,.8,.6), opacity .75s ease-in, scale .75s; }
`;

export interface Progress {
  label: string;
  tier: Tier;
  stepsDone: number;
  steps: number;
  partsTaken: number;
  parts: number;
  /** Large sites: shared with others. */
  shared: boolean;
}

export class TeardownUi {
  readonly overlay = document.createElement('div');
  private top: HTMLElement;
  private tipEl: HTMLElement;
  private ringEl: SVGSVGElement;
  private tagsEl: HTMLElement;
  private msgEl: HTMLElement;
  private nextEl: HTMLElement;
  private tagPool: HTMLElement[] = [];
  private lastTip = '';
  private lastNext = '';

  private scrapEl: HTMLButtonElement;
  private sureTimer = 0;

  constructor() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);

    const o = this.overlay;
    o.id = 'tdOverlay';
    o.innerHTML = `<div id="tdTags"></div>
<svg id="tdRing" viewBox="0 0 ${RING_R * 2 + 12} ${RING_R * 2 + 12}"><circle class="bg" cx="${RING_R + 6}" cy="${RING_R + 6}" r="${RING_R}"/><circle class="fg" cx="${RING_R + 6}" cy="${RING_R + 6}" r="${RING_R}" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"/></svg>
<div class="panel" id="tdTop">
  <div class="head"><span class="name"></span><span class="tier"></span><span class="who"></span><button class="scrap">${TEXT.teardown.scrap}</button><button class="leave">${kbd('interact')}</button></div>
  <div class="meters"><span>${TEXT.teardown.steps}</span><div class="bar steps"><i></i></div><b class="ns"></b><span>${TEXT.teardown.parts}</span><div class="bar parts"><i></i></div><b class="np"></b></div>
  <div class="next"></div>
</div>
<div id="tdTip"><div class="t"></div><div class="a"></div></div>
<div id="tdMsg"></div>`;
    document.body.append(o);
    this.top = o.querySelector('#tdTop')!;
    this.tipEl = o.querySelector('#tdTip')!;
    this.ringEl = o.querySelector('#tdRing')!;
    this.tagsEl = o.querySelector('#tdTags')!;
    this.msgEl = o.querySelector('#tdMsg')!;
    this.nextEl = this.top.querySelector('.next')!;
    // Scrapping throws the machine away: the first click asks, a second within a few seconds does it.
    this.scrapEl = this.top.querySelector('.scrap')!;
    this.setPhase('off');
  }

  /** 'walk': the character is walking up, nothing shows yet. 'work': all of it. */
  setPhase(phase: 'off' | 'work') {
    this.overlay.style.display = phase === 'off' ? 'none' : 'block';
    this.top.style.display = 'none'; // the machine and the world say how far along it is
    if (phase !== 'work') {
      this.tip(null);
      this.ring(null);
      this.tags([]);
    }
  }

  /** Whether the Scrap button shows (the table's machine can be scrapped whole). */
  setScrap(on: boolean) {
    clearTimeout(this.sureTimer);
    this.scrapEl.classList.remove('sure');
    this.scrapEl.textContent = TEXT.teardown.scrap;
    this.scrapEl.style.display = on ? '' : 'none';
  }

  setProgress(p: Progress) {
    const t = this.top;
    t.querySelector('.name')!.textContent = p.label;
    const tier = t.querySelector<HTMLElement>('.tier')!;
    tier.textContent = RARITY[p.tier].name;
    tier.style.color = rarityColor(p.tier);
    t.querySelector('.who')!.textContent = p.shared ? TEXT.teardown.shared : '';
    t.querySelector<HTMLElement>('.steps i')!.style.width = `${p.steps ? (100 * p.stepsDone) / p.steps : 100}%`;
    t.querySelector<HTMLElement>('.parts i')!.style.width = `${p.parts ? (100 * p.partsTaken) / p.parts : 100}%`;
    t.querySelector<HTMLElement>('.bar.parts')!.style.setProperty('--c', rarityColor(p.tier));
    t.querySelector('.ns')!.textContent = `${p.stepsDone}/${p.steps}`;
    t.querySelector('.np')!.textContent = `${p.partsTaken}/${p.parts}`;
  }

  /** The "what to do next" line. */
  setNext(text: string) {
    if (text === this.lastNext) return;
    this.lastNext = text;
    this.nextEl.textContent = text;
  }

  /** The tip by the pointer at (x, y), or hidden with null. `action` may hold one <kbd>. */
  tip(t: { x: number; y: number; title: string; action: string; locked?: boolean; color?: string } | null) {
    const el = this.tipEl;
    if (!t) {
      el.style.display = 'none';
      this.lastTip = '';
      return;
    }
    const key = `${t.title}|${t.action}|${t.locked}|${t.color}`;
    if (key !== this.lastTip) {
      this.lastTip = key;
      el.classList.toggle('locked', !!t.locked);
      const title = el.querySelector<HTMLElement>('.t')!;
      title.textContent = t.title;
      title.style.color = t.color ?? '';
      el.querySelector('.a')!.innerHTML = t.action;
    }
    el.style.display = 'block';
    // Beside the pointer, flipped to stay on screen.
    const w = el.offsetWidth, h = el.offsetHeight;
    const x = t.x + 18 + w > innerWidth - 8 ? t.x - 14 - w : t.x + 18;
    const y = t.y + 18 + h > innerHeight - 8 ? t.y - 12 - h : t.y + 18;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  /** Radial progress at (x, y), 0..1; `guide` draws the dashed circle to follow (bolts). Null hides it. */
  ring(r: { x: number; y: number; f: number; guide?: boolean } | null) {
    const el = this.ringEl;
    if (!r) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    el.style.left = `${r.x}px`;
    el.style.top = `${r.y}px`;
    el.classList.toggle('guide', !!r.guide);
    el.style.scale = r.guide ? '1.5' : '1'; // the bolt guide matches the circle to draw
    el.querySelector<SVGCircleElement>('.fg')!.style.strokeDashoffset = `${RING_C * (1 - Math.min(1, Math.max(0, r.f)))}`;
  }

  /** Labels over the parts that are free to take. */
  tags(list: { x: number; y: number; text: string; color: string }[]) {
    while (this.tagPool.length < list.length) {
      const d = document.createElement('div');
      this.tagsEl.append(d);
      this.tagPool.push(d);
    }
    this.tagPool.forEach((d, i) => {
      const t = list[i];
      d.style.display = t ? 'block' : 'none';
      if (!t) return;
      if (d.textContent !== t.text) d.textContent = t.text;
      d.style.setProperty('--c', t.color);
      d.style.left = `${t.x}px`;
      d.style.top = `${t.y}px`;
    });
  }

  /** A short line that fades out; `bad` for refusals. */
  message(text: string, bad = false) {
    if (!text) return;
    // The same line again just restarts.
    for (const d of this.msgEl.children) if (d.textContent === text) d.remove();
    const el = document.createElement('div');
    el.textContent = text;
    if (bad) el.className = 'bad';
    this.msgEl.append(el);
    while (this.msgEl.children.length > 3) this.msgEl.firstElementChild!.remove();
    setTimeout(() => el.remove(), MSG_MS);
  }

  /** "+ Motor · Quality" flies from (x, y) down to the hotbar (src/water.ts), where the bag is. */
  fly(x: number, y: number, part: PartId, tier: Tier) {
    const el = document.createElement('div');
    el.className = 'tdFly';
    el.textContent = `+ ${partName(part, tier)}`;
    el.style.setProperty('--c', rarityColor(tier));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    document.body.append(el);
    const bar = document.getElementById('hotbar')?.getBoundingClientRect();
    const tx = bar && bar.width ? bar.left + bar.width / 2 : innerWidth / 2;
    const ty = bar && bar.height ? bar.top + bar.height / 2 : innerHeight - 30;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.left = `${tx}px`;
      el.style.top = `${ty}px`;
      el.style.opacity = '0.15';
      el.style.scale = '0.7';
    }));
    setTimeout(() => el.remove(), 900);
  }
}
