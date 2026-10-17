// Crafting at the base's workbench (shared/stations.ts): recipes, and using up their ingredients from the bag.
// The client shows the recipes in the Tab inventory while the workbench is in reach (src/inventory.ts) and
// asks; the server checks reach and runs craft() on the real bag (server/items.ts).
//
// Ingredients match groups of item kinds, so any tier of a part will do: wiring is the coil part in any
// tier (coil_scrap … coil_space, shared/parts.ts), metal sheets are clean or dented. The worst matching item
// (lowest tier) is used first.
import { addItem, HOTBAR, ITEMS, type Slots } from './items.ts';
import { partOf } from './parts.ts';
import { TIERS } from './salvage.ts';

export type Ingredient = { label: string; n: number; match: (kind: string) => boolean };
export type Recipe = { makes: string; needs: Ingredient[] };

/** Better tiers last: craft() uses the worst matching item first. Untiered items rank lowest. */
const tierRank = (kind: string) => {
  const t = ITEMS[kind]?.tier;
  return t ? TIERS.indexOf(t) : -1;
};

const sheet: Ingredient['match'] = (k) => k === 'metal_sheet' || k === 'dented_sheet';
/** The wiring coil part, any tier. */
const coil: Ingredient['match'] = (k) => partOf(k)?.part === 'coil' && k in ITEMS;

/** Recipe id → what it makes and needs. The id is the item kind it makes. */
export const RECIPES: Record<string, Recipe> = {
  plant_bed: { makes: 'plant_bed', needs: [{ label: 'Metal sheet', n: 3, match: sheet }] },
  uv_lamp: { makes: 'uv_lamp', needs: [{ label: 'Metal sheet', n: 2, match: sheet }, { label: 'Wiring coil', n: 1, match: coil }] },
};

/** How many items in `slots` match an ingredient. */
export const countMatching = (slots: Slots, ing: Ingredient) => slots.reduce((n, it) => n + (it && ing.match(it.kind) ? it.n : 0), 0);

/** Slot indexes to use up for a recipe (one entry per item; backpack before hotbar, worst tier first), or null if short. */
export function pickIngredients(slots: Slots, recipe: Recipe): number[] | null {
  const used = new Map<number, number>();
  const out: number[] = [];
  for (const ing of recipe.needs) {
    const cands = slots.map((it, i) => ({ it, i })).filter((c) => c.it && ing.match(c.it.kind))
      .sort((a, b) => tierRank(a.it!.kind) - tierRank(b.it!.kind) || (b.i >= HOTBAR ? 1 : 0) - (a.i >= HOTBAR ? 1 : 0) || b.i - a.i);
    let need = ing.n;
    for (const c of cands) {
      while (need > 0 && (used.get(c.i) ?? 0) < c.it!.n) {
        used.set(c.i, (used.get(c.i) ?? 0) + 1);
        out.push(c.i);
        need--;
      }
    }
    if (need > 0) return null;
  }
  return out;
}

/** Craft `id` in `slots`: use up the ingredients, add what it makes. Mutates; false (no change) if it can't. */
export function craft(slots: Slots, id: string, newId: () => number, size = slots.length): boolean {
  const recipe = RECIPES[id];
  if (!recipe || !(recipe.makes in ITEMS)) return false;
  const pick = pickIngredients(slots, recipe);
  if (!pick) return false;
  for (const i of pick) {
    const it = slots[i]!;
    if (--it.n <= 0) slots[i] = null;
  }
  return addItem(slots, recipe.makes, 1, newId, Math.min(HOTBAR, size - 1), size);
}
