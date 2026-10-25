// The simulated world: everything a player can go to, as points of interest built from the game's own deterministic
// layout (WORLD_ID picks the seed, shared/world.ts) and loot laid out with the game's own dice (shared/lootRoll.ts).
// Time is the sim's clock (s); what's taken comes back on the server's timers.
import { ORIGIN } from './origin.ts';
import { biome } from '../../shared/biomes.ts';
import { ENEMIES, type EnemyKind } from '../../shared/enemies.ts';
import { machinesAt } from '../../shared/crash.ts';
import { CRASH_KINDS } from '../../shared/crashKinds.ts';
import { coreCrashSites, siteLevel, type CrashSite, type LootLevel, type SiteLevel } from '../../shared/crashsites.ts';
import { debrisItem, scrapItem } from '../../shared/items.ts';
import { cacheContents, cacheSpot, findContents, findSpot, nearPiles, shelterStash, shipFind, shipFindSpot, type Drop, type Rand } from '../../shared/lootRoll.ts';
import { SHIP_AT, shipSites } from '../../shared/ship.ts';
import { SCRAP_CELL, scrapPieces } from '../../shared/scrap.ts';
import { junkSpec, type JunkKind } from '../../shared/salvage.ts';
import { sheltersNear, shelterLootSpot } from '../../shared/shelters.ts';
import { CACHES, FINDS, RARE_FINDS, SHELTER_STASHES, SHIP_LOOT } from '../../shared/tables.ts';
import { CORE_HALF } from '../../shared/terrain.ts';
import { wrecksNear } from '../../shared/wrecks.ts';

/** Server timers (server/loot.ts, server/scrap.ts, server/crash.ts, shared/corpse.ts), s. */
const FIND_BACK = 3 * 60, CACHE_BACK = 60, SCRAP_BACK = 30 * 60, DEBRIS_BACK = 30 * 60, WRECK_BACK = 45 * 60, STARTER_BACK = 20 * 60;
export const CORPSE_S = 30 * 60;
/** Scrap piles further out than this aren't worth listing: scrap is near home. */
const PILE_R = 1100;
/** Hunting spots are looked for within this distance of the base (m). */
const HUNT_R = 2600;

export type Thing = Drop & { id: number; src: Source };
/** Where a thing came from, for the report's part sources. */
export type Source = string;

/** A machine to take apart: a crash site's large one (worked where it lies) or a small one or salvage wreck (carried home). */
export type Machine = { kind: JunkKind; seed: number; level: LootLevel; carry: boolean; backAt: number; respawn: number };

export type Poi = {
  id: number;
  type: 'pile' | 'site' | 'wreck' | 'shelter' | 'loot' | 'corpse' | 'jet';
  x: number; z: number;
  /** How dangerous the ground is (shared/crashsites.ts siteLevel). */
  zone: SiteLevel;
  known: boolean;
  /** Last time the agent looked here (s), -Infinity: never. */
  seenAt: number;
  /** Pieces to pick up (scrap piles, crash debris): their item and when each is back (≤ now: lying there). */
  pieces: { item: string; backAt: number; respawn: number }[];
  machines: Machine[];
  /** Loose things lying here. */
  things: Thing[];
  /** A crash site: the site, and when its pack (if any) is back. */
  site?: CrashSite;
  packBackAt: number;
  /** A corpse pack or a jet's wreck goes after this. */
  expires: number;
  /** A hunting spot: ground where this enemy comes to you (shared/enemies.ts roaming meets with `hunt`). */
  hunt?: EnemyKind;
};

type Pending = { at: number; what: 'find' | 'cache' | 'stash' | 'ship'; kind: string };

export class World {
  readonly pois: Poi[] = [];
  private nextId = 1;
  private pending: Pending[] = [];
  private sites: CrashSite[];
  private piles = nearPiles();
  private shelters: Poi[] = [];
  /** The crashed ship players arrive at (shared/ship.ts): its starter machines and what lies about it. */
  private ship: Poi | null = null;
  private mudCache = new Map<string, boolean>();
  private rand: Rand;

  constructor(rand: Rand) {
    this.rand = rand;
    this.sites = coreCrashSites();
    for (const s of this.sites) {
      const p = this.poi('site', s.x, s.z);
      p.site = s;
      p.known = true; // smoke, the beacon's beep
      for (const pc of s.pieces) if (pc.id) p.pieces.push({ item: debrisItem(CRASH_KINDS[pc.kind].node), backAt: 0, respawn: DEBRIS_BACK });
      for (const m of machinesAt(s)) {
        const carry = junkSpec(m.kind).carry;
        // A large machine stripped stays stripped; a small one carried off is gone, but a scrap field's comes back.
        p.machines.push({ kind: m.kind, seed: m.seed, level: m.level, carry, backAt: 0, respawn: carry && s.loot === 0 ? STARTER_BACK : Infinity });
      }
    }
    const lo = Math.floor((ORIGIN.x - PILE_R) / SCRAP_CELL), hi = Math.floor((ORIGIN.x + PILE_R) / SCRAP_CELL);
    const loZ = Math.floor((ORIGIN.z - PILE_R) / SCRAP_CELL), hiZ = Math.floor((ORIGIN.z + PILE_R) / SCRAP_CELL);
    for (let iz = loZ; iz <= hiZ; iz++) for (let ix = lo; ix <= hi; ix++) {
      const ps = scrapPieces(ix, iz);
      if (!ps.length) continue;
      const x = ps.reduce((a, q) => a + q.x, 0) / ps.length, z = ps.reduce((a, q) => a + q.z, 0) / ps.length;
      if (Math.hypot(x - ORIGIN.x, z - ORIGIN.z) > PILE_R) continue;
      const p = this.poi('pile', x, z);
      for (const q of ps) p.pieces.push({ item: scrapItem(q.kind), backAt: 0, respawn: SCRAP_BACK });
    }
    for (const w of wrecksNear(ORIGIN.x, ORIGIN.z, CORE_HALF)) {
      const p = this.poi('wreck', w.x, w.z);
      p.machines.push({ kind: w.kind, seed: 0, level: 1, carry: true, backAt: 0, respawn: WRECK_BACK });
    }
    for (const s of sheltersNear(0, 0, CORE_HALF * 1.5)) {
      const p = this.poi('shelter', s.x, s.z);
      this.shelters.push(p);
      for (let i = 0; i < SHELTER_STASHES.perShelter[s.kind]; i++) {
        shelterLootSpot(s, this.rand); // (the server rolls a spot too: keep the stream in step with it)
        p.things.push(this.thing(shelterStash(this.rand), 'stash'));
      }
    }
    if (SHIP_AT) {
      const p = (this.ship = this.poi('wreck', SHIP_AT.x, SHIP_AT.z));
      p.known = true; // (where you start)
      for (const m of shipSites()) p.machines.push({ kind: m.kind, seed: m.seed, level: 0, carry: true, backAt: 0, respawn: STARTER_BACK });
      for (let i = 0; i < SHIP_LOOT.n; i++) this.spawnShip();
    }
    for (const [kind, f] of Object.entries(FINDS)) for (let i = 0; i < f.n; i++) this.spawnFind(kind);
    for (let i = 0; i < RARE_FINDS.n; i++) this.spawnFind('rare');
    for (let i = 0; i < CACHES.n; i++) this.spawnCache();
    this.huntingSpots();
  }

  /** Where to go and wait for what can be hunted (shared/enemies.ts `hunt`): the nearest few stretches of its ground. */
  private huntingSpots() {
    for (const kind of Object.keys(ENEMIES) as EnemyKind[]) for (const m of ENEMIES[kind].meet) {
      if (m.at !== 'roam' || !m.hunt) continue;
      const spots: { x: number; z: number; d: number }[] = [];
      for (let r = 300; r <= HUNT_R; r += 150) for (let a = 0; a < 24; a++) {
        const x = ORIGIN.x + Math.cos((a / 24) * Math.PI * 2) * r, z = ORIGIN.z + Math.sin((a / 24) * Math.PI * 2) * r;
        const ok = m.where === 'mudflat' ? biome('mudflat', x, z) >= 0.9 : m.where === 'guardianGround' ? siteLevel(x, z) === 2 : false;
        if (ok && spots.every((s) => Math.hypot(s.x - x, s.z - z) > 600)) spots.push({ x, z, d: r });
      }
      for (const s of spots.slice(0, 4)) {
        const p = this.poi('loot', s.x, s.z);
        p.hunt = kind;
        p.known = true; // (the lie of the land: seen from afar)
      }
    }
  }

  /** Near a mud flat: within the distance a harvester rises from someone (server/harvesters.ts RISE_MAX), roughly. */
  nearMud(x: number, z: number): boolean {
    const k = `${Math.round(x / 200)},${Math.round(z / 200)}`;
    let near = this.mudCache.get(k);
    if (near === undefined) {
      near = false;
      for (let i = 0; i < 9 && !near; i++) {
        const r = i ? 600 : 0, a = (i / 8) * Math.PI * 2;
        near = biome('mudflat', x + Math.cos(a) * r, z + Math.sin(a) * r) >= 0.9;
      }
      this.mudCache.set(k, near);
    }
    return near;
  }

  /** How many crash sites hold finds of loot level `level` (FINDS lie at one of them). */
  sitesAt(level: LootLevel): number {
    return Math.max(1, this.sites.filter((s) => s.loot === level).length);
  }

  poi(type: Poi['type'], x: number, z: number): Poi {
    const p: Poi = { id: this.nextId++, type, x, z, zone: siteLevel(x, z), known: false, seenAt: -Infinity, pieces: [], machines: [], things: [], packBackAt: 0, expires: Infinity };
    this.pois.push(p);
    return p;
  }

  thing(d: Drop, src: Source): Thing {
    return { ...d, id: this.nextId++, src };
  }

  private spawnFind(kind: string) {
    const { x, z } = findSpot(FINDS[kind]?.level ?? 2, this.sites, this.piles, this.rand);
    this.poi('loot', x, z).things.push(this.thing(findContents(kind, this.rand), kind === 'rare' ? 'rare find' : 'find'));
  }

  /** Scrap, cloth or a broken canteen about the ship (server/loot.ts rolls the thing, then its spot). */
  private spawnShip() {
    const d = shipFind(this.rand);
    shipFindSpot(this.rand);
    this.ship!.things.push(this.thing(d, 'ship'));
  }

  private spawnCache() {
    const { x, z } = cacheSpot(this.rand);
    this.poi('loot', x, z).things.push(this.thing(cacheContents(this.rand), 'cache'));
  }

  /** Things laid on the sand at (x, z) (kills, a jet's wreck), known at once. */
  drop(x: number, z: number, things: Thing[], type: Poi['type'] = 'loot', expires = Infinity): Poi {
    const p = this.poi(type, x, z);
    p.things.push(...things);
    p.known = true;
    p.expires = expires;
    return p;
  }

  /** A thing taken from where it lay: finds, caches and stashes come back (somewhere else) on the server's timers. */
  taken(p: Poi, t: Thing, now: number) {
    p.things.splice(p.things.indexOf(t), 1);
    if (t.src === 'find' || t.src === 'rare find') this.pending.push({ at: now + FIND_BACK, what: 'find', kind: t.src === 'rare find' ? 'rare' : t.kind });
    else if (t.src === 'cache') this.pending.push({ at: now + CACHE_BACK, what: 'cache', kind: '' });
    else if (t.src === 'stash') this.pending.push({ at: now + FIND_BACK, what: 'stash', kind: '' });
    else if (t.src === 'ship') this.pending.push({ at: now + FIND_BACK, what: 'ship', kind: '' });
  }

  /** Bring back what's due, drop what's expired. */
  tick(now: number) {
    const due = this.pending.filter((q) => q.at <= now);
    if (due.length) this.pending = this.pending.filter((q) => q.at > now);
    for (const q of due) {
      if (q.what === 'find') this.spawnFind(q.kind);
      else if (q.what === 'cache') this.spawnCache();
      else if (q.what === 'ship') this.spawnShip();
      else {
        // The shelter furthest short of its stashes (shared/lootRoll.ts stashSpot, by counts).
        const s = this.shelters.reduce((a, b) => (b.things.length < a.things.length ? b : a));
        s.things.push(this.thing(shelterStash(this.rand), 'stash'));
      }
    }
    for (let i = this.pois.length - 1; i >= 0; i--) {
      const p = this.pois[i];
      if (p.expires <= now || (p.type === 'loot' && !p.things.length && !p.hunt)) this.pois.splice(i, 1);
    }
  }
}
