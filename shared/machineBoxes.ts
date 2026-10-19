// A model-built machine (shared/machines.ts) is solid, and its solid shrinks as it comes apart: each shell, rotor and
// accessory the layout lists in `hits` is a stretch of cylinder along the machine's axis, there while any of the modules
// it belongs to is still on the machine. A module is off once all its outer steps are done. Run by both the client
// and the server like the other collisions (shared/sim.ts), reading each machine's finished steps from `setMachineProgress`'s
// source (the server's sessions, the client's mirror of them): a step done can only shrink the machine, so a client a
// moment ahead of the server is never pushed.
import { sitesNear, type CrashSite } from './crash.ts';
import { machineModules } from './machine.ts';
import { layoutOf } from './machines.ts';
import { heightAt } from './terrain.ts';

/** Where a site's finished step indexes are (see server/crash.ts sessions, src/world/crash.ts progress). */
let doneOf: (id: string) => ReadonlySet<number> | undefined = () => undefined;
export function setMachineProgress(source: (id: string) => ReadonlySet<number> | undefined) {
  doneOf = source;
  boxCache.clear();
}

/** Where a pushed machine has been shoved to, as metres from where it lay (the server's, mirrored on every client). It stays
 *  within MAX_SHOVE of its place, so it never reaches what lies round it. */
export const MAX_SHOVE = 5;
const shoves = new Map<string, { x: number; z: number }>();
export function machineShove(id: string): { x: number; z: number } {
  return shoves.get(id) ?? ZERO;
}
const ZERO = { x: 0, z: 0 };
export function setMachineShove(id: string, x: number, z: number) {
  if (x === 0 && z === 0) shoves.delete(id);
  else shoves.set(id, { x, z });
  boxCache.delete(id);
}

/** A machine's finished steps changed (or all of them, with no id): its solid is worked out again next time it is asked for. */
export function machineChanged(id?: string) {
  if (id === undefined) boxCache.clear();
  else boxCache.delete(id);
}

interface Cap {
  x: number;
  z: number;
  ax: number;
  az: number;
  half: number;
  r: number;
  /** Height of the top above the ground at the machine. */
  h: number;
}

const boxCache = new Map<string, Cap[]>();
const STAND_MARGIN = 0.15;

/** The capsules of a machine as it stands now. */
export function machineCapsules(site: CrashSite): Cap[] {
  const layout = layoutOf(site.kind);
  if (!layout?.hits || !layout.pose) return [];
  const done = doneOf(site.id);
  let out = boxCache.get(site.id);
  if (out) return out;
  const mods = machineModules(site.kind, site.seed, site.level);
  const present = new Set(mods.map((m) => m.mod.id));
  // which modules have come off: every outer step of theirs done (the steps are numbered in the order src/teardown/glbMachine.ts builds them)
  const off = new Set<string>();
  let index = 0;
  for (const { mod } of mods) {
    let outer = 0, outerDone = 0;
    for (const s of mod.steps) {
      if (s.with && !s.with.every((id) => present.has(id))) continue;
      if (!s.inner) {
        outer++;
        if (done?.has(index)) outerDone++;
      }
      index++;
    }
    if (outer > 0 && outerDone === outer) off.add(mod.id);
  }
  const { pitch, lift } = layout.pose;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const sy = Math.sin(site.yaw), cy = Math.cos(site.yaw);
  const o = machineShove(site.id);
  out = [];
  for (const h of layout.hits) {
    if (h.mods.length && !h.mods.some((id) => present.has(id) && !off.has(id))) continue;
    const zc = (h.z0 + h.z1) / 2;
    const along = zc * cp; // how far out along the ground
    out.push({
      x: site.x + o.x + sy * along, z: site.z + o.z + cy * along, ax: sy, az: cy,
      half: ((h.z1 - h.z0) / 2) * cp, r: h.r, h: lift - zc * sp + h.r * cp,
    });
  }
  if (boxCache.size > 512) boxCache.clear();
  boxCache.set(site.id, out);
  return out;
}

/** The model-built machines near a player, by the cell of 12 m they stand in (they do not move). */
const nearCache = new Map<number, CrashSite[]>();
const NEAR_CELL = 12;
function machinesNear(x: number, z: number): CrashSite[] {
  const cx = Math.floor(x / NEAR_CELL), cz = Math.floor(z / NEAR_CELL);
  const key = cx * 100003 + cz;
  let list = nearCache.get(key);
  if (!list) {
    list = sitesNear((cx + 0.5) * NEAR_CELL, (cz + 0.5) * NEAR_CELL, NEAR_CELL * 0.75 + 8 + MAX_SHOVE).filter((s) => !!layoutOf(s.kind)?.hits);
    if (nearCache.size > 256) nearCache.clear();
    nearCache.set(key, list);
  }
  return list;
}

/**
 * The machine a player is leaning on, if any: touching its side (within a hand's breadth), not standing on it, and meaning to walk
 * into it (`wishX`, `wishZ`: the unit direction the keys ask for; the velocity cannot say, the collision has just taken the part
 * into the machine away). Returns it with the direction from its axis to the player (horizontal, unit) and how squarely they push (0..1).
 * The server turns that into the machine rolling slowly about its axis (server/crash.ts push), so every side can be reached.
 */
export function pushedMachine(p: { x: number; z: number }, y: number, radius: number, stepUp: number, wishX: number, wishZ: number):
  { site: CrashSite; nx: number; nz: number; into: number } | null {
  for (const site of machinesNear(p.x, p.z)) {
    const o = machineShove(site.id);
    if (Math.abs(p.x - site.x - o.x) > 4 + radius || Math.abs(p.z - site.z - o.z) > 4 + radius) continue;
    const base = heightAt(site.x + o.x, site.z + o.z);
    for (const b of machineCapsules(site)) {
      let t = (p.x - b.x) * b.ax + (p.z - b.z) * b.az;
      t = t < -b.half ? -b.half : t > b.half ? b.half : t;
      const ex = p.x - (b.x + b.ax * t), ez = p.z - (b.z + b.az * t);
      const d = Math.sqrt(ex * ex + ez * ez);
      if (d < 1e-6 || d > b.r + radius + 0.12 || y >= base + b.h - stepUp) continue;
      const nx = ex / d, nz = ez / d;
      const into = -(wishX * nx + wishZ * nz);
      if (into > 0.3) return { site, nx, nz, into };
    }
  }
  return null;
}

/**
 * Collide a player (circle of `radius` at feet height y; prevY is last tick's) with the machines near: the same rules as
 * collideCrash (shared/crashsites.ts): a top within `stepUp` below the feet is ground (the highest such top, or -Infinity),
 * anything taller a wall that pushes the position out and takes the velocity into it away, in place.
 */
export function collideMachines(p: { x: number; z: number; vx: number; vz: number }, y: number, prevY: number, radius: number, stepUp: number): number {
  const sites = machinesNear(p.x, p.z);
  if (!sites.length) return -Infinity;
  let support = -Infinity;
  const feet = Math.max(y, prevY);
  for (const site of sites) {
    const o = machineShove(site.id);
    if (Math.abs(p.x - site.x - o.x) > 4 + radius || Math.abs(p.z - site.z - o.z) > 4 + radius) continue; // (the longest stretch is about 1.5 m each way of the middle)
    const base = heightAt(site.x + o.x, site.z + o.z);
    for (const b of machineCapsules(site)) {
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
