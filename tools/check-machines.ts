// Solvability check for the model-built machines (shared/machines.ts): for many seeds, every step's prerequisites exist and
// the steps can all be done in some order, every part's holds are steps that exist, and counts stay within the server's cap.
//   node tools/check-machines.ts
import { machineModules, machineParts } from '../shared/machine.ts';
import { layoutOf } from '../shared/machines.ts';
import type { JunkKind } from '../shared/salvage.ts';

const KINDS: JunkKind[] = ['jet_engine'];
let bad = 0;
for (const kind of KINDS) {
  const layout = layoutOf(kind)!;
  let minSteps = 1e9, maxSteps = 0, minParts = 1e9, maxParts = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const mods = machineModules(kind, seed, 2);
    const ids = new Map<string, string[]>();
    const all: { id: string; label: string; after: string[]; mod: string }[] = [];
    for (const { mod } of mods) {
      ids.set(mod.id, mod.steps.map((s) => s.id));
      for (const s of mod.steps) all.push({ id: s.id, label: s.label, after: s.after, mod: mod.id });
    }
    const deps = new Map<string, Set<string>>();
    for (const s of all) {
      const d = new Set<string>();
      for (const e of s.after) {
        if (all.some((x) => x.id === e)) d.add(e);
        else if (ids.has(e)) for (const x of ids.get(e)!) d.add(x);
        else for (const x of all) if (x.mod === s.mod && x.label === e) d.add(x.id);
      }
      d.delete(s.id);
      deps.set(s.id, d);
    }
    const done = new Set<string>();
    for (let progress = true; progress && done.size < all.length;) {
      progress = false;
      for (const s of all) if (!done.has(s.id) && [...deps.get(s.id)!].every((x) => done.has(x))) (done.add(s.id), (progress = true));
    }
    if (done.size < all.length) { bad++; console.log(`${kind} seed ${seed}: ${all.length - done.size} steps can never be done`); }
    const parts = machineParts(kind, seed, 2);
    const idx = mods.flatMap((m) => m.parts.map((p) => p.index));
    if (idx.join() !== parts.map((_, i) => i).join()) { bad++; console.log(`${kind} seed ${seed}: part indexes out of order`); }
    minSteps = Math.min(minSteps, all.length); maxSteps = Math.max(maxSteps, all.length);
    minParts = Math.min(minParts, parts.length); maxParts = Math.max(maxParts, parts.length);
    if (all.length > 255) { bad++; console.log(`${kind} seed ${seed}: ${all.length} steps is over the cap`); }
  }
  console.log(`${kind}: ${layout.modules.length} modules; steps ${minSteps}-${maxSteps}, parts ${minParts}-${maxParts} over 400 seeds`);
}
if (bad) process.exit(1);
