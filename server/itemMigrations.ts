// Items saved by older versions of the game, made right as their box loads (server/items.ts slots): gear from before
// repairs, gear whose slots changed, buildings from when they were carried, stacks bigger than their kind allows now
// and scrap from before it was one kind. Laying the box out again afterwards (settle) is the caller's.
import { isGear, refit, scrapParts } from '../shared/gear.ts';
import { makeItem, partAt, stackOf, stacks, type Slots } from '../shared/items.ts';
import { fittedBox } from '../shared/boxes.ts';
import { buildCost, isBuildable } from '../shared/crafting.ts';

/** Bring box `box`'s items up to date; what doesn't fit where it was goes past the end. Mutates; whether anything changed. */
export function migrateBox(box: string, slots: Slots, newId: () => number): boolean {
  let changed = false;
  // Buildings from when they were crafted and carried (shared/crafting.ts BUILDS): back into what they were made
  // of, their parts and materials. (Not on the workbench, whose one slot can't take them: moved off it, they're
  // turned back next time the box loads.)
  if (!fittedBox(box) && box !== 'bench') {
    for (let i = 0; i < slots.length; i++) {
      const it = slots[i];
      if (!it || !isBuildable(it.kind)) continue;
      slots[i] = null;
      for (const m of buildCost(it.kind)) {
        for (let n = m.n; n > 0; n -= stackOf(m.kind)) slots.push(makeItem(newId(), { kind: m.kind, n: Math.min(n, stackOf(m.kind)) }));
      }
      for (let j = 0; j < (it.parts?.length ?? 0); j++) {
        const p = partAt(it, j);
        if (p) slots.push(makeItem(newId(), p));
      }
      changed = true;
    }
  }
  for (const it of [...slots]) {
    // Gear from before repairs existed (the old starter canteen and spyglass, guns crafted before they were gear)
    // works: Scrap parts in every slot.
    if (it && isGear(it.kind) && !it.parts) {
      it.parts = scrapParts(it.kind);
      changed = true;
    }
    // Gear whose slots changed since (shared/gear.ts refit).
    if (it && refit(it)) changed = true;
    // Stacks bigger than their kind allows now: one item per stack, the rest past the end.
    for (; it && it.n > stackOf(it.kind); it.n--) {
      slots.push(makeItem(newId(), { kind: it.kind }));
      changed = true;
    }
  }
  // Scrap migrated from the old kinds (server/db.ts) comes as many stacks of one: merge them.
  if (mergeStacks(slots)) changed = true;
  return changed;
}

/** Pile stacks of one kind onto the first of them, up to its stack size (shared/items.ts stacks). Mutates; whether it did. */
function mergeStacks(slots: Slots): boolean {
  let changed = false;
  for (let i = 0; i < slots.length; i++) {
    const a = slots[i];
    if (!a || a.n >= stackOf(a.kind)) continue;
    for (let j = i + 1; j < slots.length && a.n < stackOf(a.kind); j++) {
      const b = slots[j];
      if (!b || !stacks(a, b)) continue;
      const k = Math.min(b.n, stackOf(a.kind) - a.n);
      a.n += k;
      b.n -= k;
      if (b.n <= 0) slots[j] = null;
      changed = true;
    }
  }
  return changed;
}
