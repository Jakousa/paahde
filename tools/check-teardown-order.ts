// Order check for the model-built engine: working every ready step in turn over 300 seeds, no inner shell step (core cowl, core
// casing, rotors) may become ready before the whole shell outside it that is on the machine is gone, and every step must come
// ready in the end.   node tools/check-teardown-order.ts   (model and part loads fail in node; that is expected and ignored)
process.on('unhandledRejection', () => {});
import { buildJunk, stepReady } from '../src/teardown/junk.ts';
import { machineModules } from '../shared/machine.ts';

const OUTSIDE = (id: string): string[] =>
  id.startsWith('corecowl') ? ['reverser_a', 'reverser_b'] : id.startsWith('casing') ? ['corecowl_a', 'corecowl_b']
    : ['compressor', 'combustor', 'turbine'].includes(id) ? ['casing_a', 'casing_b'] : [];
let bad = 0;
for (let seed = 1; seed <= 300; seed++) {
  const j = buildJunk('jet_engine', seed * 7919, 2);
  const mods = machineModules('jet_engine', seed * 7919, 2);
  const owner: string[] = [];
  for (const { mod } of mods) for (const ls of mod.steps) if (!ls.with || ls.with.every((id) => mods.some((m) => m.mod.id === id))) owner.push(mod.id);
  const present = new Set(mods.map((m) => m.mod.id));
  const gone = (id: string) => j.steps.every((s, i) => owner[i] !== id || s.done);
  for (let n = 0; n < 500; n++) {
    const s = j.steps.find((x) => stepReady(x));
    if (!s) break;
    const id = owner[j.steps.indexOf(s)];
    for (const need of OUTSIDE(id)) if (present.has(need) && !gone(need)) { console.log(`seed ${seed}: ${id} ready before ${need} is gone`); bad++; }
    s.done = true;
    s.progress = s.need;
  }
  const left = j.steps.filter((x) => !x.done).length;
  if (left) { console.log(`seed ${seed}: ${left} steps never ready`); bad++; }
}
console.log(bad ? `${bad} problems` : 'order ok');
process.exit(bad ? 1 : 0);
