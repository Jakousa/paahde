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
import { SCRAP_CELL, scrapPieces } from '../shared/scrap.ts';
import { PART_IDS, pickTier } from '../shared/parts.ts';
import { PISTOL } from '../shared/rifle.ts';
import { rocksNear } from '../shared/rocks.ts';
import { BROKEN_GEAR, CACHES, FINDS, RARE_FINDS } from '../shared/tables.ts';
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
/** How far from the base buried caches lie, and how deep (m). */
const CACHE_MIN_R = 80, CACHE_MAX_R = 1200;
const CACHE_DEPTH = [0.5, 1.1];
/** A taken find / cache is replaced this long after (ms). */
const FIND_RESPAWN_MS = 3 * 60_000;
const CACHE_RESPAWN_MS = 60_000;
const CACHE_PARTS = PART_IDS.filter((p) => !CACHES.noParts.includes(p));

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

export class LootServer {
  readonly loot = new Map<number, Loot>();
  private nextId = 1;
  private pending: Spawn[] = [];
  private added: Loot[] = [];
  private removed: number[] = [];
  private sites = allCrashSites();
  private piles = nearPiles();
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    // Dropped items keep their ids; everything else is numbered after them.
    for (const r of db.loadDropped()) {
      this.loot.set(r.id, { id: r.id, kind: r.kind, ...(r.parts ? { parts: r.parts } : {}), x: r.x, z: r.z, depth: 0, src: 'drop' });
      this.nextId = Math.max(this.nextId, r.id + 1);
    }
    for (const [kind, f] of Object.entries(FINDS)) for (let i = 0; i < f.n; i++) this.spawnFind(kind);
    for (let i = 0; i < RARE_FINDS.n; i++) this.spawnFind(RARE_KIND);
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
    else if (what === 'scrap') kind = pick(SCRAP_ITEMS);
    else if (what === 'pistol') kind = PISTOL;
    else {
      kind = pick(GEAR_KINDS);
      parts = this.brokenParts(kind);
    }
    this.add({ id: this.nextId++, kind, ...(parts ? { parts } : {}), x, z, depth: rand(CACHE_DEPTH[0], CACHE_DEPTH[1]), src: 'cache' });
  }
}
