// Item box ids and what kind of box each is: the one place their grammar lives. 'bag', 'equip' and 'bench' are the
// player's own; the rest are numbered and shared: chests in the base ('chest<i>'), the packs left by the dead
// ('corpse<id>', shared/corpse.ts), a building's item ('bld<placed id>') and a vehicle's ('veh<id>', its cargo
// 'cargo<id>'). A kind's fixed traits are in BOX_KINDS; what depends on the world (size, label, shape, reach) is per
// kind in shared/storage.ts and shared/gear.ts, as Record<BoxKind, ...> so a new kind can't be missed there.

/**
 * `own`: the player's own (stored per player); else shared by everyone. `grows`: a grid without end (shared/storage.ts
 * growChest). `fitted`: holds one item that never moves in or out, only its parts (shared/gear.ts fitPart). `takeOnly`:
 * only taken from, nothing put in.
 */
type BoxTraits = { own?: true; grows?: true; fitted?: true; takeOnly?: true };

export const BOX_KINDS = {
  bag: { own: true },
  equip: { own: true },
  bench: { own: true },
  chest: { grows: true },
  corpse: { grows: true, takeOnly: true },
  bld: { fitted: true },
  veh: { fitted: true },
  cargo: {},
} as const satisfies Record<string, BoxTraits>;
export type BoxKind = keyof typeof BOX_KINDS;

const OWN = new Set<string>(['bag', 'equip', 'bench']);
const PARSE = /^([a-z]+?)(\d+)$/;

/** The kind of box `box` is and its number (-1 for the player's own), or null if it's no box id. */
export function boxKind(box: string): { kind: BoxKind; id: number } | null {
  if (OWN.has(box)) return { kind: box as BoxKind, id: -1 };
  const m = PARSE.exec(box);
  return m && m[1] in BOX_KINDS && !OWN.has(m[1]) ? { kind: m[1] as BoxKind, id: Number(m[2]) } : null;
}

const traits = (box: string): BoxTraits => {
  const k = boxKind(box);
  return k ? BOX_KINDS[k.kind] : {};
};

/** The number in a box id of kind `kind`, or -1 for any other box. */
export const boxNumber = (kind: BoxKind, box: string) => {
  const k = boxKind(box);
  return k?.kind === kind ? k.id : -1;
};

/** Shared boxes are owned by nobody (''); the player's own by them. */
export const isShared = (box: string) => !!boxKind(box) && !traits(box).own;
/** Chests and packs grow without end (growChest). */
export const grows = (box: string) => !!traits(box).grows;
/** A box holding one fitted item that never moves in or out of it, only its parts: a building's or a vehicle's. */
export const fittedBox = (box: string) => !!traits(box).fitted;
/** Only taken from (a dead player's pack): nothing may be put in. */
export const takeOnly = (box: string) => !!traits(box).takeOnly;

/** A building standing in the world (shared/placed.ts) keeps its item, parts and all, in a box of one slot,
 *  `bld<placed id>`, open while you're in reach of it: its parts are fitted like the workbench's (fitPart / unfitPart
 *  with that box as the target), but the item itself never moves in or out of it (tryMove). */
export const buildingBox = (id: number) => `bld${id}`;
/** The placed id of a building's box, or -1. */
export const buildingId = (box: string) => boxNumber('bld', box);
/** A vehicle in the world (shared/vehicles.ts) keeps its item in a box of one slot, `veh<vehicle id>`, like a
 *  building's; its cargo is the grid `cargo<vehicle id>`. */
export const vehicleBox = (id: number) => `veh${id}`;
export const cargoBox = (id: number) => `cargo${id}`;
/** The vehicle id of a vehicle's item box, or -1. */
export const vehicleId = (box: string) => boxNumber('veh', box);
/** The vehicle id of a vehicle's cargo box, or -1. */
export const cargoId = (box: string) => boxNumber('cargo', box);
