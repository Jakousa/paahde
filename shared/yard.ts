// The dev machine yard: a few rows of machines on the sand in front of the bunker, one of every kind, so each can be
// walked up to and taken apart at once with the real disassembly mode, the server's sessions, scrap and part grants
// and other players (docs: the machines program, "dev yard"). Development only: the server turns it on with the
// `--yard` flag (npm run dev:yard) and tells clients ('yard'); production never has it.
// Each yard machine is a site like the crash sites' (shared/crash.ts `CrashSite`, ids "yard:<n>"), worked in place
// even when its kind is small enough to carry, with its saved progress in the world's database like any other.
import { BASE } from './base.ts';
import type { CrashSite } from './crash.ts';
import type { JunkKind } from './salvage.ts';

let on = false;
export const yardOn = () => on;
export function setYard(v: boolean) {
  on = v;
}

/** Every kind of machine, in rows from the entrance outwards; new kinds are added as they are made. */
export const YARD_KINDS: JunkKind[][] = [
  // the machine under review, three seeds of it (what survived differs), then the ones not reworked yet
  ['jet_engine', 'jet_engine', 'jet_engine'],
  ['winch', 'solenoid_valve', 'beacon', 'control_cabinet', 'robot_arm'],
  ['pump_housing', 'vehicle_frame', 'water_jet', 'warp_core', 'ai_control'],
];
/** Metres between machines along a row, from the entrance to the first row, and between rows. */
const GAP = 11;
const FIRST_ROW = 24;
const ROW_GAP = 14;

let cache: CrashSite[] | null = null;

export function yardSites(): CrashSite[] {
  if (cache) return cache;
  const out: CrashSite[] = [];
  YARD_KINDS.forEach((row, r) => {
    row.forEach((kind, i) => {
      const index = out.length;
      out.push({
        id: `yard:${index}`, wreck: -1, index, level: 2, yard: true, kind, seed: 1000 + index * 7919,
        x: BASE.x + (i - (row.length - 1) / 2) * GAP, z: BASE.z + FIRST_ROW + r * ROW_GAP, yaw: 0,
      });
    });
  });
  return (cache = out);
}

/** The yard machine with this id ("yard:<n>"), or null (also when the yard is off). Ids may come from the network. */
export function yardById(id: unknown): CrashSite | null {
  if (!on || typeof id !== 'string') return null;
  const m = /^yard:(\d{1,3})$/.exec(id);
  return (m && yardSites()[Number(m[1])]) || null;
}
