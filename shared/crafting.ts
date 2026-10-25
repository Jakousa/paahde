// Crafting at a workbench (shared/stations.ts) and by hand: recipes, and using up their ingredients from the bag.
// The client shows the workbench's recipes in the Tab inventory while one is in reach, the ones made by hand
// (HAND_RECIPES) always (src/inventory.ts), and asks; the server checks reach and runs craft() on the real bag
// (server/items.ts).
//
// Ingredients match groups of item kinds, so any tier of a part will do (bearing_scrap … bearing_space,
// shared/parts.ts); scrap, cloth and wiring are one item each. The worst matching item (lowest tier) is used first.
//
// What makes gear comes with the parts it took fitted in its slots, each slot the first of them that fits it: it is
// as good as what went into it, and better parts can be swapped in later.
//
// The buildings (BUILDS, shared/tables.ts BUILD_TABLE) aren't crafted: they're put up with the wrench in hand from the
// build menu (src/buildMenu.ts), their materials used up from the bag as they go up (useUp; server/placed.ts build).
import { fitsSlot, GEAR } from './gear.ts';
import { addItem, HOTBAR, ITEMS, setPart, withData, type Part, type Shape, type Slots } from './items.ts';
import { partOf } from './parts.ts';
import { TIERS } from './salvage.ts';
import { BUILD_TABLE, HAND_TABLE, RECIPE_TABLE, type IngredientSpec } from './tables.ts';

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

/** Made by hand anywhere, no station needed (shared/tables.ts HAND_TABLE): recipe id → what it makes and needs. */
export const HAND_RECIPES: Record<string, Recipe> = Object.fromEntries(
  Object.entries(HAND_TABLE).map(([id, needs]) => [id, { makes: id, needs: needs.map(ingredient) }]),
);

/** Building → the base materials it takes (shared/tables.ts BUILD_TABLE). `makes` is the placed kind. */
export const BUILDS: Record<string, Recipe> = Object.fromEntries(
  Object.entries(BUILD_TABLE).map(([id, needs]) => [id, { makes: id, needs: needs.map(ingredient) }]),
);
/** Put up with the wrench (never carried as an item). */
export const isBuildable = (kind: string | undefined) => !!kind && kind in BUILDS;
/** The tool that opens the build menu. */
export const WRENCH = 'wrench';

/** How many items in `slots` match an ingredient. */
export const countMatching = (slots: Slots, ing: Ingredient) => slots.reduce((n, it) => n + (it && ing.match(it.kind) ? it.n : 0), 0);

/**
 * Indexes into `items` to use up for a recipe (one entry per item used), or null if short. The worst tier goes first,
 * then the order `before` sets (equal: as listed). Gear (anything with parts) is never an ingredient. The economy
 * simulator (tools/econsim) picks from its chest with this too.
 */
export function pickFrom(items: readonly ({ kind: string; n: number; parts?: unknown } | null)[], recipe: Recipe,
  before: (a: number, b: number) => number = () => 0): number[] | null {
  const used = new Map<number, number>();
  const out: number[] = [];
  for (const ing of recipe.needs) {
    const cands = items.map((it, i) => ({ it, i })).filter((c) => c.it && !c.it.parts && ing.match(c.it.kind))
      .sort((a, b) => tierRank(a.it!.kind) - tierRank(b.it!.kind) || before(a.i, b.i));
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

/** Slot indexes to use up for a recipe (one entry per item; backpack before hotbar, worst tier first), or null if short. */
export const pickIngredients = (slots: Slots, recipe: Recipe): number[] | null =>
  pickFrom(slots, recipe, (a, b) => (b >= HOTBAR ? 1 : 0) - (a >= HOTBAR ? 1 : 0) || b - a);

/** What gear `kind` comes with in each slot when made from `used`: the first of them that fits it (consumes `used`). */
export function fitUsed<P extends { kind: string }>(kind: string, used: P[]): (P | null)[] {
  return (GEAR[kind]?.slots ?? []).map((slot) => {
    const j = used.findIndex((p) => fitsSlot(slot, p.kind));
    return j < 0 ? null : used.splice(j, 1)[0];
  });
}

/** Use up what `recipe` needs from `slots`. Mutates; false (no change) if something is short. */
export function useUp(slots: Slots, recipe: Recipe): boolean {
  const pick = pickIngredients(slots, recipe);
  if (!pick) return false;
  for (const i of pick) {
    const it = slots[i]!;
    slots[i] = it.n > 1 ? { ...it, n: it.n - 1 } : null;
  }
  return true;
}

/** The materials building `kind` took, as items to give back when it comes down (or [] if it isn't one). */
export const buildCost = (kind: string): { kind: string; n: number }[] =>
  (BUILD_TABLE[kind] ?? []).flatMap((s) => ('kinds' in s ? [{ kind: s.kinds[0], n: s.n }] : []));

/** Craft `id` in `slots`: use up the ingredients, add what it makes. Mutates; false (no change) if it can't. */
export function craft(slots: Slots, id: string, newId: () => number, shape: Shape): boolean {
  const recipe = RECIPES[id] ?? HAND_RECIPES[id];
  if (!recipe || !(recipe.makes in ITEMS)) return false;
  const pick = pickIngredients(slots, recipe);
  if (!pick) return false;
  // Used up first, so what it makes can go where they were; on no room, nothing is used up.
  const s = slots.map((it) => it && { ...it });
  const used: Part[] = pick.map((i) => ({ kind: slots[i]!.kind, ...withData(slots[i]!.data) }));
  for (const i of pick) {
    const it = s[i]!;
    if (--it.n <= 0) s[i] = null;
  }
  let made = -1;
  if (!addItem(s, recipe.makes, 1, () => (made = newId()), shape)) return false;
  const gear = GEAR[recipe.makes];
  const it = gear && s.find((x) => x?.id === made);
  if (it) {
    // Each slot takes an ingredient that fits it, its data with it.
    fitUsed(recipe.makes, used).forEach((p, i) => setPart(it, i, p));
  }
  slots.splice(0, slots.length, ...s);
  return true;
}
