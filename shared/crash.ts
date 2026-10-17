// Crash sites: where wrecked machinery lies in the desert, one component each (COMPONENTS in salvage.ts) that
// you walk up to and take apart on the spot (src/teardown). Layout is deterministic like shared/scrap.ts,
// integer hashing and exact arithmetic only, so every client sees the same sites with the same contents.
// Taking things apart is local for now: nothing about a site changes on the server.
import { BASE_SPAWN, padBlend } from './base.ts';
import { COMPONENTS, type ComponentKind } from './salvage.ts';
import { STATIONS } from './stations.ts';
import { baseHeight, WORLD_HALF, WORLD_SEED } from './terrain.ts';

/** Components small enough to carry; each is an item of the same kind (shared/items.ts) in the bag. */
export const CARRY_KINDS = (Object.keys(COMPONENTS) as ComponentKind[]).filter((k) => COMPONENTS[k].carry);
/** Where carried components are taken apart: the disassembly table in the base (shared/stations.ts). `top` is the
 *  tabletop's height, `floor` the room's. */
const TABLE = STATIONS.find((s) => s.kind === 'disassembly');
export const BENCH = TABLE
  ? { x: (TABLE.x0 + TABLE.x1) / 2, z: (TABLE.z0 + TABLE.z1) / 2, top: TABLE.y1, floor: TABLE.y0, w: TABLE.x1 - TABLE.x0, d: TABLE.z1 - TABLE.z0 }
  : { x: BASE_SPAWN.x, z: BASE_SPAWN.z, top: 0, floor: 0, w: 1, d: 1 };
/** How far (m) from a large site you may be to work on it with others. */
export const SITE_RANGE = 14;

/** Small sites whose component has been carried off, kept in step with the server ('crash' messages). */
export const crashTaken = new Set<string>();
export const crashListeners: (() => void)[] = [];
export function crashChanged() {
  for (const f of crashListeners) f();
}

/** Grid cell size (m); each cell holds at most one site. */
export const CRASH_CELL = 240;
const DENSITY = 0.4;
/** How close you must be (m) for the "Disassemble" prompt. */
export const CRASH_REACH = 4.5;
const MAX_GRAD2 = 1 / (0.92 * 0.92) - 1;

export interface CrashSite {
  /** Unique, stable id (cell "ix,iz", or "start" / "start2" near the base). */
  id: string;
  x: number;
  z: number;
  /** Heading of the component, radians. */
  yaw: number;
  kind: ComponentKind;
  /** Seeds what is inside (tiers) and the scattered wreckage. */
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

function flatEnough(x: number, z: number): boolean {
  const e = 0.5;
  const gx = (baseHeight(x + e, z) - baseHeight(x - e, z)) / (2 * e);
  const gz = (baseHeight(x, z + e) - baseHeight(x, z - e)) / (2 * e);
  return gx * gx + gz * gz < MAX_GRAD2;
}

const KINDS = Object.keys(COMPONENTS) as ComponentKind[];
const TOTAL = KINDS.reduce((s, k) => s + COMPONENTS[k].weight, 0);
function pickKind(u: number): ComponentKind {
  let r = u * TOTAL;
  for (const k of KINDS) if ((r -= COMPONENTS[k].weight) < 0) return k;
  return KINDS[0];
}

function make(id: string, x: number, z: number, r: () => number, kind?: ComponentKind): CrashSite {
  return { id, x, z, yaw: r() * 6.2831853, kind: kind ?? pickKind(r()), seed: (r() * 4294967296) >>> 0 };
}

function cellRng(ix: number, iz: number) {
  return seeded(Math.imul(ix | 0, 0x2545f491) ^ Math.imul(iz | 0, 0x4f1bbcdd) ^ Math.imul(WORLD_SEED, 0x9e3779b1) ^ 0x7ac3);
}

const cache = new Map<string, CrashSite | null>();

/** The site in cell (ix, iz), or null. */
export function crashSiteAt(ix: number, iz: number): CrashSite | null {
  const k = `${ix},${iz}`;
  let s = cache.get(k);
  if (s === undefined) cache.set(k, (s = generate(ix, iz)));
  return s;
}

function generate(ix: number, iz: number): CrashSite | null {
  const r = cellRng(ix, iz);
  if (r() >= DENSITY) return null;
  for (let t = 0; t < 4; t++) {
    const x = (ix + 0.1 + 0.8 * r()) * CRASH_CELL;
    const z = (iz + 0.1 + 0.8 * r()) * CRASH_CELL;
    if (Math.abs(x) < WORLD_HALF - 10 && Math.abs(z) < WORLD_HALF - 10 && flatEnough(x, z) && padBlend(x, z) > 0.3) return make(`${ix},${iz}`, x, z, r);
  }
  return null;
}

/** A site close to where new players start, so there is something to take apart straight away. */
const STARTER_OFFSETS: [number, number][] = [[24, 10], [-24, 10], [10, 26], [-10, 26], [30, 0], [-30, 0], [18, -24], [-18, -24], [0, 34], [36, 14], [-36, 14], [0, -36]];
let starters: CrashSite[] | undefined;
/** Two near the base: a large one (taken apart where it lies) and a small one (carry it home). */
function starterSites(): CrashSite[] {
  if (starters) return starters;
  starters = [];
  const kinds: [string, ComponentKind][] = [['start', 'pump_housing'], ['start2', 'control_cabinet']];
  for (const [dx, dz] of STARTER_OFFSETS) {
    const x = BASE_SPAWN.x + dx, z = BASE_SPAWN.z + dz;
    if (!flatEnough(x, z) || padBlend(x, z) <= 0.3) continue;
    if (starters.some((s) => Math.hypot(s.x - x, s.z - z) < 14)) continue;
    const [id, kind] = kinds[starters.length];
    starters.push(make(id, x, z, cellRng(7, 7 + starters.length), kind));
    if (starters.length === kinds.length) break;
  }
  return starters;
}

/** The site with this id ("start" or "ix,iz"), or null. */
export function crashSiteById(id: unknown): CrashSite | null {
  if (typeof id !== 'string') return null;
  if (id === 'start' || id === 'start2') return starterSites().find((s) => s.id === id) ?? null;
  const m = /^(-?\d{1,5}),(-?\d{1,5})$/.exec(id);
  return m ? crashSiteAt(Number(m[1]), Number(m[2])) : null;
}

/** Every site within `radius` of (x, z). */
export function sitesNear(x: number, z: number, radius: number): CrashSite[] {
  const out: CrashSite[] = [];
  for (const s0 of starterSites()) if (Math.hypot(s0.x - x, s0.z - z) <= radius) out.push(s0);
  const n = Math.ceil(radius / CRASH_CELL);
  const cx = Math.floor(x / CRASH_CELL), cz = Math.floor(z / CRASH_CELL);
  for (let iz = cz - n; iz <= cz + n; iz++) {
    for (let ix = cx - n; ix <= cx + n; ix++) {
      const s = crashSiteAt(ix, iz);
      if (s && Math.hypot(s.x - x, s.z - z) <= radius) out.push(s);
    }
  }
  return out;
}
