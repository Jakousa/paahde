// The dev test lab: world `?w=lab` (shared/world.ts LAB, development only), a flat bright room next to the bunker where
// every machine can be taken apart with the real disassembly mode (the server's sessions, part grants, other players)
// and every part, gear and tool lies on the floor to pick up. Nothing of the desert is in it: the ground is one height
// (baseHeight in shared/terrain.ts), the layouts of rocks, scrap, wrecks, crash sites and shelters are empty, the
// clock stands at noon, and the server runs no storms, jets, walkers, bosses or heat (server/world.ts).
//
// Layout, in metres from the bunker's door (BASE; +Z is out into the open, away from the door), x across:
//   spawn      (0, 12), looking out at the machine rows
//   parts      x 24..33, z 8..38: 11 parts (rows, a name plate left of each) x 4 tiers (columns, tier plates at z 5)
//   tools+gear x -24 down to -39, z 8 on: the grinder, then every gear kind, broken with every slot empty, 4 a row
//   machines   z 50 / 70 / 90: the jet engine in six seeds, then the other kinds, each with its name plate in front
// The pickups come back at once when taken (server/loot.ts), so a table never runs out.
import { BASE } from './base.ts';
import type { CrashSite } from './crash.ts';
import { GEAR, GEAR_KINDS } from './gear.ts';
import { ITEMS } from './items.ts';
import { PART_IDS, partItem } from './parts.ts';
import { junkSpec, TIERS, type JunkKind } from './salvage.ts';
import { TEXT } from './text.ts';
import { LAB } from './world.ts';

export { LAB };

/** Machine rows, nearest first; new kinds are added as they are made. */
export const LAB_ROWS: JunkKind[][] = [
  // the machine under review, six seeds of it (which shell halves and modules survive differs), then the ones not reworked yet
  ['jet_engine', 'jet_engine', 'jet_engine', 'jet_engine', 'jet_engine', 'jet_engine'],
  ['winch', 'solenoid_valve', 'beacon', 'control_cabinet', 'robot_arm'],
  ['pump_housing', 'vehicle_frame', 'water_jet', 'warp_core', 'ai_control'],
];
const GAP = 16;
const FIRST_ROW = 50;
const ROW_GAP = 20;

const at = (lx: number, lz: number) => ({ x: BASE.x + lx, z: BASE.z + lz });

/** Where a new player appears, and the point they face. */
export const LAB_SPAWN = at(0, 12);
export const LAB_LOOK = at(0, FIRST_ROW);

let cache: CrashSite[] | null = null;

/** The machines, as work sites (ids "lab:<n>", like the crash sites' shared/crash.ts `CrashSite`): worked in place
 *  whatever their size, never spent, their progress saved in the world's database like any other. */
export function labSites(): CrashSite[] {
  if (!LAB) return [];
  if (cache) return cache;
  const out: CrashSite[] = [];
  LAB_ROWS.forEach((row, r) => {
    row.forEach((kind, i) => {
      const index = out.length;
      out.push({
        id: `lab:${index}`, wreck: -1, index, level: 2, lab: true, kind, seed: 1000 + index * 7919,
        ...at((i - (row.length - 1) / 2) * GAP, FIRST_ROW + r * ROW_GAP), yaw: 0,
      });
    });
  });
  return (cache = out);
}

/** The lab machine with this id ("lab:<n>"), or null (also outside the lab). Ids may come from the network. */
export function labById(id: unknown): CrashSite | null {
  if (!LAB || typeof id !== 'string') return null;
  const m = /^lab:(\d{1,3})$/.exec(id);
  return (m && labSites()[Number(m[1])]) || null;
}

/** An item lying on the lab floor: kind and, for gear, the parts it comes with (all slots empty: broken). */
export type LabItem = { kind: string; parts?: (string | null)[]; x: number; z: number; /** gets a plate of its own (parts have row and column plates) */ plate?: true };

let items: LabItem[] | null = null;

/** Every part in every tier, the grinder and every gear kind. */
export function labItems(): LabItem[] {
  if (!LAB) return [];
  if (items) return items;
  const out: LabItem[] = [];
  PART_IDS.forEach((part, r) => TIERS.forEach((tier, c) => out.push({ kind: partItem(part, tier), ...at(24 + c * 3, 8 + r * 3) })));
  ['grinder', ...GEAR_KINDS].forEach((kind, i) => {
    const gear = GEAR[kind];
    out.push({ kind, ...(gear ? { parts: gear.slots.map(() => null) } : {}), plate: true, ...at(-24 - (i % 4) * 4, 8 + Math.floor(i / 4) * 4) });
  });
  return (items = out);
}

/** A name plate lying on the floor, readable from the spawn side. */
export type LabPlate = { text: string; x: number; z: number; w: number };

/** Dev-only words (docs/text.md): the lab's plates, from the game's own names plus numbers. */
export function labPlates(): LabPlate[] {
  if (!LAB) return [];
  const out: LabPlate[] = [];
  const seeds = new Map<string, number>();
  for (const s of labSites()) {
    const n = (seeds.get(s.kind) ?? 0) + 1;
    seeds.set(s.kind, n);
    const same = LAB_ROWS.flat().filter((k) => k === s.kind).length;
    const label = junkSpec(s.kind).label;
    out.push({ text: same > 1 ? `${label} #${n}  seed ${s.seed}` : label, x: s.x, z: s.z + 4.2, w: 3.6 });
  }
  PART_IDS.forEach((part, r) => out.push({ text: TEXT.parts[part], ...at(20.5, 8 + r * 3), w: 2.6 }));
  TIERS.forEach((tier, c) => out.push({ text: TEXT.tiers[tier], ...at(24 + c * 3, 5), w: 2.6 }));
  labItems().filter((it) => it.plate).forEach((it) => {
    out.push({ text: ITEMS[it.kind]?.label ?? it.kind, x: it.x, z: it.z + 1.3, w: 2.6 });
  });
  return out;
}
