// Machine sites: the wrecked machinery lying at the crashed spacecraft (shared/crashsites.ts `machines`), one
// component each (COMPONENTS in salvage.ts) that you take apart where it lies (large) or carry home (small),
// src/teardown. Every crash site has one large machine next to its wreck and 0–2 small ones in the debris trail; a
// scrap field (site level 0) only 2–3 small ones. Which kinds lie where depends on the site's level, and so do the
// large machines' part tiers (shared/tables.ts LEVEL_KINDS, LEVEL_TIERS).
// The layout is the crash sites' (deterministic, integer hashing), so every client sees the same machines with the
// same contents. Ids are "<crash site id>:<index>", index 0 the large machine (if the site has one).
import { BASE_SPAWN } from './base.ts';
import { crashSite, crashSitesNear, crashTaken, type CrashSite as Wreck } from './crashsites.ts';
import type { LootLevel } from './crashsites.ts';
import { COMPONENTS, SALVAGE, junkSpec, type ComponentKind, type JunkKind, type SalvageId } from './salvage.ts';
import { labById, labSites } from './lab.ts';
import { jetSiteById, jetSites } from './jetcrash.ts';
import { STATIONS } from './stations.ts';
import { LEVEL_KINDS } from './tables.ts';
import { mulberry32 as seeded } from './noise.ts';

/** Deterministic PRNG from a seed (integer hashing only). */
export { seeded };

/** Components small enough to carry, and the salvage wrecks (shared/wrecks.ts); each is an item of the same kind
 *  (shared/items.ts) in the bag, taken apart on the disassembly table. */
export const CARRY_KINDS: JunkKind[] = [
  ...(Object.keys(COMPONENTS) as ComponentKind[]).filter((k) => COMPONENTS[k].carry),
  ...(Object.keys(SALVAGE) as SalvageId[]),
];
/** Where carried components are taken apart: the disassembly table in the base (shared/stations.ts). `top` is the
 *  tabletop's height, `floor` the room's. */
const TABLE = STATIONS.find((s) => s.kind === 'disassembly');
export const BENCH = TABLE
  ? { x: (TABLE.x0 + TABLE.x1) / 2, z: (TABLE.z0 + TABLE.z1) / 2, top: TABLE.y1, floor: TABLE.y0, w: TABLE.x1 - TABLE.x0, d: TABLE.z1 - TABLE.z0 }
  : { x: BASE_SPAWN.x, z: BASE_SPAWN.z, top: 0, floor: 0, w: 1, d: 1 };
/** How far (m) from a large site you may be to work on it with others. */
export const SITE_RANGE = 14;

/** Small sites whose component, wrecks (shared/wrecks.ts) and crash debris that have been carried off (shared/crashsites.ts). */
export { crashTaken };
export const crashListeners: (() => void)[] = [];
/** Crash sites (numeric shared/crashsites.ts ids) whose large machine has been stripped of every part: no smoke,
 *  no beeping, and its frame was scrapped. Kept in step with the server ('crashSpent' messages). */
export const crashSpent = new Set<number>();
/** Crash sites (numeric shared/crashsites.ts ids) someone has picked something up from (a part off its large machine, a
 *  small machine, debris, a find lying there): it has been visited, and stops smoking for good (src/world/crashsites.ts).
 *  Kept in step with the server ('crashVisited' messages). */
export const crashVisited = new Set<number>();
/** The large machine at this site had its frame scrapped (every part out, then mashed to scrap): it is gone, solid and drawn no more. */
export const siteSpent = (site: CrashSite) => !site.lab && !junkSpec(site.kind).carry && crashSpent.has(site.wreck);
export function crashChanged() {
  for (const f of crashListeners) f();
}

/** Version of the machines' step lists (src/teardown/junk.ts, wrecks.ts): saved steps-done indexes are only kept
 *  when they were saved under this layout. Bump it whenever a machine's steps change order or number. */
export const TEARDOWN_LAYOUT = 12;

/** How close you must be (m) for the "Disassemble" prompt. */
export const CRASH_REACH = 4.5;

export interface CrashSite {
  /** Unique, stable id: "<crash site id>:<index>", index 0 the large machine (if the site has one). */
  id: string;
  /** The crash site (shared/crashsites.ts id) it lies at. */
  wreck: number;
  /** Index at the crash site: 0 is the large machine (if any), then the small ones. */
  index: number;
  /** The crash site's loot level (shared/crashsites.ts LootLevel): its large machine's parts roll by it. */
  level: LootLevel;
  x: number;
  z: number;
  /** Heading of the component, radians (three.js rotation.y; the machine lies across its throw direction). */
  yaw: number;
  kind: JunkKind;
  /** Seeds what is inside (tiers). */
  seed: number;
  /** A machine of the dev test lab (shared/lab.ts) or an engine torn off a downed jet (shared/jetcrash.ts): worked in place whatever its size, never spent. */
  lab?: boolean;
}

function pickKind(u: number, carry: boolean, level: LootLevel): ComponentKind {
  const ks = (Object.entries(LEVEL_KINDS[level]) as [ComponentKind, number][]).filter(([k]) => COMPONENTS[k].carry === carry);
  let r = u * ks.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of ks) if ((r -= w) < 0) return k;
  return ks[0][0];
}

const cache = new Map<number, CrashSite[]>();

/** The machine sites at crash site `w`. */
export function machinesAt(w: Wreck): CrashSite[] {
  let out = cache.get(w.id);
  if (out) return out;
  out = w.machines.map((m, index) => {
    const r = seeded(m.seed);
    const kind = pickKind(r(), !m.large, w.loot);
    return { id: `${w.id}:${index}`, wreck: w.id, index, level: w.loot, x: m.x, z: m.z, yaw: Math.atan2(m.dx, m.dz), kind, seed: (r() * 4294967296) >>> 0 };
  });
  cache.set(w.id, out);
  return out;
}

/** The site with this id ("<crash site id>:<index>"), or null. Ids may come from the network: this validates them. */
export function crashSiteById(id: unknown): CrashSite | null {
  if (typeof id !== 'string') return null;
  const y = labById(id) ?? jetSiteById(id);
  if (y) return y;
  const m = /^(\d{1,16}):(\d)$/.exec(id);
  const w = m ? crashSite(Number(m[1])) : undefined;
  return (w && machinesAt(w)[Number(m![2])]) ?? null;
}


/** Every machine site within `radius` of (x, z). */
export function sitesNear(x: number, z: number, radius: number): CrashSite[] {
  const out: CrashSite[] = [];
  for (const s of labSites()) if (Math.hypot(s.x - x, s.z - z) <= radius) out.push(s);
  for (const s of jetSites()) if (Math.hypot(s.x - x, s.z - z) <= radius) out.push(s);
  for (const w of crashSitesNear(x, z, radius + 40)) {
    for (const s of machinesAt(w)) if (Math.hypot(s.x - x, s.z - z) <= radius) out.push(s);
  }
  return out;
}
