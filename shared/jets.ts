// Fixed-wing drones ("jets"): big, high and fast, by day and by night. No lights and no searchlight; for now they
// only fly over. The server (server/jets.ts) now and then sends one past a random player and broadcasts the list;
// like the sandstorms (shared/storm.ts) the rest is plain math on that list and the server clock, so both sides agree
// where each one is. Drawn by src/world/jets.ts, heard via src/guardianSound.ts (jets).
//
// A flight is a straight run in, an arc of a big circle (none: a straight pass) and a straight run out, at a steady
// speed and height. It starts and ends far out of sight (LEAD m beyond where it turns or passes).

export type Jet = {
  id: number;
  /** Where it enters (m) and its heading there (three.js yaw: forward = (sin, cos)). */
  x: number;
  z: number;
  yaw: number;
  /** Height (m, world), held all the way. */
  y: number;
  /** Speed (m/s). */
  speed: number;
  /** Straight run in (m), then an arc of `turn` radians (+ turns towards +yaw) on radius `r` (m), then a run out (m). */
  run: number;
  turn: number;
  r: number;
  out: number;
  /** Server-clock ms it enters; it leaves at start + length / speed. */
  start: number;
  end: number;
};

/** Wingspan (m): a searchlight drone is about 2. */
export const JET_SPAN = 18;
/** Height above the sand (m) and speed (m/s) a flight picks from. */
export const JET_ALT_MIN = 110;
export const JET_ALT_MAX = 180;
export const JET_SPEED_MIN = 75;
export const JET_SPEED_MAX = 110;
/** Straight run before and after the part near the players (m): out of sight at both ends. */
export const LEAD = 3000;
/** Bank in a turn (rad; a coordinated turn's, at most MAX_BANK), eased in and out over BANK_EASE m of the arc. */
const G = 9.81;
const MAX_BANK = 0.7;
const BANK_EASE = 250;

/** The flight's path length (m). */
export const jetLength = (j: Pick<Jet, 'run' | 'turn' | 'r' | 'out'>) => j.run + Math.abs(j.turn) * j.r + j.out;

export type JetPose = { x: number; y: number; z: number; yaw: number; bank: number; vx: number; vz: number };

/** Where jet `j` is at server time `t` (ms), into `out`; false before it enters or after it leaves. */
export function jetAt(j: Jet, t: number, out: JetPose): boolean {
  if (t < j.start || t > j.end) return false;
  const s = (j.speed * (t - j.start)) / 1000;
  const arc = Math.abs(j.turn) * j.r;
  let x = j.x + Math.sin(j.yaw) * Math.min(s, j.run);
  let z = j.z + Math.cos(j.yaw) * Math.min(s, j.run);
  let yaw = j.yaw, bank = 0;
  if (s > j.run && arc > 0) {
    // On the circle: curvature k (signed), heading yaw + k·u; the centre sits 1/k to the side.
    const k = Math.sign(j.turn) / j.r, u = Math.min(s - j.run, arc);
    const cx = x + Math.cos(yaw) / k, cz = z - Math.sin(yaw) / k;
    yaw += k * u;
    x = cx - Math.cos(yaw) / k;
    z = cz + Math.sin(yaw) / k;
    const ease = Math.min(1, u / BANK_EASE, (arc - u) / BANK_EASE);
    bank = Math.sign(j.turn) * Math.min(MAX_BANK, Math.atan((j.speed * j.speed) / (G * j.r))) * ease * ease * (3 - 2 * ease);
  }
  if (s > j.run + arc) {
    x += Math.sin(yaw) * (s - j.run - arc);
    z += Math.cos(yaw) * (s - j.run - arc);
  }
  out.x = x;
  out.y = j.y;
  out.z = z;
  out.yaw = yaw;
  out.bank = bank;
  out.vx = Math.sin(yaw) * j.speed;
  out.vz = Math.cos(yaw) * j.speed;
  return true;
}
