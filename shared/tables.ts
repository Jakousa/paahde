// Every loot table and crafting recipe in one place, to tune without hunting through the code. Plain data only: the
// code that rolls them lives where it always did (named above each table). Shared by client and server, so a change
// here reaches both on the next deploy.
//
// Tier weights are relative odds per tier (scrap, basic, quality, space): { scrap: 3, basic: 1 } is 3 to 1, and a
// tier left out or 0 never comes up. Part ids are shared/salvage.ts PartId (battery, motor, heatsink, compute,
// antimatter, coil, impeller, bearing, gear, valve, relay); an item of a part is "<part>_<tier>" (shared/items.ts).
//
// Machine and wreck contents are rolled from a seed on both sides (shared/parts.ts rollParts): changing their yields
// changes what is inside every machine in the world, including half-stripped ones, which can leave a part someone has
// already taken back in place. Fine between sessions; just be aware.
import type { SiteLevel } from './crashsites.ts';
import type { ComponentKind, PartId, SalvageId, SalvageYield, Tier } from './salvage.ts';

export type TierWeights = Partial<Record<Tier, number>>;
type Loot = { yields: SalvageYield[]; tierWeights: TierWeights };

// ---------------------------------------------------------------------------------------------------------------
// Crafting at the workbench (shared/crafting.ts). The id is the item kind it makes. An ingredient is any item of a
// part (any tier; the worst is used first) or one of a list of item kinds.

export type IngredientSpec = { label: string; n: number } & ({ part: PartId } | { kinds: string[] });

const SCRAP = (n: number): IngredientSpec => ({ label: 'Scrap', n, kinds: ['scrap'] });

export const RECIPE_TABLE: Record<string, IngredientSpec[]> = {
  plant_bed: [SCRAP(4)],
  uv_lamp: [SCRAP(2), { label: 'Wiring coil', n: 1, part: 'coil' }],
  // The jammer (shared/jammer.ts): a compute unit to find the drones' link, a coil for the antenna, a cell to drive it.
  // (The guns aren't crafted: they're found broken and repaired, shared/gear.ts.)
  jammer: [{ label: 'Compute unit', n: 1, part: 'compute' }, { label: 'Wiring coil', n: 1, part: 'coil' }, { label: 'Battery', n: 1, part: 'battery' }],
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
      { part: 'antimatter', min: 1, max: 2 },
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
      { part: 'impeller', min: 1, max: 1 },
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
  1: { control_cabinet: 3, robot_arm: 2, beacon: 1, pump_housing: 3, jet_engine: 1 },
  2: { robot_arm: 3, control_cabinet: 2, jet_engine: 3, pump_housing: 1 },
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
  motorcycle: { n: 3, level: 1 }, shovel: { n: 3, level: 1 }, storm_detector: { n: 2, level: 1 }, wristpad: { n: 2, level: 1 },
  metal_detector: { n: 2, level: 1 },
  // The guns (shared/rifle.ts): the pistol near home, the rifle out on crawler ground, to take on the guardians with.
  laser_pistol: { n: 4, level: 0 }, laser_rifle: { n: 3, level: 1 },
};

/** One broken motorcycle always lies on the sand in front of the base door (server/loot.ts homeBikeSpot), so a bike is
 *  in sight from the first step out: it has these slots fitted (scrap tier) and the rest are parts the scrap fields'
 *  starter machines give (battery: beacon, bearing: winch). Taken, another lies there FIND_RESPAWN_MS later. */
export const HOME_BIKE = { fitted: ['motor'] as PartId[] };

/** Loose rare parts (any part, anti-matter too) lying at guardian ground at once, and their tiers. */
export const RARE_FINDS = { n: 10, tierWeights: { quality: 3, space: 1 } satisfies TierWeights };

/** Broken gear (finds and caches): each part slot is filled with these odds, by a part of these tiers (or scrap that
 *  fits); at least one slot is always left empty. */
export const BROKEN_GEAR = { filled: 0.5, tierWeights: { scrap: 7, basic: 3 } satisfies TierWeights };

/** Buried caches, dug up with the shovel after the metal detector finds them: how many at once, and what is inside
 *  (relative odds: a part, some scrap, a broken laser pistol, a piece of other broken gear). */
export const CACHES = {
  n: 60,
  contents: { part: 0.65, scrap: 0.2, pistol: 0.04, gear: 0.11 },
  /** A cache part: any part but these, at these tiers. */
  noParts: ['antimatter'] as PartId[],
  tierWeights: { scrap: 5, basic: 3, quality: 1.2, space: 0.25 } satisfies TierWeights,
};

// ---------------------------------------------------------------------------------------------------------------
// What a killed enemy leaves on the sand (server/index.ts dropSpoils): with `odds`, min..max parts, each a random
// one of `parts` at a tier from tierWeights.

type Spoils = { odds: number; min: number; max: number; parts: PartId[]; tierWeights: TierWeights };
const SPOILS: PartId[] = ['coil', 'battery', 'compute', 'relay', 'motor', 'bearing'];

export const KILL_SPOILS: Record<'guardian' | 'crawler' | 'drone', Spoils> = {
  guardian: { odds: 1, min: 2, max: 3, parts: SPOILS, tierWeights: { quality: 2, space: 1 } },
  crawler: { odds: 0.35, min: 1, max: 1, parts: SPOILS, tierWeights: { scrap: 1, basic: 1 } },
  drone: { odds: 1, min: 1, max: 1, parts: SPOILS, tierWeights: { basic: 1, quality: 1 } },
};
