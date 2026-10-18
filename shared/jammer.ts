// The jammer: a handheld tool (gear found broken on crawler ground and repaired, shared/gear.ts) that takes down fixed-wing drones (shared/jets.ts) and
// searchlight drones (shared/guardians.ts) without a shot. Hold the use button with one inside its wide cone for
// JAM_MS and its controls drop out: it glides down and lands whole (a jet on its belly, a drone settling on the sand).
// Losing it from the cone bleeds the lock away at JAM_BLEED× the rate it built.
//
// The client (src/jammer.ts) picks the target nearest the aim within the cone and, while held, tells the server
// ('jam') about JAM_SEND_MS; the server (server/index.ts onJam) checks the tool is in hand and the target in the cone
// and range and adds up the time.

export const JAMMER = 'jammer';
/** Held on one target this long (ms) brings it down, with Scrap parts (better parts: shared/gear.ts jamMs). */
export const JAM_MS = 5000;
/** The cone's half angle (rad) and its reach (m): enough for a jet passing high overhead. */
export const JAM_CONE = 0.2;
export const JAM_RANGE = 400;
/** The client says it's still jamming about this often (ms). */
export const JAM_SEND_MS = 200;
/** Out of the cone (or let go), the lock fades this many times as fast as it built. */
export const JAM_BLEED = 2;

/** Whether (tx, ty, tz) is within the cone from (x, y, z) along unit (dx, dy, dz), widened by `slack` rad. */
export function inCone(x: number, y: number, z: number, dx: number, dy: number, dz: number, tx: number, ty: number, tz: number, slack = 0): boolean {
  const ox = tx - x, oy = ty - y, oz = tz - z, d = Math.hypot(ox, oy, oz);
  if (d > JAM_RANGE || d < 0.5) return false;
  return (ox * dx + oy * dy + oz * dz) / d >= Math.cos(JAM_CONE + slack);
}
