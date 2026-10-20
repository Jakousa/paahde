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

import { baseSolid, LAB_FLOOR_Y, nearBunker, overBase, overPlaced, withPad } from './base.ts';
import { duneHeight, WORLD_SEED } from './dunes.ts';
import { rockHeight } from './rocks.ts';
import { LAB } from './world.ts';
import { nearShelter, overShelter, shelterSolid, withShelterPad } from './shelters.ts';
export { WIND, WORLD_SEED } from './dunes.ts';

/**
 * The world has no edge. The server spreads the finite things (finds, stashes, giant guardians, roaming bosses) over
 * this square of ±CORE_HALF metres round the origin; scrap, crash sites, wrecks and shelters go on forever.
 */
export const CORE_HALF = 2000;

/** Edit grid spacing in metres. Edit vertex (ix, iz) sits at world (ix * EDIT_CELL, iz * EDIT_CELL). */
export const EDIT_CELL = 0.5;
/** Edit vertices per chunk side; chunks are the unit of storage, sync and mesh invalidation. */
export const EDIT_CHUNK = 32;

/** Procedural dunes and rocks (shared/rocks.ts) before player edits, flattened into a pad around the home
 *  base (shared/base.ts) and the shelters (shared/shelters.ts). */
export function baseHeight(x: number, z: number): number {
  if (LAB) return LAB_FLOOR_Y; // the dev test lab (shared/lab.ts): one flat floor, same on client and server
  return withShelterPad(x, z, withPad(x, z, Math.max(duneHeight(x, z, WORLD_SEED), rockHeight(x, z))));
}

/** How far the dunes would have to be dug to reach rock at (x, z), m: 0 on bare rock, Infinity with no
 *  rock under the sand. Rocks avoid the base, so the pad never matters here. */
export function sandOverRock(x: number, z: number): number {
  const r = rockHeight(x, z);
  return r === -Infinity ? Infinity : Math.max(0, duneHeight(x, z, WORLD_SEED) - r);
}

/** True where bare rock is the ground (no dunes or piled sand over it): hard footing, no digging. */
export function onRock(x: number, z: number): boolean {
  return sandOverRock(x, z) === 0 && edits.sample(x, z) < 0.05;
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

  /** Set the offset at edit vertex (ix, iz) to an absolute value in millimetres. Not over the bunker, a shelter or a building on the sand. */
  setMm(ix: number, iz: number, mm: number) {
    if (mm !== 0 && (overBase(ix * EDIT_CELL, iz * EDIT_CELL, 1) || overShelter(ix * EDIT_CELL, iz * EDIT_CELL, 1) || overPlaced(ix * EDIT_CELL, iz * EDIT_CELL, 1))) return;
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

/** A shot at world (x, y, z) is stopped here: in the sand, or the base's or a shelter's walls (down in them the sand
 *  above is their roof, not in the way). */
export function shotSolid(x: number, y: number, z: number): boolean {
  return baseSolid(x, y, z) ?? shelterSolid(x, y, z) ?? y <= heightAt(x, z);
}

/**
 * How far a shot from (ox, oy, oz) along unit (dx, dy, dz) goes before the sand or the base's walls stop it, or
 * `range` if nothing does. Sampled every 0.75 m (0.15 m by the bunker), then refined.
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
    t += nearBunker(px, pz, 2) || nearShelter(px, pz, 2) ? 0.15 : 0.75;
  }
  return range;
}
