// The electric well: a borehole with a submersible pump in it, put up with the wrench out on the sand (shared/placed.ts
// PLACEABLES.well, tools/blender/well.py), its part slots empty at first like the windmill's (shared/gear.ts GEAR.well:
// the pump's motor, the check valve, the relay that switches it). It's water at home: the canteen fills at
// its spigot like at a pump, but only while it runs.
//
// It runs on electricity (server/power.ts): wired to a grid (shared/wires.ts), every part in, its control box takes
// WELL_IDLE_W the whole time (its lamp lit), and the pump wants wellSpec().watts while it fills a bottle, which the grid
// must be able to give right then: from the windmills, or out of the batteries. Unpowered it's dry. A bottle's worth
// comes out of the batteries each fill (pump()). The server says which wells run (PowerState.wells); setWellsOn()
// keeps the list here on both sides, for the fill check (waterAt).
//
// Realism in game time (shared/power.ts): a small 0.4 kW borehole pump from scrap parts (Scrap draws more, gives less)
// fills a bottle in a few game minutes; a Scrap car battery runs it for about twenty bottles. Groundwater is
// everywhere the sand is: the wells go wherever a building can (no water table to read off the biomes: the dunes and
// the mud flats both have it, and the canyons' rock is too steep to build on anyway).
import { parsePart } from './items.ts';
import { placed, turnXZ, type Placed } from './placed.ts';
import { atWater } from './shelters.ts';
import { FILL_MS } from './water.ts';

export const WELL = 'well';

/** The spigot's mouth in the well's own frame (rot 0; m, from the footprint's centre on what it stands on). Match
 *  tools/blender/well.py SPIGOT. */
export const SPIGOT = { x: 0.6, y: 0.78, z: 0.46 };
/** The canteen fills with your feet within this (m, horizontally) of the spigot. */
export const WELL_REACH = 1.3;
/** The control box and its lamp, all the time while it has every part (W). */
export const WELL_IDLE_W = 4;

const by = (q: number, lo: number, hi: number) => lo + ((hi - lo) * q) / 3;

/** A well's pump from its parts: what it draws while it fills a bottle (W) and how long a fill takes (ms, real); the
 *  mean tier of its parts (0 Scrap .. 3 Space-grade) sets both. Null while a slot is empty. */
export function wellSpec(parts: readonly (string | null)[] | undefined) {
  if (!parts?.length || parts.some((p) => !p)) return null;
  const q = parts.reduce((s, p) => s + (parsePart(p!)?.tier ?? 0), 0) / parts.length;
  return { watts: by(q, 600, 300), fillMs: FILL_MS * by(q, 2.5, 0.8) };
}

/** The wells running right now (from the server's power state). Replace with setWellsOn(). */
let on = new Set<number>();
export function setWellsOn(ids: readonly number[] | undefined) {
  on = new Set(ids ?? []);
}
export const wellOn = (id: number) => on.has(id);

/** World position of a well's spigot. */
export function spigotAt(p: Placed): { x: number; y: number; z: number } {
  const [dx, dz] = turnXZ(p.rot, SPIGOT.x, SPIGOT.z);
  return { x: p.x + dx, y: p.y + SPIGOT.y, z: p.z + dz };
}

/** The running well (or with `any`, any well) whose spigot someone with feet at world (x, y, z) is at (+ margin), or
 *  null. */
export function wellAt(x: number, y: number, z: number, margin = 0, list: Placed[] = placed, any = false): Placed | null {
  const r = WELL_REACH + margin;
  for (const p of list) {
    if (p.kind !== WELL || (!any && !on.has(p.id))) continue;
    const s = spigotAt(p), dx = x - s.x, dz = z - s.z;
    if (dx * dx + dz * dz < r * r && Math.abs(y - p.y) < 1.5 + margin) return p;
  }
  return null;
}

/** Where the canteen fills at world (x, y, z) (+ margin): a shelter's pump (shared/shelters.ts atWater),
 *  or a running well, with how long a fill takes there (ms); null where there's no water. */
export function waterAt(x: number, y: number, z: number, margin = 0): { well: Placed | null; ms: number } | null {
  if (atWater(x, y, z, margin)) return { well: null, ms: FILL_MS };
  const well = wellAt(x, y, z, margin);
  return well ? { well, ms: wellSpec(well.parts)?.fillMs ?? FILL_MS } : null;
}
