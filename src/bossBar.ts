// The boss health bar (shared/bosses.ts: health goes down a hit at a time on the weak points): the nearest live boss's
// name and a bar across the top of the screen while one is within reach (src/bosses.ts BossFx.bar). It eases down as
// hits land, a pale trail sliding down after it showing the last ones.
import { BOSSES, type BossKind } from '../shared/bosses.ts';

const css = `
#bossBar { position: fixed; top: 22px; left: 50%; transform: translateX(-50%); width: min(520px, 60vw); z-index: 6;
  pointer-events: none; display: grid; gap: 5px; justify-items: center; opacity: 0; transition: opacity .8s;
  font: 600 12px var(--mono); letter-spacing: .3em; color: #ffd9a0; text-shadow: 0 1px 2px #000; }
#bossBar.on { opacity: 1; }
#bossBar .track { position: relative; width: 100%; height: 8px; background: rgba(20, 8, 4, .65); border-radius: 2px;
  box-shadow: 0 0 0 1px rgba(255, 190, 110, .35); overflow: hidden; }
#bossBar .trail, #bossBar .fill { position: absolute; inset: 0 auto 0 0; }
#bossBar .trail { background: rgba(255, 230, 190, .45); }
#bossBar .fill { background: linear-gradient(#e8562a, #a8261a); box-shadow: 0 0 6px rgba(255, 90, 40, .7); }
`;

export class BossBar {
  private el = document.createElement('div');
  private name: HTMLElement;
  private fill: HTMLElement;
  private trail: HTMLElement;
  private kind: BossKind | null = null;
  private shown = 1;
  private trailed = 1;

  constructor() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.el.id = 'bossBar';
    this.el.innerHTML = '<div class="name"></div><div class="track"><div class="trail"></div><div class="fill"></div></div>';
    this.name = this.el.querySelector('.name')!;
    this.fill = this.el.querySelector('.fill')!;
    this.trail = this.el.querySelector('.trail')!;
    document.body.append(this.el);
  }

  /** Every frame: the boss to show (null hides the bar). */
  update(dt: number, bar: { kind: BossKind; hp: number } | null) {
    this.el.classList.toggle('on', !!bar);
    if (!bar) return;
    if (bar.kind !== this.kind) {
      this.kind = bar.kind;
      this.name.textContent = BOSSES[bar.kind].label.toUpperCase();
      this.shown = this.trailed = bar.hp;
    }
    this.shown += (bar.hp - this.shown) * Math.min(1, dt * 12);
    // The trail slides down after the bar; it jumps up at once when health comes back.
    this.trailed = bar.hp > this.trailed ? bar.hp : this.trailed + (bar.hp - this.trailed) * Math.min(1, dt * 1.5);
    this.fill.style.width = `${(this.shown * 100).toFixed(2)}%`;
    this.trail.style.width = `${(this.trailed * 100).toFixed(2)}%`;
  }
}
