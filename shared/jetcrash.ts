// Where a downed jet (shared/jets.ts) crashed: the wreck of the plane stays for good (drawn by src/world/jets.ts), its right engine torn off
// and lying a little way on as a machine to take apart (kind jet_engine, level 2: the good parts), the sand dug up round them
// (server/world.ts). The server keeps the list (server/jetcrash.ts, saved in the world's database) and sends it to everyone;
// the engines are machine sites like any other (shared/crash.ts, ids "jet:<n>").
import type { CrashSite } from './crash.ts';

export interface JetCrash {
  id: number;
  /** The flight it was (shared/jets.ts Jet.id), while that is still in the air list. */
  jet: number;
  /** The plane's wreck pose (the origin at its centre; three.js: heading, nose up, roll). */
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  bank: number;
  /** The engine on the ground: where and which way it lies. */
  ex: number;
  ez: number;
  eyaw: number;
  /** Seeds what is in the engine. */
  seed: number;
}

/** How many crash sites the world keeps; the oldest go first. */
export const JET_CRASH_MAX = 12;

let crashes = new Map<number, JetCrash>();
const sites = new Map<number, CrashSite>();
export const jetCrashListeners: (() => void)[] = [];

export function jetCrashList(): JetCrash[] {
  return [...crashes.values()];
}

/** Replace (`reset`) or add to the list: from the server's 'jetCrashes' message, or its own database. */
export function setJetCrashes(list: JetCrash[], reset = true) {
  if (reset) {
    crashes = new Map();
    sites.clear();
  }
  for (const c of list) crashes.set(c.id, c);
  for (const f of jetCrashListeners) f();
}

function siteOf(c: JetCrash): CrashSite {
  let s = sites.get(c.id);
  if (!s) {
    // (worked in place, never spent: like the lab's machines)
    sites.set(c.id, (s = { id: `jet:${c.id}`, wreck: -1, index: 0, level: 2, lab: true, x: c.ex, z: c.ez, yaw: c.eyaw, kind: 'jet_engine', seed: c.seed }));
  }
  return s;
}

/** Every torn-off engine, as a machine site. */
export function jetSites(): CrashSite[] {
  return jetCrashList().map(siteOf);
}

/** The engine site with this id ("jet:<n>"), or null. Ids may come from the network. */
export function jetSiteById(id: unknown): CrashSite | null {
  if (typeof id !== 'string') return null;
  const m = /^jet:(\d{1,9})$/.exec(id);
  const c = m ? crashes.get(Number(m[1])) : undefined;
  return c ? siteOf(c) : null;
}
