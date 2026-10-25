// Items: the catalogue, slot containers ("boxes") and the rules for moving stacks between them. The server
// owns every item (server/items.ts, `items` table, one row per stack with a stable id); the client applies
// the same moves at once and the server's answer then replaces them (src/net.ts).
//
// Boxes are laid out like Tarkov's: a few free slots that hold one item of any size (the hotbar, the equipment,
// the workbench), then a grid where every item takes w × h cells by its size (ITEMS), turned 90° if the player
// turned it. An item sits in the slot of its top-left cell; the other cells it covers stay null in the array.
import { partItems, partItem, partOf } from './parts.ts';
import { SALVAGE, TIERS, type PartId, type Tier } from './salvage.ts';
import { SCRAP_KINDS } from './scrap.ts';
import { TEXT } from './text.ts';

type Size = [number, number];

/** Grid cells [w, h] per part; the rest are 1 × 1. */
const PART_SIZES: Partial<Record<PartId, Size>> = { battery: [1, 2], motor: [2, 2], heatsink: [2, 1], uranium: [2, 2], impeller: [2, 2], fanrotor: [2, 2], comprotor: [2, 2], turbinerotor: [2, 2], turbinedisc: [2, 2], fuelmanifold: [2, 2] };

/**
 * Item kind ids as stored in the DB. Never rename one: rows hold them (or migrate them, server/db.ts). `stack`: how
 * many fit one stack (1 for all but scrap).
 * `tier`: the item's quality, which doubles as its rarity (RARITY in shared/salvage.ts); parts have one.
 * `size`: [w, h] grid cells it takes, 1 × 1 if not given. Keep the smaller side at most MAX_SIDE.
 * Gear (shared/gear.ts: the water bottle, telescope, motorcycle, ...) is found broken and repaired with parts.
 */
export const ITEMS: Record<string, { label: string; stack: number; tier?: Tier; size?: Size }> = {
  canteen: { label: TEXT.items.canteen, stack: 1, size: [1, 2] },
  spyglass: { label: TEXT.items.spyglass, stack: 1, size: [2, 1] },
  motorcycle: { label: TEXT.items.motorcycle, stack: 1, size: [4, 2] },
  backpack: { label: TEXT.items.backpack, stack: 1, size: [2, 2] },
  storm_detector: { label: TEXT.items.storm_detector, stack: 1, size: [1, 2] },
  wristpad: { label: TEXT.items.wristpad, stack: 1 },
  shield: { label: TEXT.items.shield, stack: 1, size: [2, 2] },
  // Every piece of junk picked up (scrap piles, crash-site debris) is just scrap: the crafting and repair metal.
  scrap: { label: TEXT.items.scrap, stack: 128 }, // (taking machines apart pays in it: shared/tables.ts SCRAP_REWARD)
  // The other basic material: tarps, sacks and seat covers (cloth bundles in the scrap piles, burnt seats at crash sites).
  cloth: { label: TEXT.items.cloth, stack: 20 },
  // The third: lengths of copper wire, what a machine's wiring coil comes out as (shared/parts.ts UNTIERED). Strung as
  // power lines (shared/wires.ts) and built into the buildings.
  wiring: { label: TEXT.items.wiring, stack: 20 },
  // Small crash-site machines carried home to the disassembly table (COMPONENTS with carry: true, shared/salvage.ts).
  // The item kind is the component kind.
  robot_arm: { label: TEXT.machines.robot_arm, stack: 1, size: [2, 2] },
  control_cabinet: { label: TEXT.machines.control_cabinet, stack: 1, size: [2, 3] },
  winch: { label: TEXT.machines.winch, stack: 1, size: [3, 2] },
  solenoid_valve: { label: TEXT.machines.solenoid_valve, stack: 1, size: [3, 2] },
  beacon: { label: TEXT.machines.beacon, stack: 1, size: [2, 2] },
  // Parts taken out of machines (shared/parts.ts): `<part>_<tier>`, e.g. battery_space.
  ...Object.fromEntries(Object.entries(partItems()).map(([k, v]) => [k, { ...v, size: PART_SIZES[partOf(k)!.part] }])),
  // Crafted at the workbench (shared/crafting.ts) and put down on a shelter's floor from the hotbar (shared/placed.ts).
  plant_bed: { label: TEXT.items.plant_bed, stack: 1, size: [3, 2] },
  uv_lamp: { label: TEXT.items.uv_lamp, stack: 1, size: [1, 2] },
  // Made by hand and laid out on the sand or a shelter's floor (shared/placed.ts): where you wake up after dying.
  bedroll: { label: TEXT.items.bedroll, stack: 1, size: [2, 1] },
  // Buildings: put up with the wrench from the base materials (shared/crafting.ts BUILDS), never carried. A windmill or
  // battery station keeps its item (gear, shared/gear.ts GEAR: its part slots) in a box of its own while it stands.
  windmill: { label: TEXT.items.windmill, stack: 1, size: [2, 3] },
  battery_station: { label: TEXT.items.battery_station, stack: 1, size: [2, 2] },
  // A pole to carry power lines (shared/wires.ts).
  power_pole: { label: TEXT.items.power_pole, stack: 1, size: [1, 3] },
  // A mast with a lamp that shines a column of light into the sky (src/world/beacons.ts): a marker, put up anywhere.
  beacon_light: { label: TEXT.items.beacon_light, stack: 1, size: [1, 3] },
  // A canvas pyramid on a centre pole (shared/tarp.ts): shade, put up anywhere.
  tarp: { label: TEXT.items.tarp, stack: 1, size: [2, 2] },
  // Work stations and a chest, put up anywhere on the sand or a shelter's floor (shared/stations.ts, shared/storage.ts).
  workbench: { label: TEXT.items.workbench, stack: 1, size: [3, 2] },
  dismantle_bench: { label: TEXT.items.dismantle_bench, stack: 1, size: [2, 2] },
  storage_chest: { label: TEXT.items.storage_chest, stack: 1, size: [2, 1] },
  // A borehole with an electric pump (shared/wells.ts): water at home while it has power.
  well: { label: TEXT.items.well, stack: 1, size: [2, 2] },
  // The bosses' trophies (shared/trophies.ts): put up with the wrench once their kind is beaten.
  trophy_worm: { label: TEXT.items.trophy_worm, stack: 1 },
  trophy_carrier: { label: TEXT.items.trophy_carrier, stack: 1 },
  trophy_colossus: { label: TEXT.items.trophy_colossus, stack: 1 },
  trophy_queen: { label: TEXT.items.trophy_queen, stack: 1 },
  // The build tool (crafted by hand): with it in hand, the right mouse opens the build menu (src/buildMenu.ts).
  wrench: { label: TEXT.items.wrench, stack: 1 },
  // The guns (shared/rifle.ts) and the jammer are gear: found broken, repaired at the workbench.
  laser_rifle: { label: TEXT.items.laser_rifle, stack: 1, size: [4, 1] },
  laser_pistol: { label: TEXT.items.laser_pistol, stack: 1, size: [2, 1] },
  jammer: { label: TEXT.items.jammer, stack: 1, size: [2, 1] },
  // A tool you make (an electric motor, a battery and scrap): grinds the seams of a machine's shell open (src/teardown).
  grinder: { label: TEXT.items.grinder, stack: 1, size: [2, 1] },
  // The receivers that call the bosses (shared/bosses.ts RECEIVERS), and the enemies' and bosses' own parts they take.
  receiver_carrier: { label: TEXT.items.receiver_carrier, stack: 1, size: [2, 1] },
  receiver_queen: { label: TEXT.items.receiver_queen, stack: 1, size: [2, 1] },
  receiver_colossus: { label: TEXT.items.receiver_colossus, stack: 1, size: [2, 1] },
  receiver_worm: { label: TEXT.items.receiver_worm, stack: 1, size: [2, 1] },
  drone_transponder: { label: TEXT.items.drone_transponder, stack: 1 },
  brood_gland: { label: TEXT.items.brood_gland, stack: 1 },
  servo_heart: { label: TEXT.items.servo_heart, stack: 1 },
  hive_core: { label: TEXT.items.hive_core, stack: 1 },
  queen_eye: { label: TEXT.items.queen_eye, stack: 1 },
  furnace_heart: { label: TEXT.items.furnace_heart, stack: 1 },
  // Salvage wrecks carried home from the desert (shared/wrecks.ts), taken apart on the disassembly table too.
  vehicle_frame: { label: SALVAGE.vehicle_frame.label, stack: 1, size: [4, 2] },
  water_jet: { label: SALVAGE.water_jet.label, stack: 1, size: [3, 2] },
  warp_core: { label: SALVAGE.warp_core.label, stack: 1, size: [3, 2] },
  ai_control: { label: SALVAGE.ai_control.label, stack: 1, size: [2, 2] },
};
const ORDER = Object.keys(ITEMS);

/** Kinds taken out of the game (the shovel and metal detector went with digging): dropped from boxes and the world on load. */
export const RETIRED = new Set(['shovel', 'metal_detector']);

/** Used from the hotbar (held in hand): Store all leaves these in the bag. Placeables (shared/placed.ts) stay too. */
export const TOOLS = new Set(['canteen', 'spyglass', 'laser_rifle', 'laser_pistol', 'jammer', 'grinder', 'wrench',
  'receiver_carrier', 'receiver_queen', 'receiver_colossus', 'receiver_worm']);

/** Every item fits a grid this many rows tall once turned (its smaller side): the smallest backpack's rows
 *  (shared/gear.ts backpackRows), so anything can be picked up into any bag; chests keep this many rows empty. */
export const MAX_SIDE = 2;
for (const [k, v] of Object.entries(ITEMS)) if (Math.min(...(v.size ?? [1, 1])) > MAX_SIDE) throw new Error(`shared/items.ts: ${k} is too big`);

/** Item kind of a part (shared/parts.ts partItem). */
export const partKind = (part: PartId, tier: Tier) => partItem(part, tier);
/** A part kind's part and tier index (0 scrap .. 3 space), or null for anything else. */
export function parsePart(kind: string): { part: PartId; tier: number } | null {
  const p = partOf(kind);
  return p ? { part: p.part, tier: TIERS.indexOf(p.tier) } : null;
}

/** The basic materials: scrap (most scrap-pile pieces and crash-site debris), cloth (cloth bundles in the piles, burnt
 *  seats at crash sites) and wiring (the machines' wiring coils). What the buildings are made of. */
export const SCRAP = 'scrap';
export const CLOTH = 'cloth';
export const WIRING = 'wiring';
/** Wiring coils from before they became wiring (server/db.ts migrates them, one wiring each). */
export const OLD_COILS = ['coil_scrap', 'coil_basic', 'coil_quality', 'coil_space'];
/** What scrap-pile piece kind `kind` (SCRAP_KINDS index) gives. */
export const scrapItem = (kind: number) => SCRAP_KINDS[kind]?.item ?? SCRAP;
/** What a crash-site debris piece (CRASH_KINDS node name) gives: the burnt seat is cloth, the rest scrap. */
export const debrisItem = (node: string) => (node === 'Crash_Debris_4' ? CLOTH : SCRAP);
/** Scrap kinds from before they were all one SCRAP (old DB rows; old `inventory` table indexes = SCRAP_KINDS order). */
export const OLD_SCRAP = ['oil_drum', 'rusty_drum', 'gear', 'scrap_frame', 'bent_frame', 'metal_plank', 'metal_sheet', 'dented_sheet', 'spring'];

/**
 * One stack. `id` is its DB row id (negative: a client-side guess until the server answers). Gear also has
 * `parts`: the item kind fitted in each of its part slots (shared/gear.ts), null where one is missing.
 * `r`: turned 90° in a grid (its size's w and h swapped).
 */
/** `data`: what this one item has of its own (ItemData). */
export type Item = { id: number; kind: string; n: number; parts?: (string | null)[]; r?: boolean; data?: ItemData };

/**
 * State one item has of its own, which two of the same kind can differ in. Stored as one JSON column (`data`, server/db.ts)
 * and carried wherever the item goes (boxes, dropped on the sand, sent to clients): a new field only needs adding here.
 * An item with any never stacks (stacks below): it's always one of its own. Leave a field out for its default, never
 * store it.
 * `worn`: a shield plate's killing blows taken since it last broke (shared/gear.ts shieldSaves).
 * `charge`: a battery's charge, the part of what it holds (0..1, shared/power.ts CELLS); full when not set.
 * `color`: a beacon's light, by its index in BEACON_COLORS (shared/placed.ts); the first when not set.
 * `fitted`: gear's (a building's, a vehicle's) fitted parts' own data, by part slot like `parts`: a part keeps its
 *   data while it's fitted. Always move parts with partAt / setPart, never `parts` alone.
 */
export type ItemData = { worn?: number; charge?: number; color?: number; fitted?: (ItemData | null)[] };

/** `data` as an item's field to spread into it: a copy (its fitted parts' too), or nothing when there's none. */
export const withData = (data: ItemData | null | undefined): { data?: ItemData } =>
  data && Object.keys(data).length ? { data: { ...data, ...(data.fitted ? { fitted: data.fitted.map((d) => d && { ...d }) } : {}) } } : {};

/** What an item has of its own (gear's `parts`, its ItemData), copied, to spread into another; nothing for a plain one. */
export const ownOf = (it: { parts?: (string | null)[] | null; data?: ItemData | null }): { parts?: (string | null)[]; data?: ItemData } =>
  ({ ...(it.parts ? { parts: [...it.parts] } : {}), ...withData(it.data) });

/** Item `id`: `it`'s kind, count (default one), turn and what it has of its own (ownOf). Build items with this, not by
 *  hand, so nothing of their own is left behind. */
export const makeItem = (id: number, it: { kind: string; n?: number; r?: boolean | number; parts?: (string | null)[] | null; data?: ItemData | null }): Item =>
  ({ id, kind: it.kind, n: it.n ?? 1, ...ownOf(it), ...(it.r ? { r: true } : {}) });

/** Set (or with undefined, clear) one of an item's own fields; an item left with none loses `data`. */
export function setData<K extends keyof ItemData>(it: { data?: ItemData }, key: K, value: ItemData[K] | undefined) {
  const data: ItemData = { ...it.data };
  if (value === undefined) delete data[key];
  else data[key] = value;
  if (Object.keys(data).length) it.data = data;
  else delete it.data;
}

/** A part as it's fitted into gear or taken out: its kind and its own data. */
export type Part = { kind: string; data?: ItemData };

/** The part fitted in slot `i` of `it`, with its data; null for an empty slot. */
export function partAt(it: { parts?: (string | null)[]; data?: ItemData }, i: number): Part | null {
  const kind = it.parts?.[i];
  return kind ? { kind, ...withData(it.data?.fitted?.[i]) } : null;
}

/** Fit `p` into slot `i` of `it` (null: empty it), its data with it. Mutates `it`, with fresh arrays. */
export function setPart(it: { parts?: (string | null)[]; data?: ItemData }, i: number, p: Part | null) {
  const parts = [...(it.parts ?? [])];
  while (parts.length <= i) parts.push(null);
  parts[i] = p?.kind ?? null;
  it.parts = parts;
  setFitted(it, Object.assign([...(it.data?.fitted ?? [])], { [i]: p?.data ?? null }));
}

/** Set every fitted part's data at once (by slot; null where there's none), dropping it all when there's none. */
export function setFitted(it: { data?: ItemData }, fitted: (ItemData | null | undefined)[]) {
  const f = Array.from(fitted, (d) => (d && Object.keys(d).length ? d : null));
  while (f.length && !f[f.length - 1]) f.pop();
  setData(it, 'fitted', f.length ? f : undefined);
}

/** A battery's charge (0..1), or null for anything that isn't one. */
export function chargeOf(it: { kind: string; data?: ItemData }): number | null {
  return partOf(it.kind)?.part === 'battery' ? Math.max(0, Math.min(1, it.data?.charge ?? 1)) : null;
}
export type Slots = (Item | null)[];

/**
 * The player's own bag: HOTBAR free slots of hotbar (keys 1–5, src/water.ts), then a BAG_COLS wide grid of which
 * the equipped backpack opens some rows (shared/gear.ts bagShape), up to BAG_ROWS. The slots array is always
 * at least BAG_SLOTS long; items past it (or in rows the backpack doesn't open) are stranded: only moved out.
 */
export const HOTBAR = 5;
export const BAG_COLS = 6;
export const BAG_ROWS = 6;
export const BAG_SLOTS = HOTBAR + BAG_COLS * BAG_ROWS;
/** The motorcycle's cargo grid. */
export const BIKE_COLS = 6;
export const BIKE_ROWS = 4;
/** Chests are this wide and grow downwards (shared/storage.ts growChest), at least CHEST_ROWS. */
export const CHEST_COLS = 8;
export const CHEST_ROWS = 10;

/**
 * A box's layout: `free` slots (one item of any size each), then a grid `cols` wide and `grid` rows long of
 * which the first `rows` are usable (a small backpack opens fewer). Slot free + y·cols + x is cell (x, y).
 */
export type Shape = { free: number; cols: number; rows: number; grid: number };
export const freeSlots = (n: number): Shape => ({ free: n, cols: 1, rows: 0, grid: 0 });
export const gridShape = (cols: number, rows: number): Shape => ({ free: 0, cols, rows, grid: rows });

export const stackOf = (kind: string) => ITEMS[kind]?.stack ?? 1;

/** An item's footprint [w, h] in grid cells, turned when `r`. */
export function sizeOf(kind: string, r?: boolean): Size {
  const [w, h] = ITEMS[kind]?.size ?? [1, 1];
  return r ? [h, w] : [w, h];
}

/** Cells a w × h item at slot i would cover, or null if it doesn't fit there (out of the first `rows` rows or off the side). */
export function cellsAt(shape: Shape, i: number, w: number, h: number, rows = shape.rows): number[] | null {
  if (i < shape.free) return i >= 0 ? [i] : null;
  const x = (i - shape.free) % shape.cols, y = Math.floor((i - shape.free) / shape.cols);
  if (x + w > shape.cols || y + h > rows) return null;
  const out: number[] = [];
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) out.push(shape.free + (y + dy) * shape.cols + x + dx);
  return out;
}

/** Which item covers each slot: the slot index of its top-left cell, -1 where empty. Items in `skip` don't count. */
export function coverage(slots: Slots, shape: Shape, skip: number[] = []): Int32Array {
  const out = new Int32Array(Math.max(slots.length, shape.free + shape.cols * shape.grid)).fill(-1);
  for (let i = 0; i < slots.length; i++) {
    const it = slots[i];
    if (!it || skip.includes(i)) continue;
    // Anywhere in the grid, usable or not (an item stranded in rows a smaller backpack lacks still takes room).
    const cells = cellsAt(shape, i, ...sizeOf(it.kind, it.r), shape.grid) ?? [];
    for (const c of cells) out[c] = i;
  }
  return out;
}

/** Could a w × h item go at slot i: inside the usable grid (or a free slot), on cells only `skip` items cover? */
export function fitsAt(slots: Slots, shape: Shape, i: number, w: number, h: number, skip: number[] = [], cov = coverage(slots, shape, skip)): boolean {
  const cells = cellsAt(shape, i, w, h);
  return !!cells && cells.every((c) => cov[c] < 0);
}

/** Is the item at slot i outside the usable grid (rows the backpack doesn't open, or past the end)? */
export function strandedAt(slots: Slots, shape: Shape, i: number): boolean {
  const it = slots[i];
  return !!it && i >= shape.free && !cellsAt(shape, i, ...sizeOf(it.kind, it.r));
}

/**
 * The first place an item of `kind` fits: in the grid, row by row, as it lies and then turned; then (if `free`)
 * the first empty free slot. Null if there's none.
 */
export function findSpot(slots: Slots, shape: Shape, kind: string, r = false, skip: number[] = [], free = true): { i: number; r: boolean } | null {
  const cov = coverage(slots, shape, skip);
  const end = shape.free + shape.cols * shape.rows;
  for (const turned of [r, !r]) {
    const [w, h] = sizeOf(kind, turned);
    for (let i = shape.free; i < end; i++) if (fitsAt(slots, shape, i, w, h, skip, cov)) return { i, r: turned };
    if (w === h) break;
  }
  if (free) for (let i = 0; i < shape.free; i++) if (cov[i] < 0) return { i, r };
  return null;
}

/** Set an item's turn (only stored when turned). */
function turn(it: Item, r: boolean) {
  if (r) it.r = true;
  else delete it.r;
}

/** Does `slots` hold an item of this kind? */
export const hasItem = (slots: Slots | undefined, kind: string) => !!slots?.some((it) => it?.kind === kind);

/** Has it anything of its own (gear's parts, ItemData)? Then it's one of a kind: never stacked, always n = 1. */
const ownState = (it: Item) => !!it.parts || !!it.data;
/** Can these two stack: the same kind, and neither has anything of its own? */
export const stacks = (a: Item, b: Item | string) =>
  a.kind === (typeof b === 'string' ? b : b.kind) && !ownState(a) && (typeof b === 'string' || !ownState(b));

/** Room for one more of `kind` (on a stack of it, or a free spot)? */
export function roomFor(slots: Slots, kind: string, shape: Shape): boolean {
  return slots.some((it, i) => it && stacks(it, kind) && it.n < stackOf(kind) && !strandedAt(slots, shape, i)) || !!findSpot(slots, shape, kind);
}

/**
 * Put n of `kind` into `slots`: onto stacks of it first, then wherever it fits (findSpot: the grid before the
 * free slots, so pickups land in the backpack before the hotbar). With `data` (ItemData), each is one of its own:
 * never onto a stack. Mutates; false (and no change) if there's no room.
 */
export function addItem(slots: Slots, kind: string, n: number, newId: () => number, shape: Shape, data?: ItemData): boolean {
  const s = [...slots];
  if (addUpTo(s, kind, n, newId, shape, data) < n) return false;
  for (let i = 0; i < s.length; i++) slots[i] = s[i];
  return true;
}

/** Put up to n of `kind` into `slots` like addItem, as many as fit. Mutates; returns how many went in. */
export function addUpTo(slots: Slots, kind: string, n: number, newId: () => number, shape: Shape, data?: ItemData): number {
  const own = withData(data);
  let left = n;
  for (let i = 0; i < slots.length && left > 0 && !own.data; i++) {
    const it = slots[i];
    if (!it || !stacks(it, kind) || strandedAt(slots, shape, i)) continue;
    const k = Math.min(left, stackOf(kind) - it.n);
    if (k > 0) slots[i] = { ...it, n: it.n + k };
    left -= Math.max(0, k);
  }
  while (left > 0) {
    const spot = findSpot(slots, shape, kind);
    if (!spot) break;
    const k = own.data ? 1 : Math.min(left, stackOf(kind));
    slots[spot.i] = makeItem(newId(), { kind, n: k, r: spot.r, data: own.data });
    left -= k;
  }
  return n - left;
}

/**
 * Drag n (default all) of the stack at src[si] to dst slot di, turned if `r` (default: as it lies): onto free
 * cells, onto a stack of the same kind (what doesn't fit stays behind), or swapped with the item lying there
 * (whole stacks only: it takes that item's corner, or the dropped-on cell, and that item goes where it was).
 * di = -1 means "anywhere in dst" (shift-click): onto its stacks, then the first spot it fits (findSpot).
 * src and dst may be the same array. Mutates; returns whether anything changed (no change when refused).
 */
export function moveItem(src: Slots, si: number, srcShape: Shape, dst: Slots, di: number, dstShape: Shape, n: number | undefined,
  newId: () => number, r?: boolean): boolean {
  const it = src[si];
  if (!it) return false;
  const k = Math.max(1, Math.min(it.n, n ?? it.n));
  if (di === -1) {
    if (src === dst) return false;
    let left = k;
    for (let j = 0; j < dst.length && left > 0; j++) {
      const d = dst[j];
      if (!d || !stacks(d, it) || strandedAt(dst, dstShape, j)) continue;
      const m = Math.min(left, stackOf(it.kind) - d.n);
      d.n += m;
      left -= m;
    }
    const spot = left > 0 ? findSpot(dst, dstShape, it.kind, !!it.r) : null;
    if (spot) {
      // The rest goes into a free spot: as the stack itself (keeping its id) when all of it moves.
      if (k === it.n) {
        it.n = left;
        turn(it, spot.r);
        src[si] = null;
        dst[spot.i] = it;
        return true;
      }
      dst[spot.i] = makeItem(newId(), { kind: it.kind, n: left, r: spot.r });
      left = 0;
    }
    it.n -= k - left;
    if (it.n === 0) src[si] = null;
    return left < k;
  }
  const rr = r ?? !!it.r;
  if (src === dst && si === di && rr === !!it.r) return false;
  const [w, h] = sizeOf(it.kind, rr);
  const skip = src === dst ? [si] : [];
  const cov = coverage(dst, dstShape, skip);
  const dj = di >= 0 && di < cov.length ? cov[di] : -1;
  if (dj < 0) {
    if (!fitsAt(dst, dstShape, di, w, h, skip, cov)) return false;
    if (k === it.n) {
      src[si] = null;
      turn(it, rr);
      dst[di] = it;
    } else {
      dst[di] = makeItem(newId(), { kind: it.kind, n: k, r: rr });
      it.n -= k;
    }
    return true;
  }
  const d = dst[dj]!;
  if (stacks(d, it)) {
    const m = Math.min(k, stackOf(it.kind) - d.n);
    if (m === 0) return false;
    d.n += m;
    it.n -= m;
    if (it.n === 0) src[si] = null;
    return true;
  }
  if (k !== it.n) return false;
  // Swap: lift both out, put `it` down, then `d` where `it` was (as it lies, else turned); undo if either won't fit.
  const ir = !!it.r, dr = !!d.r;
  src[si] = null;
  dst[dj] = null;
  turn(it, rr);
  for (const t of new Set([dj, di])) {
    if (!fitsAt(dst, dstShape, t, w, h)) continue;
    dst[t] = it;
    for (const turned of [dr, !dr]) {
      if (!fitsAt(src, srcShape, si, ...sizeOf(d.kind, turned))) continue;
      turn(d, turned);
      src[si] = d;
      return true;
    }
    dst[t] = null;
  }
  turn(it, ir);
  dst[dj] = d;
  src[si] = it;
  return false;
}

/**
 * Tidy a box's grid: merge stacks of the same kind and pack them again, biggest first (then by catalogue),
 * row by row. Free slots (the hotbar) stay as the player set them, and so do stranded items. Mutates; false
 * (and no change) if the packing came out worse than what was there and something wouldn't fit.
 */
export function sortItems(slots: Slots, shape: Shape): boolean {
  const s = [...slots];
  const items: Item[] = [];
  for (let i = shape.free; i < s.length; i++) {
    const it = s[i];
    if (!it || strandedAt(s, shape, i)) continue;
    items.push(it);
    s[i] = null;
  }
  const merged: Item[] = [];
  for (const it of items) {
    let left = it.n;
    for (const m of merged) {
      if (!stacks(m, it) || left === 0) continue;
      const k = Math.min(left, stackOf(it.kind) - m.n);
      m.n += k;
      left -= k;
    }
    if (left > 0) merged.push({ ...it, n: left });
  }
  const area = (it: Item) => sizeOf(it.kind)[0] * sizeOf(it.kind)[1];
  merged.sort((a, b) => area(b) - area(a) || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.n - a.n || a.id - b.id);
  for (const it of merged) {
    // Lying wide first: rows fill more evenly.
    const [w, h] = sizeOf(it.kind);
    const spot = findSpot(s, shape, it.kind, h > w, [], false);
    if (!spot) return false;
    turn(it, spot.r);
    s[spot.i] = it;
  }
  for (let i = 0; i < s.length; i++) slots[i] = s[i];
  return true;
}

/**
 * Make a box's layout valid (after loading it, or after item sizes changed): an item that overlaps an earlier
 * one or sticks out of the grid moves to the first spot it fits, the usable rows first, then the rest of the
 * grid, then (with `grow`, a chest) a new row, else past the end (stranded). Mutates; returns whether anything moved.
 */
export function settle(slots: Slots, shape: Shape, grow = false): boolean {
  let all = { ...shape, rows: shape.grid };
  const s: Slots = new Array(Math.max(slots.length, shape.free + shape.cols * shape.grid)).fill(null);
  const homeless: Item[] = [];
  for (let i = 0; i < slots.length; i++) {
    const it = slots[i];
    if (!it) continue;
    if (i < shape.free || fitsAt(s, all, i, ...sizeOf(it.kind, it.r))) s[i] = it;
    else homeless.push(it);
  }
  for (const it of homeless) {
    let spot = findSpot(s, shape, it.kind, !!it.r, [], false) ?? findSpot(s, all, it.kind, !!it.r, [], false);
    while (!spot && grow) {
      all = { ...all, rows: all.rows + 1, grid: all.grid + 1 };
      s.push(...new Array(shape.cols).fill(null));
      spot = findSpot(s, all, it.kind, !!it.r, [], false);
    }
    if (spot) {
      turn(it, spot.r);
      s[spot.i] = it;
    } else s.push(it);
  }
  slots.length = s.length;
  for (let i = 0; i < s.length; i++) slots[i] = s[i];
  return homeless.length > 0;
}
