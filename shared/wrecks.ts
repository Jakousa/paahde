// Salvage wrecks (GitHub issue #13): big broken objects lying out in the desert, one per site (SALVAGE in
// salvage.ts: a vehicle frame, a jet ski, an AI rack, now and then a warp drive core). You carry one home (it
// becomes an item of the same kind in the bag) and take it apart on the base's disassembly table, the same way as
// the small crash-site machines of shared/crash.ts: the server's CrashServer handles both, and a carried-off wreck
// is in `crashTaken` until it respawns (45 min). Layout is deterministic like shared/scrap.ts (integer hashing, exact
// arithmetic), so every client and the server agree where every wreck is.
import { padBlend } from './base.ts';
import { ORIGIN_FRONT } from './origin.ts';
import { seeded, sitesNear } from './crash.ts';
import { crashSitesNear, siteLevel } from './crashsites.ts';
import { shelterWithin } from './shelters.ts';
import { onShipGround } from './shipSpot.ts';
import { rocksNear } from './rocks.ts';
import { LAB } from './world.ts';
import { SALVAGE, type SalvageId } from './salvage.ts';
import { baseHeight, WORLD_SEED } from './terrain.ts';

/** Grid cell size (m); each cell holds at most one wreck. */
export const WRECK_CELL = 300;
const DENSITY = 0.45;
/** How close you must be (m) for the "Pick up" prompt. */
export const WRECK_REACH = 3.5;

export interface Wreck {
  /** Unique, stable id: "w:ix,iz", or "w:start" near the base. Never clashes with shared/crash.ts ids. */
  id: string;
  x: number;
  z: number;
  /** Heading of the model, radians. */
  yaw: number;
  kind: SalvageId;
}

const KINDS = Object.keys(SALVAGE) as SalvageId[];
const TOTAL = KINDS.reduce((s, k) => s + SALVAGE[k].weight, 0);
function pickKind(u: number): SalvageId {
  let r = u * TOTAL;
  for (const k of KINDS) if ((r -= SALVAGE[k].weight) < 0) return k;
  return KINDS[0];
}

function cellRng(ix: number, iz: number) {
  return seeded(Math.imul(ix | 0, 0x1b873593) ^ Math.imul(iz | 0, 0x68e31da4) ^ Math.imul(WORLD_SEED, 0x85ebca6b) ^ 0x3c6e);
}

const MAX_GRAD2 = 1 / (0.92 * 0.92) - 1;
function flatEnough(x: number, z: number): boolean {
  const e = 0.5;
  const gx = (baseHeight(x + e, z) - baseHeight(x - e, z)) / (2 * e);
  const gz = (baseHeight(x, z + e) - baseHeight(x, z - e)) / (2 * e);
  return gx * gx + gz * gz < MAX_GRAD2;
}

/** Clear of the base pad, rocks, shelters, the crash-site machines and the crashed spacecraft. */
function clear(x: number, z: number): boolean {
  return flatEnough(x, z) && padBlend(x, z) > 0.3 && !rocksNear(x, z, 4) &&
    sitesNear(x, z, 12).length === 0 && crashSitesNear(x, z, 30).length === 0 && !shelterWithin(x, z, 6) &&
    !onShipGround(x, z, 6);
}

const cache = new Map<string, Wreck | null>();

/** The wreck in cell (ix, iz), or null. */
export function wreckAt(ix: number, iz: number): Wreck | null {
  const k = `${ix},${iz}`;
  let w = cache.get(k);
  if (w === undefined) cache.set(k, (w = generate(ix, iz)));
  return w;
}

function generate(ix: number, iz: number): Wreck | null {
  if (LAB) return null;
  const r = cellRng(ix, iz);
  if (r() >= DENSITY) return null;
  const kind = pickKind(r());
  const yaw = r() * 6.2831853;
  for (let t = 0; t < 4; t++) {
    const x = (ix + 0.1 + 0.8 * r()) * WRECK_CELL;
    const z = (iz + 0.1 + 0.8 * r()) * WRECK_CELL;
    // The warp core is guardian ground's (shared/crashsites.ts SiteLevel): nearer in, an AI rack lies there instead.
    if (clear(x, z)) return { id: `w:${ix},${iz}`, x, z, yaw, kind: kind === 'warp_core' && siteLevel(x, z) < 2 ? 'ai_control' : kind };
  }
  return null;
}

/** One wreck near where new players start (a vehicle frame), so the carry-home loop shows up straight away. */
const STARTER_OFFSETS: [number, number][] = [[-40, 30], [40, 30], [-30, 44], [30, 44], [-48, 10], [48, 10], [0, 52], [-44, -30], [44, -30]];
let starter: Wreck | null | undefined;
function starterWreck(): Wreck | null {
  if (LAB) return null;
  if (starter !== undefined) return starter;
  starter = null;
  const r = cellRng(9, 9);
  for (const [dx, dz] of STARTER_OFFSETS) {
    const x = ORIGIN_FRONT.x + dx, z = ORIGIN_FRONT.z + dz;
    if (!clear(x, z)) continue;
    starter = { id: 'w:start', x, z, yaw: r() * 6.2831853, kind: 'vehicle_frame' };
    break;
  }
  return starter;
}

/** The wreck with this id ("w:start" or "w:ix,iz"), or null. */
export function wreckById(id: unknown): Wreck | null {
  if (typeof id !== 'string' || !id.startsWith('w:')) return null;
  if (id === 'w:start') return starterWreck();
  const m = /^w:(-?\d{1,5}),(-?\d{1,5})$/.exec(id);
  return m ? wreckAt(Number(m[1]), Number(m[2])) : null;
}

/** Every wreck within `radius` of (x, z). */
export function wrecksNear(x: number, z: number, radius: number): Wreck[] {
  const out: Wreck[] = [];
  const s = starterWreck();
  if (s && Math.hypot(s.x - x, s.z - z) <= radius) out.push(s);
  const n = Math.ceil(radius / WRECK_CELL);
  const cx = Math.floor(x / WRECK_CELL), cz = Math.floor(z / WRECK_CELL);
  for (let iz = cz - n; iz <= cz + n; iz++) {
    for (let ix = cx - n; ix <= cx + n; ix++) {
      const w = wreckAt(ix, iz);
      if (w && Math.hypot(w.x - x, w.z - z) <= radius) out.push(w);
    }
  }
  return out;
}
