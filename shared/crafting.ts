// Crafting at the base's workbench (shared/stations.ts): recipes, and using up their ingredients from the bag.
// The client shows the recipes in the Tab inventory while the workbench is in reach (src/inventory.ts) and
// asks; the server checks reach and runs craft() on the real bag (server/items.ts).
//
// Ingredients match groups of item kinds, so any tier of a part will do: wiring is the coil part in any
// tier (coil_scrap … coil_space, shared/parts.ts), metal sheets are clean or dented. The worst matching item
// (lowest tier) is used first.
import { addItem, HOTBAR, ITEMS, type Shape, type Slots } from './items.ts';
import { partOf } from './parts.ts';
import { TIERS } from './salvage.ts';
import { RECIPE_TABLE, type IngredientSpec } from './tables.ts';

export type Ingredient = { label: string; n: number; match: (kind: string) => boolean };
export type Recipe = { makes: string; needs: Ingredient[] };

/** Better tiers last: craft() uses the worst matching item first. Untiered items rank lowest. */
const tierRank = (kind: string) => {
  const t = ITEMS[kind]?.tier;
  return t ? TIERS.indexOf(t) : -1;
};

/** An ingredient from shared/tables.ts: any tier of a part, or one of a list of kinds. */
const ingredient = (spec: IngredientSpec): Ingredient => ({
  label: spec.label,
  n: spec.n,
  match: 'part' in spec ? (k) => partOf(k)?.part === spec.part && k in ITEMS : (k) => spec.kinds.includes(k),
});

/** Recipe id → what it makes and needs (shared/tables.ts RECIPE_TABLE). The id is the item kind it makes. */
export const RECIPES: Record<string, Recipe> = Object.fromEntries(
  Object.entries(RECIPE_TABLE).map(([id, needs]) => [id, { makes: id, needs: needs.map(ingredient) }]),
);

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
export function craft(slots: Slots, id: string, newId: () => number, shape: Shape): boolean {
  const recipe = RECIPES[id];
  if (!recipe || !(recipe.makes in ITEMS)) return false;
  const pick = pickIngredients(slots, recipe);
  if (!pick) return false;
  // Used up first, so what it makes can go where they were; on no room, nothing is used up.
  const s = slots.map((it) => it && { ...it });
  for (const i of pick) {
    const it = s[i]!;
    if (--it.n <= 0) s[i] = null;
  }
  if (!addItem(s, recipe.makes, 1, newId, shape)) return false;
  slots.splice(0, slots.length, ...s);
  return true;
}
