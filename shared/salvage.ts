// Salvage: big broken objects found in the wild (GitHub issue #13). You carry one home and take it apart
// for parts (the craftable items of issue #8). This table lists what each one can yield; the
// disassembly mechanic itself lives elsewhere.

/** Craftable part ids, matching tools/blender/items.py (public/models/items/<id>_<tier>.glb). */
export type PartId = 'battery' | 'motor' | 'heatsink' | 'compute' | 'antimatter' | 'coil'
  // Mechanical and switching parts that come out of the smaller crash-site components.
  | 'impeller' | 'bearing' | 'gear' | 'valve' | 'relay';

export interface SalvageYield {
  part: PartId;
  /** Inclusive range of how many come out. */
  min: number;
  max: number;
}

/** Part quality, matching tools/blender/items.py (public/models/items/<part>_<tier>.glb). Doubles as rarity. */
export const TIERS = ['scrap', 'basic', 'quality', 'space'] as const;
export type Tier = (typeof TIERS)[number];

export const RARITY: Record<Tier, { name: string; color: number }> = {
  scrap: { name: 'Common', color: 0xb08a62 },
  basic: { name: 'Uncommon', color: 0x74d08a },
  quality: { name: 'Rare', color: 0xff9a3c },
  space: { name: 'Legendary', color: 0x3ff0ff },
};

export interface SalvageKind {
  /** Inventory label. */
  label: string;
  /** Model path relative to public/models/ (salvage/<id>.glb), built by tools/blender/salvage/<id>.py. */
  model: string;
  yields: SalvageYield[];
  /** Relative odds of each part coming out at each tier: better wrecks hold better parts. */
  tierWeights: Record<Tier, number>;
}

export const SALVAGE: Record<string, SalvageKind> = {
  // #14: rusted buggy chassis with a cracked battery tray, rear hub motor and a finned controller.
  vehicle_frame: {
    label: 'Broken vehicle frame',
    model: 'salvage/vehicle_frame.glb',
    yields: [
      { part: 'battery', min: 1, max: 3 },
      { part: 'motor', min: 1, max: 2 },
      { part: 'heatsink', min: 1, max: 2 },
      { part: 'coil', min: 0, max: 2 },
    ],
    tierWeights: { scrap: 3, basic: 4, quality: 2, space: 0.2 },
  },
  // #17: a stranded jet ski; its battery bay and drive motor are still in there, plus the bilge pump motor.
  water_jet: {
    label: 'Broken water jet',
    model: 'salvage/water_jet.glb',
    yields: [
      { part: 'battery', min: 1, max: 2 },
      { part: 'motor', min: 1, max: 2 },
    ],
    tierWeights: { scrap: 6, basic: 3, quality: 0.5, space: 0 },
  },
  // #16: rare, the valuable one. A starship's reactor column: compute racks, coolant fins, anti-matter bottles.
  warp_core: {
    label: 'Warp drive core',
    model: 'salvage/warp_core.glb',
    yields: [
      { part: 'compute', min: 1, max: 3 },
      { part: 'heatsink', min: 2, max: 3 },
      { part: 'antimatter', min: 1, max: 2 },
    ],
    tierWeights: { scrap: 0, basic: 1, quality: 4, space: 6 },
  },
  // #15: broken rack computer that once ran some big machine; finned side cooler + a stack of modules.
  ai_control: {
    label: 'AI control system',
    model: 'salvage/ai_control.glb',
    yields: [
      { part: 'heatsink', min: 1, max: 3 },
      { part: 'compute', min: 2, max: 4 },
      { part: 'coil', min: 0, max: 1 },
    ],
    tierWeights: { scrap: 1, basic: 3, quality: 4, space: 1.5 },
  },
};

/** Crash-site components (src/teardown): smaller than the wrecks above, and taken apart on the spot. */
export type ComponentKind = 'pump_housing' | 'jet_engine' | 'robot_arm' | 'control_cabinet';

export interface ComponentSpec {
  label: string;
  yields: SalvageYield[];
  tierWeights: Record<Tier, number>;
  /** Relative odds of a crash site holding this component. */
  weight: number;
  /** Small enough to carry home as junk (taken apart at the base workbench); the rest is taken apart where it lies. */
  carry: boolean;
}

export const COMPONENTS: Record<ComponentKind, ComponentSpec> = {
  // Centrifugal pump on a skid: motor through a guarded coupling, bearing housing, impeller behind the suction
  // cover, check valve in the discharge, a contactor in the motor's terminal box.
  pump_housing: {
    label: 'Pump housing',
    weight: 3,
    carry: false,
    yields: [
      { part: 'motor', min: 1, max: 1 },
      { part: 'impeller', min: 1, max: 1 },
      { part: 'bearing', min: 1, max: 2 },
      { part: 'valve', min: 0, max: 1 },
      { part: 'relay', min: 0, max: 1 },
    ],
    tierWeights: { scrap: 5, basic: 3, quality: 1, space: 0.1 },
  },
  // Small turbojet on a stand with its engine-control box: ECU, starter motor on the accessory gearbox,
  // igniter coil, fuel valve, shaft bearings.
  jet_engine: {
    label: 'Jet engine',
    weight: 2,
    carry: false,
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
  // Robot arm joint: servo motor into a gear stage, slewing bearing under the top cover, driver board on the link.
  robot_arm: {
    label: 'Robot arm joint',
    weight: 2,
    carry: true,
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
  // Wall-mounted control cabinet: mains in through a gland, a transformer, contactors on a rail and a controller
  // board with a heatsink on its regulator.
  control_cabinet: {
    label: 'Control cabinet',
    weight: 3,
    carry: true,
    yields: [
      { part: 'relay', min: 1, max: 2 },
      { part: 'compute', min: 1, max: 1 },
      { part: 'heatsink', min: 0, max: 1 },
      { part: 'coil', min: 1, max: 1 },
    ],
    tierWeights: { scrap: 3, basic: 4, quality: 2, space: 0.3 },
  },
};
