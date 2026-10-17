// What is inside a machine (a crash-site component or salvage wreck, shared/salvage.ts COMPONENTS / SALVAGE): the parts it rolls from its
// seed (shared/parts.ts rollParts). Run by both the client (src/teardown/junk.ts mounts part i of this list as the
// slot with index i) and the server (server/crash.ts gives part i to whoever takes it), so they must agree.
import { seeded } from './crash.ts';
import { rollParts } from './parts.ts';
import type { JunkKind, PartId, Tier } from './salvage.ts';

export { partItem } from './parts.ts';

export interface MachinePart {
  part: PartId;
  tier: Tier;
}

const cache = new Map<string, MachinePart[]>();

/** The parts in a machine of `kind` with this seed, in roll order; `level` is its crash site's (default: carried home). */
export function machineParts(kind: JunkKind, seed: number, level = 1): MachinePart[] {
  const key = `${kind}:${seed >>> 0}:${level}`;
  let out = cache.get(key);
  if (!out) {
    out = rollParts(kind, seeded(seed), level);
    if (cache.size > 512) cache.clear();
    cache.set(key, out);
  }
  return out;
}
