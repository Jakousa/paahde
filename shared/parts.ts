// Parts as inventory items (GitHub issue #8): one item kind per part and tier, `<part>_<tier>` (battery_space,
// relay_scrap, ...), the same names as the models (public/models/items/<part>_<tier>.glb) and icons
// (public/icons/items/<part>_<tier>.png). They come out of machines in the disassembly mode (src/teardown) and
// land in the bag through the server (server/crash.ts), which rolls the same contents from the same seed as the
// client (rollParts) and never hands out more of a kind than the machine holds.
import { junkSpec, TIERS, type JunkKind, type PartId, type Tier } from './salvage.ts';
import { LEVEL_TIERS, TIER_RAMP, type TierWeights } from './tables.ts';
import { BASE } from './base.ts';
import type { SiteLevel } from './crashsites.ts';
import { TEXT } from './text.ts';

export const PART_LABELS: Record<PartId, string> = TEXT.parts;
export const PART_IDS = Object.keys(PART_LABELS) as PartId[];

/** Quality word in front of the part's name. */
export const TIER_LABELS: Record<Tier, string> = TEXT.tiers;

/** Item kind of a part. */
export const partItem = (part: PartId, tier: Tier) => `${part}_${tier}`;

/** Part and tier of an item kind, or null if it isn't a part. */
export function partOf(kind: string): { part: PartId; tier: Tier } | null {
  const i = kind.lastIndexOf('_');
  const part = kind.slice(0, i) as PartId, tier = kind.slice(i + 1) as Tier;
  return i > 0 && part in PART_LABELS && (TIERS as readonly string[]).includes(tier) ? { part, tier } : null;
}

/** Catalogue entries for every part item (spread into ITEMS, shared/items.ts), tiers of a part together. */
export function partItems(): Record<string, { label: string; stack: number; tier: Tier }> {
  const out: Record<string, { label: string; stack: number; tier: Tier }> = {};
  for (const part of PART_IDS) {
    for (const tier of TIERS) out[partItem(part, tier)] = { label: TEXT.partItem(TIER_LABELS[tier], PART_LABELS[part]), stack: 1, tier };
  }
  return out;
}

export function pickTier(weights: TierWeights, rand: () => number): Tier {
  let sum = 0;
  for (const t of TIERS) sum += weights[t] ?? 0;
  let r = rand() * sum;
  for (const t of TIERS) if ((r -= weights[t] ?? 0) < 0) return t;
  return 'scrap';
}

/** `weights` scaled for a find lying at (x, z): the better tiers fade in with the distance from the base (TIER_RAMP). */
export function tierWeightsAt(weights: TierWeights, x: number, z: number): TierWeights {
  const d = Math.hypot(x - BASE.x, z - BASE.z);
  const out: TierWeights = {};
  for (const t of TIERS) {
    const ramp = TIER_RAMP[t];
    const u = ramp ? Math.min(1, Math.max(0, (d - ramp.from) / (ramp.to - ramp.from))) : 1;
    out[t] = (weights[t] ?? 0) * u * u * (3 - 2 * u);
  }
  return out;
}

/** What is inside a component or salvage wreck of `kind`, rolled with `rand` (shared/crash.ts seeded(seed)): every part and its
 *  tier, in roll order. `level` is the crash site's (shared/tables.ts LEVEL_TIERS). src/teardown/junk.ts mounts these; the server checks takes
 *  against them. */
export function rollParts(kind: JunkKind, rand: () => number, level = 1): { part: PartId; tier: Tier }[] {
  const spec = junkSpec(kind);
  const boost = LEVEL_TIERS[level as SiteLevel] ?? LEVEL_TIERS[1];
  const weights = Object.fromEntries(TIERS.map((t) => [t, (spec.tierWeights[t] ?? 0) * boost[t]])) as Record<Tier, number>;
  const out: { part: PartId; tier: Tier }[] = [];
  for (const y of spec.yields) {
    const n = y.min + Math.floor(rand() * (y.max - y.min + 1));
    for (let i = 0; i < n; i++) out.push({ part: y.part, tier: pickTier(weights, rand) });
  }
  return out;
}
