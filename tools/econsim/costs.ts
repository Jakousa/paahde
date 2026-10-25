// Everything the economy simulator assumes that the game's own code doesn't say: how long things take a player. The
// loot itself (what lies where, what is in it, what drops) and the enemies (shared/enemies.ts: where they're met, how
// fights go) come from the game's shared/ code, so a change there shows in the results; a change here changes the
// yardstick, and the report says so ("sim changed"). Calibrate against real play (docs/econsim.md).
import { WALK_SPEED } from '../../shared/sim.ts';

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
  /** Fallback only for older commits whose shared rules cannot enumerate code-built steps: this many to open,
   *  then this many per part. Current commits use the exact shared topology instead. */
  codeSteps: { base: 4, perPart: 2.5 },
  /** At home: unloading, the workbench, sorting the chest (s per visit), and per repair or craft. */
  baseS: 45,
  benchS: 8,
  /** Down, then up again at home (shared/ragdoll.ts DOWN_MS plus finding your feet), s. */
  respawnS: 20,

  // ---- seeing --------------------------------------------------------------------------------------------------
  /** How far off you notice things while passing (m): a scrap pile, a salvage wreck, a shelter's hut, small loot
   *  (a cache, a broken find, a dropped pack). Crash sites smoke and beep: always known. The spyglass multiplies the
   *  small-loot range by this at quality 0 .. 3. */
  see: { pile: 220, wreck: 260, shelter: 200, loot: 45 },
  spyglassSee: [1.6, 2.4] as [number, number],
  /** Expected unseen finds at a crash site come back this fast after you've looked (s for a full turnover). */
  findTurnoverS: 3600,

  // ---- risk ----------------------------------------------------------------------------------------------------------
  // (Every enemy, where it's met and how a fight with it goes, is shared/enemies.ts.)
  /** Don't go where the odds of dying are higher than this (risk taken for a goal you can't reach otherwise: x2). */
  maxRisk: 0.15,

  /** A downed jet: the flying wing's odds grow with distance from the origin, up to this at WING_FAR (server/jets.ts
   *  WING_ODDS, WING_FAR); its engines, the share that tear off whole and of those the share wrecked in the landing
   *  (shared/jetbreak.ts fates). */
  wing: { odds: 0.8, far: 10_000, engines: 2, tearOff: 0.8, wrecked: 0.3 },
} as const;

/** One pass of value per second worth a trip: below it the agent goes home or explores. */
export const MIN_SCORE = 1e-4;
