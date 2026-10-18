// Loot lying in the world (shared/loot.ts): broken gear to find and repair (shared/gear.ts) at the crash sites (the
// starter gear at the scrap fields near the base, the advanced gear on crawler ground, rare loose parts on guardian
// ground: shared/crashsites.ts SiteLevel; and one broken motorcycle always in front of the base door, HOME_BIKE), stashes
// on the shelters' floors (SHELTER_STASHES), and caches lying out in the open desert. All shared: the first player to press F
// takes it. Taken finds and caches come back somewhere else after a while, so there are always some out there.
// Kept in the DB (`world_loot`, `loot_pending`, written on change), so a restart keeps what was taken. Items
// players drop are kept in `dropped` and never respawn.
import { BASE, BASE_SPAWN, overBase } from '../shared/base.ts';
import { overShelter, shelterAt, shelterLootSpot, sheltersNear } from '../shared/shelters.ts';
import { GEAR, GEAR_KINDS, isGear, refit, scrapParts } from '../shared/gear.ts';
import { JAMMER } from '../shared/jammer.ts';
import { RECEIVERS, receiverBoss } from '../shared/bosses.ts';
import { CLOTH, partKind, RETIRED, SCRAP } from '../shared/items.ts';
import { DROP_AHEAD, lootReach, type Loot } from '../shared/loot.ts';
import { coreCrashSites, type SiteLevel } from '../shared/crashsites.ts';
import { SCRAP_CELL, scrapPieces } from '../shared/scrap.ts';
import { PART_IDS, pickTier } from '../shared/parts.ts';
import { GUNS, PISTOL } from '../shared/rifle.ts';
import { rocksNear } from '../shared/rocks.ts';
import { BROKEN_GEAR, CACHES, FINDS, HOME_BIKE, RARE_FINDS, SHELTER_STASHES, type TierWeights } from '../shared/tables.ts';
import { CORE_HALF } from '../shared/terrain.ts';
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
/** The pending-spawn key for a stash on a shelter's floor (SHELTER_STASHES). */
const STASH_KIND = 'shelter';
/** How far from the base caches lie (m). */
const CACHE_MIN_R = 80, CACHE_MAX_R = 1200;
/** A taken find / cache is replaced this long after (ms). */
const FIND_RESPAWN_MS = 3 * 60_000;
const CACHE_RESPAWN_MS = 60_000;
const CACHE_PARTS = PART_IDS.filter((p) => !CACHES.noParts.includes(p));
const RARE_PARTS = PART_IDS.filter((p) => !RARE_FINDS.noParts.includes(p));
/** Broken gear a cache can hold (not the jammer or the receivers; the guns have their own odds: only the pistol,
 *  CACHES.contents.pistol). */
const CACHE_GEAR = GEAR_KINDS.filter((k) => !(k in GUNS) && k !== JAMMER && !receiverBoss(k));

/** A taken find or cache waiting to come back; id is its loot_pending row. */
type Spawn = { id: number; at: number; what: 'find' | 'cache'; kind?: string };

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
  /** Finds lie at the sites in the core square (terrain.ts CORE_HALF), not spread over the endless world. */
  private sites = coreCrashSites();
  private piles = nearPiles();
  private homeBike = homeBikeSpot();
  private homeBikeId = -1;
  private shelters = sheltersNear(0, 0, CORE_HALF * 1.5);
  /** What each lying find stands in for (FINDS key, RARE_KIND, HOME_KIND); caches aren't in it. */
  private spawnKey = new Map<number, string>();
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    // Dropped items keep their ids; everything else is numbered after them.
    for (const r of db.loadDropped()) {
      if (RETIRED.has(r.kind)) {
        db.deleteDropped(r.id);
        continue;
      }
      // Gear whose slots changed since (shared/gear.ts refit); a jammer from before it was gear works, with Scrap parts.
      const parts = r.parts ? (refit(r.kind, r.parts) ?? r.parts) : isGear(r.kind) ? scrapParts(r.kind) : undefined;
      this.loot.set(r.id, { id: r.id, kind: r.kind, ...(parts ? { parts } : {}), x: r.x, z: r.z, src: 'drop' });
      this.nextId = Math.max(this.nextId, r.id + 1);
    }
    // Finds and caches from before the restart, and the ones waiting to come back. Caches buried back when there was
    // digging lie on the surface now; gear no longer in the game is gone (and comes back as something else).
    const world = db.loadWorldLoot();
    for (const r of world) {
      if (RETIRED.has(r.kind)) {
        db.deleteWorldLoot(r.id);
        if (r.src === 'cache') this.queue('cache', '');
        continue;
      }
      if (r.depth > 0) db.surfaceWorldLoot(r.id);
      const parts = r.parts ? (refit(r.kind, r.parts) ?? r.parts) : undefined;
      this.loot.set(r.id, { id: r.id, kind: r.kind, ...(parts ? { parts } : {}), x: r.x, z: r.z, src: r.src });
      if (r.spawn) this.spawnKey.set(r.id, r.spawn);
      if (r.spawn === HOME_KIND) this.homeBikeId = r.id;
      this.nextId = Math.max(this.nextId, r.id + 1);
    }
    this.pending = db.loadLootPending().map((p) => ({ id: p.id, at: p.at, what: p.what, ...(p.kind ? { kind: p.kind } : {}) }));
    // As many of each as shared/tables.ts says (a fresh DB lays them all out; a changed table tops up or trims).
    db.tx(() => {
      const want = new Map<string, number>(Object.entries(FINDS).map(([k, f]) => [k, f.n]));
      want.set(RARE_KIND, RARE_FINDS.n);
      want.set(HOME_KIND, 1);
      want.set(STASH_KIND, this.shelters.length ? SHELTER_STASHES.n : 0);
      const lying = new Map<string, number[]>();
      for (const [id, k] of this.spawnKey) lying.set(k, [...(lying.get(k) ?? []), id]);
      lying.set('', [...this.loot.values()].filter((l) => l.src === 'cache').map((l) => l.id));
      want.set('', CACHES.n);
      const keyOf = (p: Spawn) => (p.what === 'cache' ? '' : p.kind ?? '');
      for (const k of new Set([...want.keys(), ...lying.keys(), ...this.pending.map(keyOf)])) {
        let extra = (lying.get(k)?.length ?? 0) + this.pending.filter((p) => keyOf(p) === k).length - (want.get(k) ?? 0);
        for (const p of this.pending.filter((p) => keyOf(p) === k)) {
          if (extra <= 0) break;
          this.dropPending(p);
          extra--;
        }
        for (const id of lying.get(k) ?? []) {
          if (extra <= 0) break;
          this.remove(this.loot.get(id)!);
          extra--;
        }
        for (; extra < 0; extra++) {
          if (k === '') this.spawnCache();
          else this.spawnFind(k);
        }
      }
    });
    this.added = [];
    this.removed = [];
  }

  /** Everything, for a joining client (browser id `who`). */
  joinMessage(who: string): ServerMsg {
    return this.seenBy({ t: 'loot', add: [...this.loot.values()], remove: [], reset: true }, who);
  }

  /** A loot message as player `who` (browser id) sees it: the home bike is gone for whoever has had theirs. */
  seenBy(msg: Extract<ServerMsg, { t: 'loot' }>, who: string): Extract<ServerMsg, { t: 'loot' }> {
    if (!msg.add.some((l) => l.id === this.homeBikeId) || !this.db.hasGrant(who, HOME_KIND)) return msg;
    return { ...msg, add: msg.add.filter((l) => l.id !== this.homeBikeId) };
  }

  /** What changed since the last flush, for everyone (null if nothing). */
  flush(): Extract<ServerMsg, { t: 'loot' }> | null {
    if (!this.added.length && !this.removed.length) return null;
    // Taken again before this went out: just the removal.
    const msg: Extract<ServerMsg, { t: 'loot' }> = { t: 'loot', add: [...new Set(this.added)].filter((l) => this.loot.get(l.id) === l), remove: this.removed };
    this.added = [];
    this.removed = [];
    return msg;
  }

  /**
   * A player (browser id `who`) takes loot `id`: it must be in reach. `give` puts it in their bag
   * (false: no room). Returns the item's kind, 'full' if the bag was full, 'had' if it's the home bike and they've
   * had one (one each, so it can't be farmed for motors; another lies there at once), or null if refused.
   */
  take(s: PlayerState, who: string, id: unknown, give: (l: Loot) => boolean): string | null {
    const l = typeof id === 'number' ? this.loot.get(id) : undefined;
    if (!l || !lootReach(s, l, 1.5)) return null;
    if (l.id === this.homeBikeId) {
      if (this.db.hasGrant(who, HOME_KIND)) return 'had';
      if (!this.db.tx(() => give(l) && (this.db.markGrant(who, HOME_KIND), this.remove(l), this.queue('find', HOME_KIND), true))) return 'full';
      return l.kind;
    }
    if (l.src === 'drop') {
      if (!this.db.tx(() => give(l) && (this.db.deleteDropped(l.id), true))) return 'full';
      this.remove(l);
      return l.kind;
    }
    const key = this.spawnKey.get(l.id) ?? (l.kind in FINDS ? l.kind : RARE_KIND);
    if (!this.db.tx(() => give(l) && (this.remove(l), this.queue(l.src === 'find' ? 'find' : 'cache', key), true))) return 'full';
    return l.kind;
  }

  /** An item a player dropped: it lands on the sand just in front of them. Call inside the transaction that takes it out of their box. */
  drop(s: PlayerState, item: { kind: string; parts?: (string | null)[] }) {
    const a = s.riding ? s.heading : s.facing;
    const x = s.x - Math.sin(a) * DROP_AHEAD + rand(-0.2, 0.2);
    const z = s.z - Math.cos(a) * DROP_AHEAD + rand(-0.2, 0.2);
    const l: Loot = { id: this.nextId++, kind: item.kind, ...(item.parts ? { parts: [...item.parts] } : {}), x, z, src: 'drop' };
    this.db.insertDropped(l.id, l.kind, l.parts, x, z);
    this.add(l);
  }

  /** Something left on the sand within `spread` m of (x, z) (a killed walker's parts, server/guardians.ts; thrown
   *  scrap, server/throws.ts), kept like a dropped item. */
  dropAt(x: number, z: number, kind: string, spread = 0.8) {
    const l: Loot = { id: this.nextId++, kind, x: x + rand(-spread, spread), z: z + rand(-spread, spread), src: 'drop' };
    this.db.insertDropped(l.id, l.kind, l.parts, l.x, l.z);
    this.add(l);
  }

  /** A piece of broken gear left on the sand at (x, z), like dropAt. */
  dropBroken(x: number, z: number, kind: string, spread = 0.8) {
    const l: Loot = { id: this.nextId++, kind, parts: this.brokenParts(kind), x: x + rand(-spread, spread), z: z + rand(-spread, spread), src: 'drop' };
    this.db.insertDropped(l.id, l.kind, l.parts, l.x, l.z);
    this.add(l);
  }

  /** Every few seconds: put back what was taken a while ago. */
  respawn() {
    const now = Date.now();
    const due = this.pending.filter((p) => p.at <= now);
    if (!due.length) return;
    this.db.tx(() => {
      for (const p of due) {
        this.dropPending(p);
        if (p.what === 'find') this.spawnFind(p.kind!);
        else this.spawnCache();
      }
    });
  }

  /** A find or cache laid out (kept in the DB); `spawn`: what a find stands in for. Dropped items use add(). */
  private place(l: Loot, spawn: string | null) {
    this.db.putWorldLoot(l, spawn);
    if (spawn) this.spawnKey.set(l.id, spawn);
    this.add(l);
  }

  private add(l: Loot) {
    this.loot.set(l.id, l);
    this.added.push(l);
  }

  private remove(l: Loot) {
    this.loot.delete(l.id);
    this.removed.push(l.id);
    if (l.src !== 'drop') {
      this.db.deleteWorldLoot(l.id);
      this.spawnKey.delete(l.id);
    }
  }

  /** A taken find (spawn key `kind`) or cache comes back somewhere else after a while. */
  private queue(what: 'find' | 'cache', kind: string) {
    const at = Date.now() + (what === 'find' ? FIND_RESPAWN_MS : CACHE_RESPAWN_MS);
    const k = what === 'find' ? kind : null;
    this.pending.push({ id: this.db.insertLootPending(at, what, k), at, what, ...(k ? { kind: k } : {}) });
  }

  private dropPending(p: Spawn) {
    this.db.deleteLootPending(p.id);
    this.pending = this.pending.filter((q) => q !== p);
  }

  /** Broken: a few low-tier parts already in (never a rare slot's), at least one slot empty. */
  private brokenParts(kind: string): (string | null)[] {
    const slots = GEAR[kind].slots;
    const parts = slots.map((s): string | null =>
      !s.rare && Math.random() < BROKEN_GEAR.filled ? ('part' in s ? partKind(s.part, pickTier(BROKEN_GEAR.tierWeights, Math.random)) : pick(s.scrap)) : null);
    if (!parts.includes(null)) parts[Math.floor(Math.random() * parts.length)] = null;
    return parts;
  }

  /** Gear kind `kind` (FINDS) lying at a crash site of its level, among the debris around the wreck; RARE_KIND: a rare part. */
  private spawnFind(kind: string) {
    if (kind === STASH_KIND) return this.spawnStash();
    if (kind === HOME_KIND) {
      const parts = GEAR.motorcycle.slots.map((s) => ('part' in s && HOME_BIKE.fitted.includes(s.part) ? partKind(s.part, 'scrap') : null));
      this.homeBikeId = this.nextId++;
      this.place({ id: this.homeBikeId, kind: 'motorcycle', parts, ...this.homeBike, src: 'find' }, HOME_KIND);
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
      if (!overBase(x, z, 6) && !overShelter(x, z, 6)) break;
    }
    if (kind === RARE_KIND) {
      this.place({ id: this.nextId++, kind: partKind(pick(RARE_PARTS), pickTier(RARE_FINDS.tierWeights, Math.random)), x, z, src: 'find' }, kind);
    } else this.place({ id: this.nextId++, kind, parts: this.brokenParts(kind), x, z, src: 'find' }, kind);
  }

  /** A stash on the floor of a shelter that has none lying in it yet. */
  private spawnStash() {
    const taken = new Set<number>();
    for (const [id, k] of this.spawnKey) {
      const l = this.loot.get(id);
      if (k === STASH_KIND && l) taken.add(shelterAt(l.x, l.z)?.id ?? -1);
    }
    const free = this.shelters.filter((s) => !taken.has(s.id));
    const { x, z } = shelterLootSpot(pick(free.length ? free : this.shelters), Math.random);
    this.place({ id: this.nextId++, ...this.contents(SHELTER_STASHES), x, z, src: 'find' }, STASH_KIND);
  }

  /** What a cache or stash holds, picked by its table's odds. */
  private contents(t: { contents: Record<'part' | 'scrap' | 'cloth' | 'pistol' | 'gear' | 'receiver', number>; tierWeights: TierWeights }) {
    const what = pickOdds(t.contents);
    if (what === 'part') return { kind: partKind(pick(CACHE_PARTS), pickTier(t.tierWeights, Math.random)) };
    if (what === 'scrap') return { kind: SCRAP };
    if (what === 'cloth') return { kind: CLOTH };
    const kind = what === 'pistol' ? PISTOL : what === 'receiver' ? pick(Object.values(RECEIVERS)) : pick(CACHE_GEAR);
    return { kind, parts: this.brokenParts(kind) };
  }

  private spawnCache() {
    let x = 0, z = 0;
    for (let tries = 0; tries < 20; tries++) {
      const a = rand(0, Math.PI * 2), d = rand(CACHE_MIN_R, CACHE_MAX_R);
      x = BASE.x + Math.sin(a) * d;
      z = BASE.z + Math.cos(a) * d;
      if (!overBase(x, z, 10) && !overShelter(x, z, 10) && !rocksNear(x, z, 3)) break;
    }
    this.place({ id: this.nextId++, ...this.contents(CACHES), x, z, src: 'cache' }, null);
  }
}
