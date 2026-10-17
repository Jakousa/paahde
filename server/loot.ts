// Loot lying in the world (shared/loot.ts): broken gear to find and repair (shared/gear.ts), things buried
// in the sand that the metal detector hears and a shovel digs up. All shared: the first player to press F
// takes it. Taken finds and caches come back somewhere else after a while, so there are always some out there.
// Kept in memory: a restart lays out fresh ones.
import { BASE, BASE_SPAWN, overBase } from '../shared/base.ts';
import { GEAR, GEAR_KINDS } from '../shared/gear.ts';
import { partKind, SCRAP_ITEMS } from '../shared/items.ts';
import { lootReach, type Loot } from '../shared/loot.ts';
import { allCrashSites } from '../shared/crashsites.ts';
import { PART_IDS } from '../shared/parts.ts';
import { TIERS } from '../shared/salvage.ts';
import { EDIT_CELL, edits, WORLD_HALF } from '../shared/terrain.ts';
import type { PlayerState } from '../shared/sim.ts';
import type { ServerMsg } from '../shared/protocol.ts';

/** How many of each piece of broken gear lie around at once. */
const FINDS: Record<string, number> = {
  canteen: 4, shovel: 3, backpack: 3, spyglass: 2, storm_detector: 2, wristpad: 2, metal_detector: 2, motorcycle: 2,
};
/** Gear that also turns up near the spawn point (one of each), so a new player can make a start. */
const NEAR_SPAWN = ['canteen', 'shovel'];
const NEAR_MIN = 25, NEAR_MAX = 110;
/** Buried caches at once, how far from the base, and how deep (m). */
const CACHES = 60;
const CACHE_MIN_R = 80, CACHE_MAX_R = 1200;
const CACHE_DEPTH = [0.5, 1.1];
/** A taken find / cache is replaced this long after (ms). */
const FIND_RESPAWN_MS = 3 * 60_000;
const CACHE_RESPAWN_MS = 60_000;
/** Cache contents: part tiers, and the odds of a part / a piece of scrap / broken gear. */
const TIER_WEIGHTS = [5, 3, 1.2, 0.25];
const CACHE_ODDS = { part: 0.65, scrap: 0.2 };
const PARTS = PART_IDS.filter((p) => p !== 'antimatter');

type Spawn = { at: number; what: 'find' | 'cache'; kind?: string; nearSpawn?: boolean };

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
function pickTier(): number {
  let r = Math.random() * TIER_WEIGHTS.reduce((a, b) => a + b);
  for (let i = 0; i < TIER_WEIGHTS.length; i++) if ((r -= TIER_WEIGHTS[i]) < 0) return i;
  return 0;
}

export class LootServer {
  readonly loot = new Map<number, Loot>();
  private nextId = 1;
  private pending: Spawn[] = [];
  private added: Loot[] = [];
  private removed: number[] = [];
  private sites = allCrashSites();

  constructor() {
    for (const [kind, n] of Object.entries(FINDS)) {
      const near = NEAR_SPAWN.includes(kind);
      for (let i = 0; i < n; i++) this.spawnFind(kind, near && i === 0);
    }
    for (let i = 0; i < CACHES; i++) this.spawnCache();
    this.added = [];
  }

  /** Everything, for a joining client. */
  joinMessage(): ServerMsg {
    return { t: 'loot', add: [...this.loot.values()], remove: [], reset: true };
  }

  /** What changed since the last flush, for everyone (null if nothing). */
  flush(): ServerMsg | null {
    if (!this.added.length && !this.removed.length) return null;
    // Taken again before this went out: just the removal.
    const msg: ServerMsg = { t: 'loot', add: [...new Set(this.added)].filter((l) => this.loot.get(l.id) === l), remove: this.removed };
    this.added = [];
    this.removed = [];
    return msg;
  }

  /**
   * A player takes loot `id`: it must be on the surface and in reach. `give` puts it in their bag (false:
   * no room). Returns the item's kind, 'full' if the bag was full, or null if refused.
   */
  take(s: PlayerState, id: unknown, give: (l: Loot) => boolean): string | null {
    const l = typeof id === 'number' ? this.loot.get(id) : undefined;
    if (!l || l.depth > 0 || !lootReach(s, l, 1.5)) return null;
    if (!give(l)) return 'full';
    this.remove(l);
    this.pending.push({ at: Date.now() + (l.src === 'find' ? FIND_RESPAWN_MS : CACHE_RESPAWN_MS), what: l.src, kind: l.src === 'find' ? l.kind : undefined, nearSpawn: l.near });
    return l.kind;
  }

  /** After a dig stroke at (x, z) with radius r: caches the hole has reached (anywhere within a cell of them) come up. */
  dug(x: number, z: number, r: number) {
    for (const l of this.loot.values()) {
      if (l.depth <= 0 || Math.hypot(l.x - x, l.z - z) > r + 2 * EDIT_CELL) continue;
      const ix = Math.round(l.x / EDIT_CELL), iz = Math.round(l.z / EDIT_CELL);
      let mm = Infinity;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) mm = Math.min(mm, edits.getMm(ix + dx, iz + dz));
      if (mm > -l.depth * 1000) continue;
      l.depth = 0;
      this.added.push(l); // clients take an add of a known id as an update
    }
  }

  /** Every few seconds: put back what was taken a while ago. */
  respawn() {
    const now = Date.now();
    const due = this.pending.filter((p) => p.at <= now);
    if (!due.length) return;
    this.pending = this.pending.filter((p) => p.at > now);
    for (const p of due) {
      if (p.what === 'find') this.spawnFind(p.kind!, !!p.nearSpawn);
      else this.spawnCache();
    }
  }

  private add(l: Loot) {
    this.loot.set(l.id, l);
    this.added.push(l);
  }

  private remove(l: Loot) {
    this.loot.delete(l.id);
    this.removed.push(l.id);
  }

  /** Broken: a few low-tier parts already in, at least one slot empty. */
  private brokenParts(kind: string): (string | null)[] {
    const slots = GEAR[kind].slots;
    const parts = slots.map((s): string | null => (Math.random() < 0.5 ? ('part' in s ? partKind(s.part, TIERS[Math.random() < 0.7 ? 0 : 1]) : pick(s.scrap)) : null));
    if (!parts.includes(null)) parts[Math.floor(Math.random() * parts.length)] = null;
    return parts;
  }

  private spawnFind(kind: string, nearSpawn: boolean) {
    let x = 0, z = 0;
    for (let tries = 0; tries < 20; tries++) {
      if (nearSpawn) {
        const a = rand(0, Math.PI * 2), d = rand(NEAR_MIN, NEAR_MAX);
        x = BASE_SPAWN.x + Math.sin(a) * d;
        z = BASE_SPAWN.z + Math.cos(a) * d;
      } else {
        // Out at a crash site, lying among the debris around the wreck.
        const site = pick(this.sites);
        const a = rand(0, Math.PI * 2), d = rand(site.radius * 0.4, site.radius + 8);
        x = site.x + Math.sin(a) * d;
        z = site.z + Math.cos(a) * d;
      }
      if (!overBase(x, z, 6)) break;
    }
    this.add({ id: this.nextId++, kind, parts: this.brokenParts(kind), x, z, depth: 0, src: 'find', ...(nearSpawn ? { near: true } : {}) });
  }

  private spawnCache() {
    let x = 0, z = 0;
    for (let tries = 0; tries < 20; tries++) {
      const a = rand(0, Math.PI * 2), d = rand(CACHE_MIN_R, CACHE_MAX_R);
      x = Math.round((BASE.x + Math.sin(a) * d) / EDIT_CELL) * EDIT_CELL;
      z = Math.round((BASE.z + Math.cos(a) * d) / EDIT_CELL) * EDIT_CELL;
      if (Math.abs(x) < WORLD_HALF - 20 && Math.abs(z) < WORLD_HALF - 20 && !overBase(x, z, 10)) break;
    }
    const r = Math.random();
    let kind: string, parts: (string | null)[] | undefined;
    if (r < CACHE_ODDS.part) kind = partKind(pick(PARTS), TIERS[pickTier()]);
    else if (r < CACHE_ODDS.part + CACHE_ODDS.scrap) kind = pick(SCRAP_ITEMS);
    else {
      kind = pick(GEAR_KINDS);
      parts = this.brokenParts(kind);
    }
    this.add({ id: this.nextId++, kind, ...(parts ? { parts } : {}), x, z, depth: rand(CACHE_DEPTH[0], CACHE_DEPTH[1]), src: 'cache' });
  }
}
