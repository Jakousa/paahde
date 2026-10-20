// Every loot table and crafting recipe in one place, to tune without hunting through the code. Plain data only: the
// code that rolls them lives where it always did (named above each table). Shared by client and server, so a change
// here reaches both on the next deploy.
//
// Tier weights are relative odds per tier (scrap, basic, quality, space): { scrap: 3, basic: 1 } is 3 to 1, and a
// tier left out or 0 never comes up. Part ids are shared/salvage.ts PartId (battery, motor, heatsink, compute,
// uranium, coil, impeller, bearing, gear, valve, relay); an item of a part is "<part>_<tier>" (shared/items.ts).
//
// Machine and wreck contents are rolled from a seed on both sides (shared/parts.ts rollParts): changing their yields
// changes what is inside every machine in the world, including half-stripped ones, which can leave a part someone has
// already taken back in place. Fine between sessions; just be aware.
import type { SiteLevel } from './crashsites.ts';
import type { ShelterKind } from './shelters.ts';
import type { ComponentKind, PartId, SalvageId, SalvageYield, Tier } from './salvage.ts';
import { TEXT } from './text.ts';

export type TierWeights = Partial<Record<Tier, number>>;
type Loot = { yields: SalvageYield[]; tierWeights: TierWeights };

// ---------------------------------------------------------------------------------------------------------------
// Crafting at the workbench (shared/crafting.ts). The id is the item kind it makes. An ingredient is any item of a
// part (any tier; the worst is used first) or one of a list of item kinds.

export type IngredientSpec = { label: string; n: number } & ({ part: PartId } | { kinds: string[] });

const SCRAP = (n: number): IngredientSpec => ({ label: TEXT.items.scrap, n, kinds: ['scrap'] });
const CLOTH = (n: number): IngredientSpec => ({ label: TEXT.items.cloth, n, kinds: ['cloth'] });

/** Scrap for taking machines apart (server/crash.ts): every step done gives `step`, a module that comes off (all its outer steps) `module`
 *  more, a piece taken apart on the ground (all its inner steps) `piece` more. The frame left when everything is out is mashed to scrap
 *  for `machine` plus `perModule` for each module it had; at the disassembly table a machine can also be scrapped unfinished, and every
 *  part still on it (destroyed) adds `perPartLeft`. Scrap is the crafting metal, so this is the economy's tap. */
export const SCRAP_REWARD = { step: 1, module: 2, piece: 2, machine: 6, perModule: 1, perPartLeft: 2 };

export const RECIPE_TABLE: Record<string, IngredientSpec[]> = {
  // (The plant bed and UV lamp aren't crafted for now: growing doesn't fit the game yet. Their code is still in
  // shared/garden.ts; to bring them back: plant_bed: [SCRAP(2), CLOTH(2)], uv_lamp: [SCRAP(2), coil 1].)
  // The plain metal parts, hammered out of scrap: Scrap tier only, so better ones still come from salvage. The
  // electrics (motor, battery, coil, relay, compute, uranium) can't be made.
  gear_scrap: [SCRAP(3)],
  bearing_scrap: [SCRAP(2)],
  valve_scrap: [SCRAP(3)],
  heatsink_scrap: [SCRAP(4)],
  // The grinder, for seams in a machine's shell: a motor spins the disc through a pair of gears, a battery drives it.
  grinder: [{ label: TEXT.parts.motor, n: 1, part: 'motor' }, { label: TEXT.parts.battery, n: 1, part: 'battery' }, { label: TEXT.parts.gear, n: 2, part: 'gear' }, SCRAP(3)],
  // A scavenger bot: a compute unit for its brain, a motor, a battery, two bearings and scrap plates.
  scavenger_bot: [
    { label: TEXT.parts.compute, n: 1, part: 'compute' },
    { label: TEXT.parts.motor, n: 1, part: 'motor' },
    { label: TEXT.parts.battery, n: 1, part: 'battery' },
    { label: TEXT.parts.bearing, n: 2, part: 'bearing' },
    SCRAP(6),
  ],
  // (Tools, guns and the jammer aren't crafted: they're found broken and repaired, shared/gear.ts.)
};

// ---------------------------------------------------------------------------------------------------------------
// Taking things apart (shared/parts.ts rollParts). Each yield rolls min..max of that part, each at a tier from
// tierWeights. Keep the order of yields: the rolls go in order, so inserting one reshuffles everything after it.

/** Salvage wrecks out in the desert (shared/salvage.ts SALVAGE), carried home. `weight`: odds of a wreck being this kind. */
export const SALVAGE_LOOT: Record<SalvageId, Loot & { weight: number }> = {
  vehicle_frame: {
    yields: [
      { part: 'battery', min: 1, max: 3 },
      { part: 'motor', min: 1, max: 2 },
      { part: 'heatsink', min: 1, max: 2 },
      { part: 'coil', min: 0, max: 2 },
    ],
    tierWeights: { scrap: 3, basic: 4, quality: 2, space: 0.2 },
    weight: 4,
  },
  water_jet: {
    yields: [
      { part: 'battery', min: 1, max: 2 },
      { part: 'motor', min: 1, max: 2 },
    ],
    tierWeights: { scrap: 6, basic: 3, quality: 0.5 },
    weight: 3,
  },
  // Rare, the valuable one.
  warp_core: {
    yields: [
      { part: 'compute', min: 1, max: 3 },
      { part: 'heatsink', min: 2, max: 3 },
      { part: 'uranium', min: 1, max: 2 },
    ],
    tierWeights: { basic: 1, quality: 4, space: 6 },
    weight: 0.6,
  },
  ai_control: {
    yields: [
      { part: 'heatsink', min: 1, max: 3 },
      { part: 'compute', min: 2, max: 4 },
      { part: 'coil', min: 0, max: 1 },
    ],
    tierWeights: { scrap: 1, basic: 3, quality: 4, space: 1.5 },
    weight: 2,
  },
};

/** Crash-site machines (shared/salvage.ts COMPONENTS). Their tierWeights are then scaled by the site's LEVEL_TIERS. */
export const COMPONENT_LOOT: Record<ComponentKind, Loot> = {
  pump_housing: {
    yields: [
      { part: 'motor', min: 1, max: 1 },
      { part: 'bearing', min: 1, max: 2 },
      { part: 'valve', min: 0, max: 1 },
      { part: 'relay', min: 0, max: 1 },
    ],
    tierWeights: { scrap: 5, basic: 3, quality: 1, space: 0.1 },
  },
  jet_engine: {
    yields: [
      { part: 'motor', min: 1, max: 1 },
      { part: 'gear', min: 1, max: 2 },
      { part: 'bearing', min: 1, max: 2 },
      { part: 'compute', min: 1, max: 1 },
      { part: 'heatsink', min: 0, max: 1 },
      { part: 'coil', min: 1, max: 1 },
      { part: 'valve', min: 1, max: 1 },
      { part: 'relay', min: 0, max: 1 },
    ],
    tierWeights: { scrap: 2, basic: 4, quality: 3, space: 0.6 },
  },
  robot_arm: {
    yields: [
      { part: 'motor', min: 1, max: 1 },
      { part: 'gear', min: 2, max: 3 },
      { part: 'bearing', min: 1, max: 2 },
      { part: 'compute', min: 1, max: 1 },
      { part: 'heatsink', min: 0, max: 1 },
      { part: 'coil', min: 0, max: 1 },
      { part: 'relay', min: 0, max: 1 },
    ],
    tierWeights: { scrap: 1, basic: 3, quality: 4, space: 1.5 },
  },
  control_cabinet: {
    yields: [
      { part: 'relay', min: 1, max: 2 },
      { part: 'compute', min: 1, max: 1 },
      { part: 'heatsink', min: 0, max: 1 },
      { part: 'coil', min: 1, max: 1 },
      { part: 'battery', min: 1, max: 1 },
    ],
    tierWeights: { scrap: 3, basic: 4, quality: 2, space: 0.3 },
  },
  // The starter machines of the scrap fields (level 0): between them everything the first gear needs (canteen:
  // valve; telescope: gear, bearing; backpack: gear; laser pistol: coil).
  winch: {
    yields: [
      { part: 'gear', min: 1, max: 2 },
      { part: 'bearing', min: 1, max: 1 },
    ],
    tierWeights: { scrap: 6, basic: 3, quality: 0.3 },
  },
  solenoid_valve: {
    yields: [
      { part: 'valve', min: 1, max: 1 },
      { part: 'coil', min: 0, max: 1 },
    ],
    tierWeights: { scrap: 6, basic: 3, quality: 0.3 },
  },
  beacon: {
    yields: [
      { part: 'battery', min: 1, max: 1 },
      { part: 'coil', min: 1, max: 1 },
    ],
    tierWeights: { scrap: 6, basic: 3, quality: 0.3 },
  },
};

/** Which machines lie at each crash-site level (0 scrap fields, 1 crawler ground, 2 guardian ground), relative odds.
 *  Each site has one large machine (carry: false) and a few small ones; each is picked from its own size. */
export const LEVEL_KINDS: Record<SiteLevel, Partial<Record<ComponentKind, number>>> = {
  0: { winch: 3, solenoid_valve: 3, beacon: 3 },
  1: { control_cabinet: 3, robot_arm: 2, beacon: 1, pump_housing: 3 },
  // (jet engines come off downed jets, shared/jetcrash.ts; hardly ever lie at a crash site)
  2: { robot_arm: 3, control_cabinet: 2, jet_engine: 0.15, pump_housing: 1 },
};

/** Multipliers on a machine's tierWeights by crash-site level. Machines carried home roll at level 1. */
export const LEVEL_TIERS: Record<SiteLevel, Record<Tier, number>> = {
  0: { scrap: 1, basic: 1, quality: 0.2, space: 0 },
  1: { scrap: 1, basic: 1, quality: 1, space: 1 },
  2: { scrap: 0.2, basic: 0.6, quality: 2.5, space: 5 },
};

// ---------------------------------------------------------------------------------------------------------------
// Things lying in the world (server/loot.ts).

/** Broken gear lying around at once, and the crash-site level it lies at (level-0 finds also lie at scrap piles). */
export const FINDS: Record<string, { n: number; level: SiteLevel }> = {
  canteen: { n: 7, level: 0 }, spyglass: { n: 5, level: 0 }, backpack: { n: 7, level: 0 },
  motorcycle: { n: 3, level: 1 }, storm_detector: { n: 2, level: 1 }, wristpad: { n: 2, level: 1 },
  // The shield plate (shared/gear.ts): out where things first try to kill you.
  shield: { n: 3, level: 1 },
  // The guns (shared/rifle.ts): the pistol near home, the rifle out on crawler ground, to take on the guardians with.
  laser_pistol: { n: 4, level: 0 }, laser_rifle: { n: 3, level: 1 },
  // The jammer (shared/jammer.ts): out where the roaming drones and the jets first come after you.
  jammer: { n: 3, level: 1 },
  // The receivers that call the bosses (shared/bosses.ts): out on guardian ground.
  receiver_carrier: { n: 1, level: 2 }, receiver_queen: { n: 1, level: 2 }, receiver_colossus: { n: 1, level: 2 },
  receiver_worm: { n: 1, level: 2 },
};

/** One broken motorcycle always lies on the sand in front of the base door (server/loot.ts homeBikeSpot), so a bike is
 *  in sight from the first step out: it has these slots fitted (scrap tier) and the rest are parts the scrap fields'
 *  starter machines give (battery: beacon, bearing: winch). Taken, another lies there at once. */
export const HOME_BIKE = { fitted: ['motor'] as PartId[] };

/** Parts that only an engine gives (nothing uses them yet): never found loose. */
const ROTORS: PartId[] = ['fanrotor', 'comprotor', 'turbinerotor', 'turbinedisc', 'fuelmanifold'];

/** Loose rare parts (any part, uranium too) lying at guardian ground at once, and their tiers. */
/** `noParts`: never found this way. The impeller isn't dropped anywhere: nothing uses it. */
export const RARE_FINDS = { n: 10, noParts: ['impeller', ...ROTORS] as PartId[], tierWeights: { quality: 3, space: 1 } satisfies TierWeights };

/** Broken gear (finds and caches): each part slot is filled with these odds, by a part of these tiers (or scrap that
 *  fits); at least one slot is always left empty. */
export const BROKEN_GEAR = { filled: 0.5, tierWeights: { scrap: 7, basic: 3 } satisfies TierWeights };

/** Caches lying out in the desert: how many at once, and what is inside
 *  (relative odds: a part, some scrap, some cloth, a broken laser pistol, a piece of other broken gear, a broken boss
 *  receiver: any of shared/bosses.ts RECEIVERS). */
export const CACHES = {
  n: 60,
  contents: { part: 0.6, scrap: 0.15, cloth: 0.1, pistol: 0.04, gear: 0.11, receiver: 0.01 },
  /** A cache part: any part but these, at these tiers. */
  noParts: ['uranium', 'impeller', ...ROTORS] as PartId[],
  tierWeights: { scrap: 5, basic: 3, quality: 1.2, space: 0.25 } satisfies TierWeights,
};

/** Stashes left on the floors of the shelters (shared/shelters.ts): how many lie in each shelter by its kind (every
 *  shelter is stocked; a taken one comes back in whichever shelter is shortest), and what they are, like CACHES but
 *  richer: more gear, better parts. */
export const SHELTER_STASHES = {
  perShelter: { small: 2, deep: 3, long: 3 } satisfies Record<ShelterKind, number>,
  contents: { part: 0.42, scrap: 0.06, cloth: 0.1, pistol: 0.1, gear: 0.29, receiver: 0.03 },
  tierWeights: { scrap: 1, basic: 3, quality: 2.5, space: 0.6 } satisfies TierWeights,
};

// ---------------------------------------------------------------------------------------------------------------
// What a killed enemy leaves on the sand (server/world.ts dropSpoils): with `odds`, min..max parts, each a random
// one of `parts` at a tier from tierWeights.

type Spoils = { odds: number; min: number; max: number; parts: PartId[]; tierWeights: TierWeights };
const SPOILS: PartId[] = ['coil', 'battery', 'compute', 'relay', 'motor', 'bearing'];

export const KILL_SPOILS: Record<'guardian' | 'crawler' | 'drone', Spoils> = {
  guardian: { odds: 1, min: 2, max: 3, parts: SPOILS, tierWeights: { quality: 2, space: 1 } },
  crawler: { odds: 0.35, min: 1, max: 1, parts: SPOILS, tierWeights: { scrap: 1, basic: 1 } },
  drone: { odds: 1, min: 1, max: 1, parts: SPOILS, tierWeights: { basic: 1, quality: 1 } },
};

/** A downed jet's crash site (server/world.ts jetCame): its engine is a machine to take apart (shared/jetcrash.ts); besides, its drone transponder
 *  (what the carrier's receiver takes) with JET_RELIC_ODDS, and some scrap off the airframe. */
export const JET_RELIC_ODDS = 0.2;
export const JET_SCRAP = { min: 2, max: 4 };

/** A killed harvester (shared/harvester.ts; server/world.ts dropHarvesterSpoils): its burst ore hopper spills what it
 *  sifted out of the sand (uranium mostly) and its drive train lies about it; lots of scrap off the hull. */
export const HARVESTER_SPOILS: Spoils = { odds: 1, min: 4, max: 6, parts: ['uranium', 'uranium', 'uranium', 'motor', 'bearing', 'heatsink', 'relay', 'battery'], tierWeights: { basic: 2, quality: 2, space: 0.6 } };
export const HARVESTER_SCRAP = { min: 8, max: 14 };

/** Besides its spoils, a killed enemy leaves its own part with these odds: what its boss's receiver takes (shared/gear.ts). */
export const RELIC_DROPS: Record<'guardian' | 'crawler' | 'drone', { kind: string; odds: number }> = {
  guardian: { kind: 'servo_heart', odds: 0.5 },
  crawler: { kind: 'brood_gland', odds: 0.1 },
  drone: { kind: 'drone_transponder', odds: 0.1 },
};

/** Odds a killed enemy (or a downed jet) also leaves a broken boss receiver, any of shared/bosses.ts RECEIVERS. */
export const RECEIVER_DROPS: Record<'guardian' | 'crawler' | 'drone' | 'jet', number> = {
  guardian: 0.1, crawler: 0.03, drone: 0, jet: 0.05,
};

/** A killed boss (shared/bosses.ts): min..max parts scattered over its wreck (`odds` unused: always), a uranium cell
 *  among them likely; its own part too (shared/bosses.ts RELICS). */
const BOSS_PARTS: PartId[] = [...SPOILS, 'uranium'];
export const BOSS_SPOILS: Record<'worm' | 'carrier' | 'colossus' | 'queen', Spoils> = {
  worm: { odds: 1, min: 5, max: 7, parts: BOSS_PARTS, tierWeights: { quality: 2, space: 2 } },
  carrier: { odds: 1, min: 5, max: 7, parts: BOSS_PARTS, tierWeights: { quality: 2, space: 2 } },
  colossus: { odds: 1, min: 6, max: 8, parts: BOSS_PARTS, tierWeights: { quality: 1, space: 3 } },
  queen: { odds: 1, min: 5, max: 7, parts: BOSS_PARTS, tierWeights: { quality: 2, space: 2 } },
};
