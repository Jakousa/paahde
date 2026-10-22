// Power lines: wires strung between the connectors of the electric things put up round the base (the windmill, the
// battery station, the power pole: shared/placed.ts). Only what is wired together shares power: each set of things
// joined by wires is one grid (grids(), used by server/power.ts).
//
// A wire is a wiring coil: hold one in the hotbar, click a connector, click another (src/wiring.ts). The coil is used
// up, and its tier says how far it reaches (COIL_REACH, socket to socket). A power pole is only a connector up high,
// to carry a line further than one coil reaches. Picking a thing up takes its wires down, their coils back to you;
// clicking a wired pair again takes that wire down.
//
// The server owns the list (server/wires.ts, `wires` table) and sends it whole when it changes; client and server
// both keep it here with setWires().
import { EYE_HEIGHT } from './dig.ts';
import { parsePart } from './items.ts';
import type { Placed } from './placed.ts';
import { TEXT } from './text.ts';

/** A wire: DB id, the two placed things it joins (a < b), and the coil it was made of. */
export type Wire = { id: number; a: number; b: number; kind: string };

/** Each electric kind's connector: where its socket is in its own frame (rot 0; m, from the footprint's centre on
 *  what it stands on). High enough that a sagging wire clears your head. Match tools/blender/placeables.py. */
export const CONNECTORS: Record<string, { x: number; y: number; z: number }> = {
  windmill: { x: 0.98, y: 3.2, z: 0 },
  battery_station: { x: 0.6, y: 3.25, z: -0.3 },
  power_pole: { x: 0, y: 4.5, z: 0 },
};

export const hasConnector = (kind: string) => kind in CONNECTORS;

/** How far a wire of each coil tier reaches (m, socket to socket): Scrap .. Space-grade. */
export const COIL_REACH = [10, 16, 24, 35];
/** At most this many wires on one connector. */
export const MAX_WIRES = 6;
/** How far from the eye a connector can be clicked (m). */
export const CONNECT_REACH = 5;
/** How close to a socket the crosshair must pass (m). */
const SOCKET_R = 0.45;

/** Is `kind` a wiring coil (any tier)? */
export const isCoil = (kind: string | undefined) => !!kind && parsePart(kind)?.part === 'coil';
/** How far a coil of `kind` reaches (m), 0 if it isn't one. */
export const coilReach = (kind: string | undefined) => {
  const t = kind ? parsePart(kind) : null;
  return t?.part === 'coil' ? COIL_REACH[t.tier] : 0;
};

/** Everything strung right now (from the server). Replace it with setWires(). */
export let wires: Wire[] = [];
export function setWires(list: Wire[]) {
  wires = list;
}

/** World position of a placed thing's socket. */
export function socketAt(p: Placed): { x: number; y: number; z: number } {
  const c = CONNECTORS[p.kind];
  // Turned a quarter (rot 1): local +X goes to world -Z, local +Z to +X (three.js rotation.y = π/2).
  return p.rot ? { x: p.x + c.z, y: p.y + c.y, z: p.z - c.x } : { x: p.x + c.x, y: p.y + c.y, z: p.z + c.z };
}

const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** The wire between `a` and `b`, if there is one. */
export const wireBetween = (a: number, b: number, list: Wire[] = wires) =>
  list.find((w) => (w.a === a && w.b === b) || (w.a === b && w.b === a));

/** Why a wire of coil `kind` can't go from `a` to `b`, or null if it can. */
export function wireError(a: Placed | undefined, b: Placed | undefined, kind: string | undefined, list: Wire[] = wires): string | null {
  if (!a || !b || a.id === b.id || !hasConnector(a.kind) || !hasConnector(b.kind)) return TEXT.notice.cantConnect;
  if (!isCoil(kind)) return TEXT.notice.cantConnect;
  if (dist(socketAt(a), socketAt(b)) > coilReach(kind)) return TEXT.notice.outOfReach;
  for (const p of [a, b]) {
    if (list.filter((w) => w.a === p.id || w.b === p.id).length >= MAX_WIRES) return TEXT.notice.tooManyWires;
  }
  return null;
}

/** The connector under the crosshair (nearest socket the ray passes within SOCKET_R of, within CONNECT_REACH), or null. */
export function connectorTarget(feet: { x: number; y: number; z: number }, yaw: number, pitch: number, list: Placed[]): Placed | null {
  const cp = Math.cos(pitch);
  const d = { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
  const e = { x: feet.x, y: feet.y + EYE_HEIGHT, z: feet.z };
  let best: Placed | null = null, bestT = CONNECT_REACH;
  for (const p of list) {
    if (!hasConnector(p.kind)) continue;
    const s = socketAt(p);
    const t = (s.x - e.x) * d.x + (s.y - e.y) * d.y + (s.z - e.z) * d.z;
    if (t < 0 || t > bestT) continue;
    const miss = Math.hypot(e.x + d.x * t - s.x, e.y + d.y * t - s.y, e.z + d.z * t - s.z);
    if (miss < SOCKET_R) {
      best = p;
      bestT = t;
    }
  }
  return best;
}

/** How far a wire `len` m long sags in the middle (m). */
export const sagOf = (len: number) => Math.min(0.9, Math.max(0.05, len * 0.025));

/** Points along a wire from `a` to `b` (a parabola, close enough to the catenary at this sag), `n` + 1 of them. */
export function wirePoints(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, n = 16) {
  const sag = sagOf(dist(a, b));
  const out: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t - 4 * sag * t * (1 - t), z: a.z + (b.z - a.z) * t });
  }
  return out;
}

/** The grids: each set of placed ids joined by wires (things on no wire are a grid of their own). */
export function grids(list: Placed[], ws: Wire[] = wires): number[][] {
  const up = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (up.get(r) !== r) r = up.get(r)!;
    up.set(x, r);
    return r;
  };
  for (const p of list) if (hasConnector(p.kind)) up.set(p.id, p.id);
  for (const w of ws) if (up.has(w.a) && up.has(w.b)) up.set(find(w.a), find(w.b));
  const out = new Map<number, number[]>();
  for (const id of up.keys()) {
    const r = find(id);
    if (!out.has(r)) out.set(r, []);
    out.get(r)!.push(id);
  }
  return [...out.values()];
}
