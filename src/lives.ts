// The world's shared lives (server/world.ts): a row of marks in the top-right corner (under the weather, src/water.ts
// #env), one put out per death, ten to a row; each boss kind's first kill adds a row (shared/bosses.ts BOSS_LIVES).
// At 0 the game is over and the end screen comes up (src/landing.ts).
import { BOSS_LIVES, beatenCount } from '../shared/bosses.ts';
import { LIVES } from '../shared/world.ts';

const css = `
#lives { position: fixed; top: 50px; right: 16px; display: grid; grid-template-columns: repeat(10, 7px); gap: 5px; pointer-events: none; z-index: 5; }
#lives i { width: 7px; height: 7px; border-radius: 50%; background: #ffb24a; box-shadow: 0 0 4px #e8902e, 0 0 0 1px rgba(0, 0, 0, .3);
  transition: background .6s, box-shadow .6s; }
#lives i.gone { background: rgba(40, 20, 10, .55); box-shadow: none; }
`;

export class Lives {
  private el = document.createElement('div');

  constructor() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.el.id = 'lives';
    this.el.innerHTML = '<i></i>'.repeat(LIVES);
    document.body.append(this.el);
  }

  set(n: number, beaten: number) {
    const marks = Math.max(n, LIVES + BOSS_LIVES * beatenCount(beaten));
    while (this.el.children.length < marks) this.el.append(document.createElement('i'));
    this.el.querySelectorAll('i').forEach((m, i) => m.classList.toggle('gone', i >= n));
  }
}
