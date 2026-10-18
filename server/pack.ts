// Hunting as a pack (crawlers, the queen's spiderlings): rather than all running straight at their prey, each one
// after the same person takes its own side of them (by its place in the pack) and heads for where they're going.
// The further off it is, the wider it swings, so the pack fans out and closes in from all round: running straight
// away from one runs into another's path, and only a slide out of the closing ring gets clear. They go round wrecks
// and scrap rather than over them (skirt).
import { collideCrash } from '../shared/crashsites.ts';
import { collideScrap } from '../shared/scrap.ts';
import { heightAt } from '../shared/terrain.ts';

/** Sides (rad, off the hunter's own bearing to the prey) by place in the pack: the first comes straight on. */
const SIDES = [0, 1.1, -1.1, 1.9, -1.9, 0.55, -0.55, 2.5, -2.5];

/** Where hunter number i of the n after the same prey heads from (x, z): the prey at (px, pz) led along its velocity
 *  (vx, vz) by about the time the hunter needs to get there at `speed` (at most `maxLead` s), pushed out to its own
 *  side of them, up to `wide` m. */
export function flank(x: number, z: number, px: number, pz: number, vx: number, vz: number, speed: number,
  i: number, n: number, wide: number, maxLead = 1.5): [number, number] {
  const d = Math.hypot(px - x, pz - z);
  const t = Math.min(maxLead, d / speed);
  const lx = px + vx * t, lz = pz + vz * t;
  const side = n > 1 ? SIDES[i % SIDES.length] : 0;
  if (side === 0) return [lx, lz];
  const a = Math.atan2(x - lx, z - lz) + side, r = Math.min(wide, d * 0.45);
  return [lx + Math.sin(a) * r, lz + Math.cos(a) * r];
}

/** Hunters on foot keep to the sand: wrecks and scrap taller than STEP (m) are in their way, not walked over. */
const STEP = 0.5, LOOK = 2.5;

/** Pushes (x, z) out of any wreck or scrap a body of radius r can't step over; how far it moved it, which way. */
function shove(p: { x: number; z: number; vx: number; vz: number }, r: number): [number, number, number] {
  const x = p.x, z = p.z, y = heightAt(x, z);
  collideScrap(p, y, y, r, STEP);
  collideCrash(p, y, y, r, STEP);
  const dx = p.x - x, dz = p.z - z, d = Math.hypot(dx, dz);
  return d > 1e-4 ? [d, dx / d, dz / d] : [0, 0, 0];
}

/** Which way a hunter goes round what's in its way (±1, 0 not yet), kept till `until` (ms) so it doesn't dither in a
 *  pocket between wreck pieces. */
export type Skirt = { side: number; until: number };

/** Is the way from (x, z) along heading clear for a body of radius r (a stride and half of one ahead)? */
function clear(x: number, z: number, heading: number, r: number): boolean {
  const sx = Math.sin(heading), sz = Math.cos(heading);
  for (const l of [LOOK * 0.5, LOOK]) if (shove({ x: x + sx * l, z: z + sz * l, vx: 0, vz: 0 }, r)[0]) return false;
  return true;
}

/** The heading (rad) a hunter of radius r at (x, z) takes to go `heading` round what's in the way: turned, to the side
 *  it has picked (the one that clears soonest), just far enough to get by. */
export function skirt(x: number, z: number, heading: number, r: number, k: Skirt, now: number): number {
  if (clear(x, z, heading, r)) return heading;
  if (now >= k.until) k.side = 0;
  for (let i = 1; i <= 9; i++) {
    for (const s of k.side ? [k.side] : [1, -1]) {
      const h = heading + s * i * 0.35;
      if (!clear(x, z, h, r)) continue;
      k.side = s;
      k.until = now + 2500;
      return h;
    }
  }
  // Boxed in: back the way it came, round to its side.
  k.side ||= 1;
  k.until = now + 2500;
  return heading + k.side * 2.6;
}

/** (x, z) moved out of anything a body of radius r can't step over. */
export function keepOut(x: number, z: number, r: number): [number, number] {
  const p = { x, z, vx: 0, vz: 0 };
  shove(p, r);
  return [p.x, p.z];
}
