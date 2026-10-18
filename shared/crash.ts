// Machine sites: the wrecked machinery lying at the crashed spacecraft (shared/crashsites.ts `machines`), one
// component each (COMPONENTS in salvage.ts) that you take apart where it lies (large) or carry home (small),
// src/teardown. Every crash site has one large machine next to its wreck and 0–2 small ones in the debris trail; a
// scrap field (site level 0) only 2–3 small ones. Which kinds lie where depends on the site's level, and so do the
// large machines' part tiers (shared/tables.ts LEVEL_KINDS, LEVEL_TIERS).
// The layout is the crash sites' (deterministic, integer hashing), so every client sees the same machines with the
// same contents. Ids are "<crash site id>:<index>", index 0 the large machine (if the site has one).
import { BASE_SPAWN } from './base.ts';
import { crashSite, crashSitesNear, crashTaken, type CrashSite as Wreck } from './crashsites.ts';
import type { SiteLevel } from './crashsites.ts';
import { COMPONENTS, SALVAGE, type ComponentKind, type JunkKind, type SalvageId } from './salvage.ts';
import { STATIONS } from './stations.ts';
import { LEVEL_KINDS } from './tables.ts';

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
 *  no beeping, the machine stays a husk. Kept in step with the server ('crashSpent' messages). */
export const crashSpent = new Set<number>();
export function crashChanged() {
  for (const f of crashListeners) f();
}

/** Version of the machines' step lists (src/teardown/junk.ts, wrecks.ts): saved steps-done indexes are only kept
 *  when they were saved under this layout. Bump it whenever a machine's steps change order or number. */
export const TEARDOWN_LAYOUT = 2;

/** How close you must be (m) for the "Disassemble" prompt. */
export const CRASH_REACH = 4.5;

export interface CrashSite {
  /** Unique, stable id: "<crash site id>:<index>", index 0 the large machine (if the site has one). */
  id: string;
  /** The crash site (shared/crashsites.ts id) it lies at. */
  wreck: number;
  /** Index at the crash site: 0 is the large machine (if any), then the small ones. */
  index: number;
  /** The crash site's level (shared/crashsites.ts SiteLevel): its large machine's parts roll by it. */
  level: SiteLevel;
  x: number;
  z: number;
  /** Heading of the component, radians (three.js rotation.y; the machine lies across its throw direction). */
  yaw: number;
  kind: ComponentKind;
  /** Seeds what is inside (tiers). */
  seed: number;
}

/** Deterministic PRNG from a seed (integer hashing only). */
export function seeded(seed: number) {
  let h = seed | 0;
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickKind(u: number, carry: boolean, level: SiteLevel): ComponentKind {
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
    const kind = pickKind(r(), !m.large, w.level);
    return { id: `${w.id}:${index}`, wreck: w.id, index, level: w.level, x: m.x, z: m.z, yaw: Math.atan2(m.dx, m.dz), kind, seed: (r() * 4294967296) >>> 0 };
  });
  cache.set(w.id, out);
  return out;
}

/** The site with this id ("<crash site id>:<index>"), or null. Ids may come from the network: this validates them. */
export function crashSiteById(id: unknown): CrashSite | null {
  if (typeof id !== 'string') return null;
  const m = /^(\d{1,16}):(\d)$/.exec(id);
  const w = m ? crashSite(Number(m[1])) : undefined;
  return (w && machinesAt(w)[Number(m![2])]) ?? null;
}


/** Every machine site within `radius` of (x, z). */
export function sitesNear(x: number, z: number, radius: number): CrashSite[] {
  const out: CrashSite[] = [];
  for (const w of crashSitesNear(x, z, radius + 40)) {
    for (const s of machinesAt(w)) if (Math.hypot(s.x - x, s.z - z) <= radius) out.push(s);
  }
  return out;
}
