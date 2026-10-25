// What the steps of a model-built machine (shared/machines.ts) are, by index, for the server: the steps are numbered in the order
// src/teardown/glbMachine.ts builds them (each module's steps in turn, those that join something that is not there left out). The
// server uses it to know when a module has come off, a piece on the ground has been taken apart, or the whole machine is finished
// (the scrap they give, shared/tables.ts SCRAP_REWARD).
import { machineModules } from './machine.ts';
import { layoutOf } from './machines.ts';
import type { JunkKind } from './salvage.ts';
import { SCRAP_REWARD } from './tables.ts';
import { codeMachineSteps } from './codeMachineSteps.ts';

export interface StepInfo {
  module: string;
  /** Done on the piece once it has come off (not on the machine). */
  inner: boolean;
  after: number[];
}

/** Scrap for turning a machine's frame into scrap (shared/tables.ts SCRAP_REWARD): the same for the client's bag check and the server's pay.
 *  `partsLeft` parts still on it (only at the disassembly table) are destroyed and add to it. */
export function frameScrap(kind: JunkKind, seed: number, level: number, partsLeft: number): number {
  return SCRAP_REWARD.machine + (stepList(kind, seed, level)?.modules ?? 0) * SCRAP_REWARD.perModule + partsLeft * SCRAP_REWARD.perPartLeft;
}

type Steps = { list: StepInfo[]; modules: number; parts: number[][] };
const cache = new Map<string, Steps>();

/** The exact client step order, prerequisites and part mounts, without constructing geometry. */
export function stepList(kind: JunkKind, seed: number, level: number): Steps {
  const key = `${kind}:${seed >>> 0}:${level}`;
  if (cache.has(key)) return cache.get(key)!;
  let out: Steps;
  if (layoutOf(kind)) {
    const mods = machineModules(kind, seed, level);
    const list: StepInfo[] = [];
    const parts: number[][] = [];
    const byId = new Map<string, number>(), ofModule = new Map<string, number[]>();
    for (const { mod, parts: rolled } of mods) {
      const outer: number[] = [], inner: number[] = [], mine: { label: string; index: number }[] = [];
      for (const s of mod.steps) {
        if (s.with && !s.with.every((id) => mods.some((m) => m.mod.id === id))) continue;
        const after = new Set<number>();
        for (const key of s.after) {
          const one = byId.get(key);
          if (one !== undefined) after.add(one);
          else if (ofModule.has(key)) for (const i of ofModule.get(key)!) after.add(i);
          else for (const m of mine) if (m.label === key) after.add(m.index);
        }
        if (s.inner) for (const i of outer) after.add(i);
        const index = list.length;
        list.push({ module: mod.id, inner: !!s.inner, after: [...after] });
        mine.push({ label: s.label, index });
        byId.set(s.id, index);
        (s.inner ? inner : outer).push(index);
      }
      ofModule.set(mod.id, outer);
      for (const p of rolled) parts[p.index] = p.at.inner && inner.length ? inner : outer;
    }
    out = { list, modules: mods.length, parts };
  } else {
    const rules = codeMachineSteps(kind, seed, level);
    out = { list: rules.steps.map((after) => ({ module: '', inner: false, after })), modules: 0, parts: rules.parts };
  }
  if (cache.size > 256) cache.clear();
  cache.set(key, out);
  return out;
}

export const stepAllowed = (rules: Steps, done: ReadonlySet<number>, i: number) => !!rules.list[i] && !done.has(i) && rules.list[i].after.every((n) => done.has(n));
export const partAllowed = (rules: Steps, done: ReadonlySet<number>, i: number) => !!rules.parts[i] && rules.parts[i].every((n) => done.has(n));
