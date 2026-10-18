// Digging and sand physics on the terrain edit layer (shared/terrain.ts), shared by client and server.
//
// - Strokes (dig / pile) are deterministic integer-millimetre brush operations. The server applies them
//   authoritatively; the client applies the same stroke immediately as a prediction, and the server's
//   absolute values overwrite it a moment later (see src/net.ts).
// - Relaxer is a cellular-automaton avalanche: neighbouring edit vertices steeper than the angle of
//   repose shed sand downhill until they are not. Only an active set of recently changed vertices is
//   processed, never the whole world. It runs on the server only; results are broadcast.
//
// - heal() is the wind slowly erasing player marks: every edited vertex creeps back to 0 (the original
//   dunes). Server only, a few times a minute; results are broadcast like any other edit.
//
// The dig point is where the player looks: a ray from the eye along the camera yaw/pitch, marched
// against heightAt up to DIG_REACH metres. Yaw and pitch travel quantized, so both sides agree.
import { yawFromQ } from './sim.ts';
import { baseHeight, EDIT_CELL, EDIT_CHUNK, heightAt, sandOverRock, type TerrainEdits } from './terrain.ts';
import { sandHidden } from './shelters.ts';

/** Eye height above the feet (first-person camera). */
export const EYE_HEIGHT = 1.65;
/** How far the dig ray reaches from the eye, metres. */
export const DIG_REACH = 4;
/** Brush radius, metres. */
export const DIG_RADIUS = 1.2;
/** Depth removed at the brush centre per dig stroke, mm. */
export const DIG_STROKE_MM = 220;
/** How deep and wide one dig stroke goes: bare hands or a shovel (shared/gear.ts digTool). */
export type DigTool = { mm: number; radius: number; cooldown: number };
const DEFAULT_TOOL: DigTool = { mm: DIG_STROKE_MM, radius: DIG_RADIUS, cooldown: 12 };
/** Height added at the brush centre per pile stroke, mm. */
export const PILE_STROKE_MM = 110;
/** Ticks between strokes while the button is held (60 Hz → 0.2 s). */
export const DIG_COOLDOWN_TICKS = 12;
/** Edit-layer bounds: never dig more than 5 m below the dunes or pile more than 3 m above. */
export const MIN_EDIT_MM = -5000;
export const MAX_EDIT_MM = 3000;
/** Dug sand lands as a pile this far to the digger's right. */
export const DEPOSIT_SIDE = 3.2;
export const DEPOSIT_RADIUS = 1.4;

/** Healing per heal() pass: HEAL_MIN_MM plus 1/2^HEAL_SHIFT of the offset (a 1 m hole fills in ~12 min at 5 s passes). */
export const HEAL_MIN_MM = 3;
export const HEAL_SHIFT = 6;

/** Angle of repose for dry sand (~34°) as a max height difference between neighbouring vertices. */
export const REPOSE_TAN = Math.tan((34 * Math.PI) / 180);
export const REPOSE_AXIS_MM = Math.round(REPOSE_TAN * EDIT_CELL * 1000);
export const REPOSE_DIAG_MM = Math.round(REPOSE_TAN * EDIT_CELL * Math.SQRT2 * 1000);

// Camera pitch is sent with every input like yaw: 16 bits over [-π/2, π/2]. Negative pitch looks down.
export const PITCH_STEPS = 65536;
export function quantizePitch(pitch: number): number {
  const t = (pitch + Math.PI / 2) / Math.PI;
  return Math.max(0, Math.min(PITCH_STEPS - 1, Math.round(t * (PITCH_STEPS - 1))));
}
export function pitchFromQ(q: number): number {
  return (q / (PITCH_STEPS - 1)) * Math.PI - Math.PI / 2;
}

/** Packs an edit vertex index pair into one safe integer (for Sets/Maps). */
export function cellKey(ix: number, iz: number): number {
  return (ix + 32768) * 65536 + (iz + 32768);
}
export function cellX(k: number): number {
  return Math.floor(k / 65536) - 32768;
}
export function cellZ(k: number): number {
  return (k % 65536) - 32768;
}

/** Called after an edit vertex changes, with its previous value. */
export type CellSink = (ix: number, iz: number, prevMm: number) => void;

export type Point = { x: number; y: number; z: number };

/**
 * Where the look ray from the eye hits the ground, or null if nothing is within DIG_REACH or the sand it hits
 * is not the ground for this player (the bunker's roof seen from inside, the hole over the entrance).
 * `feet` is the player's position; yaw 0 looks down -Z (see sim.ts).
 */
export function digTarget(feet: { x: number; y: number; z: number }, yawQ: number, pitchQ: number): Point | null {
  const yaw = yawFromQ(yawQ), pitch = pitchFromQ(pitchQ);
  const cp = Math.cos(pitch);
  const dx = -Math.sin(yaw) * cp, dy = Math.sin(pitch), dz = -Math.cos(yaw) * cp;
  const ex = feet.x, ey = feet.y + EYE_HEIGHT, ez = feet.z;
  const STEP = 0.1;
  let prev = 0;
  for (let t = STEP; t <= DIG_REACH + 1e-9; t += STEP) {
    const x = ex + dx * t, y = ey + dy * t, z = ez + dz * t;
    if (y <= heightAt(x, z)) {
      // Bisect between the last point above ground and this one.
      let lo = prev, hi = t;
      for (let i = 0; i < 8; i++) {
        const m = (lo + hi) / 2;
        if (ey + dy * m <= heightAt(ex + dx * m, ez + dz * m)) hi = m;
        else lo = m;
      }
      const hx = ex + dx * hi, hz = ez + dz * hi;
      return sandHidden(hx, hz, feet.y) ? null : { x: hx, y: ey + dy * hi, z: hz };
    }
    prev = t;
  }
  return null;
}

/** Lowest edit at vertex (ix, iz), mm: MIN_EDIT_MM, or less deep where rock lies under the sand
 *  (0 on bare rock: it can't be dug). */
export function floorMm(ix: number, iz: number): number {
  return Math.max(MIN_EDIT_MM, -Math.round(sandOverRock(ix * EDIT_CELL, iz * EDIT_CELL) * 1000));
}

/** Smooth radial brush weight in [0, 1]: (1 - d²/r²)². */
function weight(d2: number, r2: number): number {
  if (d2 >= r2) return 0;
  const u = 1 - d2 / r2;
  return u * u;
}

function set(edits: TerrainEdits, ix: number, iz: number, mm: number, sink?: CellSink) {
  const prev = edits.getMm(ix, iz);
  if (prev === mm) return;
  edits.setMm(ix, iz, mm);
  sink?.(ix, iz, prev);
}

/** Lower a soft circle around (x, z). Returns the removed volume in mm·vertices. */
export function strokeDig(edits: TerrainEdits, x: number, z: number, sink?: CellSink, tool: DigTool = DEFAULT_TOOL): number {
  const r2 = tool.radius * tool.radius;
  const n = Math.ceil(tool.radius / EDIT_CELL);
  const gx = Math.round(x / EDIT_CELL), gz = Math.round(z / EDIT_CELL);
  let removed = 0;
  for (let iz = gz - n; iz <= gz + n; iz++) {
    for (let ix = gx - n; ix <= gx + n; ix++) {
      const ddx = ix * EDIT_CELL - x, ddz = iz * EDIT_CELL - z;
      const w = weight(ddx * ddx + ddz * ddz, r2);
      if (w === 0) continue;
      const cur = edits.getMm(ix, iz);
      const next = Math.max(floorMm(ix, iz), cur - Math.round(tool.mm * w));
      if (next < cur) {
        removed += cur - next;
        set(edits, ix, iz, next, sink);
      }
    }
  }
  return removed;
}

/** Spread `volume` mm·vertices as a soft mound around (x, z), capped at MAX_EDIT_MM. */
export function deposit(edits: TerrainEdits, x: number, z: number, volume: number, radius: number, sink?: CellSink) {
  if (volume <= 0) return;
  const r2 = radius * radius;
  const n = Math.ceil(radius / EDIT_CELL);
  const gx = Math.round(x / EDIT_CELL), gz = Math.round(z / EDIT_CELL);
  let total = 0;
  for (let iz = gz - n; iz <= gz + n; iz++) {
    for (let ix = gx - n; ix <= gx + n; ix++) {
      const ddx = ix * EDIT_CELL - x, ddz = iz * EDIT_CELL - z;
      total += weight(ddx * ddx + ddz * ddz, r2);
    }
  }
  if (total === 0) return;
  for (let iz = gz - n; iz <= gz + n; iz++) {
    for (let ix = gx - n; ix <= gx + n; ix++) {
      const ddx = ix * EDIT_CELL - x, ddz = iz * EDIT_CELL - z;
      const w = weight(ddx * ddx + ddz * ddz, r2);
      if (w === 0) continue;
      const cur = edits.getMm(ix, iz);
      set(edits, ix, iz, Math.min(MAX_EDIT_MM, cur + Math.round((volume * w) / total)), sink);
    }
  }
}

/** Raise a soft circle around (x, z) (sand from nowhere: building is a gift). */
export function strokePile(edits: TerrainEdits, x: number, z: number, sink?: CellSink) {
  const r2 = DIG_RADIUS * DIG_RADIUS;
  const n = Math.ceil(DIG_RADIUS / EDIT_CELL);
  const gx = Math.round(x / EDIT_CELL), gz = Math.round(z / EDIT_CELL);
  for (let iz = gz - n; iz <= gz + n; iz++) {
    for (let ix = gx - n; ix <= gx + n; ix++) {
      const ddx = ix * EDIT_CELL - x, ddz = iz * EDIT_CELL - z;
      const w = weight(ddx * ddx + ddz * ddz, r2);
      if (w === 0) continue;
      const cur = edits.getMm(ix, iz);
      const next = Math.min(MAX_EDIT_MM, cur + Math.round(PILE_STROKE_MM * w));
      if (next > cur) set(edits, ix, iz, next, sink);
    }
  }
}

/**
 * One dig (pile = false) or pile stroke by a player at `feet` looking along yaw/pitch.
 * Dug sand is deposited beside the hole, to the right of the view direction.
 * Returns the stroke point, or null if the ground is out of reach.
 */
export function stroke(
  edits: TerrainEdits, feet: { x: number; y: number; z: number }, yawQ: number, pitchQ: number, pile: boolean,
  sink?: CellSink, tool: DigTool = DEFAULT_TOOL,
): Point | null {
  const p = digTarget(feet, yawQ, pitchQ);
  if (!p) return null;
  if (pile) {
    strokePile(edits, p.x, p.z, sink);
  } else {
    const removed = strokeDig(edits, p.x, p.z, sink, tool);
    const yaw = yawFromQ(yawQ);
    // Camera right is (cos yaw, -sin yaw).
    deposit(edits, p.x + Math.cos(yaw) * DEPOSIT_SIDE, p.z - Math.sin(yaw) * DEPOSIT_SIDE, removed, DEPOSIT_RADIUS, sink);
  }
  return p;
}

/** One healing pass: moves every edited vertex toward 0 (the untouched dunes). Returns the vertices changed. */
export function heal(edits: TerrainEdits, sink?: CellSink): number {
  let changed = 0;
  for (const [cx, cz, c] of edits.entries()) {
    for (let i = 0; i < c.length; i++) {
      const v = c[i];
      if (v === 0) continue;
      const a = Math.abs(v), q = Math.min(a, HEAL_MIN_MM + (a >> HEAL_SHIFT));
      set(edits, cx * EDIT_CHUNK + (i % EDIT_CHUNK), cz * EDIT_CHUNK + Math.floor(i / EDIT_CHUNK), v > 0 ? v - q : v + q, sink);
      changed++;
    }
  }
  return changed;
}

const NEIGHBOURS: [number, number, number][] = [
  [1, 0, REPOSE_AXIS_MM], [-1, 0, REPOSE_AXIS_MM], [0, 1, REPOSE_AXIS_MM], [0, -1, REPOSE_AXIS_MM],
  [1, 1, REPOSE_DIAG_MM], [-1, 1, REPOSE_DIAG_MM], [1, -1, REPOSE_DIAG_MM], [-1, -1, REPOSE_DIAG_MM],
];

/**
 * Angle-of-repose avalanche over the active set. Total height = baseHeight + edit; only the edit layer
 * moves. A pair steeper than repose sheds sand from the higher to the lower vertex, but never past the
 * natural (base) slope, so untouched dunes steeper than repose stay as they are.
 */
export class Relaxer {
  /** Vertices to check next step (keys from cellKey). */
  active = new Set<number>();
  private baseCache = new Map<number, number>();
  private floorCache = new Map<number, number>();

  /** Mark a vertex as changed, e.g. from a dig sink. */
  touch(ix: number, iz: number) {
    this.active.add(cellKey(ix, iz));
  }

  get idle() {
    return this.active.size === 0;
  }

  private baseMm(ix: number, iz: number): number {
    const k = cellKey(ix, iz);
    let b = this.baseCache.get(k);
    if (b === undefined) {
      b = Math.round(baseHeight(ix * EDIT_CELL, iz * EDIT_CELL) * 1000);
      if (this.baseCache.size > 200_000) this.baseCache.clear();
      this.baseCache.set(k, b);
    }
    return b;
  }

  private floorMm(ix: number, iz: number): number {
    const k = cellKey(ix, iz);
    let f = this.floorCache.get(k);
    if (f === undefined) {
      f = floorMm(ix, iz);
      if (this.floorCache.size > 200_000) this.floorCache.clear();
      this.floorCache.set(k, f);
    }
    return f;
  }

  /**
   * One relaxation pass over at most `maxCells` active vertices. Vertices that changed become the next
   * active set. Returns the number of vertices processed.
   */
  step(edits: TerrainEdits, maxCells = 20_000, sink?: CellSink): number {
    const next = new Set<number>();
    let processed = 0;
    const record = (ix: number, iz: number, prev: number) => {
      next.add(cellKey(ix, iz));
      sink?.(ix, iz, prev);
    };
    for (const k of this.active) {
      if (processed >= maxCells) {
        next.add(k); // carry over
        continue;
      }
      processed++;
      const ax = cellX(k), az = cellZ(k);
      const baseA = this.baseMm(ax, az);
      for (const [ox, oz, limitMm] of NEIGHBOURS) {
        const bx = ax + ox, bz = az + oz;
        const eA = edits.getMm(ax, az), eB = edits.getMm(bx, bz);
        const baseB = this.baseMm(bx, bz);
        const diff = baseA + eA - (baseB + eB);
        const bd = baseA - baseB;
        if (diff > 0) {
          const q = transfer(diff - Math.max(limitMm, bd), eA - this.floorMm(ax, az), eB);
          if (q > 0) {
            set(edits, ax, az, eA - q, record);
            set(edits, bx, bz, eB + q, record);
          }
        } else if (diff < 0) {
          const q = transfer(-diff - Math.max(limitMm, -bd), eB - this.floorMm(bx, bz), eA);
          if (q > 0) {
            set(edits, bx, bz, eB - q, record);
            set(edits, ax, az, eA + q, record);
          }
        }
      }
    }
    this.active = next;
    if (next.size === 0) { this.baseCache.clear(); this.floorCache.clear(); }
    return processed;
  }
}

/** Sand to move from a vertex with `avail` mm above its floor to one with edit `to`, given the excess height (mm). */
function transfer(excess: number, avail: number, to: number): number {
  if (excess <= 0) return 0;
  // A quarter of the excess per pass (half would level the pair): slumps over a second or so.
  const q = (excess + 3) >> 2;
  return Math.max(0, Math.min(q, avail, MAX_EDIT_MM - to));
}
