// Dying: the body drops as a ragdoll where it fell (src/models/ragdoll.ts) and the camera pulls back to third person
// for DOWN_MS before the server respawns you at the base. A blast that kills you throws the body: `blastPush` is
// the launch velocity (m/s) the server sends with the death ('died' and the snapshot's `down`).

/** How long a dead player lies there before respawning (ms). */
export const DOWN_MS = 4000;

/** Launch speed at the centre of a blast that kills (m/s), falling off to a quarter at its edge. */
const BLAST_PUSH = 14;
/** Upward share added to every blast push, so the body is lifted rather than slid along the sand. */
const BLAST_LIFT = 0.45;

/** Velocity (m/s, [x, y, z], rounded for the wire) a blast of radius r at (bx, by, bz) gives the body of a player
 *  whose feet are at (px, py, pz): away from it, harder the closer, always somewhat up. */
export function blastPush(bx: number, by: number, bz: number, px: number, py: number, pz: number, r: number): [number, number, number] {
  let dx = px - bx, dy = py + 0.9 - by, dz = pz - bz; // from the blast to the chest
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-3) (dx = 0), (dy = 1), (dz = 0);
  else (dx /= d), (dy /= d), (dz /= d);
  const k = BLAST_PUSH * (1 - 0.75 * Math.min(1, d / r));
  const up = Math.max(dy, 0) + BLAST_LIFT;
  const n = Math.hypot(dx, up, dz);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return [r2((dx / n) * k), r2((up / n) * k), r2((dz / n) * k)];
}
