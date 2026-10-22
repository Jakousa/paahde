// Which enemies we hit lately (rifle or pistol shot, jammer), so the moment one dies can be put down to us: the
// character's remark on a kill (src/speechLines.ts `killed`). Client-side only, by key: `g<id>` walker, `d<id>` drone,
// `j<id>` jet, `h<id>` harvester, `b<id>` boss. Someone else finishing it off still counts: we helped.

/** A hit this long ago (ms) still earns the kill. */
const CREDIT_MS = 20_000;

const hits = new Map<string, number>();

/** We just hit (or jammed) this enemy. */
export function hit(key: string) {
  hits.set(key, performance.now());
}

/** It just died: did we hit it lately? Forgets it either way. */
export function claim(key: string): boolean {
  const at = hits.get(key);
  hits.delete(key);
  return at !== undefined && performance.now() - at < CREDIT_MS;
}
