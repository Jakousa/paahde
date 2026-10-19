// The engine's solid shrinks as it comes apart: with nothing done every shell is solid; with every outer step done only
// the structure is left.   node tools/check-machine-boxes.ts
import { machineChanged, machineCapsules, setMachineProgress } from '../shared/machineBoxes.ts';
import { machineModules } from '../shared/machine.ts';
import type { CrashSite } from '../shared/crash.ts';

const site = (seed: number): CrashSite => ({ id: 'lab:t', wreck: -1, index: 0, level: 2, lab: true, kind: 'jet_engine', seed, x: 0, z: 0, yaw: 0 }) as CrashSite;
let all = new Set<number>();
setMachineProgress(() => all);
let bad = 0;
for (const seed of [1000, 8919, 16838, 24757]) {
  const n = machineModules('jet_engine', seed, 2).reduce((a, m) => a + m.mod.steps.filter((s) => !s.with || s.with.every((id) => machineModules('jet_engine', seed, 2).some((x) => x.mod.id === id))).length, 0);
  all = new Set(); machineChanged();
  const before = machineCapsules(site(seed));
  all = new Set(Array.from({ length: n }, (_, i) => i)); machineChanged();
  const after = machineCapsules(site(seed));
  const top = (c: { h: number }[]) => Math.max(...c.map((x) => x.h)).toFixed(2);
  console.log(`seed ${seed}: ${before.length} -> ${after.length} stretches, top ${top(before)} -> ${top(after)} m`);
  if (after.length >= before.length && before.length > 2) bad++;
}
process.exit(bad ? 1 : 0);
