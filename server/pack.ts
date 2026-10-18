// Hunting as a pack (crawlers, the queen's spiderlings): rather than all running straight at their prey, each one
// after the same person takes its own side of them (by its place in the pack) and heads for where they're going.
// The further off it is, the wider it swings, so the pack fans out and closes in from all round: running straight
// away from one runs into another's path, and only a slide out of the closing ring gets clear.

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
