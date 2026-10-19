// What the steps of a model-built machine (shared/machines.ts) are, by index, for the server: the steps are numbered in the order
// src/teardown/glbMachine.ts builds them (each module's steps in turn, those that join something that is not there left out). The
// server uses it to know when a module has come off, a piece on the ground has been taken apart, or the whole machine is finished
// (the scrap they give, shared/tables.ts SCRAP_REWARD).
import { machineModules } from './machine.ts';
import { layoutOf } from './machines.ts';
import type { JunkKind } from './salvage.ts';

export interface StepInfo {
  module: string;
  /** Done on the piece once it has come off (not on the machine). */
  inner: boolean;
}

const cache = new Map<string, { list: StepInfo[]; modules: number } | null>();

/** The machine's steps in index order and how many modules it has, or null for a machine built in code (nothing is known of its steps). */
export function stepList(kind: JunkKind, seed: number, level: number): { list: StepInfo[]; modules: number } | null {
  const key = `${kind}:${seed >>> 0}:${level}`;
  if (cache.has(key)) return cache.get(key)!;
  let out: { list: StepInfo[]; modules: number } | null = null;
  if (layoutOf(kind)) {
    const mods = machineModules(kind, seed, level);
    const list: StepInfo[] = [];
    for (const { mod } of mods) for (const s of mod.steps) if (!s.with || s.with.every((id) => mods.some((m) => m.mod.id === id))) list.push({ module: mod.id, inner: !!s.inner });
    out = { list, modules: mods.length };
  }
  if (cache.size > 256) cache.clear();
  cache.set(key, out);
  return out;
}
