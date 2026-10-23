// Loot lying in the world (shared/loot.ts): broken gear to find and repair (shared/gear.ts) at the crash sites (the
// starter gear at the scrap fields near the base, the advanced gear on crawler ground, rare loose parts on guardian
// ground: shared/crashsites.ts SiteLevel; the motorcycles among FINDS lie there as vehicles: server/vehicles.ts), stashes
// on the shelters' floors (SHELTER_STASHES), and caches lying out in the open desert. All shared: the first player to press F
// takes it. Taken finds and caches come back somewhere else after a while, so there are always some out there.
// Kept in the DB (`world_loot`, `loot_pending`, written on change), so a restart keeps what was taken. Items
// players drop are kept in `dropped` and never respawn.
import { shelterAt, sheltersNear } from '../shared/shelters.ts';
import { isGear, isVehicle, refit, scrapParts } from '../shared/gear.ts';
import { RETIRED, withData, type ItemData } from '../shared/items.ts';
import { DROP_AHEAD, lootReach, type Loot } from '../shared/loot.ts';
import { coreCrashSites } from '../shared/crashsites.ts';
import { brokenParts, cacheContents, cacheSpot, findContents, findSpot, nearPiles, shelterStash, stashSpot } from '../shared/lootRoll.ts';
import { CACHES, FINDS, RARE_FINDS, SHELTER_STASHES } from '../shared/tables.ts';
import { CORE_HALF } from '../shared/terrain.ts';
import type { PlayerState } from '../shared/sim.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { LAB } from '../shared/world.ts';
import { labItems, type LabItem } from '../shared/lab.ts';
import type { openDb } from './db.ts';

type Db = ReturnType<typeof openDb>;

// What lies around and what is in it: FINDS, RARE_FINDS, BROKEN_GEAR and CACHES in shared/tables.ts; the dice (what's in
// them, where they lie) in shared/lootRoll.ts, shared with the economy simulator (tools/econsim).
/** The FINDS key for a loose rare part at guardian ground (level 2). */
const RARE_KIND = 'rare';
/** The pending-spawn key for a stash on a shelter's floor (SHELTER_STASHES). */
const STASH_KIND = 'shelter';
/** A taken find / cache is replaced this long after (ms). */
const FIND_RESPAWN_MS = 3 * 60_000;
const CACHE_RESPAWN_MS = 60_000;

/** A taken find or cache waiting to come back; id is its loot_pending row. */
type Spawn = { id: number; at: number; what: 'find' | 'cache'; kind?: string };

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class LootServer {
  readonly loot = new Map<number, Loot>();
  private nextId = 1;
  private pending: Spawn[] = [];
  private added: Loot[] = [];
  private removed: number[] = [];
  /** Finds lie at the sites in the core square (terrain.ts CORE_HALF), not spread over the endless world. */
  private sites = coreCrashSites();
  private piles = nearPiles();
  private shelters = sheltersNear(0, 0, CORE_HALF * 1.5);
  /** What each lying find stands in for (FINDS key, RARE_KIND, STASH_KIND); caches aren't in it. */
  private spawnKey = new Map<number, string>();
  /** The dev test lab's pickups (shared/lab.ts): taken, they are laid out again where they were. */
  private labSpots = new Map<number, LabItem>();
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    if (LAB) {
      // Nothing of the desert's finds and caches: only what players dropped here, and the lab's own tables.
      for (const r of db.loadDropped()) {
        this.loot.set(r.id, { id: r.id, kind: r.kind, ...(r.parts ? { parts: r.parts } : {}), ...withData(r.data), x: r.x, z: r.z, src: 'drop' });
        this.nextId = Math.max(this.nextId, r.id + 1);
      }
      for (const r of db.loadWorldLoot()) db.deleteWorldLoot(r.id);
      for (const it of labItems()) this.labPlace(it);
      this.added = [];
      return;
    }
    // Dropped items keep their ids; everything else is numbered after them.
    for (const r of db.loadDropped()) {
      if (RETIRED.has(r.kind)) {
        db.deleteDropped(r.id);
        continue;
      }
      // Gear whose slots changed since (shared/gear.ts refit); a jammer from before it was gear works, with Scrap parts.
      const parts = r.parts ?? (isGear(r.kind) ? scrapParts(r.kind) : undefined);
      const l: Loot = { id: r.id, kind: r.kind, ...(parts ? { parts } : {}), ...withData(r.data), x: r.x, z: r.z, src: 'drop' };
      refit(l);
      this.loot.set(r.id, l);
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
      const l: Loot = { id: r.id, kind: r.kind, ...(r.parts ? { parts: r.parts } : {}), x: r.x, z: r.z, src: r.src };
      refit(l);
      this.loot.set(r.id, l);
      if (r.spawn) this.spawnKey.set(r.id, r.spawn);
      this.nextId = Math.max(this.nextId, r.id + 1);
    }
    this.pending = db.loadLootPending().map((p) => ({ id: p.id, at: p.at, what: p.what, ...(p.kind ? { kind: p.kind } : {}) }));
    // As many of each as shared/tables.ts says (a fresh DB lays them all out; a changed table tops up or trims). Not the
    // vehicles (server/vehicles.ts); those lying here from when they were items are trimmed away.
    db.tx(() => {
      const want = new Map<string, number>(Object.entries(FINDS).filter(([k]) => !isVehicle(k)).map(([k, f]) => [k, f.n]));
      want.set(RARE_KIND, RARE_FINDS.n);
      want.set(STASH_KIND, this.shelters.reduce((n, s) => n + SHELTER_STASHES.perShelter[s.kind], 0));
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

  /** Everything, for a joining client. */
  joinMessage(): ServerMsg {
    return { t: 'loot', add: [...this.loot.values()], remove: [], reset: true };
  }

  /** Loot `id` again, for a player whose client hid it on a refused take; null if it's gone. */
  back(id: unknown): Extract<ServerMsg, { t: 'loot' }> | null {
    const l = typeof id === 'number' ? this.loot.get(id) : undefined;
    return l ? { t: 'loot', add: [l], remove: [] } : null;
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
   * A player takes loot `id`: it must be in reach. `give` puts it in their bag (false: no room). Returns the item's
   * kind, 'full' if the bag was full, or null if refused.
   */
  take(s: PlayerState, id: unknown, give: (l: Loot) => boolean): string | null {
    const l = typeof id === 'number' ? this.loot.get(id) : undefined;
    if (!l || !lootReach(s, l, 1.5)) return null;
    const spot = this.labSpots.get(l.id);
    if (spot) {
      if (!give(l)) return 'full';
      this.remove(l);
      this.labPlace(spot);
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
  drop(s: PlayerState, item: { kind: string; parts?: (string | null)[]; data?: ItemData }) {
    const a = s.riding ? s.heading : s.facing;
    const x = s.x - Math.sin(a) * DROP_AHEAD + rand(-0.2, 0.2);
    const z = s.z - Math.cos(a) * DROP_AHEAD + rand(-0.2, 0.2);
    const l: Loot = { id: this.nextId++, kind: item.kind, ...(item.parts ? { parts: [...item.parts] } : {}), ...withData(item.data), x, z, src: 'drop' };
    this.db.insertDropped(l.id, l.kind, l.parts, x, z, l.data);
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
  dropBroken(x: number, z: number, kind: string, spread = 0.8, parts = this.brokenParts(kind)) {
    const l: Loot = { id: this.nextId++, kind, parts, x: x + rand(-spread, spread), z: z + rand(-spread, spread), src: 'drop' };
    this.db.insertDropped(l.id, l.kind, l.parts, l.x, l.z);
    this.add(l);
  }

  /** A lab pickup lying at its spot (not kept in the DB: the table is laid out afresh every start). */
  private labPlace(it: LabItem) {
    const l: Loot = { id: this.nextId++, kind: it.kind, ...(it.parts ? { parts: [...it.parts] } : {}), x: it.x, z: it.z, src: 'find' };
    this.labSpots.set(l.id, it);
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
    this.labSpots.delete(l.id);
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

  private brokenParts(kind: string): (string | null)[] {
    return brokenParts(kind, Math.random);
  }

  /** Gear kind `kind` (FINDS) lying at a crash site of its level, among the debris around the wreck; RARE_KIND: a rare part. */
  private spawnFind(kind: string) {
    if (kind === STASH_KIND) return this.spawnStash();
    // At a crash site of its level, among the debris round the wreck (level 0 now and then at a scrap pile near the base);
    // RARE_KIND (not in FINDS): a loose rare part on guardian ground.
    const { x, z } = findSpot(FINDS[kind]?.level ?? 2, this.sites, this.piles, Math.random);
    this.place({ id: this.nextId++, ...findContents(kind, Math.random), x, z, src: 'find' }, kind);
  }

  /** A stash on the floor of the shelter furthest short of its SHELTER_STASHES.perShelter. */
  private spawnStash() {
    const lying = new Map<number, number>();
    for (const [id, k] of this.spawnKey) {
      const l = this.loot.get(id);
      const s = l && k === STASH_KIND ? shelterAt(l.x, l.z) : null;
      if (s) lying.set(s.id, (lying.get(s.id) ?? 0) + 1);
    }
    const { x, z } = stashSpot(this.shelters, lying, Math.random);
    this.place({ id: this.nextId++, ...shelterStash(Math.random), x, z, src: 'find' }, STASH_KIND);
  }

  private spawnCache() {
    const { x, z } = cacheSpot(Math.random);
    this.place({ id: this.nextId++, ...cacheContents(Math.random), x, z, src: 'cache' }, null);
  }
}
