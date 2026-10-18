// Fixed-wing drones ("jets"): big, high and fast, by day and by night. No lights and no searchlight; they only fly
// over, but can be shot (JET_HP hits, shared/rifle.ts): the last one kills the engine and it glides down to the sand,
// where the wreck smokes for WRECK_MS. The server (server/jets.ts) now and then sends one past a random player and broadcasts the list;
// like the sandstorms (shared/storm.ts) the rest is plain math on that list and the server clock, so both sides agree
// where each one is. Drawn by src/world/jets.ts, heard via src/guardianSound.ts (jets).
//
// A flight is a straight run in, an arc of a big circle (none: a straight pass) and a straight run out, at a steady
// speed and height. It starts and ends far out of sight (LEAD m beyond where it turns or passes). Once shot down the
// server adds `down`: from where it was then, a straight glide along its heading to where that line meets the sand.

import { baseHeight } from './terrain.ts';

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
  /** Server-clock ms it enters; it leaves at start + length / speed (shot down: the wreck goes WRECK_MS after landing). */
  start: number;
  end: number;
  /** Rifle hits taken. */
  hurt: number;
  /** Shot down at server time `at` at (x, y, z) heading `yaw`; it glides to (lx, ly, lz), landing at `land`. `soft`:
   *  jammed (shared/jammer.ts), not shot: it drops into a flat spin, falling steeply, and lands whole on its belly, no smoke. */
  down?: { at: number; x: number; y: number; z: number; yaw: number; land: number; lx: number; ly: number; lz: number; soft?: true };
};

/** Hits that bring one down. */
export const JET_HP = 3;
/** Shot down: it glides at this share of its speed, dropping 1 m for every GLIDE m forward. */
export const GLIDE_SPEED = 0.8;
export const GLIDE = 5;
/** Jammed: it falls like a plane that's lost its controls. Its way along its heading bleeds off from full speed to
 *  SPIN_KEEP of it (time constant SPIN_SLOW s), it sinks faster and faster towards SPIN_SINK m/s (SPIN_FALL s, like
 *  falling with drag), and it spins flat, the spin tightening with the sink up to SPIN_RATE rad/s. */
const SPIN_KEEP = 0.25;
const SPIN_SLOW = 2.5;
const SPIN_SINK = 45;
const SPIN_FALL = 3;
const SPIN_RATE = 2.8;
/** How far along its heading (m), how far down (m) and how far round (rad) a jammed jet is `s` seconds on. */
export function jetSpin(speed: number, s: number) {
  const ease = (k: number) => s - k * (1 - Math.exp(-s / k));
  return {
    fwd: speed * (SPIN_KEEP * s + (1 - SPIN_KEEP) * (s - ease(SPIN_SLOW))),
    drop: SPIN_SINK * ease(SPIN_FALL),
    turn: SPIN_RATE * ease(SPIN_FALL),
    v: speed * (SPIN_KEEP + (1 - SPIN_KEEP) * Math.exp(-s / SPIN_SLOW)),
    w: 1 - Math.exp(-s / SPIN_FALL),
  };
}
/** The wreck lies on the sand this long (ms) before it's cleared. */
export const WRECK_MS = 90_000;

/** Wingspan (m): a searchlight drone is about 2. */
export const JET_SPAN = 18;
/** Server hit test: the shot must pass this close (m) to its centre (it's JET_SPAN wide). */
export const JET_HIT = JET_SPAN / 2 + 3;
/** Height above the sand (m) and speed (m/s) a flight picks from. */
export const JET_ALT_MIN = 110;
export const JET_ALT_MAX = 180;
export const JET_SPEED_MIN = 60;
export const JET_SPEED_MAX = 90;
/** Straight run before and after the part near the players (m): out of sight at both ends. */
export const LEAD = 3000;
/** Bank in a turn (rad; a coordinated turn's, at most MAX_BANK), eased in and out over BANK_EASE m of the arc. */
const G = 9.81;
const MAX_BANK = 0.7;
const BANK_EASE = 250;

/** The flight's path length (m). */
export const jetLength = (j: Pick<Jet, 'run' | 'turn' | 'r' | 'out'>) => j.run + Math.abs(j.turn) * j.r + j.out;

/** `pitch`: nose up (rad); `state`: 0 flying, 1 gliding down, 2 a wreck on the sand. */
export type JetPose = { x: number; y: number; z: number; yaw: number; bank: number; pitch: number; vx: number; vz: number; state: number };

export const jetPose = (): JetPose => ({ x: 0, y: 0, z: 0, yaw: 0, bank: 0, pitch: 0, vx: 0, vz: 0, state: 0 });

/** Where jet `j` is at server time `t` (ms), into `out`; false before it enters or after it leaves. */
export function jetAt(j: Jet, t: number, out: JetPose): boolean {
  if (t < j.start || t > j.end) return false;
  if (j.down && t >= j.down.at) return downAt(j, t, out);
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
  out.pitch = 0;
  out.state = 0;
  return true;
}

/** Shot down: gliding in, nose dipping and rolling over as it goes, then the wreck, nose in and on one wing. */
function downAt(j: Jet, t: number, out: JetPose): boolean {
  const d = j.down!, u = Math.min(1, (t - d.at) / Math.max(1, d.land - d.at));
  out.x = d.x + (d.lx - d.x) * u;
  out.y = d.y + (d.ly - d.y) * u;
  out.z = d.z + (d.lz - d.z) * u;
  out.yaw = d.yaw;
  const s = (t - d.at) / 1000;
  if (d.soft) {
    // Jammed: it carries on along its heading, slowing, while it drops faster and faster and spins flat, tighter as
    // it falls, nose dipping and wings see-sawing; then it sits on the sand whole, on its belly, facing wherever the
    // spin left it.
    const f = Math.min(s, (d.land - d.at) / 1000), m = jetSpin(j.speed, f);
    out.x = d.x + Math.sin(d.yaw) * m.fwd;
    out.z = d.z + Math.cos(d.yaw) * m.fwd;
    out.y = d.y - m.drop;
    out.yaw = d.yaw + (j.id % 2 ? 1 : -1) * m.turn;
    if (u >= 1) {
      out.y = baseHeight(out.x, out.z) + 0.6;
      out.bank = 0;
      out.pitch = 0.03;
      out.vx = out.vz = 0;
      out.state = 2;
      return true;
    }
    // Wound up with the fall, levelling off over the last half second so it sits down flat.
    const w = Math.min(m.w * 1.5, 1, (d.land - t) / 500);
    out.bank = w * (0.25 + 0.2 * Math.sin(s * 5 + j.id));
    out.pitch = -w * (0.45 + 0.1 * Math.sin(s * 3.7));
    const v = m.v;
    out.vx = Math.sin(d.yaw) * v;
    out.vz = Math.cos(d.yaw) * v;
    out.state = 1;
    return true;
  }
  // A slow wallow in roll that grows, the nose sagging below the glide path.
  out.bank = (0.15 + 0.35 * u) * Math.sin(s * 0.9 + j.id) + 0.25 * u;
  out.pitch = -Math.atan(1 / GLIDE) - 0.15 * u;
  if (u >= 1) {
    out.y += 0.4; // half sunk, nose in
    out.bank = 0.35;
    out.pitch = -0.12;
    out.vx = out.vz = 0;
    out.state = 2;
    return true;
  }
  const v = j.speed * GLIDE_SPEED;
  out.vx = Math.sin(d.yaw) * v;
  out.vz = Math.cos(d.yaw) * v;
  out.state = 1;
  return true;
}
