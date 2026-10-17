// Metal detector (a hotbar item, shared/gear.ts): held and repaired, it listens for loot buried in the sand
// (shared/loot.ts, depth > 0) within its range and ticks faster and higher the closer the spot you look at
// (where you'd dig) is to the nearest one, with a signal meter under the crosshair. Right over it says to dig:
// a hole as deep as the find brings it up (server/loot.ts). Client-only: the server already sends where
// everything is.
import { detectorRange } from '../shared/gear.ts';
import type { Loot } from '../shared/loot.ts';
import { audio } from './audio';

/** Tick interval (s) at the edge of the range and right on top. */
const SLOW = 1.1;
const FAST = 0.1;
/** Tick pitch (Hz) at the edge and on top, length (s) and level (under the storm pips, src/storm.ts). */
const LOW_HZ = 900;
const HIGH_HZ = 2200;
const TICK = 0.045;
const GAIN = 0.15;
/** Within this (m, horizontally) it says to dig here. */
const ON_TOP = 0.7;

const css = `
#detector { position: fixed; left: 50%; top: calc(50% + 46px); transform: translateX(-50%); pointer-events: none;
  display: none; flex-direction: column; align-items: center; gap: 3px; font: 600 11px var(--mono); color: #fff4e4;
  text-shadow: 0 1px 2px #000; }
#detector .bars { display: flex; gap: 2px; }
#detector .bars i { width: 6px; height: 10px; border-radius: 1px; background: rgba(255, 244, 228, 0.18); }
#detector .bars i.on { background: #ffd060; box-shadow: 0 0 4px rgba(255, 200, 80, 0.8); }
`;
const BARS = 8;

export class Detector {
  private el = document.createElement('div');
  private bars: HTMLElement[] = [];
  private text: HTMLElement;
  private next = 0; // seconds until the next tick

  constructor() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.el.id = 'detector';
    this.el.innerHTML = `<div class="bars">${'<i></i>'.repeat(BARS)}</div><div class="t"></div>`;
    this.bars = [...this.el.querySelectorAll<HTMLElement>('.bars i')];
    this.text = this.el.querySelector('.t')!;
    document.body.append(this.el);
  }

  /** Every frame. `quality` of the held detector (shared/gear.ts), or -1 when none is in hand; `at` the spot looked at. */
  update(dt: number, quality: number, loot: Map<number, Loot>, at: { x: number; z: number }) {
    if (quality < 0) {
      this.el.style.display = 'none';
      this.next = 0;
      return;
    }
    const range = detectorRange(quality);
    let near = Infinity;
    for (const l of loot.values()) {
      if (l.depth <= 0) continue;
      near = Math.min(near, Math.hypot(l.x - at.x, l.z - at.z));
    }
    const signal = near < range ? 1 - near / range : 0; // 0 at the edge .. 1 on top
    this.el.style.display = 'flex';
    const lit = signal > 0 ? Math.max(1, Math.ceil(signal * BARS)) : 0;
    this.bars.forEach((b, i) => b.classList.toggle('on', i < lit));
    this.text.textContent = near < ON_TOP ? 'Dig' : signal > 0 ? 'Signal' : 'Nothing';
    if (signal <= 0) {
      this.next = 0;
      return;
    }
    this.next -= dt;
    if (this.next <= 0) {
      this.next = SLOW + (FAST - SLOW) * signal;
      tick(LOW_HZ + (HIGH_HZ - LOW_HZ) * signal);
    }
  }
}

/** One short sine tick through the shared output (src/audio.ts: volume, limiter), with soft edges. */
function tick(hz: number) {
  const ctx = audio.ctx, out = audio.out;
  if (!ctx || !out || !audio.running) return;
  const t0 = ctx.currentTime + 0.01;
  const osc = ctx.createOscillator();
  osc.frequency.value = hz;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  osc.connect(gain).connect(out);
  gain.gain.setTargetAtTime(GAIN, t0, 0.003);
  gain.gain.setTargetAtTime(0, t0 + TICK, 0.006);
  osc.start(t0);
  osc.stop(t0 + TICK + 0.06);
  osc.onended = () => gain.disconnect();
}
