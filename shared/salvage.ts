// Salvage: big broken objects found in the wild (GitHub issue #13). You carry one home and take it apart
// for parts (the craftable items of issue #8). This table lists what each one can yield; the
// disassembly mechanic itself lives elsewhere.

/** Craftable part ids, matching tools/blender/items.py (public/models/items/<id>_<tier>.glb). */
export type PartId = 'battery' | 'motor' | 'heatsink' | 'compute' | 'antimatter' | 'coil';

export interface SalvageYield {
  part: PartId;
  /** Inclusive range of how many come out. */
  min: number;
  max: number;
}

export interface SalvageKind {
  /** Inventory label. */
  label: string;
  /** Model path relative to public/models/ (salvage/<id>.glb), built by tools/blender/salvage/<id>.py. */
  model: string;
  yields: SalvageYield[];
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
  },
  // #17: a stranded jet ski; its battery bay and drive motor are still in there, plus the bilge pump motor.
  water_jet: {
    label: 'Broken water jet',
    model: 'salvage/water_jet.glb',
    yields: [
      { part: 'battery', min: 1, max: 2 },
      { part: 'motor', min: 1, max: 2 },
    ],
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
  },
};
