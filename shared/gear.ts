// Gear: the things you find broken in the desert (server/loot.ts) and repair with parts at a workbench
// (built with the wrench). Each piece of gear has part slots (GEAR below); an item's `parts` (shared/items.ts) says what is
// fitted in each. With every slot filled it works, and how well depends on the parts' tiers (quality): a
// better part can be swapped in any time. Some gear is equipped in the Tab menu (the 'equip' box: back,
// wrist, belt, armor), the rest is used from the hotbar. The motorcycle is never carried: it stands in the world
// (shared/vehicles.ts) and is repaired where it lies, its item in a box of its own like a building's.
//
// The rules for moving items and parts between boxes are in shared/moves.ts; the bits that tell others what you wear
// and carry in shared/gearBits.ts.
import { BAG_COLS, BAG_ROWS, HOTBAR, parsePart, partAt, partKind, setFitted, type Item, type ItemData, type Part, type Shape, type Slots } from './items.ts';
import { PART_LABELS } from './parts.ts';
import type { PartId, Tier } from './salvage.ts';
import { TEXT, type HintKeys } from './text.ts';

export const EQUIP_SLOTS = ['back', 'wrist', 'belt', 'armor'] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];
export const EQUIP_LABELS: Record<EquipSlot, string> = TEXT.equip;

/** A part slot: a tiered part from disassembly, or a basic material (shared/items.ts SCRAP, CLOTH or WIRING; no tier: it holds
 *  things together), or one of the kinds `scrap` lists (an enemy's or boss's own part: no tier either). `rare`: never
 *  already fitted in gear found broken (server/loot.ts). */
export type PartSlot = ({ part: PartId } | { scrap: string[]; label: string }) & { rare?: true };

export type GearSpec = {
  slots: PartSlot[];
  /** Equipped in the Tab menu; otherwise used from the hotbar. */
  equip?: EquipSlot;
  /** What better parts do, and how to use it, for the tooltip. */
  better: string;
  /** Given the current key or button names (src/bindings.ts hintKeys). */
  use: (k: HintKeys) => string;
  /** A building: put up with the wrench from base materials (shared/crafting.ts BUILDS) with its slots empty, never
   *  found or carried; its parts are fitted where it stands, like on the workbench (buildingBox). */
  built?: true;
  /** A vehicle (shared/vehicles.ts): lies broken in the world and is repaired and ridden where it stands, never carried;
   *  its item is in its own box (vehicleBox), like a building's. */
  vehicle?: true;
};

const P = (part: PartId): PartSlot => ({ part });
/** The basic materials (shared/items.ts): a piece of scrap metal, a piece of cloth, a length of wiring. */
const SCRAP: PartSlot = { scrap: ['scrap'], label: TEXT.items.scrap };
const CLOTH: PartSlot = { scrap: ['cloth'], label: TEXT.items.cloth };
const WIRING: PartSlot = { scrap: ['wiring'], label: TEXT.items.wiring };
/** The receivers' slots: the uranium cell that drives the call, and an enemy's or boss's own part. */
const CELL: PartSlot = { part: 'uranium', rare: true };
const own = (kind: keyof typeof TEXT.items): PartSlot => ({ scrap: [kind], label: TEXT.items[kind], rare: true });
const RECEIVER = { better: 'how steady its needle', use: TEXT.gearUse.receiver };

export const GEAR: Record<string, GearSpec> = {
  motorcycle: { slots: [P('motor'), P('battery'), P('bearing')], vehicle: true, better: 'top speed and acceleration',
    use: TEXT.gearUse.motorcycle },
  spyglass: { slots: [P('gear'), P('bearing')], better: 'zoom', use: TEXT.gearUse.spyglass },
  canteen: { slots: [P('valve'), CLOTH], better: 'how many sips it holds',
    use: TEXT.gearUse.canteen },
  backpack: { slots: [CLOTH, SCRAP, P('gear')], equip: 'back', better: 'room (rows)',
    use: TEXT.gearUse.backpack },
  storm_detector: { slots: [WIRING, P('relay')], equip: 'belt', better: 'how early it warns',
    use: TEXT.gearUse.storm_detector },
  wristpad: { slots: [P('compute'), P('battery')], equip: 'wrist', better: 'how far away players show on the locator',
    use: TEXT.gearUse.wristpad },
  // The guns (shared/rifle.ts): wiring to the emitter, a heat sink to cool it; the rifle also needs a cell.
  laser_pistol: { slots: [WIRING, P('heatsink'), SCRAP], better: 'how fast it recharges', use: TEXT.gearUse.laser_pistol },
  laser_rifle: { slots: [WIRING, P('battery'), P('heatsink'), SCRAP], better: 'how fast it recharges',
    use: TEXT.gearUse.laser_rifle },
  // The jammer (shared/jammer.ts): a compute unit to find the drones' link, wiring for the antenna, a cell to drive it.
  jammer: { slots: [P('compute'), WIRING, P('battery')], better: 'how fast it locks on',
    use: TEXT.gearUse.jammer },
  // The shield plate (server/world.ts die): a hull plate over cloth padding, and an emitter (wiring, cell) that throws a
  // field round you as a killing blow lands. It takes that blow; its last one (shieldSaves) breaks it: the cell burns
  // out and the plate cracks.
  shield: { slots: [WIRING, P('battery'), SCRAP, CLOTH], equip: 'armor', better: 'how many killing blows it takes',
    use: TEXT.gearUse.shield },
  // The receivers (shared/bosses.ts RECEIVERS): each calls its boss, spending the cell. Tuned by a part from the boss's
  // kin (shared/tables.ts RELIC_DROPS); the worm's by a part from each of the other bosses.
  receiver_carrier: { slots: [CELL, own('drone_transponder'), P('compute')], ...RECEIVER },
  receiver_queen: { slots: [CELL, own('brood_gland'), WIRING], ...RECEIVER },
  receiver_colossus: { slots: [CELL, own('servo_heart'), P('relay')], ...RECEIVER },
  receiver_worm: { slots: [CELL, own('hive_core'), own('queen_eye'), own('furnace_heart')], ...RECEIVER },
  // The buildings (shared/placed.ts), put up empty (their frame and windings are the base materials they're built of,
  // shared/tables.ts BUILD_TABLE). The windmill: bearings for the rotor shaft and the head's turn, an electric motor
  // run backwards for its generator. The battery station: a rack of six cells. The beacon: one cell.
  windmill: { slots: [P('bearing'), P('bearing'), P('bearing'), P('motor')],
    better: 'how much power it makes', use: TEXT.gearUse.windmill, built: true },
  battery_station: { slots: [P('battery'), P('battery'), P('battery'), P('battery'), P('battery'), P('battery')],
    better: 'how much power it holds', use: TEXT.gearUse.battery_station, built: true },
  // The beacon (shared/placed.ts): a battery to run its lamp away from the grid (wired to one, it runs on the grid's power
  // and the grid charges its battery: server/power.ts).
  beacon_light: { slots: [P('battery')], better: 'how long it shines on its battery', use: TEXT.gearUse.beacon_light, built: true },
  // The light pole (shared/placed.ts LIGHT_POLE): the same, its floodlight on from dusk to dawn.
  light_pole: { slots: [P('battery')], better: 'how many nights it lights on its battery', use: TEXT.gearUse.light_pole, built: true },
  // The electric well (shared/wells.ts): the submersible pump's motor down the bore, the check valve in the riser, the
  // relay in the control box that switches the pump.
  well: { slots: [P('motor'), P('valve'), P('relay')], better: 'how fast it fills a bottle, and the less power it takes',
    use: TEXT.gearUse.well, built: true },
};
export const GEAR_KINDS = Object.keys(GEAR);

export const isGear = (kind: string) => kind in GEAR;
export const isBuilding = (kind: string | undefined) => !!kind && !!GEAR[kind]?.built;
export const isVehicle = (kind: string | undefined) => !!kind && !!GEAR[kind]?.vehicle;

export function slotLabel(s: PartSlot) {
  return 'part' in s ? PART_LABELS[s.part] : s.label;
}

/** Can `kind` go into part slot `s`? */
export function fitsSlot(s: PartSlot, kind: string): boolean {
  if ('part' in s) return parsePart(kind)?.part === s.part;
  return s.scrap.includes(kind);
}

/** The item's fitted parts, one per slot (a fresh array, null where missing). */
export function partsOf(it: Item): (string | null)[] {
  const n = GEAR[it.kind]?.slots.length ?? 0;
  return Array.from({ length: n }, (_, i) => it.parts?.[i] ?? null);
}

/** Gear `kind` in working order with the worst parts (Scrap tier) in every slot, or `tier`'s. */
export function scrapParts(kind: string, tier: Tier = 'scrap'): string[] {
  return GEAR[kind].slots.map((s) => ('part' in s ? partKind(s.part, tier) : s.scrap[0]));
}

/**
 * Parts fitted under an older slot list (GEAR changed since: e.g. the backpack got a cloth slot), laid onto the
 * item's slots as they are now: each slot takes the first old part that fits it (its data with it), and what fits
 * nowhere is gone. Gear that worked keeps working: a slot nothing fits gets its Scrap-tier part or material. Mutates;
 * false if nothing needed to change.
 */
export function refit(it: { kind: string; parts?: (string | null)[]; data?: ItemData }): boolean {
  const slots = GEAR[it.kind]?.slots;
  const parts = it.parts;
  if (!slots || !parts) return false;
  if (parts.length === slots.length && parts.every((p, i) => p === null || fitsSlot(slots[i], p))) return false;
  const worked = parts.every((p) => p !== null);
  const left = parts.map((_, i) => partAt(it, i));
  const fallback = scrapParts(it.kind);
  const now = slots.map((s, i): Part | null => {
    const j = left.findIndex((p) => p !== null && fitsSlot(s, p.kind));
    if (j < 0) return worked ? { kind: fallback[i] } : null;
    const p = left[j];
    left[j] = null;
    return p;
  });
  it.parts = now.map((p) => p?.kind ?? null);
  setFitted(it, now.map((p) => p?.data));
  return true;
}

/** Every slot filled. */
export function repaired(it: Item | null | undefined): boolean {
  return !!it && isGear(it.kind) && partsOf(it).every((p) => p !== null);
}

/**
 * How good a repaired item is: the mean tier of its tiered parts, 0 (all Scrap) .. 3 (all Space-grade).
 * -1 when it's broken (or not gear).
 */
export function quality(it: Item | null | undefined): number {
  if (!it || !repaired(it)) return -1;
  let sum = 0, n = 0;
  for (const p of partsOf(it)) {
    const t = parsePart(p!);
    if (t) {
      sum += t.tier;
      n++;
    }
  }
  return n ? sum / n : 0;
}

/** lerp from `lo` (quality 0) to `hi` (quality 3). */
const by = (q: number, lo: number, hi: number) => lo + ((hi - lo) * q) / 3;

// What each piece of gear does at quality q (0..3).
/** Receiver: how far its needle wanders off the true bearing (rad). */
export const receiverWobble = (q: number) => by(q, 0.35, 0.05);
/** Motorcycle top speed (m/s) and engine (m/s² from a standstill). With the sand's drag (shared/sim.ts stepBike) it
 *  cruises at about 16 m/s on Scrap parts (a bit over a sprint), 23 on Basic, 29.5 on Quality and 35 on Space-grade. */
export const bikeTopSpeed = (q: number) => by(q, 20, 50);
export const bikeEngine = (q: number) => by(q, 13, 30);
/** Telescope's strongest zoom. */
export const spyglassZoom = (q: number) => by(q, 6, 20);
/** Sips in a full water bottle. */
export const canteenSips = (q: number) => Math.round(by(q, 5, 10));
/** Backpack rows of bag grid (BAG_COLS wide, past the hotbar). */
export const backpackRows = (q: number) => Math.round(by(q, 3, BAG_ROWS));
/** Storm detector: warns this long before a storm reaches you (s). */
export const stormWarnS = (q: number) => by(q, 6, 20);
/** Wrist computer: other players show on the locator this far away (m). Home (your bedroll, else the pod) always does. */
export const locatorRange = (q: number) => by(q, 250, 2000);

/** A gun's recharge (ms) at quality q: its base at Scrap parts (a gun is a gun), down a fifth of it per tier to 40% at
 *  Space-grade (two and a half times the fire rate). */
export const gunCooldown = (base: number, q: number) => base * by(q, 1, 0.4);

/** The jammer's lock time (ms) at quality q: from its base (shared/jammer.ts JAM_MS) at Scrap parts down to 60% at Space-grade. */
export const jamMs = (base: number, q: number) => base * by(q, 1, 0.6);

/** The shield plate: how many killing blows it takes before it breaks, by tier (1 Scrap .. 4 Space-grade). */
export const shieldSaves = (tier: number) => tier + 1;
/** The shield plate: after it takes a killing blow, nothing else can hurt you for this long (ms), to get away. */
export const shieldGraceMs = (q: number) => by(q, 1500, 5000);
/** What breaks when the shield breaks: the cell (burnt out) and the scrap plate (cracked); the coil and padding
 *  stay. Its part slot indices (GEAR.shield). */
export const SHIELD_BREAKS = [1, 2];

/** The tier an item looks like (0 Scrap .. 3 Space-grade): its quality rounded down, 0 when broken or not gear. */
export const tierOf = (it: Item | null | undefined) => Math.max(0, Math.min(3, Math.floor(quality(it) + 1e-6)));

/** The repaired gear equipped in a slot, or null. */
export function equipped(equip: Slots | undefined, slot: EquipSlot): Item | null {
  const it = equip?.[EQUIP_SLOTS.indexOf(slot)];
  return it && repaired(it) ? it : null;
}

/** The bag's layout: the hotbar, then the grid with as many rows open as the backpack's (none without one). */
export function bagShape(equip: Slots | undefined): Shape {
  const pack = equipped(equip, 'back');
  return { free: HOTBAR, cols: BAG_COLS, rows: pack ? Math.min(BAG_ROWS, backpackRows(quality(pack))) : 0, grid: BAG_ROWS };
}

/** Water bottle sips for a bag holding `canteen` (its best repaired one), 0 without. */
export function bottleSips(bag: Slots | undefined): number {
  let best = -1;
  for (const it of bag ?? []) if (it?.kind === 'canteen') best = Math.max(best, quality(it));
  return best < 0 ? 0 : canteenSips(best);
}

/** Motorcycle level for PlayerState.bike: 0 for none (or a broken one), else 1 + its quality (1..4). */
export function bikeLevel(bike: Item | null | undefined): number {
  return bike?.kind === 'motorcycle' && repaired(bike) ? 1 + quality(bike) : 0;
}

