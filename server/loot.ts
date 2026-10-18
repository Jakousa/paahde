// Loot lying in the world (shared/loot.ts): broken gear to find and repair (shared/gear.ts) at the crash sites (the
// starter gear at the scrap fields near the base, the advanced gear on crawler ground, rare loose parts on guardian
// ground: shared/crashsites.ts SiteLevel; and one broken motorcycle always in front of the base door, HOME_BIKE), things buried in the sand that the metal detector hears and a shovel digs up. All shared: the first player to press F
// takes it. Taken finds and caches come back somewhere else after a while, so there are always some out there.
// Kept in memory: a restart lays out fresh ones. Items players drop are kept in the DB (`dropped`) and never respawn.
import { BASE, BASE_SPAWN, overBase } from '../shared/base.ts';
import { GEAR, GEAR_KINDS, refit } from '../shared/gear.ts';
import { CLOTH, partKind, SCRAP } from '../shared/items.ts';
import { DROP_AHEAD, lootReach, type Loot } from '../shared/loot.ts';
import { allCrashSites, type SiteLevel } from '../shared/crashsites.ts';
import { SCRAP_CELL, scrapPieces } from '../shared/scrap.ts';
import { PART_IDS, pickTier } from '../shared/parts.ts';
import { GUNS, PISTOL } from '../shared/rifle.ts';
import { rocksNear } from '../shared/rocks.ts';
import { BROKEN_GEAR, CACHES, FINDS, HOME_BIKE, RARE_FINDS } from '../shared/tables.ts';
import { EDIT_CELL, edits, WORLD_HALF } from '../shared/terrain.ts';
import type { PlayerState } from '../shared/sim.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import type { openDb } from './db.ts';

type Db = ReturnType<typeof openDb>;

// What lies around and what is in it: FINDS, RARE_FINDS, BROKEN_GEAR and CACHES in shared/tables.ts.
/** The odds a level-0 find lies at a scrap pile (shared/scrap.ts) within PILE_FIND_R m of the base instead of a crash site. */
const PILE_ODDS = 0.45;
const PILE_FIND_R = 600;
/** The FINDS key for a loose rare part at guardian ground (level 2). */
const RARE_KIND = 'rare';
/** The pending-spawn key for the motorcycle in front of the base door (HOME_BIKE). */
const HOME_KIND = 'home_bike';
/** How far from the base buried caches lie, and how deep (m). */
const CACHE_MIN_R = 80, CACHE_MAX_R = 1200;
const CACHE_DEPTH = [0.5, 1.1];
/** A taken find / cache is replaced this long after (ms). */
const FIND_RESPAWN_MS = 3 * 60_000;
const CACHE_RESPAWN_MS = 60_000;
const CACHE_PARTS = PART_IDS.filter((p) => !CACHES.noParts.includes(p));
/** Broken gear a cache can hold (the guns have their own odds: only the pistol, CACHES.contents.pistol). */
const CACHE_GEAR = GEAR_KINDS.filter((k) => !(k in GUNS));

type Spawn = { at: number; what: 'find' | 'cache'; kind?: string };

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
/** A key of `odds`, picked by its relative odds. */
function pickOdds<K extends string>(odds: Record<K, number>): K {
  const ks = Object.keys(odds) as K[];
  let r = Math.random() * ks.reduce((a, k) => a + odds[k], 0);
  for (const k of ks) if ((r -= odds[k]) < 0) return k;
  return ks[0];
}

/** The scrap piles within PILE_FIND_R of the base: centre and how far their pieces reach. */
function nearPiles() {
  const out: { x: number; z: number; r: number }[] = [];
  const lo = (c: number) => Math.floor((c - PILE_FIND_R) / SCRAP_CELL), hi = (c: number) => Math.floor((c + PILE_FIND_R) / SCRAP_CELL);
  for (let iz = lo(BASE.z); iz <= hi(BASE.z); iz++) for (let ix = lo(BASE.x); ix <= hi(BASE.x); ix++) {
    const ps = scrapPieces(ix, iz);
    if (!ps.length) continue;
    const x = ps.reduce((a, p) => a + p.x, 0) / ps.length, z = ps.reduce((a, p) => a + p.z, 0) / ps.length;
    if (Math.hypot(x - BASE.x, z - BASE.z) > PILE_FIND_R || overBase(x, z, 6)) continue;
    out.push({ x, z, r: Math.max(...ps.map((p) => Math.hypot(p.x - x, p.z - z))) });
  }
  return out;
}

/** Where the home bike lies: out from the door (it faces +Z), off the path a little, on clear sand in plain view.
 *  The same spot every time. */
function homeBikeSpot() {
  const clear = (x: number, z: number) => {
    if (overBase(x, z, 6) || rocksNear(x, z, 3)) return false;
    const ix = Math.floor(x / SCRAP_CELL), iz = Math.floor(z / SCRAP_CELL);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (scrapPieces(ix + dx, iz + dz).some((p) => Math.hypot(p.x - x, p.z - z) < 4)) return false;
    }
    return true;
  };
  for (const d of [22, 28, 34, 16, 42]) for (const a of [0.35, -0.35, 0.6, -0.6, 0, 0.9, -0.9]) {
    const x = BASE_SPAWN.x + Math.sin(a) * d, z = BASE_SPAWN.z + Math.cos(a) * d;
    if (clear(x, z)) return { x, z };
  }
  return { x: BASE_SPAWN.x + 8, z: BASE_SPAWN.z + 20 };
}

export class LootServer {
  readonly loot = new Map<number, Loot>();
  private nextId = 1;
  private pending: Spawn[] = [];
  private added: Loot[] = [];
  private removed: number[] = [];
  private sites = allCrashSites();
  private piles = nearPiles();
  private homeBike = homeBikeSpot();
  private homeBikeId = -1;
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    // Dropped items keep their ids; everything else is numbered after them.
    for (const r of db.loadDropped()) {
      const parts = r.parts && (refit(r.kind, r.parts) ?? r.parts); // gear whose slots changed since (shared/gear.ts)
      this.loot.set(r.id, { id: r.id, kind: r.kind, ...(parts ? { parts } : {}), x: r.x, z: r.z, depth: 0, src: 'drop' });
      this.nextId = Math.max(this.nextId, r.id + 1);
    }
    for (const [kind, f] of Object.entries(FINDS)) for (let i = 0; i < f.n; i++) this.spawnFind(kind);
    for (let i = 0; i < RARE_FINDS.n; i++) this.spawnFind(RARE_KIND);
    this.spawnFind(HOME_KIND);
    for (let i = 0; i < CACHES.n; i++) this.spawnCache();
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
   * A player (browser id `who`) takes loot `id`: it must be on the surface and in reach. `give` puts it in their bag
   * (false: no room). Returns the item's kind, 'full' if the bag was full, 'had' if it's the home bike and they've
   * had one (one each, so it can't be farmed for motors), or null if refused.
   */
  take(s: PlayerState, who: string, id: unknown, give: (l: Loot) => boolean): string | null {
    const l = typeof id === 'number' ? this.loot.get(id) : undefined;
    if (!l || l.depth > 0 || !lootReach(s, l, 1.5)) return null;
    if (l.id === this.homeBikeId) {
      if (this.db.hasGrant(who, HOME_KIND)) return 'had';
      if (!this.db.tx(() => give(l) && (this.db.markGrant(who, HOME_KIND), true))) return 'full';
      this.remove(l);
      this.pending.push({ at: Date.now() + FIND_RESPAWN_MS, what: 'find', kind: HOME_KIND });
      return l.kind;
    }
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

  /** Something left on the sand within `spread` m of (x, z) (a killed walker's parts, server/guardians.ts; thrown
   *  scrap, server/throws.ts), kept like a dropped item. */
  dropAt(x: number, z: number, kind: string, spread = 0.8) {
    const l: Loot = { id: this.nextId++, kind, x: x + rand(-spread, spread), z: z + rand(-spread, spread), depth: 0, src: 'drop' };
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
    const parts = slots.map((s): string | null =>
      Math.random() < BROKEN_GEAR.filled ? ('part' in s ? partKind(s.part, pickTier(BROKEN_GEAR.tierWeights, Math.random)) : pick(s.scrap)) : null);
    if (!parts.includes(null)) parts[Math.floor(Math.random() * parts.length)] = null;
    return parts;
  }

  /** Gear kind `kind` (FINDS) lying at a crash site of its level, among the debris around the wreck; RARE_KIND: a rare part. */
  private spawnFind(kind: string) {
    if (kind === HOME_KIND) {
      const parts = GEAR.motorcycle.slots.map((s) => ('part' in s && HOME_BIKE.fitted.includes(s.part) ? partKind(s.part, 'scrap') : null));
      this.homeBikeId = this.nextId++;
      this.add({ id: this.homeBikeId, kind: 'motorcycle', parts, ...this.homeBike, depth: 0, src: 'find' });
      return;
    }
    const level = FINDS[kind]?.level ?? 2;
    const sites = this.sites.filter((s) => s.level === level);
    let x = 0, z = 0;
    if (level === 0 && this.piles.length && Math.random() < PILE_ODDS) {
      // Among the pieces of a scrap pile near the base.
      const p = pick(this.piles);
      const a = rand(0, Math.PI * 2), d = rand(1, p.r + 1.5);
      x = p.x + Math.sin(a) * d;
      z = p.z + Math.cos(a) * d;
    } else for (let tries = 0; tries < 20; tries++) {
      const site = pick(sites.length ? sites : this.sites);
      const a = rand(0, Math.PI * 2), d = rand(site.radius * 0.4, site.radius + 8);
      x = site.x + Math.sin(a) * d;
      z = site.z + Math.cos(a) * d;
      if (!overBase(x, z, 6)) break;
    }
    if (kind === RARE_KIND) {
      this.add({ id: this.nextId++, kind: partKind(pick(PART_IDS), pickTier(RARE_FINDS.tierWeights, Math.random)), x, z, depth: 0, src: 'find' });
    } else this.add({ id: this.nextId++, kind, parts: this.brokenParts(kind), x, z, depth: 0, src: 'find' });
  }

  private spawnCache() {
    let x = 0, z = 0;
    for (let tries = 0; tries < 20; tries++) {
      const a = rand(0, Math.PI * 2), d = rand(CACHE_MIN_R, CACHE_MAX_R);
      x = Math.round((BASE.x + Math.sin(a) * d) / EDIT_CELL) * EDIT_CELL;
      z = Math.round((BASE.z + Math.cos(a) * d) / EDIT_CELL) * EDIT_CELL;
      if (Math.abs(x) < WORLD_HALF - 20 && Math.abs(z) < WORLD_HALF - 20 && !overBase(x, z, 10) && !rocksNear(x, z, 3)) break; // dug up: not under rock
    }
    const what = pickOdds(CACHES.contents);
    let kind: string, parts: (string | null)[] | undefined;
    if (what === 'part') kind = partKind(pick(CACHE_PARTS), pickTier(CACHES.tierWeights, Math.random));
    else if (what === 'scrap') kind = SCRAP;
    else if (what === 'cloth') kind = CLOTH;
    else {
      kind = what === 'pistol' ? PISTOL : pick(CACHE_GEAR);
      parts = this.brokenParts(kind);
    }
    this.add({ id: this.nextId++, kind, ...(parts ? { parts } : {}), x, z, depth: rand(CACHE_DEPTH[0], CACHE_DEPTH[1]), src: 'cache' });
  }
}
