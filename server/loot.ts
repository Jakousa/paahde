// Loot lying in the world (shared/loot.ts): broken gear to find and repair (shared/gear.ts) at the crash sites (the
// starter gear at the scrap fields near the base, the advanced gear on crawler ground, rare loose parts on guardian
// ground: shared/crashsites.ts SiteLevel), things buried in the sand that the metal detector hears and a shovel digs up. All shared: the first player to press F
// takes it. Taken finds and caches come back somewhere else after a while, so there are always some out there.
// Kept in memory: a restart lays out fresh ones. Items players drop are kept in the DB (`dropped`) and never respawn.
import { BASE, overBase } from '../shared/base.ts';
import { GEAR, GEAR_KINDS } from '../shared/gear.ts';
import { partKind, SCRAP_ITEMS } from '../shared/items.ts';
import { DROP_AHEAD, lootReach, type Loot } from '../shared/loot.ts';
import { allCrashSites, type SiteLevel } from '../shared/crashsites.ts';
import { PART_IDS } from '../shared/parts.ts';
import { TIERS } from '../shared/salvage.ts';
import { EDIT_CELL, edits, WORLD_HALF } from '../shared/terrain.ts';
import type { PlayerState } from '../shared/sim.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import type { openDb } from './db.ts';

type Db = ReturnType<typeof openDb>;

/** How many of each piece of broken gear lie around at once, and the level of crash site they lie at: a new player
 *  starts with nothing and finds the canteen, telescope and backpack at the scrap fields. */
const FINDS: Record<string, { n: number; level: SiteLevel }> = {
  canteen: { n: 4, level: 0 }, spyglass: { n: 3, level: 0 }, backpack: { n: 4, level: 0 },
  motorcycle: { n: 3, level: 1 }, shovel: { n: 3, level: 1 }, storm_detector: { n: 2, level: 1 }, wristpad: { n: 2, level: 1 },
  metal_detector: { n: 2, level: 1 },
};
/** Loose Quality / Space-grade parts lying at guardian ground (level 2) at once (RARE_KIND: any such part, anti-matter too). */
const RARE_FINDS = 10;
const RARE_KIND = 'rare';
const RARE_TIERS = [3, 1];
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

type Spawn = { at: number; what: 'find' | 'cache'; kind?: string };

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
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    // Dropped items keep their ids; everything else is numbered after them.
    for (const r of db.loadDropped()) {
      this.loot.set(r.id, { id: r.id, kind: r.kind, ...(r.parts ? { parts: r.parts } : {}), x: r.x, z: r.z, depth: 0, src: 'drop' });
      this.nextId = Math.max(this.nextId, r.id + 1);
    }
    for (const [kind, f] of Object.entries(FINDS)) for (let i = 0; i < f.n; i++) this.spawnFind(kind);
    for (let i = 0; i < RARE_FINDS; i++) this.spawnFind(RARE_KIND);
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
    if (l.src === 'drop') {
      if (!this.db.tx(() => give(l) && (this.db.deleteDropped(l.id), true))) return 'full';
      this.remove(l);
      return l.kind;
    }
    if (!give(l)) return 'full';
    this.remove(l);
    const kind = l.kind in FINDS ? l.kind : RARE_KIND;
    this.pending.push({ at: Date.now() + (l.src === 'find' ? FIND_RESPAWN_MS : CACHE_RESPAWN_MS), what: l.src, kind: l.src === 'find' ? kind : undefined });
    return l.kind;
  }

  /** An item a player dropped: it lands on the sand just in front of them. Call inside the transaction that takes it out of their box. */
  drop(s: PlayerState, item: { kind: string; parts?: (string | null)[] }) {
    const a = s.riding ? s.heading : s.facing;
    const x = s.x - Math.sin(a) * DROP_AHEAD + rand(-0.2, 0.2);
    const z = s.z - Math.cos(a) * DROP_AHEAD + rand(-0.2, 0.2);
    const l: Loot = { id: this.nextId++, kind: item.kind, ...(item.parts ? { parts: [...item.parts] } : {}), x, z, depth: 0, src: 'drop' };
    this.db.insertDropped(l.id, l.kind, l.parts, x, z);
    this.add(l);
  }

  /** Something left on the sand at (x, z) (a killed walker's parts, server/guardians.ts), kept like a dropped item. */
  dropAt(x: number, z: number, kind: string) {
    const l: Loot = { id: this.nextId++, kind, x: x + rand(-0.8, 0.8), z: z + rand(-0.8, 0.8), depth: 0, src: 'drop' };
    this.db.insertDropped(l.id, l.kind, l.parts, l.x, l.z);
    this.add(l);
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
      if (p.what === 'find') this.spawnFind(p.kind!);
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

  /** Gear kind `kind` (FINDS) lying at a crash site of its level, among the debris around the wreck; RARE_KIND: a rare part. */
  private spawnFind(kind: string) {
    const level = FINDS[kind]?.level ?? 2;
    const sites = this.sites.filter((s) => s.level === level);
    let x = 0, z = 0;
    for (let tries = 0; tries < 20; tries++) {
      const site = pick(sites.length ? sites : this.sites);
      const a = rand(0, Math.PI * 2), d = rand(site.radius * 0.4, site.radius + 8);
      x = site.x + Math.sin(a) * d;
      z = site.z + Math.cos(a) * d;
      if (!overBase(x, z, 6)) break;
    }
    if (kind === RARE_KIND) {
      const tier = Math.random() * (RARE_TIERS[0] + RARE_TIERS[1]) < RARE_TIERS[0] ? 'quality' : 'space';
      this.add({ id: this.nextId++, kind: partKind(pick(PART_IDS), tier), x, z, depth: 0, src: 'find' });
    } else this.add({ id: this.nextId++, kind, parts: this.brokenParts(kind), x, z, depth: 0, src: 'find' });
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
