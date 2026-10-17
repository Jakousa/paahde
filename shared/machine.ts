// What is inside a machine (a crash-site component, shared/salvage.ts COMPONENTS): the parts it rolls from its
// seed. Run by both the client (src/teardown/junk.ts mounts part i of this list as the slot with index i) and the
// server (server/crash.ts gives part i to whoever takes it), so they must agree: integer hashing and plain
// arithmetic only, and the seeded rng is used for nothing else.
import { seeded } from './crash.ts';
import { COMPONENTS, TIERS, type ComponentKind, type PartId, type Tier } from './salvage.ts';

export interface MachinePart {
  part: PartId;
  tier: Tier;
}

function pickTier(weights: Record<Tier, number>, rand: () => number): Tier {
  let sum = 0;
  for (const t of TIERS) sum += weights[t];
  let r = rand() * sum;
  for (const t of TIERS) if ((r -= weights[t]) < 0) return t;
  return 'scrap';
}

const cache = new Map<string, MachinePart[]>();

/** The parts in a machine of `kind` with this seed, in roll order (yields in order, each one's count then tiers). */
export function machineParts(kind: ComponentKind, seed: number): MachinePart[] {
  const key = `${kind}:${seed >>> 0}`;
  let out = cache.get(key);
  if (out) return out;
  const spec = COMPONENTS[kind];
  const rand = seeded(seed);
  out = [];
  for (const y of spec.yields) {
    const n = y.min + Math.floor(rand() * (y.max - y.min + 1));
    for (let i = 0; i < n; i++) out.push({ part: y.part, tier: pickTier(spec.tierWeights, rand) });
  }
  if (cache.size > 512) cache.clear();
  cache.set(key, out);
  return out;
}

/** Item kind of a part at a tier (shared/items.ts), matching public/models/items/<part>_<tier>.glb. */
export const partItem = (part: PartId, tier: Tier) => `${part}_${tier}`;
