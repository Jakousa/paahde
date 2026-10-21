// One-time hints: a short banner the first time you do something new (repair a piece of gear, craft a thing,
// carry home your first machine) saying how to use it, then never again on this browser (localStorage). The texts are
// shared/text.ts `hints`, keyed by the gear or recipe (or 'part', 'broken', 'machine').
// Fed from the inventory's box updates (src/inventory.ts).
import { hintKeys } from './bindings';
import { COMPONENTS, SALVAGE } from '../shared/salvage.ts';
import { isGear, repaired } from '../shared/gear.ts';
import { partOf } from '../shared/parts.ts';
import { RECIPES } from '../shared/crafting.ts';
import type { Slots } from '../shared/items.ts';
import { TEXT } from '../shared/text.ts';

const KEY = 'dadajam.hints';
const SHOW_MS = 7000;

const css = `
#hint { position: fixed; left: 50%; top: 22%; transform: translateX(-50%); z-index: 20; padding: 6px 14px;
  font: 600 14px var(--mono); letter-spacing: .03em; color: #ffd9a0; background: rgba(40, 18, 6, 0.6);
  border-radius: 6px; box-shadow: 0 0 0 1px rgba(255, 190, 110, 0.35); text-shadow: 0 1px 2px #000;
  pointer-events: none; white-space: nowrap; opacity: 0; transition: opacity .4s; }
#hint.on { opacity: 1; }
`;

const isMachine = (kind: string) => kind in SALVAGE || !!COMPONENTS[kind as keyof typeof COMPONENTS]?.carry;

export class Hints {
  private el = document.createElement('div');
  private seen: Set<string>;
  private queue: string[] = [];
  private busy = false;
  /** Item ids in the bag at the last update; null before the first (what you log in with is old news). */
  private bagIds: Set<number> | null = null;
  /** The workbench item at the last update, and whether it worked. */
  private bench: { id: number; ok: boolean } | null = null;

  constructor() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.el.id = 'hint';
    document.body.appendChild(this.el);
    let seen: string[] = [];
    try {
      seen = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    } catch { /* private window: every hint shows once per visit */ }
    this.seen = new Set(Array.isArray(seen) ? seen : []);
  }

  /** A box changed (Net.onItems); `got`: what was picked up or crafted. */
  onItems(boxes: Record<string, Slots>, box: string, got?: string) {
    if (got && got in RECIPES) this.show(partOf(got) ? 'part' : got);
    if (box === 'bench') {
      const it = boxes.bench?.[0];
      const ok = repaired(it);
      if (it && ok && this.bench?.id === it.id && !this.bench.ok) this.show(it.kind);
      this.bench = it ? { id: it.id, ok } : null;
    }
    if (box === 'bag') {
      const bag = boxes.bag ?? [];
      const ids = new Set(bag.flatMap((it) => (it ? [it.id] : [])));
      if (this.bagIds) {
        for (const it of bag) {
          if (!it || this.bagIds.has(it.id)) continue;
          if (isGear(it.kind) && !repaired(it)) this.show('broken');
          else if (isMachine(it.kind)) this.show('machine');
        }
      }
      this.bagIds = ids;
    }
  }

  private show(key: string) {
    if (!TEXT.hints[key] || this.seen.has(key)) return;
    this.seen.add(key);
    try {
      localStorage.setItem(KEY, JSON.stringify([...this.seen]));
    } catch { /* not kept */ }
    this.queue.push(key);
    this.next();
  }

  private next() {
    if (this.busy) return;
    const key = this.queue.shift();
    if (!key) return;
    this.busy = true;
    this.el.textContent = TEXT.hints[key](hintKeys());
    this.el.classList.add('on');
    setTimeout(() => {
      this.el.classList.remove('on');
      setTimeout(() => {
        this.busy = false;
        this.next();
      }, 500);
    }, SHOW_MS);
  }
}
