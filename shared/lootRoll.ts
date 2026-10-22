// The dice of the loot in the world, as plain functions of a `rand` (() => [0, 1)): what a cache, stash or broken find
// holds, where finds and caches are laid out, and what a killed enemy, a downed jet, a harvester or a boss leaves. The
// server rolls them with Math.random (server/loot.ts, server/world.ts); the economy simulator (tools/econsim) rolls the
// same ones with seeded streams, so the two can't drift apart. Tables in shared/tables.ts.
import { BASE, BASE_SPAWN, overBase } from './base.ts';
import { overShelter, shelterLootSpot, type Shelter } from './shelters.ts';
import { GEAR, GEAR_KINDS } from './gear.ts';
import { JAMMER } from './jammer.ts';
import { RECEIVERS, RELICS, receiverBoss, type BossKind } from './bosses.ts';
import { CLOTH, partKind, SCRAP, WIRING } from './items.ts';
import type { CrashSite, SiteLevel } from './crashsites.ts';
import { SCRAP_CELL, scrapPieces } from './scrap.ts';
import { PART_IDS, pickTier } from './parts.ts';
import { GUNS, PISTOL, RIFLE } from './rifle.ts';
import { rocksNear } from './rocks.ts';
import type { JetKind } from './jetbreak.ts';
import {
  BOSS_SPOILS, BROKEN_GEAR, CACHES, DRONE_JET_SPOILS, FINDS, HARVESTER_SCRAP, HARVESTER_SPOILS, JET_RELIC_ODDS, JET_SCRAP,
  KILL_SPOILS, RARE_FINDS, RECEIVER_DROPS, RELIC_DROPS, SHELTER_STASHES, WIRING_DROPS, type TierWeights,
} from './tables.ts';

export type Rand = () => number;
/** Something laid on the sand: an item kind, and the parts in it if it's broken gear. */
export type Drop = { kind: string; parts?: (string | null)[] };

/** The odds a level-0 find lies at a scrap pile (shared/scrap.ts) within PILE_FIND_R m of the base instead of a crash site. */
export const PILE_ODDS = 0.45;
export const PILE_FIND_R = 600;
/** How far from the base caches lie (m). */
export const CACHE_MIN_R = 80, CACHE_MAX_R = 1200;

export const CACHE_PARTS = PART_IDS.filter((p) => !CACHES.noParts.includes(p));
export const RARE_PARTS = PART_IDS.filter((p) => !RARE_FINDS.noParts.includes(p));
/** Broken gear a cache can hold (not the jammer or the receivers; the guns have their own odds: CACHES.contents.pistol
 *  and .rifle). */
export const CACHE_GEAR = GEAR_KINDS.filter((k) => !(k in GUNS) && k !== JAMMER && !receiverBoss(k) && !GEAR[k].built);

const between = (rand: Rand, a: number, b: number) => a + rand() * (b - a);
export const pick = <T>(a: readonly T[], rand: Rand) => a[Math.floor(rand() * a.length)];

/** A key of `odds`, picked by its relative odds. */
export function pickOdds<K extends string>(odds: Record<K, number>, rand: Rand): K {
  const ks = Object.keys(odds) as K[];
  let r = rand() * ks.reduce((a, k) => a + odds[k], 0);
  for (const k of ks) if ((r -= odds[k]) < 0) return k;
  return ks[0];
}

/** Broken: a few low-tier parts already in (never a rare slot's), at least one slot empty. */
export function brokenParts(kind: string, rand: Rand): (string | null)[] {
  const slots = GEAR[kind].slots;
  const parts = slots.map((s): string | null =>
    !s.rare && rand() < BROKEN_GEAR.filled ? ('part' in s ? partKind(s.part, pickTier(BROKEN_GEAR.tierWeights, rand)) : pick(s.scrap, rand)) : null);
  if (!parts.includes(null)) parts[Math.floor(rand() * parts.length)] = null;
  return parts;
}

/** A piece of broken gear of `kind`. */
export const broken = (kind: string, rand: Rand): Drop => ({ kind, parts: brokenParts(kind, rand) });

/** A random boss receiver kind (shared/bosses.ts RECEIVERS). */
export const randomReceiver = (rand: Rand) => pick(Object.values(RECEIVERS), rand);

/** What a cache or stash holds, picked by its table's odds (CACHES, SHELTER_STASHES). */
export function stashContents(t: { contents: Record<'part' | 'scrap' | 'cloth' | 'pistol' | 'rifle' | 'gear' | 'receiver', number>; tierWeights: TierWeights }, rand: Rand): Drop {
  const what = pickOdds(t.contents, rand);
  if (what === 'part') return { kind: partKind(pick(CACHE_PARTS, rand), pickTier(t.tierWeights, rand)) };
  if (what === 'scrap') return { kind: SCRAP };
  if (what === 'cloth') return { kind: CLOTH };
  const kind = what === 'pistol' ? PISTOL : what === 'rifle' ? RIFLE : what === 'receiver' ? randomReceiver(rand) : pick(CACHE_GEAR, rand);
  return broken(kind, rand);
}
export const cacheContents = (rand: Rand) => stashContents(CACHES, rand);
export const shelterStash = (rand: Rand) => stashContents(SHELTER_STASHES, rand);

/** A loose rare part, as found on guardian ground (RARE_FINDS). */
export const rarePart = (rand: Rand): Drop => ({ kind: partKind(pick(RARE_PARTS, rand), pickTier(RARE_FINDS.tierWeights, rand)) });

// ---- where things lie --------------------------------------------------------------------------------------------

/** The scrap piles within PILE_FIND_R of the base: centre and how far their pieces reach. */
export function nearPiles() {
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
export function homeBikeSpot() {
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

/** Where a find of FINDS level `level` lies: among the debris of a crash site of that level (`sites`: the ones finds lie
 *  at), or for level 0 now and then among the pieces of a scrap pile near the base (`piles`, nearPiles). */
export function findSpot(level: SiteLevel, sites: CrashSite[], piles: { x: number; z: number; r: number }[], rand: Rand) {
  const atLevel = sites.filter((s) => s.loot === level);
  let x = 0, z = 0;
  if (level === 0 && piles.length && rand() < PILE_ODDS) {
    const p = pick(piles, rand);
    const a = between(rand, 0, Math.PI * 2), d = between(rand, 1, p.r + 1.5);
    x = p.x + Math.sin(a) * d;
    z = p.z + Math.cos(a) * d;
  } else for (let tries = 0; tries < 20; tries++) {
    const site = pick(atLevel.length ? atLevel : sites, rand);
    const a = between(rand, 0, Math.PI * 2), d = between(rand, site.radius * 0.4, site.radius + 8);
    x = site.x + Math.sin(a) * d;
    z = site.z + Math.cos(a) * d;
    if (!overBase(x, z, 6) && !overShelter(x, z, 6)) break;
  }
  return { x, z };
}

/** Where a cache lies: out in the open desert CACHE_MIN_R..CACHE_MAX_R from the base. */
export function cacheSpot(rand: Rand) {
  let x = 0, z = 0;
  for (let tries = 0; tries < 20; tries++) {
    const a = between(rand, 0, Math.PI * 2), d = between(rand, CACHE_MIN_R, CACHE_MAX_R);
    x = BASE.x + Math.sin(a) * d;
    z = BASE.z + Math.cos(a) * d;
    if (!overBase(x, z, 10) && !overShelter(x, z, 10) && !rocksNear(x, z, 3)) break;
  }
  return { x, z };
}

/** The shelter a new stash goes to: the one furthest short of its SHELTER_STASHES.perShelter (`lying`: stashes on
 *  each shelter's floor by id), and the spot on its floor. */
export function stashSpot(shelters: Shelter[], lying: Map<number, number>, rand: Rand) {
  const short = (s: Shelter) => SHELTER_STASHES.perShelter[s.kind] - (lying.get(s.id) ?? 0);
  const most = Math.max(...shelters.map(short));
  const s = pick(shelters.filter((s) => short(s) === most), rand);
  return { shelter: s, ...shelterLootSpot(s, rand) };
}

/** A find of FINDS kind `kind` (a broken piece of gear), or a loose rare part. */
export const findContents = (kind: string, rand: Rand): Drop => (kind in FINDS ? broken(kind, rand) : rarePart(rand));

// ---- what killed things leave -------------------------------------------------------------------------------------

/** `sp.min..sp.max` parts of a Spoils table (with its odds), plus `extra`. */
function spoils(sp: { odds: number; min: number; max: number; parts: string[]; tierWeights: TierWeights }, rand: Rand, extra = 0): Drop[] {
  const n = rand() < sp.odds ? sp.min + Math.floor(rand() * (sp.max - sp.min + 1)) + extra : 0;
  const out: Drop[] = [];
  for (let i = 0; i < n; i++) out.push({ kind: partKind(pick(sp.parts, rand) as never, pickTier(sp.tierWeights, rand)) });
  return out;
}

const scrapHeap = (r: { min: number; max: number }, rand: Rand): Drop[] =>
  Array.from({ length: r.min + Math.floor(rand() * (r.max - r.min + 1)) }, () => ({ kind: SCRAP }));

/** The wiring a killed `kind` always leaves (WIRING_DROPS); no dice. */
const wiring = (kind: keyof typeof WIRING_DROPS): Drop[] => Array.from({ length: WIRING_DROPS[kind] }, () => ({ kind: WIRING }));

/** A killed walker or downed drone (KILL_SPOILS): its own part maybe (RELIC_DROPS), a broken receiver now and then, its spoils,
 *  its wiring. */
export function killDrops(kind: 'guardian' | 'crawler' | 'drone', rand: Rand): Drop[] {
  const out: Drop[] = [];
  if (rand() < RELIC_DROPS[kind].odds) out.push({ kind: RELIC_DROPS[kind].kind });
  if (rand() < RECEIVER_DROPS[kind]) out.push(broken(randomReceiver(rand), rand));
  return [...out, ...spoils(KILL_SPOILS[kind], rand), ...wiring(kind)];
}

/** A downed jet's loose things (its engines are machines, shared/jetcrash.ts): the drone's parts (one more if `soft`: jammed
 *  down whole), the transponder maybe, a broken receiver now and then, scrap off the airframe, its wiring. */
export function jetDrops(kind: JetKind, soft: boolean, rand: Rand): Drop[] {
  const out: Drop[] = kind === 'drone' ? spoils({ ...DRONE_JET_SPOILS, odds: 1 }, rand, soft ? 1 : 0) : [];
  if (rand() < JET_RELIC_ODDS) out.push({ kind: RELIC_DROPS.drone.kind });
  if (rand() < RECEIVER_DROPS.jet) out.push(broken(randomReceiver(rand), rand));
  return [...out, ...scrapHeap(JET_SCRAP, rand), ...wiring('jet')];
}

/** A killed harvester's burst hopper: ore and drive parts, a heap of scrap, a broken receiver now and then, its wiring. */
export function harvesterDrops(rand: Rand): Drop[] {
  const out = [...spoils({ ...HARVESTER_SPOILS, odds: 1 }, rand), ...scrapHeap(HARVESTER_SCRAP, rand)];
  if (rand() < RECEIVER_DROPS.jet) out.push(broken(randomReceiver(rand), rand));
  return [...out, ...wiring('harvester')];
}

/** A killed boss: its own part (RELICS), its spoils and its wiring. */
export function bossDrops(kind: BossKind, rand: Rand): Drop[] {
  const relic = RELICS[kind];
  return [...(relic ? [{ kind: relic }] : []), ...spoils({ ...BOSS_SPOILS[kind], odds: 1 }, rand), ...wiring(kind)];
}
