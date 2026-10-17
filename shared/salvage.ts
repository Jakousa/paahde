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
  /** Model under public/models/salvage/, built by tools/blender/salvage/<id>.py. */
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
};
