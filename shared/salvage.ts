// Salvage: big broken objects found in the wild (GitHub issue #13). You carry one home and take it apart
// for parts (the craftable items of issue #8). What each one yields is in shared/tables.ts; the
// disassembly mechanic itself lives elsewhere.
import { COMPONENT_LOOT, SALVAGE_LOOT, type TierWeights } from './tables.ts';
import { TEXT } from './text.ts';

/** Craftable part ids, matching tools/blender/items.py (public/models/items/<id>_<tier>.glb). */
export type PartId = 'battery' | 'motor' | 'heatsink' | 'compute' | 'uranium' | 'coil'
  // Mechanical and switching parts that come out of the smaller crash-site components.
  | 'impeller' | 'bearing' | 'gear' | 'valve' | 'relay'
  // The rotors of a jet engine, taken whole out of it (tools/blender/machines/turbofan.py): they are only found in engines.
  | 'fanrotor' | 'comprotor' | 'turbinerotor' | 'turbinedisc' | 'fuelmanifold';

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
  scrap: { name: TEXT.tiers.scrap, color: 0xb08a62 },
  basic: { name: TEXT.tiers.basic, color: 0x74d08a },
  quality: { name: TEXT.tiers.quality, color: 0xff9a3c },
  space: { name: TEXT.tiers.space, color: 0x3ff0ff },
};

export interface SalvageKind {
  /** Inventory label. */
  label: string;
  /** Model path relative to public/models/ (salvage/<id>.glb), built by tools/blender/salvage/<id>.py. */
  model: string;
  yields: SalvageYield[];
  /** Relative odds of each part coming out at each tier: better wrecks hold better parts. */
  tierWeights: TierWeights;
  /** Relative odds of a wreck site in the desert holding this kind (shared/wrecks.ts): the warp core is rare. */
  weight: number;
}

/** Salvage kinds; each is also an inventory item of the same id (shared/items.ts) once carried. */
export type SalvageId = 'vehicle_frame' | 'water_jet' | 'warp_core' | 'ai_control';

export const SALVAGE: Record<SalvageId, SalvageKind> = {
  // #14: rusted buggy chassis with a cracked battery tray, rear hub motor and a finned controller.
  vehicle_frame: { label: TEXT.machines.vehicle_frame, model: 'salvage/vehicle_frame.glb', ...SALVAGE_LOOT.vehicle_frame },
  // #17: a stranded jet ski; its battery bay and drive motor are still in there, plus the bilge pump motor.
  water_jet: { label: TEXT.machines.water_jet, model: 'salvage/water_jet.glb', ...SALVAGE_LOOT.water_jet },
  // #16: rare, the valuable one. A starship's reactor column: compute racks, coolant fins, uranium cells.
  warp_core: { label: TEXT.machines.warp_core, model: 'salvage/warp_core.glb', ...SALVAGE_LOOT.warp_core },
  // #15: broken rack computer that once ran some big machine; finned side cooler + a stack of modules.
  ai_control: { label: TEXT.machines.ai_control, model: 'salvage/ai_control.glb', ...SALVAGE_LOOT.ai_control },
};

/** Crash-site components (src/teardown): smaller than the wrecks above, and taken apart on the spot. */
export type ComponentKind = 'pump_housing' | 'jet_engine' | 'robot_arm' | 'control_cabinet' | 'winch' | 'solenoid_valve' | 'beacon';

export interface ComponentSpec {
  label: string;
  yields: SalvageYield[];
  tierWeights: TierWeights;
  /** Small enough to carry home as junk (taken apart on a dismantling bench); the rest is taken apart where it lies. */
  carry: boolean;
}

export const COMPONENTS: Record<ComponentKind, ComponentSpec> = {
  // Centrifugal pump on a skid: motor through a guarded coupling, bearing housing, impeller behind the suction
  // cover, check valve in the discharge, a contactor in the motor's terminal box.
  pump_housing: { label: TEXT.machines.pump_housing, carry: false, ...COMPONENT_LOOT.pump_housing },
  // Small turbojet on a stand with its engine-control box: ECU, starter motor on the accessory gearbox,
  // igniter coil, fuel valve, shaft bearings.
  jet_engine: { label: TEXT.machines.jet_engine, carry: false, ...COMPONENT_LOOT.jet_engine },
  // Robot arm joint: servo motor into a gear stage, slewing bearing under the top cover, driver board on the link.
  robot_arm: { label: TEXT.machines.robot_arm, carry: true, ...COMPONENT_LOOT.robot_arm },
  // Wall-mounted control cabinet: mains in through a gland, a transformer, contactors on a rail and a controller
  // board with a heatsink on its regulator, a backup battery.
  control_cabinet: { label: TEXT.machines.control_cabinet, carry: true, ...COMPONENT_LOOT.control_cabinet },
  // The starter machines of the scrap fields near the start (shared/tables.ts LEVEL_KINDS).
  // Hand winch off a cargo hoist: a cable drum on a shaft between two bearing blocks, driven through a gear pair
  // from the crank, a pawl on the ratchet.
  winch: { label: TEXT.machines.winch, carry: true, ...COMPONENT_LOOT.winch },
  // Coolant line section with a solenoid valve in it: the valve body between two flanges, its coil on top.
  solenoid_valve: { label: TEXT.machines.solenoid_valve, carry: true, ...COMPONENT_LOOT.solenoid_valve },
  // Emergency locator beacon: a battery pack under the lid, a transmitter coil in the mast's foot.
  beacon: { label: TEXT.machines.beacon, carry: true, ...COMPONENT_LOOT.beacon },
};

/** Anything the disassembly mode can take apart: a crash-site component or a salvage wreck. */
export type JunkKind = ComponentKind | SalvageId;

/** What a junk kind holds, and whether it can be carried home (every salvage wreck can). */
export function junkSpec(kind: JunkKind): { label: string; yields: SalvageYield[]; tierWeights: TierWeights; carry: boolean } {
  return kind in SALVAGE ? { ...SALVAGE[kind as SalvageId], carry: true } : COMPONENTS[kind as ComponentKind];
}
