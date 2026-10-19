// Machines built from a Blender model (tools/blender/machines/<model>.py), as opposed to the ones built in code
// (src/teardown/junk.ts). The script writes the model and a layout (shared/machines/<kind>.ts): the machine's modules, each
// with the chance it is still on a given machine, the steps that hold it and the parts inside. A machine's seed picks which
// modules are there and which of their parts survived, so two engines of one kind differ in what is left to take apart.
// Run by both the client (what to build) and the server (which parts exist), so the draws below must stay deterministic.
import { LEVEL_TIERS } from './tables.ts';
import { pickTier } from './parts.ts';
import { junkSpec, TIERS, type JunkKind, type PartId, type Tier } from './salvage.ts';
import type { SiteLevel } from './crashsites.ts';
import { LAYOUT as TURBOFAN } from './machines/turbofan.ts';

export interface LayoutStep {
  id: string;
  kind: 'screw' | 'bolt' | 'clip' | 'pry' | 'lift' | 'wire' | 'grind' | 'mash';
  /** Key into TEXT.steps. */
  label: string;
  /** Not wires: where it is and which way its face points (the machine's frame, metres, y up). */
  pos?: number[];
  nrm?: number[];
  /** Wires and seams: the path (a seam is followed with the grinder), the wire's colour key and the cable's radius. */
  pts?: number[][];
  key?: string;
  r?: number;
  /** Step ids, a step label of the same module, or module ids: all of those must be done first (an absent module counts as done). */
  after: string[];
  need?: number;
  players?: number;
  /** Done on the piece once it has come off (it lies on the ground), not on the machine it came from. */
  inner?: boolean;
}

export interface LayoutPart {
  part: PartId;
  pos: number[];
  /** Orientation as a quaternion x, y, z, w (the part model's +y is its axis). */
  quat: number[];
  /** Chance it is still in a machine whose module is there. */
  chance: number;
  /** Inside the module: freed by its inner steps, on the piece lying on the ground. */
  inner?: boolean;
}

export interface LayoutModule {
  id: string;
  /** Chance the module is still on a given machine. */
  chance: number;
  /** The way it falls when its steps are done. */
  pop: number[];
  steps: LayoutStep[];
  parts: LayoutPart[];
}

export interface MachineLayout {
  kind: string;
  model: string;
  modules: LayoutModule[];
}

const LAYOUTS: Partial<Record<JunkKind, MachineLayout>> = { jet_engine: TURBOFAN };

/** The layout of a model-built machine, or undefined for one built in code. */
export const layoutOf = (kind: JunkKind): MachineLayout | undefined => LAYOUTS[kind];

export interface RolledPart {
  part: PartId;
  tier: Tier;
  /** Index into machineParts() (shared/machine.ts). */
  index: number;
  at: LayoutPart;
}

export interface RolledModule {
  mod: LayoutModule;
  parts: RolledPart[];
}

/** Which modules a machine has and what is inside them. `rand` is shared/crash.ts seeded(seed). Presence is drawn first for every module,
 *  then the parts of the modules that are there, so adding a part to the end of a module never moves the others. */
export function rollModules(kind: JunkKind, rand: () => number, level: number): RolledModule[] {
  const layout = LAYOUTS[kind];
  if (!layout) return [];
  const spec = junkSpec(kind);
  const boost = LEVEL_TIERS[level as SiteLevel] ?? LEVEL_TIERS[1];
  const weights = Object.fromEntries(TIERS.map((t) => [t, (spec.tierWeights[t] ?? 0) * boost[t]])) as Record<Tier, number>;
  const present = layout.modules.filter((m) => rand() < m.chance);
  const out: RolledModule[] = [];
  let index = 0;
  for (const mod of present) {
    const parts: RolledPart[] = [];
    for (const at of mod.parts) if (rand() < at.chance) parts.push({ part: at.part, tier: pickTier(weights, rand), index: index++, at });
    out.push({ mod, parts });
  }
  return out;
}
