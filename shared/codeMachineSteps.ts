// Run the shared recipes without constructing geometry, materials, shaders, or loading assets.
// Shape values are opaque to the rules: only steps, their prerequisites and part mounts are recorded.
import { BUILDERS } from './machineBuilders.ts';
import { machineParts } from './machine.ts';
import { TIERS, type JunkKind, type PartId, type Tier } from './salvage.ts';
import type { Kit } from '../src/teardown/junk.ts';

export type MachineRules = { steps: number[][]; parts: number[][] };
type Roll = { tier: Tier; index: number };
type RuleStep = { index: number; after: RuleStep[] };

// Recipes manipulate visual handles (position/rotation/geometry) but never read them to decide rules.
const inert: unknown = new Proxy(function () {}, {
  get: (_target, key) => key === Symbol.toPrimitive ? () => 0 : inert,
  apply: () => inert,
  construct: () => inert as object,
  set: () => true,
});

export function codeMachineSteps(kind: JunkKind, seed: number, level: number): MachineRules {
  const rolled = machineParts(kind, seed, level);
  const queues = new Map<PartId, Roll[]>();
  for (const [index, p] of rolled.entries()) {
    if (!queues.has(p.part)) queues.set(p.part, []);
    queues.get(p.part)!.push({ tier: p.tier, index });
  }
  const steps: RuleStep[] = [];
  const parts: number[][] = new Array(rolled.length);
  const add = (after: RuleStep[] = []) => {
    const s = { index: steps.length, after };
    steps.push(s);
    return s;
  };
  const adapter = {
    shapes: inert,
    grade: Math.max(0, ...rolled.map((p) => TIERS.indexOf(p.tier))),
    take: (part: PartId) => queues.get(part)?.shift() ?? null,
    screw: (_l: unknown, _p: unknown, _n?: unknown, after?: RuleStep[]) => add(after),
    bolt: (_l: unknown, _p: unknown, _n?: unknown, after?: RuleStep[]) => add(after),
    clip: (_l: unknown, _p: unknown, _n?: unknown, _clicks?: unknown, after?: RuleStep[]) => add(after),
    pry: (_l: unknown, _p: unknown, _n?: unknown, after?: RuleStep[]) => add(after),
    lift: (_l: unknown, _p: unknown, _n?: unknown, after?: RuleStep[]) => add(after),
    wire: (_l: unknown, _p: unknown, _key?: unknown, after?: RuleStep[]) => add(after),
    circle: (_l: unknown, _c: unknown, _nrm: unknown, _r: unknown, n: number, after?: RuleStep[]) => Array.from({ length: n }, () => add(after)),
    rect: (_l: unknown, _c: unknown, _nrm: unknown, _w: unknown, _h: unknown, after?: RuleStep[]) => [add(after), add(after)],
    row: (_l: unknown, _a: unknown, _b: unknown, n: number, _nrm: unknown, after?: RuleStep[]) => Array.from({ length: n }, () => add(after)),
    cover: (_o: unknown, holds: RuleStep[]) => ({ holds }),
    bay: (_x: unknown, _z: unknown, _w: unknown, _d: unknown, _deck: unknown, _h: unknown, o: { screws?: number; latch?: boolean; pry?: boolean } = {}) => {
      const n = o.screws ?? 2;
      const holds = Array.from({ length: n === 4 ? 4 : n === 2 ? 2 : 0 }, () => add());
      if (o.latch) holds.push(add());
      if (o.pry) holds.push(add([...holds]));
      return { holds };
    },
    ax: () => [inert, inert],
    part: (_part: PartId, roll: Roll, _p: unknown, holds: RuleStep[]) => { parts[roll.index] = holds.map((s) => s.index); return inert; },
    mount(part: PartId, _place: unknown, holds: (tier: Tier) => RuleStep[]) {
      const roll = this.take(part);
      return roll ? this.part(part, roll, null, holds(roll.tier)) : null;
    },
  };
  const kit = new Proxy(adapter, { get: (o, key) => Reflect.has(o, key) ? Reflect.get(o, key) : inert });
  BUILDERS[kind](kit as unknown as Kit);
  if (parts.some((p) => !p) || parts.filter(Boolean).length !== rolled.length) throw new Error(`missing machine rule mount: ${kind}`);
  return { steps: steps.map((s) => s.after.map((a) => a.index)), parts };
}
