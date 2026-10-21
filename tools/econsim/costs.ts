// Everything the economy simulator assumes that the game's own code doesn't say: how long things take a player, how
// often fights happen and how they end. The loot itself (what lies where, what is in it, what drops) comes from the
// game's shared/ code, so a change to shared/tables.ts shows in the results; a change here changes the yardstick, and
// the report says so ("sim changed"). Calibrate against real play (docs/econsim.md).
import { WALK_SPEED } from '../../shared/sim.ts';
import type { LootLevel } from '../../shared/crashsites.ts';

export type Weapon = 'none' | 'pistol' | 'rifle';

/** A fight at a crash site or with something roaming: how many there are, how long it takes, the odds of dying, by
 *  your best gun. With no gun you only get away (no kills); `deathQ`: each tier of the gun's quality cuts the death odds
 *  by this share. */
export type Fight = { enemy: 'crawler' | 'guardian' | 'drone'; n: [number, number]; seconds: Record<Weapon, number>; death: Record<Weapon, number>; deathQ: number };

export const COSTS = {
  /** Hard stop for one simulated world (s of game time). */
  capS: 10 * 3600,

  // ---- moving --------------------------------------------------------------------------------------------------
  /** Average ground speed on foot (m/s): walking pace, the odd sprint, minus the detours round dunes and rocks. */
  footSpeed: WALK_SPEED * 0.9,
  /** Share of the bike's top speed (shared/gear.ts bikeTopSpeed) made good across the dunes. */
  bikeShare: 0.6,
  /** Getting on and off, parking by the door (s per trip leg). */
  bikeMountS: 4,
  /** Share of the time outdoors spent in direct sun (the rest in the lee of dunes and rocks). */
  sunShare: 0.85,

  // ---- heat (shared/water.ts) ------------------------------------------------------------------------------------
  /** Take a sip at this heat (if the bottle has one). */
  sipAt: 70,
  /** With nothing to drink, stop in the shade at this heat... */
  restAt: 88,
  /** ...until it's down to this. */
  restTo: 25,

  // ---- handling ------------------------------------------------------------------------------------------------
  /** Picking one thing off the sand (aim, press, the animation), s. */
  pickS: 2,
  /** Walking round a scrap pile or a crash site's debris between pieces, s per piece. */
  pileWalkS: 4,
  /** Opening a cache or stash, looking it over, s. */
  openS: 4,
  /** One teardown step (unscrewing, prying, cutting a wire), s. */
  stepS: 5,
  /** Steps of a machine built in code (src/teardown/junk.ts; the server can't count them): this many to open it, then
   *  this many per part in it. Modules ≈ parts / 2 for the scrap they pay (SCRAP_REWARD). */
  codeSteps: { base: 4, perPart: 2.5 },
  /** At the base: unloading, the workbench, sorting the chest (s per visit), and per repair or craft. */
  baseS: 45,
  benchS: 8,
  /** Down, then out of the bunker again (shared/ragdoll.ts DOWN_MS plus finding your feet), s. */
  respawnS: 20,

  // ---- seeing --------------------------------------------------------------------------------------------------
  /** How far off you notice things while passing (m): a scrap pile, a salvage wreck, a shelter's hut, small loot
   *  (a cache, a broken find, a dropped pack). Crash sites smoke and beep: always known. The spyglass multiplies the
   *  small-loot range by this at quality 0 .. 3. */
  see: { pile: 220, wreck: 260, shelter: 200, loot: 45 },
  spyglassSee: [1.6, 2.4] as [number, number],
  /** Expected unseen finds at a crash site come back this fast after you've looked (s for a full turnover). */
  findTurnoverS: 3600,

  // ---- fights (flat odds; calibrate) ---------------------------------------------------------------------------
  /** Crawlers turn up at every crash site of crawler and guardian ground as you come near (server/guardians.ts: 1–4, an
   *  outpost's 1–2): the fight on arriving, unless you were there lately. */
  crawlers: {
    0.5: { enemy: 'crawler', n: [1, 2], seconds: { none: 40, pistol: 45, rifle: 30 }, death: { none: 0.25, pistol: 0.06, rifle: 0.02 }, deathQ: 0.2 },
    1: { enemy: 'crawler', n: [1, 4], seconds: { none: 60, pistol: 90, rifle: 50 }, death: { none: 0.45, pistol: 0.12, rifle: 0.04 }, deathQ: 0.2 },
    2: { enemy: 'crawler', n: [1, 4], seconds: { none: 60, pistol: 90, rifle: 50 }, death: { none: 0.45, pistol: 0.12, rifle: 0.04 }, deathQ: 0.2 },
  } as Partial<Record<LootLevel, Fight>>,
  /** A site's crawlers are back this long after you've left (s; the server refills them a minute after everyone's gone). */
  crawlersBackS: 5 * 60,
  /** By night two searchlight drones keep each site of crawler and guardian ground (server/guardians.ts DRONES_PER_SITE). */
  siteDrones: { enemy: 'drone', n: [1, 2], seconds: { none: 30, pistol: 50, rifle: 30 }, death: { none: 0.3, pistol: 0.1, rifle: 0.05 }, deathQ: 0.2 } as Fight,
  /** Guardians roam guardian ground's sites (server/guardians.ts GUARDIANS of them): one is at a site you come to with
   *  the odds GUARDIANS / sites, and one crosses your path out there this likely per minute. */
  guardians: 6,
  guardianPerMin: 0.04,
  guardian: { enemy: 'guardian', n: [1, 1], seconds: { none: 50, pistol: 150, rifle: 110 }, death: { none: 0.5, pistol: 0.35, rifle: 0.15 }, deathQ: 0.2 } as Fight,
  /** Don't go where one fight's death odds are higher than this (risk taken for a goal you can't reach otherwise: x2). */
  maxRisk: 0.15,

  // ---- jets (shared/jets.ts, server/jets.ts) -----------------------------------------------------------------------
  /** A jet over you this often while you're out (s, uniform), and the odds you bring it down with... */
  jetGapS: [240, 600] as [number, number],
  jetDown: { rifle: 0.25, jammer: 0.55 },
  /** ...and it comes down this far off (m). */
  jetFallM: [150, 700] as [number, number],
  /** The flying wing's odds grow with distance from the base: up to this at WING_FAR (server/jets.ts). */
  wing: { odds: 0.8, far: 10_000, engines: 2, tearOff: 0.8, wrecked: 0.3 },

  // ---- bosses ------------------------------------------------------------------------------------------------------
  /** Calling and fighting a boss (s), and the odds of winning by the rifle's quality 0 .. 3 (a loss: you die, the cell is spent). */
  bossS: 15 * 60,
  bossWin: [0.35, 0.8] as [number, number],
} as const;

/** One pass of value per second worth a trip: below it the agent goes home or explores. */
export const MIN_SCORE = 1e-4;
