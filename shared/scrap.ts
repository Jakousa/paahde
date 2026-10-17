// Scrap piles: where the junkyard props lie, and their hitboxes. Shared by server physics (step() in
// sim.ts) and the client (prediction + rendering in src/world/scrap.ts), so the layout must be identical
// on every JS engine: integer hashing and exact IEEE operations only (+ - * /, Math.sqrt, Math.floor,
// Math.abs, Math.min/max). No trig — directions come from rejection-sampled unit vectors; the renderer
// turns them into angles. The layout depends only on WORLD_SEED and baseHeight (not on dug sand), so
// piles never move; their heights follow the edited ground at their centre.
//
// The world is cut into CELL-sized squares; a pile and all its pieces lie well inside its own cell
// (centre ≥ 0.1·CELL from the edges, pieces within PILE_RADIUS + ~1.5 m), so collision only has to look
// at the cell the player is in.
//
// Pieces can be picked up (server/scrap.ts): taken pieces are in `scrapTaken`, keyed by scrapKey(), and
// have no hitbox until they respawn.
//
// Hitboxes are vertical capsules: a segment in xz (centre ± half·axis) swept by radius r, from the
// ground up to h metres above it. Pieces lower than MIN_HITBOX are walked over.
import { EYE_HEIGHT, pitchFromQ } from './dig.ts';
import { yawFromQ } from './sim.ts';
import { BASE_SPAWN, padBlend } from './base.ts';
import { rocksNear } from './rocks.ts';
import { baseHeight, heightAt, WORLD_HALF, WORLD_SEED } from './terrain.ts';

/** Grid cell size (m); each cell holds at most one pile. */
export const SCRAP_CELL = 90;
/** Fraction of cells that hold a pile. */
const DENSITY = 0.45;
/** Piles avoid ground steeper than this gradient² (normal.y < 0.9); slip faces are ~32°. */
const MAX_GRAD2 = 1 / (0.9 * 0.9) - 1;
const PIECES_MIN = 3, PIECES_MAX = 8;
const PILE_RADIUS = 6;
/** Pieces lower than this (m) get no hitbox: you walk over them. */
const MIN_HITBOX = 0.3;
/** How far beyond its radius you can still stand on a piece's top. */
const STAND_MARGIN = 0.15;

export type ScrapPose = 'flat' | 'upright' | 'side' | 'stuck';

/**
 * Prop kinds: glTF node name (as authored; GLTFLoader sanitizes them), inventory label, scale to real size,
 * half extents after scaling (x, y, z; Y up, measured from public/models/junkyard_props.glb), and how they tend to lie.
 */
export const SCRAP_KINDS: { node: string; label: string; scale: number; half: [number, number, number]; weight: number; poses: [ScrapPose, number][] }[] = [
  { node: 'Barrel v1 ', label: 'Oil drum', scale: 0.28, half: [0.294, 0.44, 0.293], weight: 3, poses: [['upright', 0.5], ['side', 0.4], ['stuck', 0.1]] },
  { node: 'Barrel v2.001', label: 'Rusty drum', scale: 0.28, half: [0.293, 0.451, 0.291], weight: 2, poses: [['upright', 0.4], ['side', 0.5], ['stuck', 0.1]] },
  { node: 'Gear v1.001', label: 'Gear', scale: 0.35, half: [0.39, 0.04, 0.39], weight: 1.5, poses: [['flat', 0.6], ['stuck', 0.4]] },
  { node: 'Metal peice 2 v1.001', label: 'Scrap frame', scale: 0.45, half: [0.644, 0.036, 0.909], weight: 2, poses: [['flat', 0.5], ['stuck', 0.5]] },
  { node: 'Metal peice 2 v2.001', label: 'Bent frame', scale: 0.45, half: [0.655, 0.158, 0.905], weight: 2, poses: [['flat', 0.5], ['stuck', 0.5]] },
  { node: 'Metal plank v1.001', label: 'Metal plank', scale: 0.35, half: [1.423, 0.124, 0.082], weight: 2, poses: [['flat', 0.6], ['stuck', 0.4]] },
  { node: 'Metal sheet v1.001', label: 'Metal sheet', scale: 0.75, half: [0.75, 0.015, 0.75], weight: 2, poses: [['flat', 0.6], ['stuck', 0.4]] },
  { node: 'Metal sheet v2.001', label: 'Dented sheet', scale: 0.75, half: [0.765, 0.146, 0.75], weight: 2, poses: [['flat', 0.6], ['stuck', 0.4]] },
  { node: 'Metal spring v1.001', label: 'Spring', scale: 0.3, half: [0.708, 0.234, 0.236], weight: 1, poses: [['flat', 1]] },
];
const TOTAL_WEIGHT = SCRAP_KINDS.reduce((s, k) => s + k.weight, 0);

/** Vertical capsule hitbox; h is the top's height above the ground at (x, z). */
export type ScrapHitbox = { ax: number; az: number; half: number; r: number; h: number };

/**
 * One prop. Orientation, in the ground's frame: yaw turns local +Z to (dx, dz) (local +X to (dz, -dx)),
 * then a tilt about local X with cosine tc and sine ts, then a small visual roll about local Z (radians).
 * `sink` is the fraction of its support depth pushed into the sand.
 */
export type ScrapPiece = {
  /** Unique id: scrapKey(cell ix, cell iz, index in the cell). */
  key: string; ix: number; iz: number; i: number;
  kind: number; pose: ScrapPose; x: number; z: number; dx: number; dz: number;
  tc: number; ts: number; roll: number; sink: number; scale: number; hitbox: ScrapHitbox | null;
};

/** Deterministic PRNG seeded from a cell (integer hashing only). */
function rng(ix: number, iz: number) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(WORLD_SEED, 0x9e3779b1) ^ 0x5c4a9;
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A point in the unit disc (rejection sampled), written into `out`. */
function disc(r: () => number, out: { u: number; v: number }) {
  for (let i = 0; i < 16; i++) {
    out.u = 2 * r() - 1;
    out.v = 2 * r() - 1;
    if (out.u * out.u + out.v * out.v <= 1) return out;
  }
  out.u = out.v = 0;
  return out;
}
const tmpDisc = { u: 0, v: 0 };

function flatEnough(x: number, z: number): boolean {
  const e = 0.5;
  const gx = (baseHeight(x + e, z) - baseHeight(x - e, z)) / (2 * e);
  const gz = (baseHeight(x, z + e) - baseHeight(x, z - e)) / (2 * e);
  return gx * gx + gz * gz < MAX_GRAD2;
}

const SPAWN_IX = Math.floor(BASE_SPAWN.x / SCRAP_CELL), SPAWN_IZ = Math.floor(BASE_SPAWN.z / SCRAP_CELL);
const cache = new Map<string, ScrapPiece[]>();
const NONE: ScrapPiece[] = [];

/** The props of cell (ix, iz), cell (ix, iz) covering [ix·SCRAP_CELL, (ix+1)·SCRAP_CELL) on each axis. */
export function scrapPieces(ix: number, iz: number): ScrapPiece[] {
  const k = `${ix},${iz}`;
  let list = cache.get(k);
  if (!list) cache.set(k, (list = generate(ix, iz)));
  return list;
}

function generate(ix: number, iz: number): ScrapPiece[] {
  const r = rng(ix, iz);
  // The spawn cell always gets one, so new players see scrap straight away.
  if (r() >= DENSITY && !(ix === SPAWN_IX && iz === SPAWN_IZ)) return NONE;
  // A few candidate centres; keep the first on reasonably flat ground (no piles on slip faces).
  let px = 0, pz = 0, ok = false;
  for (let t = 0; t < 4 && !ok; t++) {
    px = (ix + 0.1 + 0.8 * r()) * SCRAP_CELL;
    pz = (iz + 0.1 + 0.8 * r()) * SCRAP_CELL;
    ok = Math.abs(px) < WORLD_HALF - 10 && Math.abs(pz) < WORLD_HALF - 10 && flatEnough(px, pz) && padBlend(px, pz) > 0.3 && !rocksNear(px, pz, PILE_RADIUS + 2);
  }
  if (!ok) return NONE;
  const out: ScrapPiece[] = [];
  const n = PIECES_MIN + Math.floor(r() * (PIECES_MAX - PIECES_MIN + 1));
  for (let i = 0; i < n; i++) {
    // Pieces bunch towards the middle of the pile.
    const p = disc(r, tmpDisc), d = PILE_RADIUS * (0.4 + 0.6 * r());
    out.push(piece(ix, iz, i, px + p.u * d, pz + p.v * d, r));
  }
  return out;
}

function piece(ix: number, iz: number, i: number, x: number, z: number, r: () => number): ScrapPiece {
  let w = r() * TOTAL_WEIGHT, kind = 0;
  while (kind < SCRAP_KINDS.length - 1 && (w -= SCRAP_KINDS[kind].weight) >= 0) kind++;
  const K = SCRAP_KINDS[kind];
  let pr = r(), pose = K.poses[K.poses.length - 1][0];
  for (const [p, pw] of K.poses) if ((pr -= pw) < 0) { pose = p; break; }
  // Yaw as a unit vector.
  let dx = 1, dz = 0;
  for (let i = 0; i < 16; i++) {
    const u = 2 * r() - 1, v = 2 * r() - 1, q = u * u + v * v;
    if (q > 0.01 && q <= 1) { const l = Math.sqrt(q); dx = u / l; dz = v / l; break; }
  }
  let ts: number, sink: number;
  switch (pose) {
    case 'upright': ts = (r() - 0.5) * 0.15; sink = 0.05 + 0.1 * r(); break;
    case 'side': ts = 1; sink = 0.15 + 0.25 * r(); break;
    case 'stuck': ts = 0.48 + r() * 0.48; sink = 0.3 + 0.35 * r(); break; // ~29°–74° tilt
    default: ts = (r() - 0.5) * 0.25; sink = 0.1 + 0.4 * r(); break;
  }
  const tc = Math.sqrt(1 - ts * ts);
  const roll = (r() - 0.5) * (pose === 'stuck' ? 0.6 : pose === 'side' ? 0 : 0.2);
  const scale = 0.85 + 0.3 * r();
  return { key: scrapKey(ix, iz, i), ix, iz, i, kind, pose, x, z, dx, dz, tc, ts, roll, sink, scale, hitbox: hitbox(K.half, pose, dx, dz, tc, ts, sink, scale) };
}

function hitbox(half: [number, number, number], pose: ScrapPose, dx: number, dz: number, tc: number, ts: number, sink: number, s: number): ScrapHitbox | null {
  const [hx, hy, hz] = half;
  // Extents of the tilted box: vertical, along local X (unchanged by the tilt) and along (dx, dz).
  // Small tilts (flat/upright) are ignored. The buried part is not part of the hitbox.
  let up: number, ex: number, ez: number;
  if (pose === 'flat' || pose === 'upright') { up = hy; ex = hx; ez = hz; }
  else { up = tc * hy + ts * hz; ex = hx; ez = ts * hy + tc * hz; }
  const vis = 1 - sink / 2; // centre sits depth·(1 − sink) up, so the top is 2·depth·(1 − sink/2) up
  const h = 2 * up * s * vis;
  if (h < MIN_HITBOX) return null;
  if (pose === 'stuck') ez *= vis; // its footprint along the lean is partly under the sand
  ex *= s;
  ez *= s;
  // Capsule along the longer horizontal axis.
  return ex >= ez ? { ax: dz, az: -dx, half: ex - ez, r: ez, h } : { ax: dx, az: dz, half: ez - ex, r: ex, h };
}

/**
 * Collide a player (circle of `radius` at feet height y; prevY is last tick's) with the scrap around it.
 * Pieces whose top is within `stepUp` below the feet are ground: returns the highest such top under the
 * player (or -Infinity). Taller pieces are walls: the position is pushed out of them and the velocity
 * into them removed, in place.
 */
export function collideScrap(p: { x: number; z: number; vx: number; vz: number }, y: number, prevY: number, radius: number, stepUp: number): number {
  const pieces = scrapPieces(Math.floor(p.x / SCRAP_CELL), Math.floor(p.z / SCRAP_CELL));
  let support = -Infinity;
  const feet = Math.max(y, prevY);
  for (const pc of pieces) {
    const b = pc.hitbox;
    if (!b || scrapTaken.has(pc.key)) continue;
    const reach = b.half + b.r + radius;
    if (Math.abs(p.x - pc.x) > reach || Math.abs(p.z - pc.z) > reach) continue;
    // Closest point on the capsule's segment.
    let t = (p.x - pc.x) * b.ax + (p.z - pc.z) * b.az;
    t = t < -b.half ? -b.half : t > b.half ? b.half : t;
    const qx = pc.x + b.ax * t, qz = pc.z + b.az * t;
    let ex = p.x - qx, ez = p.z - qz;
    const d = Math.sqrt(ex * ex + ez * ez);
    const top = heightAt(pc.x, pc.z) + b.h;
    if (feet >= top - stepUp) {
      if (d < b.r + STAND_MARGIN && top > support) support = top;
      continue;
    }
    const R = b.r + radius;
    if (d >= R) continue;
    if (d > 1e-9) { ex /= d; ez /= d; } else { ex = b.az; ez = -b.ax; } // dead centre: out sideways
    p.x = qx + ex * R;
    p.z = qz + ez * R;
    const vn = p.vx * ex + p.vz * ez;
    if (vn < 0) { p.vx -= vn * ex; p.vz -= vn * ez; }
  }
  return support;
}

/** Id of piece i in cell (ix, iz). */
export function scrapKey(ix: number, iz: number, i: number): string {
  return `${ix},${iz},${i}`;
}

/** The piece with this id, if it exists (ids come from the network: validate them with this). */
export function scrapPiece(ix: number, iz: number, i: number): ScrapPiece | undefined {
  if (!Number.isInteger(ix) || !Number.isInteger(iz) || !Number.isInteger(i)) return undefined;
  if (Math.abs(ix * SCRAP_CELL) > WORLD_HALF + SCRAP_CELL || Math.abs(iz * SCRAP_CELL) > WORLD_HALF + SCRAP_CELL) return undefined;
  return scrapPieces(ix, iz)[i];
}

/** Picked-up pieces (keys), mirrored from the server. Call scrapChanged() after changing it. */
export const scrapTaken = new Set<string>();
/** Listeners for scrapTaken changes (e.g. the renderer rebuilding its instances). */
export const scrapListeners: (() => void)[] = [];
export function scrapChanged() {
  for (const f of scrapListeners) f();
}

/** How far from the eye a piece can be picked up, metres. */
export const PICKUP_REACH = 3.5;

/** Centre height above the ground and radius of a piece's pickup sphere. */
function pickSphere(pc: ScrapPiece): [number, number] {
  const [hx, hy, hz] = SCRAP_KINDS[pc.kind].half;
  const r = Math.max(hx, hy, hz) * pc.scale;
  return [pc.hitbox ? pc.hitbox.h / 2 : 0.1, pc.hitbox ? Math.max(pc.hitbox.r + pc.hitbox.half, pc.hitbox.h / 2) : r * 0.8];
}

/**
 * The piece the player is looking at (nearest pickup sphere hit by the look ray within PICKUP_REACH),
 * or null. Same eye and look ray as digging (shared/dig.ts).
 */
export function scrapTarget(feet: { x: number; y: number; z: number }, yawQ: number, pitchQ: number): ScrapPiece | null {
  const yaw = yawFromQ(yawQ), pitch = pitchFromQ(pitchQ);
  const cp = Math.cos(pitch);
  const dx = -Math.sin(yaw) * cp, dy = Math.sin(pitch), dz = -Math.cos(yaw) * cp;
  const ex = feet.x, ey = feet.y + EYE_HEIGHT, ez = feet.z;
  let best: ScrapPiece | null = null, bestT = Infinity;
  const r = PICKUP_REACH + 2;
  for (let iz = Math.floor((ez - r) / SCRAP_CELL); iz <= Math.floor((ez + r) / SCRAP_CELL); iz++) {
    for (let ix = Math.floor((ex - r) / SCRAP_CELL); ix <= Math.floor((ex + r) / SCRAP_CELL); ix++) {
      for (const pc of scrapPieces(ix, iz)) {
        if (scrapTaken.has(pc.key) || Math.abs(pc.x - ex) > r || Math.abs(pc.z - ez) > r) continue;
        const [cy, rad] = pickSphere(pc);
        // Ray vs sphere: closest approach along the ray.
        const ox = pc.x - ex, oy = heightAt(pc.x, pc.z) + cy - ey, oz = pc.z - ez;
        const t = ox * dx + oy * dy + oz * dz;
        const d2 = ox * ox + oy * oy + oz * oz - t * t;
        if (d2 > rad * rad) continue;
        const hit = t - Math.sqrt(rad * rad - d2); // entry point (negative: the eye is inside)
        if (hit > PICKUP_REACH || t < 0) continue;
        if (hit < bestT) { bestT = hit; best = pc; }
      }
    }
  }
  return best;
}

/** Distance from the eye to a piece's pickup sphere (0 inside it). For server-side reach checks. */
export function scrapReach(feet: { x: number; y: number; z: number }, pc: ScrapPiece): number {
  const [cy, rad] = pickSphere(pc);
  const d = Math.hypot(pc.x - feet.x, heightAt(pc.x, pc.z) + cy - (feet.y + EYE_HEIGHT), pc.z - feet.z);
  return Math.max(0, d - rad);
}
