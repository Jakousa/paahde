// Crash sites: crashed spacecraft half-buried in the dunes, with a trail of debris ploughed out behind
// them, and the machines thrown out of them that players take apart (`machines`; shared/crash.ts turns them
// into machine sites). Shared by server physics (collideCrash() in sim.ts step()), the server and the client
// (prediction, src/world/crashsites.ts rendering, smoke and src/crashSound.ts).
//
// Same determinism rules as shared/scrap.ts: integer hashing and exact IEEE operations only (+ - * /,
// Math.sqrt, Math.floor, Math.abs, Math.min/max). No trig: directions are rejection-sampled unit vectors,
// the renderer turns them into angles. The layout depends only on WORLD_SEED and baseHeight, so sites
// never move; piece heights follow the (possibly dug) ground at each piece's centre.
//
// The world is cut into CRASH_CELL squares; about DENSITY of them hold one site (more around the base, see SiteLevel). A site is one main wreck
// (a CRASH_KINDS entry with main: true) plus DEBRIS_MIN..DEBRIS_MAX debris pieces strewn along the
// approach line behind it, one large machine thrown clear of the wreck and 0–2 small ones among the debris
// (a scrap field near the base: no large machine, 2–3 small ones; see SiteLevel)
// (each on a ground-dressing piece: CRASH_KINDS entries with dressing: true). Everything lies well inside its own cell (centre ≥ CELL_MARGIN from the edges,
// pieces within TRAIL + a few metres), so collision only looks at the player's cell.
//
// Debris can be picked up (server/crash.ts, like the salvage wrecks): a piece carried off is in `crashTaken`, keyed
// by its `id`, and has no hitbox until it lies there again.
//
// Piece frame: yaw turns model +Z (the nose) to (dx, dz) and model +X to (dz, -dx), like scrap. Each
// piece's origin sits at heightAt(x, z) − sink; capsule tops are origin + h.
import { BASE, BASE_SPAWN, padBlend } from './base.ts';
import { CRASH_KINDS, type CrashKind } from './crashKinds.ts';
import { shelterWithin } from './shelters.ts';
import { EYE_HEIGHT, pitchFromQ } from './dig.ts';
import { rocksNear } from './rocks.ts';
import { SCRAP_CELL, scrapPieces } from './scrap.ts';
import { yawFromQ } from './sim.ts';
import { cellId, cellOf } from './cells.ts';
import { LAB } from './world.ts';
import { baseHeight, CORE_HALF, heightAt, WORLD_SEED } from './terrain.ts';

/** Grid cell size (m); each cell holds at most one site. */
export const CRASH_CELL = 350;
/** Fraction of cells with a site, by the level of the cell's centre (siteLevel): sites are rare out in the desert, but
 *  the scrap fields around the base are common enough that every new player finds their starter machines. */
const DENSITY = [0.4, 0.14, 0.14];
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

/** Main wreck and debris kinds by whether the site is a scrap field (CrashKind.field: older, smaller, more mundane junk). */
const kindsWhere = (f: (k: CrashKind) => boolean) => CRASH_KINDS.map((k, i) => (f(k) ? i : -1)).filter((i) => i >= 0);
const MAIN_KINDS = [kindsWhere((k) => k.main && !k.field), kindsWhere((k) => k.main && k.field)];
const DEBRIS_KINDS = [kindsWhere((k) => !k.main && !k.dressing && !k.field), kindsWhere((k) => !k.main && !k.dressing && k.field)];
/** How a scrap field's debris lies (they vary much more than the crashes): along the trail like a crash, heaped around
 *  the wreck, scattered wide, or spilled out in a fan ahead of it. Scrap fields also hold more of it. */
const FIELD_STYLES = ['trail', 'heap', 'scatter', 'spill'] as const;
const FIELD_DEBRIS_MIN = 6, FIELD_DEBRIS_MAX = 14;
/** Ground dressing under the large machine and the small ones (tools/blender/crashsites.py). */
const CRADLE = CRASH_KINDS.findIndex((k) => k.node === 'Crash_Cradle');
const SKID = CRASH_KINDS.findIndex((k) => k.node === 'Crash_Skid');
/** Players stand this far from a machine's centre to work on it (src/teardown STAND 3.2) plus their radius and a
 *  little: the large machine keeps this much open ground around it, clear of every tall hitbox. */
const WALK_RING = 4.2;
/** How far beyond a capsule's radius a machine's centre stays from any wreck or debris shape (visual overlap). */
const SMALL_CLEAR = 2.0;
/** The cradle the large machine fell out of lies this far behind it (towards the wreck). */
const CRADLE_BACK = 4.5;
/** Most small machines per site (scrap fields: SCRAP_SMALL, and no large one). */
const SMALL_MAX = 2;
const SCRAP_SMALL = [2, 3];

/**
 * How far into the game a site is, by its distance from the base (LEVEL_R; a site goes by its cell's centre): 0 a scrap field (no walkers: small
 * starter machines to carry home, the broken gear a new player repairs first), 1 crawler ground (crawlers, the
 * motorcycle and the other advanced gear), 2 guardian ground (the giant guardians and night drones roam only these,
 * and their machines hold the rarest parts). shared/crash.ts picks the machines, server/loot.ts the finds,
 * server/guardians.ts the walkers by it.
 */
export type SiteLevel = 0 | 1 | 2;
export const LEVEL_R = [950, 1650];
export function siteLevel(x: number, z: number): SiteLevel {
  const d = Math.sqrt((x - BASE.x) * (x - BASE.x) + (z - BASE.z) * (z - BASE.z));
  return d < LEVEL_R[0] ? 0 : d < LEVEL_R[1] ? 1 : 2;
}

/** A vertical capsule in world xz: segment centre (x, z) ± half·(ax, az), radius r, top h above the piece origin. */
export type CrashHitbox = { x: number; z: number; ax: number; az: number; half: number; r: number; h: number };

export type CrashPiece = {
  /** Site id and index in the site (0 is the main wreck). */
  site: number; i: number;
  /** Debris only (it can be picked up): debrisId(site, i). Null for the main wreck and dressing. */
  id: string | null;
  kind: number; x: number; z: number;
  /** World yaw vector: model +Z turns to (dx, dz). */
  dx: number; dz: number;
  /** How far (m) the origin is pushed into the sand. */
  sink: number;
  /** Bounding radius (m) around (x, z) of the hitboxes. */
  reach: number;
  hitboxes: CrashHitbox[];
};

/** A machine lying at a site: centre, the direction it was thrown in (its dressing piece's +Z, see CrashPiece),
 *  large (taken apart on the spot) or small (carried home), and a seed for its kind and contents. */
export type CrashMachine = { x: number; z: number; dx: number; dz: number; large: boolean; seed: number };

export type CrashSite = {
  /** Stable id: crashSiteId(ix, iz). */
  id: number; ix: number; iz: number;
  /** How dangerous and rich it is (siteLevel). */
  level: SiteLevel;
  /** Centre of the main wreck. */
  x: number; z: number;
  /** Unit direction the craft was travelling when it came down (the debris lies behind, at −dir). */
  dirX: number; dirZ: number;
  pieces: CrashPiece[];
  /** Machines lying here to take apart: [0] is the large one, then 0–2 small ones (shared/crash.ts); a scrap field
   *  (level 0) has no large one, only SCRAP_SMALL small ones. */
  machines: CrashMachine[];
  /** Smoke points in world xz plus height above the piece origin. Every site smoulders until its large machine
   *  has been stripped (spent, shared/crash.ts `crashSpent`). */
  smokePoints: { piece: number; x: number; z: number; y: number }[];
  /** The main wreck's beacon (sound source / glow), world xz plus height above its origin. */
  beacon: { x: number; z: number; y: number };
  /** Bounding radius (m) of all pieces around the centre. */
  radius: number;
};

/** Machines (shared/crash.ts), salvage wrecks (shared/wrecks.ts) and debris pieces (`CrashPiece.id`) that have been
 *  carried off, by id; kept in step with the server ('crash' messages). Call crashChanged() (shared/crash.ts) after changing it. */
export const crashTaken = new Set<string>();

/** Id of debris piece i of site `site`. Never clashes with machine ("<site>:<i>") or wreck ("w:...") ids. */
export const debrisId = (site: number, i: number) => `d:${site}:${i}`;

/** The debris piece with this id, or null. Ids may come from the network: this validates them. */
export function debrisById(id: unknown): CrashPiece | null {
  if (typeof id !== 'string') return null;
  const m = /^d:(\d{1,16}):(\d{1,2})$/.exec(id);
  const pc = m ? crashSite(Number(m[1]))?.pieces[Number(m[2])] : undefined;
  return pc && pc.id === id ? pc : null;
}

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

/** Deterministic PRNG seeded from a cell (integer hashing only); `salt` gives an independent stream. */
function rng(ix: number, iz: number, salt = 0xc4a5) {
  let h = Math.imul(ix | 0, 0x2c1b3c6d) ^ Math.imul(iz | 0, 0x297a2d39) ^ Math.imul(WORLD_SEED, 0x9e3779b1) ^ salt;
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

/** True if a disc of `radius` at (x, z) comes within SCRAP_CLEAR of a scrap piece, or reaches a rock. */
function nearScrap(x: number, z: number, radius: number): boolean {
  if (rocksNear(x, z, radius + 1)) return true;
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
  return cellId(ix, iz);
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
  const c = cellOf(id);
  return c ? crashSiteAt(c.ix, c.iz) ?? undefined : undefined;
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

/** Every site in the core square (terrain.ts CORE_HALF: where the server lays out finds and giant guardians; debug maps). */
export function coreCrashSites(): CrashSite[] {
  const out: CrashSite[] = [];
  const lo = Math.floor(-CORE_HALF / CRASH_CELL), hi = Math.floor(CORE_HALF / CRASH_CELL);
  for (let iz = lo; iz <= hi; iz++) for (let ix = lo; ix <= hi; ix++) {
    const s = crashSiteAt(ix, iz);
    if (s) out.push(s);
  }
  return out;
}

function generate(ix: number, iz: number): CrashSite | null {
  if (LAB) return null; // the dev test lab (shared/lab.ts) has its own machine sites
  const r = rng(ix, iz);
  // The level goes by the cell's centre, so it is known before the site is placed.
  const level = siteLevel((ix + 0.5) * CRASH_CELL, (iz + 0.5) * CRASH_CELL);
  const field = level === 0 && MAIN_KINDS[1].length ? 1 : 0;
  if (r() >= DENSITY[level] || !MAIN_KINDS[field].length) return null;
  const kind = MAIN_KINDS[field][Math.floor(r() * MAIN_KINDS[field].length)];
  const K = CRASH_KINDS[kind];
  // A few candidate centres; keep the first on flat-enough open ground.
  let cx = 0, cz = 0, ok = false;
  const span = CRASH_CELL - 2 * CELL_MARGIN;
  for (let t = 0; t < 6 && !ok; t++) {
    cx = ix * CRASH_CELL + CELL_MARGIN + span * r();
    cz = iz * CRASH_CELL + CELL_MARGIN + span * r();
    const bx = cx - BASE.x, bz = cz - BASE.z, sx = cx - BASE_SPAWN.x, sz = cz - BASE_SPAWN.z;
    ok = bx * bx + bz * bz > BASE_CLEAR * BASE_CLEAR && sx * sx + sz * sz > BASE_CLEAR * BASE_CLEAR &&
      padBlend(cx, cz) >= 1 && flatEnough(cx, cz, K.radius) && !nearScrap(cx, cz, K.radius) && !shelterWithin(cx, cz, K.radius);
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
  const debrisKinds = DEBRIS_KINDS[field].length ? DEBRIS_KINDS[field] : DEBRIS_KINDS[0];
  const style = field ? FIELD_STYLES[Math.floor(r() * FIELD_STYLES.length)] : 'trail';
  const n = field ? FIELD_DEBRIS_MIN + Math.floor(r() * (FIELD_DEBRIS_MAX - FIELD_DEBRIS_MIN + 1)) : DEBRIS_MIN + Math.floor(r() * (DEBRIS_MAX - DEBRIS_MIN + 1));
  for (let i = 0; i < n && debrisKinds.length; i++) {
    const dk = debrisKinds[Math.floor(r() * debrisKinds.length)];
    const D = CRASH_KINDS[dk];
    // Mostly strewn along the ploughed trail behind the wreck, spreading out with distance; a few thrown
    // ahead or off to the side when it hit. Scrap fields: by their style.
    let along: number, across: number;
    if (style === 'heap' || style === 'scatter') {
      // All round the wreck: close in a heap, or wide over the field.
      const u = unit(r, tmpU), d = style === 'heap' ? K.radius + 1 + 9 * r() : K.radius + 4 + 38 * r();
      along = u.u * d;
      across = u.v * d;
    } else if (style === 'spill') {
      // Out of the front in a fan that widens with distance.
      along = -(K.radius + 1.5 + 30 * r());
      across = (r() * 2 - 1) * (2 - 0.5 * along);
    } else if (r() < 0.2) {
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
  const machines = placeMachines(ix, iz, id, pieces, cx, cz, tx, tz, level);
  const smokePoints: CrashSite['smokePoints'] = [];
  // The wreck's own vents, plus the first other piece that has one (the scorched ground by the large machine).
  let extra = 1;
  for (const pc of pieces) {
    const pts = CRASH_KINDS[pc.kind].smoke;
    if (!pts.length || (pc.i > 0 && extra-- <= 0)) continue;
    for (const [lx, ly, lz] of pts) smokePoints.push({ piece: pc.i, x: pc.x + lx * pc.dz + lz * pc.dx, z: pc.z - lx * pc.dx + lz * pc.dz, y: ly });
  }
  const [bx, by, bz] = K.beacon;
  const main = pieces[0];
  let radius = 0;
  for (const pc of pieces) {
    const d = Math.sqrt((pc.x - cx) * (pc.x - cx) + (pc.z - cz) * (pc.z - cz)) + pc.reach;
    if (d > radius) radius = d;
  }
  return {
    id, ix, iz, level, x: cx, z: cz, dirX: tx, dirZ: tz, pieces, machines, smokePoints,
    beacon: { x: main.x + bx * main.dz + bz * main.dx, z: main.z - bx * main.dx + bz * main.dz, y: by }, radius,
  };
}

/** Distance from (x, z) to the nearest capsule surface of any piece (all of each kind's capsules, low ones too),
 *  counting a tall one (a hitbox) only when `tall` is set. */
function clearance(pieces: CrashPiece[], x: number, z: number, tall: boolean): number {
  let best = Infinity;
  for (const pc of pieces) {
    const K = CRASH_KINDS[pc.kind];
    if (K.dressing) continue;
    for (const c of K.capsules) {
      if (tall && c.h - pc.sink < MIN_HITBOX) continue;
      const hx = pc.x + c.x * pc.dz + c.z * pc.dx, hz = pc.z - c.x * pc.dx + c.z * pc.dz;
      const ax = c.ax * pc.dz + c.az * pc.dx, az = -c.ax * pc.dx + c.az * pc.dz;
      let t = (x - hx) * ax + (z - hz) * az;
      t = t < -c.half ? -c.half : t > c.half ? c.half : t;
      const ex = x - hx - ax * t, ez = z - hz - az * t;
      const d = Math.sqrt(ex * ex + ez * ez) - c.r;
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * The machines at a site (an rng stream of their own, so the wreck layout above never changes because of them),
 * with a dressing piece under each, appended to `pieces`. The large one lies thrown clear of the main wreck, with
 * WALK_RING of open ground around it and its cradle behind it, towards the wreck; if no spot passes, the one with
 * the most room is used, so every site but a scrap field (level 0) has one. Small ones lie beside debris pieces in
 * the trail.
 */
function placeMachines(ix: number, iz: number, id: number, pieces: CrashPiece[], cx: number, cz: number, tx: number, tz: number,
  level: SiteLevel): CrashMachine[] {
  const r = rng(ix, iz, 0x51ed);
  const K = CRASH_KINDS[pieces[0].kind];
  const out: CrashMachine[] = [];
  if (level > 0) placeLarge(r, K.radius, id, pieces, cx, cz, tx, tz, out);
  // Small machines beside trail debris, tumbled along the direction of travel.
  const want = level === 0 ? SCRAP_SMALL[0] + Math.floor(r() * (SCRAP_SMALL[1] - SCRAP_SMALL[0] + 1)) : Math.floor(r() * (SMALL_MAX + 1));
  const large = out.length;
  const debris = pieces.filter((p) => p.i > 0 && !CRASH_KINDS[p.kind].dressing);
  for (let t = 0; t < 8 + 4 * want && out.length - large < want && debris.length; t++) {
    const pc = debris[Math.floor(r() * debris.length)];
    const side = r() < 0.5 ? -1 : 1, off = pc.reach + 1.8 + r();
    const x = pc.x + tz * side * off, z = pc.z - tx * side * off;
    if (clearance(pieces, x, z, false) < SMALL_CLEAR || nearScrap(x, z, 2)) continue;
    if (out.some((m) => (m.x - x) * (m.x - x) + (m.z - z) * (m.z - z) < (m.large ? 7 * 7 : 4 * 4))) continue;
    out.push({ x, z, dx: tx, dz: tz, large: false, seed: (r() * 4294967296) >>> 0 });
    if (SKID >= 0) pieces.push(piece(id, pieces.length, SKID, x, z, tx, tz, 0));
  }
  return out;
}

/** The large machine and its cradle (see placeMachines). */
function placeLarge(r: () => number, wreckR: number, id: number, pieces: CrashPiece[], cx: number, cz: number, tx: number, tz: number,
  out: CrashMachine[]) {
  let best = -Infinity, bx = 0, bz = 0, bdx = 0, bdz = 1;
  for (let t = 0; t < 24; t++) {
    // Mostly off to the sides and ahead (thrown forward out of a cargo bay as the craft ploughed in).
    const u = unit(r, tmpU);
    let ux = u.u, uz = u.v;
    if (ux * tx + uz * tz < -0.4) { ux = -ux; uz = -uz; }
    const d = wreckR * 0.5 + 5 + 7 * r();
    const x = cx + ux * d, z = cz + uz * d;
    // Thrown away from the wreck: its cradle lies behind it, between it and the wreck.
    const awayX = x - cx, awayZ = z - cz, al = Math.sqrt(awayX * awayX + awayZ * awayZ);
    const dx = awayX / al, dz = awayZ / al;
    const ring = clearance(pieces, x, z, true) - WALK_RING;
    const body = clearance(pieces, x, z, false) - SMALL_CLEAR;
    const cradle = clearance(pieces, x - dx * CRADLE_BACK, z - dz * CRADLE_BACK, false) - 1;
    let score = Math.min(ring, body, cradle);
    if (!flatEnough(x, z, 3) || nearScrap(x, z, 3.5)) score -= 10;
    if (score > best) { best = score; bx = x; bz = z; bdx = dx; bdz = dz; }
    if (score >= 0) break;
  }
  out.push({ x: bx, z: bz, dx: bdx, dz: bdz, large: true, seed: (r() * 4294967296) >>> 0 });
  if (CRADLE >= 0) pieces.push(piece(id, pieces.length, CRADLE, bx, bz, bdx, bdz, 0));
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
  const id = K.main || K.dressing ? null : debrisId(site, i);
  return { site, i, id, kind, x, z, dx, dz, sink, reach: Math.max(reach, K.radius), hitboxes };
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
    if (!pc.hitboxes.length || (pc.id && crashTaken.has(pc.id)) || Math.abs(p.x - pc.x) > pr || Math.abs(p.z - pc.z) > pr) continue;
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

/** How far from the eye a debris piece can be picked up, metres (like scrap, shared/scrap.ts PICKUP_REACH). */
export const DEBRIS_REACH = 3.5;

/** Centre height above the ground and radius of a debris piece's pickup sphere. */
function pickSphere(pc: CrashPiece): [number, number] {
  const K = CRASH_KINDS[pc.kind];
  let top = 0;
  for (const c of K.capsules) top = Math.max(top, c.h - pc.sink);
  return [Math.max(0.15, top / 2), Math.max(0.75 * K.radius, top / 2)];
}

/**
 * The debris piece the player is looking at (nearest pickup sphere hit by the look ray within DEBRIS_REACH), or
 * null. Same eye and look ray as digging and scrap (shared/scrap.ts scrapTarget).
 */
export function debrisTarget(feet: { x: number; y: number; z: number }, yawQ: number, pitchQ: number): CrashPiece | null {
  const s = crashSiteAt(Math.floor(feet.x / CRASH_CELL), Math.floor(feet.z / CRASH_CELL));
  const yaw = yawFromQ(yawQ), pitch = pitchFromQ(pitchQ);
  const cp = Math.cos(pitch);
  const dx = -Math.sin(yaw) * cp, dy = Math.sin(pitch), dz = -Math.cos(yaw) * cp;
  const ex = feet.x, ey = feet.y + EYE_HEIGHT, ez = feet.z;
  if (!s || Math.hypot(s.x - ex, s.z - ez) > s.radius + DEBRIS_REACH) return null;
  let best: CrashPiece | null = null, bestT = Infinity;
  for (const pc of s.pieces) {
    if (!pc.id || crashTaken.has(pc.id) || Math.abs(pc.x - ex) > pc.reach + DEBRIS_REACH || Math.abs(pc.z - ez) > pc.reach + DEBRIS_REACH) continue;
    const [cy, rad] = pickSphere(pc);
    // Ray vs sphere: closest approach along the ray.
    const ox = pc.x - ex, oy = heightAt(pc.x, pc.z) + cy - ey, oz = pc.z - ez;
    const t = ox * dx + oy * dy + oz * dz;
    const d2 = ox * ox + oy * oy + oz * oz - t * t;
    if (d2 > rad * rad) continue;
    const hit = t - Math.sqrt(rad * rad - d2); // entry point (negative: the eye is inside)
    if (hit > DEBRIS_REACH || t < 0) continue;
    if (hit < bestT) { bestT = hit; best = pc; }
  }
  return best;
}

/** Distance from the eye to a debris piece's pickup sphere (0 inside it). For server-side reach checks. */
export function debrisReach(feet: { x: number; y: number; z: number }, pc: CrashPiece): number {
  const [cy, rad] = pickSphere(pc);
  const d = Math.hypot(pc.x - feet.x, heightAt(pc.x, pc.z) + cy - (feet.y + EYE_HEIGHT), pc.z - feet.z);
  return Math.max(0, d - rad);
}
