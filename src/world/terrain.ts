// Renders the shared heightfield (shared/terrain.ts) as a quadtree of chunks with distance-based LOD.
//
// Every chunk is a CELLS×CELLS grid; a level-L chunk is BASE_SIZE·2^L metres wide, so level 0 has
// EDIT_CELL (0.5 m) spacing and its vertices sit exactly on the edit grid: the visible ground near
// the player is the same heightAt() the physics uses. Each frame the quadtree is re-split around the
// focus; a node splits while the focus is within SPLIT·size of it. Cracks between neighbouring levels
// are hidden by skirts (a strip hanging down from every chunk edge).
//
// Chunks are generated on the main thread under a per-frame time budget. A new layout is only shown
// once all of its chunks exist, so there are never holes; built chunks are cached for reuse.
// Edits (digging) invalidate the fine chunks they touch, which are rebuilt nearest-first.
import * as THREE from 'three/webgpu';
import { baseHeight, EDIT_CELL, EDIT_CHUNK, edits, heightAt, WIND } from '../../shared/terrain.ts';
import { hazeDensity, hazeFar } from './env.ts';
import { createSandMaterial, sand } from './sandMaterial.ts';

/** Grid cells per chunk side. */
const CELLS = 64;
/** Level-0 chunk width: CELLS · EDIT_CELL = 32 m. */
const BASE_SIZE = CELLS * EDIT_CELL;
/** Coarsest level; its chunks are BASE_SIZE · 2^MAX_LEVEL = 4096 m wide. */
const MAX_LEVEL = 7;
/** A node splits while the focus is closer than SPLIT · its size (higher = more detail, more chunks). */
const SPLIT = 1.0;
/** Chunks farther than this from the focus are not drawn at all. */
const VIEW_DISTANCE = 4500;
/** Levels at or below this sample the edit layer and are rebuilt on edits (spacing ≤ 2 m). */
const EDIT_LEVELS = 2;
/** Haze extinction per metre for a terrain this large: far dunes fade in layered bands over km. */
const HAZE_DENSITY = 0.002;
/** Main-thread milliseconds per frame spent generating chunks (after the first, blocking, build). */
const FRAME_BUDGET_MS = 3;
/** If a new layout has waited this long, raise the per-frame budget to LATE_BUDGET_MS. */
const MAX_PENDING_MS = 500;
const LATE_BUDGET_MS = 10;
const CACHE_LIMIT = 500;

const VERTS = CELLS + 1;
const SKIRT_VERTS = 4 * VERTS;
/** Convexity (−∇²h, 1/m) that counts as a full crest, and the blur radius (vertices) that widens the
 *  brink line into a band a few metres wide. */
const CREST_CURVATURE = 0.3;
const CREST_BLUR = 2;

function createTerrainMaterial(): THREE.Material {
  sand.wind.value.set(WIND.x, WIND.z); // ripples run perpendicular to the dunes' wind
  return createSandMaterial();
}

type Chunk = {
  key: string;
  level: number;
  x0: number; // world origin (min corner)
  z0: number;
  size: number;
  mesh: THREE.Mesh;
  lastUsed: number;
};

function key(level: number, ix: number, iz: number) {
  return `${level}:${ix}:${iz}`;
}

/** Index buffer shared by every chunk: the grid, plus double-sided skirt quads along the four edges. */
function buildIndex(): THREE.BufferAttribute {
  const idx: number[] = [];
  for (let j = 0; j < CELLS; j++) {
    for (let i = 0; i < CELLS; i++) {
      const a = j * VERTS + i, b = a + 1, c = a + VERTS, d = c + 1;
      idx.push(a, c, b, b, c, d); // counter-clockwise seen from above (+Y)
    }
  }
  // Edge loops: grid vertex index and skirt vertex index for each edge position.
  const edge = (e: number, t: number) => {
    switch (e) {
      case 0: return t; // z = 0 row
      case 1: return CELLS * VERTS + t; // z = max row
      case 2: return t * VERTS; // x = 0 column
      default: return t * VERTS + CELLS; // x = max column
    }
  };
  const base = VERTS * VERTS;
  for (let e = 0; e < 4; e++) {
    for (let t = 0; t < CELLS; t++) {
      const a = edge(e, t), b = edge(e, t + 1);
      const sa = base + e * VERTS + t, sb = sa + 1;
      idx.push(a, sa, b, b, sa, sb, a, b, sa, b, sb, sa); // both windings: visible from either side
    }
  }
  return new THREE.BufferAttribute(new Uint16Array(idx), 1);
}

export class Terrain {
  private scene: THREE.Scene;
  private material = createTerrainMaterial();
  private index = buildIndex();
  private cache = new Map<string, Chunk>();
  private shown = new Set<string>();
  private desired: { key: string; level: number; ix: number; iz: number; dist: number }[] = [];
  private pendingSince = 0;
  private dirty = new Set<string>();
  private frame = 0;
  private lastX = NaN;
  private lastZ = NaN;
  // Scratch buffers for generation: heights with a 1-vertex border (for central-difference normals).
  private hbuf = new Float64Array((VERTS + 2) * (VERTS + 2));
  private cbuf = new Float32Array(VERTS * VERTS);
  private cblur = new Float32Array(VERTS * VERTS);

  /** Stats for debugging/perf overlays. */
  readonly stats = { chunks: 0, triangles: 0, builtThisFrame: 0, buildMs: 0, totalBuilt: 0 };

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    // Haze must reach total just before the terrain edge, which is at least VIEW_DISTANCE away.
    hazeFar.value = VIEW_DISTANCE * 0.95;
    hazeDensity.value = HAZE_DENSITY;
    const prev = edits.onChange;
    edits.onChange = (cx, cz) => {
      prev?.(cx, cz);
      this.invalidate(cx, cz);
    };
  }

  /** Called every render frame with the local player's position. */
  update(focus: THREE.Vector3) {
    this.frame++;
    const t0 = performance.now();
    this.stats.builtThisFrame = 0;
    // Re-split only when the focus has moved a little (the finest chunk is 32 m).
    if (Math.abs(focus.x - this.lastX) + Math.abs(focus.z - this.lastZ) > 0.5 || !this.desired.length) {
      this.lastX = focus.x;
      this.lastZ = focus.z;
      this.computeDesired(focus.x, focus.z);
    }

    // First frame: build everything synchronously so the world appears complete. If a layout has been
    // waiting long (very fast movement), spend more time per frame rather than keep the stale one.
    const late = this.pendingSince > 0 && t0 - this.pendingSince > MAX_PENDING_MS;
    const deadline = this.shown.size === 0 ? Infinity : t0 + (late ? LATE_BUDGET_MS : FRAME_BUDGET_MS);

    // Rebuild dirty (edited) chunks first, nearest first; the chunk under the player always.
    if (this.dirty.size) {
      const list: Chunk[] = [];
      for (const k of this.dirty) {
        const c = this.cache.get(k);
        if (c) list.push(c);
      }
      list.sort((a, b) => this.chunkDist(a, focus) - this.chunkDist(b, focus));
      for (const c of list) {
        if (performance.now() > deadline && this.chunkDist(c, focus) > 0) break;
        this.fill(c);
        this.dirty.delete(c.key);
      }
    }

    // Build missing chunks of the desired layout (list is sorted nearest first).
    let missing = 0;
    for (const d of this.desired) {
      const c = this.cache.get(d.key);
      if (c) {
        c.lastUsed = this.frame;
      } else if (performance.now() > deadline) {
        missing++;
      } else {
        this.create(d.level, d.ix, d.iz);
      }
    }

    if (missing === 0) {
      this.pendingSince = 0;
      this.swapIn();
    } else if (!this.pendingSince) {
      this.pendingSince = t0;
    }
    this.evict();
    this.stats.buildMs = performance.now() - t0;
  }

  /** Quadtree traversal: the leaves to draw for this focus, sorted nearest first. */
  private computeDesired(fx: number, fz: number) {
    const out = this.desired;
    out.length = 0;
    const rootSize = BASE_SIZE * (1 << MAX_LEVEL);
    const r0x = Math.floor((fx - VIEW_DISTANCE) / rootSize), r1x = Math.floor((fx + VIEW_DISTANCE) / rootSize);
    const r0z = Math.floor((fz - VIEW_DISTANCE) / rootSize), r1z = Math.floor((fz + VIEW_DISTANCE) / rootSize);
    const visit = (level: number, ix: number, iz: number) => {
      const size = BASE_SIZE * (1 << level);
      const x0 = ix * size, z0 = iz * size;
      const dx = Math.max(x0 - fx, 0, fx - (x0 + size));
      const dz = Math.max(z0 - fz, 0, fz - (z0 + size));
      const dist = Math.hypot(dx, dz);
      if (dist > VIEW_DISTANCE) return;
      if (level > 0 && dist < SPLIT * size) {
        visit(level - 1, ix * 2, iz * 2);
        visit(level - 1, ix * 2 + 1, iz * 2);
        visit(level - 1, ix * 2, iz * 2 + 1);
        visit(level - 1, ix * 2 + 1, iz * 2 + 1);
      } else {
        out.push({ key: key(level, ix, iz), level, ix, iz, dist });
      }
    };
    for (let iz = r0z; iz <= r1z; iz++) for (let ix = r0x; ix <= r1x; ix++) visit(MAX_LEVEL, ix, iz);
    out.sort((a, b) => a.dist - b.dist);
  }

  /** Show exactly the desired layout. */
  private swapIn() {
    let same = this.shown.size === this.desired.length;
    if (same) for (const d of this.desired) if (!this.shown.has(d.key)) { same = false; break; }
    if (same) return;
    const next = new Set<string>();
    let tris = 0;
    for (const d of this.desired) {
      next.add(d.key);
      const c = this.cache.get(d.key)!;
      c.mesh.visible = true;
      tris += this.index.count / 3;
    }
    for (const k of this.shown) if (!next.has(k)) { const c = this.cache.get(k); if (c) c.mesh.visible = false; }
    this.shown = next;
    this.stats.chunks = next.size;
    this.stats.triangles = tris;
  }

  private create(level: number, ix: number, iz: number) {
    const size = BASE_SIZE * (1 << level);
    const geo = new THREE.BufferGeometry();
    const n = VERTS * VERTS + SKIRT_VERTS;
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('crest', new THREE.BufferAttribute(new Float32Array(n), 1));
    geo.setIndex(this.index);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(ix * size, 0, iz * size);
    mesh.receiveShadow = true;
    // Dunes shadow each other and the players: the sun's cascades reach ~1.6 km (sky.ts). The shadow
    // pass draws back faces, so lit slopes never self-shadow (only faces turned from the sun can).
    mesh.castShadow = true;
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    const c: Chunk = { key: key(level, ix, iz), level, x0: ix * size, z0: iz * size, size, mesh, lastUsed: this.frame };
    this.fill(c);
    this.scene.add(mesh);
    this.cache.set(c.key, c);
  }

  /** (Re)generate a chunk's vertices from the heightfield. */
  private fill(c: Chunk) {
    const step = c.size / CELLS;
    const W = VERTS + 2;
    const h = this.hbuf;
    const sample = c.level <= EDIT_LEVELS ? heightAt : baseHeight;
    let minY = Infinity, maxY = -Infinity;
    for (let j = 0; j < W; j++) {
      const z = c.z0 + (j - 1) * step;
      for (let i = 0; i < W; i++) {
        const y = sample(c.x0 + (i - 1) * step, z);
        h[j * W + i] = y;
      }
    }
    const geo = c.mesh.geometry;
    const pos = geo.attributes.position.array as Float32Array;
    const nor = geo.attributes.normal.array as Float32Array;
    const inv = 1 / (2 * step);
    for (let j = 0; j < VERTS; j++) {
      for (let i = 0; i < VERTS; i++) {
        const k = (j + 1) * W + (i + 1);
        const y = h[k];
        const v = (j * VERTS + i) * 3;
        pos[v] = i * step;
        pos[v + 1] = y;
        pos[v + 2] = j * step;
        // Normal of y = f(x, z): (-df/dx, 1, -df/dz), normalised.
        const gx = (h[k + 1] - h[k - 1]) * inv, gz = (h[k + W] - h[k - W]) * inv;
        const l = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
        nor[v] = -gx * l;
        nor[v + 1] = l;
        nor[v + 2] = -gz * l;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const lap = (h[k + 1] + h[k - 1] + h[k + W] + h[k - W] - 4 * y) / (step * step);
        this.cbuf[j * VERTS + i] = Math.min(1, Math.max(0, -lap / CREST_CURVATURE));
      }
    }
    const crest = geo.attributes.crest.array as Float32Array;
    this.blurCrest(crest);
    // Skirts: copies of the edge vertices, dropped by more than the worst LOD mismatch.
    const drop = 0.5 + step * 1.2;
    const base = VERTS * VERTS;
    for (let e = 0; e < 4; e++) {
      for (let t = 0; t < VERTS; t++) {
        const src = e === 0 ? t : e === 1 ? CELLS * VERTS + t : e === 2 ? t * VERTS : t * VERTS + CELLS;
        const s = (base + e * VERTS + t) * 3, g = src * 3;
        pos[s] = pos[g];
        pos[s + 1] = pos[g + 1] - drop;
        pos[s + 2] = pos[g + 2];
        nor[s] = nor[g];
        nor[s + 1] = nor[g + 1];
        nor[s + 2] = nor[g + 2];
        crest[base + e * VERTS + t] = crest[src];
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.attributes.crest.needsUpdate = true;
    minY -= drop;
    const bb = (geo.boundingBox ??= new THREE.Box3());
    bb.min.set(0, minY, 0);
    bb.max.set(c.size, maxY, c.size);
    const bs = (geo.boundingSphere ??= new THREE.Sphere());
    bb.getBoundingSphere(bs);
    this.stats.builtThisFrame++;
    this.stats.totalBuilt++;
  }

  /** Separable box blur of cbuf (clamped at the chunk edge) into the first VERTS² entries of `out`. */
  private blurCrest(out: Float32Array) {
    const src = this.cbuf, tmp = this.cblur, R = CREST_BLUR, norm = 1 / (2 * R + 1);
    for (let pass = 0; pass < 2; pass++) {
      const from = pass === 0 ? src : tmp, to = pass === 0 ? tmp : out;
      for (let j = 0; j < VERTS; j++) {
        for (let i = 0; i < VERTS; i++) {
          let sum = 0;
          for (let d = -R; d <= R; d++) {
            const a = Math.min(VERTS - 1, Math.max(0, (pass === 0 ? i : j) + d));
            sum += pass === 0 ? from[j * VERTS + a] : from[a * VERTS + i];
          }
          // A short blur dilutes a sharp brink; boost it back so a real crest still reaches ~1.
          to[j * VERTS + i] = Math.min(1, sum * norm * (pass === 0 ? 1 : 1.8));
        }
      }
    }
  }

  /** Edit chunk (cx, cz) changed: mark the fine chunks that sample it for rebuilding. */
  private invalidate(cx: number, cz: number) {
    const span = EDIT_CHUNK * EDIT_CELL;
    // Include a margin: normals and bilinear sampling reach one cell beyond the chunk.
    const x0 = cx * span - 1, x1 = (cx + 1) * span + 1;
    const z0 = cz * span - 1, z1 = (cz + 1) * span + 1;
    for (let level = 0; level <= EDIT_LEVELS; level++) {
      const size = BASE_SIZE * (1 << level);
      for (let iz = Math.floor(z0 / size); iz <= Math.floor(z1 / size); iz++) {
        for (let ix = Math.floor(x0 / size); ix <= Math.floor(x1 / size); ix++) {
          const k = key(level, ix, iz);
          const c = this.cache.get(k);
          if (!c) continue;
          if (this.shown.has(k)) this.dirty.add(k);
          else this.drop(c); // stale and hidden: just forget it
        }
      }
    }
  }

  private chunkDist(c: Chunk, focus: THREE.Vector3) {
    const dx = Math.max(c.x0 - focus.x, 0, focus.x - (c.x0 + c.size));
    const dz = Math.max(c.z0 - focus.z, 0, focus.z - (c.z0 + c.size));
    return Math.hypot(dx, dz);
  }

  private drop(c: Chunk) {
    this.scene.remove(c.mesh);
    c.mesh.geometry.setIndex(null); // the index buffer is shared; don't let dispose() free it
    c.mesh.geometry.dispose();
    this.cache.delete(c.key);
    this.dirty.delete(c.key);
  }

  private evict() {
    if (this.cache.size <= CACHE_LIMIT) return;
    const old = [...this.cache.values()]
      .filter((c) => !this.shown.has(c.key) && c.lastUsed < this.frame)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (let i = 0; i < old.length && this.cache.size > CACHE_LIMIT * 0.8; i++) this.drop(old[i]);
  }
}
