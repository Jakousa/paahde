// Crash sites: crashed spacecraft half-buried in the dunes, with a trail of debris ploughed out behind
// them. Shared by server physics (collideCrash() in sim.ts step()), the server (later: parts to salvage)
// and the client (prediction, src/world/crashsites.ts rendering, smoke and src/crashSound.ts).
//
// Same determinism rules as shared/scrap.ts: integer hashing and exact IEEE operations only (+ - * /,
// Math.sqrt, Math.floor, Math.abs, Math.min/max). No trig: directions are rejection-sampled unit vectors,
// the renderer turns them into angles. The layout depends only on WORLD_SEED and baseHeight, so sites
// never move; piece heights follow the (possibly dug) ground at each piece's centre.
//
// The world is cut into CRASH_CELL squares; about DENSITY of them hold one site. A site is one main wreck
// (a CRASH_KINDS entry with main: true) plus DEBRIS_MIN..DEBRIS_MAX debris pieces strewn along the
// approach line behind it. Everything lies well inside its own cell (centre ≥ CELL_MARGIN from the edges,
// pieces within TRAIL + a few metres), so collision only looks at the player's cell.
//
// Piece frame: yaw turns model +Z (the nose) to (dx, dz) and model +X to (dz, -dx), like scrap. Each
// piece's origin sits at heightAt(x, z) − sink; capsule tops are origin + h.
import { BASE, BASE_SPAWN, padBlend } from './base.ts';
import { CRASH_KINDS, type CrashKind } from './crashKinds.ts';
import { SCRAP_CELL, scrapPieces } from './scrap.ts';
import { baseHeight, heightAt, WORLD_HALF, WORLD_SEED } from './terrain.ts';

/** Grid cell size (m); each cell holds at most one site. */
export const CRASH_CELL = 350;
/** Fraction of cells with a site. */
const DENSITY = 0.4;
/** Fraction of sites that still smoulder (smoke column, src/world/crashsites.ts). */
const SMOKE_CHANCE = 0.6;
/** A site's centre stays this far inside its cell, so the whole trail fits in the cell. */
const CELL_MARGIN = 75;
/** Debris lies up to this far behind the wreck's edge. */
const TRAIL = 48;
const DEBRIS_MIN = 3, DEBRIS_MAX = 8;
/** No sites this close to the base or the spawn point (m). */
const BASE_CLEAR = 220;
/** Keep pieces this far (beyond their radius) from any scrap piece. */
const SCRAP_CLEAR = 3;
/** Sites avoid ground steeper than this gradient² at the centre (normal.y < 0.9), like scrap piles. */
const MAX_GRAD2 = 1 / (0.9 * 0.9) - 1;
/** Capsules lower than this (m) above the sand get no hitbox: you walk over them. */
const MIN_HITBOX = 0.3;
/** How far beyond its radius you can still stand on a capsule's top. */
const STAND_MARGIN = 0.15;

const MAIN_KINDS = CRASH_KINDS.map((k, i) => (k.main ? i : -1)).filter((i) => i >= 0);
const DEBRIS_KINDS = CRASH_KINDS.map((k, i) => (k.main ? -1 : i)).filter((i) => i >= 0);

/** A vertical capsule in world xz: segment centre (x, z) ± half·(ax, az), radius r, top h above the piece origin. */
export type CrashHitbox = { x: number; z: number; ax: number; az: number; half: number; r: number; h: number };

export type CrashPiece = {
  /** Site id and index in the site (0 is the main wreck). */
  site: number; i: number;
  kind: number; x: number; z: number;
  /** World yaw vector: model +Z turns to (dx, dz). */
  dx: number; dz: number;
  /** How far (m) the origin is pushed into the sand. */
  sink: number;
  /** Bounding radius (m) around (x, z) of the hitboxes. */
  reach: number;
  hitboxes: CrashHitbox[];
};

export type CrashSite = {
  /** Stable id: crashSiteId(ix, iz). */
  id: number; ix: number; iz: number;
  /** Centre of the main wreck. */
  x: number; z: number;
  /** Unit direction the craft was travelling when it came down (the debris lies behind, at −dir). */
  dirX: number; dirZ: number;
  /** Still smouldering. */
  smoke: boolean;
  pieces: CrashPiece[];
  /** Smoke points in world xz plus height above the piece origin (only if smoke). */
  smokePoints: { piece: number; x: number; z: number; y: number }[];
  /** The main wreck's beacon (sound source / glow), world xz plus height above its origin. */
  beacon: { x: number; z: number; y: number };
  /** Bounding radius (m) of all pieces around the centre. */
  radius: number;
};

/** Ground height of a piece's origin (its model sits here). */
export function pieceY(pc: CrashPiece): number {
  return heightAt(pc.x, pc.z) - pc.sink;
}

/** World position of a site's beacon point, written into `out`. */
export function beaconPos(s: CrashSite, out: { x: number; y: number; z: number }) {
  out.x = s.beacon.x;
  out.z = s.beacon.z;
  out.y = pieceY(s.pieces[0]) + s.beacon.y;
  return out;
}

/** Deterministic PRNG seeded from a cell (integer hashing only). */
function rng(ix: number, iz: number) {
  let h = Math.imul(ix | 0, 0x2c1b3c6d) ^ Math.imul(iz | 0, 0x297a2d39) ^ Math.imul(WORLD_SEED, 0x9e3779b1) ^ 0xc4a5;
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random unit vector (rejection sampled), written into `out`. */
function unit(r: () => number, out: { u: number; v: number }) {
  for (let i = 0; i < 16; i++) {
    const u = 2 * r() - 1, v = 2 * r() - 1, q = u * u + v * v;
    if (q > 0.01 && q <= 1) {
      const l = Math.sqrt(q);
      out.u = u / l;
      out.v = v / l;
      return out;
    }
  }
  out.u = 1;
  out.v = 0;
  return out;
}

function flatEnough(x: number, z: number, radius: number): boolean {
  const e = 0.5;
  const gx = (baseHeight(x + e, z) - baseHeight(x - e, z)) / (2 * e);
  const gz = (baseHeight(x, z + e) - baseHeight(x, z - e)) / (2 * e);
  if (gx * gx + gz * gz >= MAX_GRAD2) return false;
  // The ground under the whole wreck: no crest or slip face running through it.
  const h0 = baseHeight(x, z), d = radius * 0.7;
  let lo = h0, hi = h0;
  for (const [ox, oz] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius], [d, d], [-d, d], [d, -d], [-d, -d]]) {
    const h = baseHeight(x + ox, z + oz);
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  return hi - lo < 0.2 * radius + 0.8;
}

/** True if a disc of `radius` at (x, z) comes within SCRAP_CLEAR of a scrap piece. */
function nearScrap(x: number, z: number, radius: number): boolean {
  const reach = radius + SCRAP_CLEAR + 1.5; // + a scrap piece's own size
  for (let iz = Math.floor((z - reach) / SCRAP_CELL); iz <= Math.floor((z + reach) / SCRAP_CELL); iz++) {
    for (let ix = Math.floor((x - reach) / SCRAP_CELL); ix <= Math.floor((x + reach) / SCRAP_CELL); ix++) {
      for (const pc of scrapPieces(ix, iz)) {
        const ex = pc.x - x, ez = pc.z - z;
        if (ex * ex + ez * ez < reach * reach) return true;
      }
    }
  }
  return false;
}

/** Stable id of the site in cell (ix, iz). */
export function crashSiteId(ix: number, iz: number): number {
  return (ix + 64) * 128 + (iz + 64);
}

const cache = new Map<number, CrashSite | null>();
const tmpU = { u: 0, v: 0 };

/** The site of cell (ix, iz) (covering [ix·CRASH_CELL, (ix+1)·CRASH_CELL) on each axis), or null. */
export function crashSiteAt(ix: number, iz: number): CrashSite | null {
  const id = crashSiteId(ix, iz);
  let s = cache.get(id);
  if (s === undefined) cache.set(id, (s = generate(ix, iz)));
  return s;
}

/** The site with this id, or undefined (ids may come from the network: this validates them). */
export function crashSite(id: number): CrashSite | undefined {
  if (!Number.isInteger(id) || id < 0) return undefined;
  const ix = Math.floor(id / 128) - 64, iz = (id % 128) - 64;
  if (Math.abs(ix * CRASH_CELL) > WORLD_HALF + CRASH_CELL || Math.abs(iz * CRASH_CELL) > WORLD_HALF + CRASH_CELL) return undefined;
  return crashSiteAt(ix, iz) ?? undefined;
}

/** Sites whose centre lies within r of (x, z), nearest first. */
export function crashSitesNear(x: number, z: number, r: number): CrashSite[] {
  const out: { s: CrashSite; d: number }[] = [];
  for (let iz = Math.floor((z - r) / CRASH_CELL); iz <= Math.floor((z + r) / CRASH_CELL); iz++) {
    for (let ix = Math.floor((x - r) / CRASH_CELL); ix <= Math.floor((x + r) / CRASH_CELL); ix++) {
      const s = crashSiteAt(ix, iz);
      if (!s) continue;
      const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
      if (d <= r * r) out.push({ s, d });
    }
  }
  return out.sort((a, b) => a.d - b.d).map((o) => o.s);
}

/** Every site in the world (for the server, debug maps). */
export function allCrashSites(): CrashSite[] {
  const out: CrashSite[] = [];
  const lo = Math.floor(-WORLD_HALF / CRASH_CELL), hi = Math.floor(WORLD_HALF / CRASH_CELL);
  for (let iz = lo; iz <= hi; iz++) for (let ix = lo; ix <= hi; ix++) {
    const s = crashSiteAt(ix, iz);
    if (s) out.push(s);
  }
  return out;
}

function generate(ix: number, iz: number): CrashSite | null {
  const r = rng(ix, iz);
  if (r() >= DENSITY || !MAIN_KINDS.length) return null;
  const kind = MAIN_KINDS[Math.floor(r() * MAIN_KINDS.length)];
  const K = CRASH_KINDS[kind];
  // A few candidate centres; keep the first on flat-enough open ground.
  let cx = 0, cz = 0, ok = false;
  const span = CRASH_CELL - 2 * CELL_MARGIN;
  for (let t = 0; t < 6 && !ok; t++) {
    cx = ix * CRASH_CELL + CELL_MARGIN + span * r();
    cz = iz * CRASH_CELL + CELL_MARGIN + span * r();
    const bx = cx - BASE.x, bz = cz - BASE.z, sx = cx - BASE_SPAWN.x, sz = cz - BASE_SPAWN.z;
    ok = Math.abs(cx) < WORLD_HALF - 30 && Math.abs(cz) < WORLD_HALF - 30 &&
      bx * bx + bz * bz > BASE_CLEAR * BASE_CLEAR && sx * sx + sz * sz > BASE_CLEAR * BASE_CLEAR &&
      padBlend(cx, cz) >= 1 && flatEnough(cx, cz, K.radius) && !nearScrap(cx, cz, K.radius);
  }
  if (!ok) return null;
  const id = crashSiteId(ix, iz);
  // Approach direction; the wreck slews off it a little as it ploughs to a stop.
  const dir = unit(r, tmpU);
  const tx = dir.u, tz = dir.v;
  const slew = (r() - 0.5) * 0.7;
  let mx = tx - tz * slew, mz = tz + tx * slew;
  const ml = Math.sqrt(mx * mx + mz * mz);
  mx /= ml;
  mz /= ml;
  const pieces: CrashPiece[] = [piece(id, 0, kind, cx, cz, mx, mz, 0.25 + 0.6 * r())];
  const n = DEBRIS_MIN + Math.floor(r() * (DEBRIS_MAX - DEBRIS_MIN + 1));
  for (let i = 0; i < n && DEBRIS_KINDS.length; i++) {
    const dk = DEBRIS_KINDS[Math.floor(r() * DEBRIS_KINDS.length)];
    const D = CRASH_KINDS[dk];
    // Mostly strewn along the ploughed trail behind the wreck, spreading out with distance; a few thrown
    // ahead or off to the side when it hit.
    let along: number, across: number;
    if (r() < 0.2) {
      along = -(K.radius + 2 + 10 * r());
      across = (r() * 2 - 1) * (K.radius + 6);
    } else {
      along = K.radius + 3 + TRAIL * r();
      across = (r() * 2 - 1) * (1.5 + 0.18 * along);
    }
    const x = cx - tx * along - tz * across, z = cz - tz * along + tx * across;
    const yaw = unit(r, tmpU);
    const yx = yaw.u, yz = yaw.v;
    const sink = 0.05 + 0.3 * r();
    if (nearScrap(x, z, D.radius)) continue;
    // Don't drop debris into the wreck or on another piece.
    let clash = false;
    for (const o of pieces) {
      const ox = o.x - x, oz = o.z - z, rr = CRASH_KINDS[o.kind].radius + D.radius + 0.5;
      if (ox * ox + oz * oz < rr * rr) clash = true;
    }
    if (!clash) pieces.push(piece(id, pieces.length, dk, x, z, yx, yz, sink));
  }
  const smoke = r() < SMOKE_CHANCE;
  const smokePoints: CrashSite['smokePoints'] = [];
  if (smoke) {
    // The wreck's own vents, plus the first debris piece that has one (a burning chunk in the trail).
    let extra = 1;
    for (const pc of pieces) {
      const pts = CRASH_KINDS[pc.kind].smoke;
      if (!pts.length || (pc.i > 0 && extra-- <= 0)) continue;
      for (const [lx, ly, lz] of pts) smokePoints.push({ piece: pc.i, x: pc.x + lx * pc.dz + lz * pc.dx, z: pc.z - lx * pc.dx + lz * pc.dz, y: ly });
    }
  }
  const [bx, by, bz] = K.beacon;
  const main = pieces[0];
  let radius = 0;
  for (const pc of pieces) {
    const d = Math.sqrt((pc.x - cx) * (pc.x - cx) + (pc.z - cz) * (pc.z - cz)) + pc.reach;
    if (d > radius) radius = d;
  }
  return {
    id, ix, iz, x: cx, z: cz, dirX: tx, dirZ: tz, smoke, pieces, smokePoints,
    beacon: { x: main.x + bx * main.dz + bz * main.dx, z: main.z - bx * main.dx + bz * main.dz, y: by }, radius,
  };
}

function piece(site: number, i: number, kind: number, x: number, z: number, dx: number, dz: number, sink: number): CrashPiece {
  const K: CrashKind = CRASH_KINDS[kind];
  const hitboxes: CrashHitbox[] = [];
  let reach = 0;
  for (const c of K.capsules) {
    if (c.h - sink < MIN_HITBOX) continue;
    // Model → world: local +X → (dz, -dx), local +Z → (dx, dz).
    const hx = x + c.x * dz + c.z * dx, hz = z - c.x * dx + c.z * dz;
    const ax = c.ax * dz + c.az * dx, az = -c.ax * dx + c.az * dz;
    hitboxes.push({ x: hx, z: hz, ax, az, half: c.half, r: c.r, h: c.h });
    const d = Math.sqrt((hx - x) * (hx - x) + (hz - z) * (hz - z)) + c.half + c.r;
    if (d > reach) reach = d;
  }
  return { site, i, kind, x, z, dx, dz, sink, reach: Math.max(reach, K.radius), hitboxes };
}

/**
 * Collide a player (circle of `radius` at feet height y; prevY is last tick's) with the crash site of
 * the cell it is in. Same rules as collideScrap: capsule tops within `stepUp` below the feet are ground
 * (returns the highest such top under the player, or -Infinity); taller ones are walls that push the
 * position out and remove the velocity into them, in place.
 */
export function collideCrash(p: { x: number; z: number; vx: number; vz: number }, y: number, prevY: number, radius: number, stepUp: number): number {
  const s = crashSiteAt(Math.floor(p.x / CRASH_CELL), Math.floor(p.z / CRASH_CELL));
  if (!s) return -Infinity;
  const sr = s.radius + radius;
  if (Math.abs(p.x - s.x) > sr || Math.abs(p.z - s.z) > sr) return -Infinity;
  let support = -Infinity;
  const feet = Math.max(y, prevY);
  for (const pc of s.pieces) {
    const pr = pc.reach + radius;
    if (!pc.hitboxes.length || Math.abs(p.x - pc.x) > pr || Math.abs(p.z - pc.z) > pr) continue;
    const base = pieceY(pc);
    for (const b of pc.hitboxes) {
      const reach = b.half + b.r + radius;
      if (Math.abs(p.x - b.x) > reach || Math.abs(p.z - b.z) > reach) continue;
      let t = (p.x - b.x) * b.ax + (p.z - b.z) * b.az;
      t = t < -b.half ? -b.half : t > b.half ? b.half : t;
      const qx = b.x + b.ax * t, qz = b.z + b.az * t;
      let ex = p.x - qx, ez = p.z - qz;
      const d = Math.sqrt(ex * ex + ez * ez);
      const top = base + b.h;
      if (feet >= top - stepUp) {
        if (d < b.r + STAND_MARGIN && top > support) support = top;
        continue;
      }
      const R = b.r + radius;
      if (d >= R) continue;
      if (d > 1e-9) { ex /= d; ez /= d; } else { ex = b.az; ez = -b.ax; }
      p.x = qx + ex * R;
      p.z = qz + ez * R;
      const vn = p.vx * ex + p.vz * ez;
      if (vn < 0) { p.vx -= vn * ex; p.vz -= vn * ez; }
    }
  }
  return support;
}
