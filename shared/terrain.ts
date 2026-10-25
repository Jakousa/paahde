// Desert terrain, shared by client (rendering + prediction) and server (authority).
//
// height(x, z) = baseHeight(x, z)  — procedural dunes, a pure function of position
//              + edit layer        — player modifications (digging, piling), owned by the server
//
// baseHeight (shared/dunes.ts) must be a pure function of (x, z): no Math.random(), no time, no module
// state that differs between client and server. Build it only from exact IEEE operations (+ - * /,
// Math.sqrt, Math.floor, Math.abs, Math.min/max, Math.imul hashing, polynomial smoothstep). Avoid
// Math.sin/cos/exp/pow/atan2: their last bits are implementation-defined and differ between V8 (server)
// and Firefox/Safari (clients). Precomputed trig constants are fine.
//
// The edit layer stores absolute height offsets per grid cell, quantized to integer millimetres, so
// client and server agree exactly. Edits travel as absolute values (not deltas), so applying the same
// edit twice is harmless and a client can predict a dig locally and still converge on the server.

import { overPlaced } from './capsules.ts';
import { biome } from './biomes.ts';
import { duneHeight, WORLD_SEED } from './dunes.ts';
import { ss, vnoise } from './noise.ts';
import { canyonAt, canyonOut } from './canyons.ts';
import { canyonRockHeight, rockHeight } from './rocks.ts';
import { LAB } from './world.ts';
import { nearShelter, overShelter, shelterSolid, withShelterPad } from './shelters.ts';
import { nearShip, withShipFurrow } from './shipSpot.ts';
export { WIND, WORLD_SEED } from './dunes.ts';

/**
 * The world has no edge. The server spreads the finite things (finds, stashes, giant guardians, roaming bosses) over
 * this square of ±CORE_HALF metres round the origin; scrap, crash sites, wrecks and shelters go on forever.
 */
export const CORE_HALF = 2000;

/** More ground that's never dug (+ margin m), added by the modules that own it (shared/trophies.ts): kept here as
 *  hooks, so the terrain needn't import them (they import the terrain). */
const undug: ((x: number, z: number, margin: number) => boolean)[] = [];
export const keepUndug = (f: (x: number, z: number, margin: number) => boolean) => void undug.push(f);

/** Edit grid spacing in metres. Edit vertex (ix, iz) sits at world (ix * EDIT_CELL, iz * EDIT_CELL). */
export const EDIT_CELL = 0.5;
/** Edit vertices per chunk side; chunks are the unit of storage, sync and mesh invalidation. */
export const EDIT_CHUNK = 32;

/** The ground before player edits and pads, in its two layers: `sand` (its top) and `rock` (its top, -Infinity
 *  with no rock), the surface being the higher. Dunes and rocks (shared/rocks.ts), then the canyons
 *  (shared/canyons.ts): their tableland adds rock, their gorge cuts everything above its walls to bare rock and
 *  leaves only its wash's sand on the floor. Also `silt` (0..1, dried mud on a canyon's floor) and `mudflat` (the mud
 *  flats' weight, shared/biomes.ts). Written by ground(), for the last point asked: heightAt and onRock, or
 *  baseHeight and rockTop, at one point work it out once. */
const layers = { sand: 0, rock: -Infinity, silt: 0, mudflat: 0 };
let lastX = NaN, lastZ = NaN;
function ground(x: number, z: number) {
  if (x === lastX && z === lastZ) return;
  const mudflat = biome('mudflat', x, z);
  let sand = duneHeight(x, z, WORLD_SEED, mudflat), rock = rockHeight(x, z), silt = 0;
  if (canyonAt(x, z)) {
    silt = canyonOut.mud; // (read before canyonRockHeight: making its rocks reuses canyonOut)
    if (canyonOut.plateau > rock) {
      rock = canyonOut.plateau;
      // On the tableland: drifts of sand sheet, in soft-edged patches, thinning to bare rock towards its edges. (The
      // dunes under it poked their crests through it, a wavy sawtooth of sand; where they rise well over it, at its
      // foot, they are the dunes again.)
      const n = vnoise(x * (1 / 160), z * (1 / 160), WORLD_SEED + 31) * 0.7 + vnoise(x * (1 / 45), z * (1 / 45), WORLD_SEED + 32) * 0.3;
      const sheet = rock - 0.5 + Math.max(0, (n - 0.42) * 16) * (1 - canyonOut.bare);
      const w = ss((sand - rock - 4) * (1 / 6));
      sand = sheet + (sand - sheet) * w;
    }
    const top = Math.max(sand, rock);
    // (Rounded where the wall meets the top, a smooth min over a few metres: a sharp brink read as a comb.)
    const k = 6, g = Math.max(0, k - Math.abs(top - canyonOut.cut)), cut = canyonOut.cut - g * g / (4 * k);
    if (cut < top) {
      rock = cut;
      sand = canyonOut.wash === Infinity ? -Infinity : Math.min(canyonOut.wash, top); // (up the walls: bare rock)
      // Pillars, buttes and boulders standing on its floor (shared/rocks.ts).
      const fr = canyonRockHeight(x, z);
      if (fr > rock) rock = fr;
    }
  }
  layers.sand = sand;
  layers.rock = rock;
  layers.silt = silt;
  layers.mudflat = mudflat;
  lastX = x;
  lastZ = z;
}

/** The dev test lab's floor (shared/lab.ts): one height everywhere. */
export const LAB_FLOOR_Y = 0;
const LAB_GROUND: Readonly<typeof layers> = { sand: LAB_FLOOR_Y, rock: -Infinity, silt: 0, mudflat: 0 };

/** The ground's layers at (x, z) before edits and pads (see `layers`). Overwritten by the next call. */
export function groundAt(x: number, z: number): Readonly<typeof layers> {
  if (LAB) return LAB_GROUND;
  ground(x, z);
  return layers;
}

/** Procedural dunes, rocks and canyons before player edits, flattened into a pad round the shelters
 *  (shared/shelters.ts), with the crashed ship's furrow (shared/shipSpot.ts). */
export function baseHeight(x: number, z: number): number {
  if (LAB) return LAB_FLOOR_Y; // the dev test lab (shared/lab.ts): one flat floor, same on client and server
  ground(x, z);
  return withShipFurrow(x, z, withShelterPad(x, z, Math.max(layers.sand, layers.rock)));
}

/** Height of the rock at (x, z) (the rocks, a canyon's tableland and walls), or -Infinity where there is none. */
export function rockTop(x: number, z: number): number {
  if (LAB) return -Infinity;
  ground(x, z);
  return layers.rock;
}

/** How far the sand would have to be dug to reach rock at (x, z), m: 0 on bare rock, Infinity with no
 *  rock under the sand. The pads flatten only dunes (rocks avoid them), so they never matter here. */
export function sandOverRock(x: number, z: number): number {
  ground(x, z);
  return layers.rock === -Infinity ? Infinity : Math.max(0, layers.sand - layers.rock);
}

/** True where bare rock is the ground (no dunes or piled sand over it, or dug or blasted down to it): hard
 *  footing, no digging. */
export function onRock(x: number, z: number): boolean {
  return sandOverRock(x, z) + edits.sample(x, z) < 0.05;
}

/** Sparse grid of height offsets (millimetres), chunked. One instance per world (see `edits`). */
export class TerrainEdits {
  private chunks = new Map<string, Int32Array>();
  /** Called with the chunk key after any change, so renderers can rebuild affected meshes. Once per chunk per
   *  batch of vertex changes (a dig stroke, an edit message, a heal pass), not once per vertex: a heal pass over a
   *  few big craters changes ~100 000 vertices. Listeners only mark work for later. */
  onChange?: (cx: number, cz: number) => void;
  /** Chunks already reported in the current batch (cleared on the next microtask). */
  private told = new Set<number>();

  /** Chunk (cx, cz)'s array was changed in place (shared/dig.ts heal): tell the listeners, as setMm would. */
  touch(cx: number, cz: number) {
    // Its low-edge vertices are also sampled by the neighbouring chunks' meshes.
    this.changed(cx, cz);
    this.changed(cx - 1, cz);
    this.changed(cx, cz - 1);
  }

  private changed(cx: number, cz: number) {
    if (!this.onChange) return;
    const k = cx * 0x100000 + cz;
    if (this.told.has(k)) return;
    if (this.told.size === 0) queueMicrotask(() => this.told.clear());
    this.told.add(k);
    this.onChange(cx, cz);
  }

  static key(cx: number, cz: number) {
    return `${cx},${cz}`;
  }

  /** Offset in millimetres at edit vertex (ix, iz). */
  getMm(ix: number, iz: number): number {
    const cx = Math.floor(ix / EDIT_CHUNK), cz = Math.floor(iz / EDIT_CHUNK);
    const c = this.chunks.get(TerrainEdits.key(cx, cz));
    return c ? c[(iz - cz * EDIT_CHUNK) * EDIT_CHUNK + (ix - cx * EDIT_CHUNK)] : 0;
  }

  /** Set the offset at edit vertex (ix, iz) to an absolute value in millimetres. Not over a shelter, a building on the sand,
   *  the crashed ship or a trophy's ground (keepUndug). */
  setMm(ix: number, iz: number, mm: number) {
    if (mm !== 0 && (overShelter(ix * EDIT_CELL, iz * EDIT_CELL, 1) || overPlaced(ix * EDIT_CELL, iz * EDIT_CELL, 1) || nearShip(ix * EDIT_CELL, iz * EDIT_CELL, 1) ||
      undug.some((f) => f(ix * EDIT_CELL, iz * EDIT_CELL, 1)))) return;
    const cx = Math.floor(ix / EDIT_CHUNK), cz = Math.floor(iz / EDIT_CHUNK);
    const k = TerrainEdits.key(cx, cz);
    let c = this.chunks.get(k);
    if (!c) {
      if (mm === 0) return;
      this.chunks.set(k, (c = new Int32Array(EDIT_CHUNK * EDIT_CHUNK)));
    }
    const i = (iz - cz * EDIT_CHUNK) * EDIT_CHUNK + (ix - cx * EDIT_CHUNK);
    if (c[i] === mm) return;
    c[i] = Math.round(mm);
    this.changed(cx, cz);
    // Vertices on a chunk's low edge are also sampled by the neighbouring chunk's mesh.
    if (ix - cx * EDIT_CHUNK === 0) this.changed(cx - 1, cz);
    if (iz - cz * EDIT_CHUNK === 0) this.changed(cx, cz - 1);
  }

  /** Bilinearly interpolated offset in metres at world (x, z). */
  sample(x: number, z: number): number {
    if (this.chunks.size === 0) return 0;
    const gx = x / EDIT_CELL, gz = z / EDIT_CELL;
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const fx = gx - ix, fz = gz - iz;
    const a = this.getMm(ix, iz), b = this.getMm(ix + 1, iz);
    const c = this.getMm(ix, iz + 1), d = this.getMm(ix + 1, iz + 1);
    return ((a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz) / 1000;
  }

  /** Raw chunk data for sync/persistence. */
  chunk(cx: number, cz: number): Int32Array | undefined {
    return this.chunks.get(TerrainEdits.key(cx, cz));
  }
  setChunk(cx: number, cz: number, data: Int32Array) {
    this.chunks.set(TerrainEdits.key(cx, cz), data);
    this.onChange?.(cx, cz);
    this.onChange?.(cx - 1, cz);
    this.onChange?.(cx, cz - 1);
  }
  /** Drop a chunk (back to zero offsets), e.g. when the server no longer has it after a reconnect. */
  deleteChunk(cx: number, cz: number) {
    if (!this.chunks.delete(TerrainEdits.key(cx, cz))) return;
    this.onChange?.(cx, cz);
    this.onChange?.(cx - 1, cz);
    this.onChange?.(cx, cz - 1);
  }
  /** Number of stored chunks. */
  get size() {
    return this.chunks.size;
  }
  *entries(): IterableIterator<[number, number, Int32Array]> {
    for (const [k, v] of this.chunks) {
      const [cx, cz] = k.split(',').map(Number);
      yield [cx, cz, v];
    }
  }
}

/** The world's edit layer. The server mutates it; clients mirror it from server messages. */
export const edits = new TerrainEdits();

/** Ground height in metres at world position (x, z), including player edits. Y is up. */
export function heightAt(x: number, z: number): number {
  return baseHeight(x, z) + edits.sample(x, z);
}

/** Surface normal at (x, z) via central differences. Written into `out` to avoid allocation. */
export function normalAt(x: number, z: number, out: { x: number; y: number; z: number }) {
  const e = 0.25;
  const dx = heightAt(x + e, z) - heightAt(x - e, z);
  const dz = heightAt(x, z + e) - heightAt(x, z - e);
  const nx = -dx, ny = 2 * e, nz = -dz;
  const len = Math.hypot(nx, ny, nz);
  out.x = nx / len;
  out.y = ny / len;
  out.z = nz / len;
  return out;
}

/** A shot at world (x, y, z) is stopped here: in the sand, or a shelter's walls (down in one the sand above is its roof,
 *  not in the way). */
export function shotSolid(x: number, y: number, z: number): boolean {
  return shelterSolid(x, y, z) ?? y <= heightAt(x, z);
}

/**
 * How far a shot from (ox, oy, oz) along unit (dx, dy, dz) goes before the sand or a shelter's walls stop it, or
 * `range` if nothing does. Sampled every 0.75 m (0.15 m by a shelter), then refined.
 */
export function shotGround(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, range: number): number {
  const at = (t: number) => shotSolid(ox + dx * t, oy + dy * t, oz + dz * t);
  let prev = 0;
  for (let t = 0.5; t <= range;) {
    if (at(t)) {
      let lo = prev, hi = t;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        if (at(mid)) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    prev = t;
    const px = ox + dx * t, pz = oz + dz * t;
    t += nearShelter(px, pz, 2) ? 0.15 : 0.75;
  }
  return range;
}
