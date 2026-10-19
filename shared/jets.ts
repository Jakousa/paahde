// Fixed-wing drones ("jets"): big, high and fast, by day and by night. No lights and no searchlight; they only fly
// over, but can be shot (JET_HP hits, shared/rifle.ts): the last one kills the engine and it dives into the sand,
// where the wreck smokes for WRECK_MS. The server (server/jets.ts) now and then sends one past a random player and broadcasts the list;
// like the sandstorms (shared/storm.ts) the rest is plain math on that list and the server clock, so both sides agree
// where each one is. Drawn by src/world/jets.ts, heard via src/guardianSound.ts (jets).
//
// A flight is a straight run in, an arc of a big circle (none: a straight pass) and a straight run out, at a steady
// speed and height. It starts and ends far out of sight (LEAD m beyond where it turns or passes). Once brought down
// (shot or jammed) the server adds `down`: from where it was then it dives along its heading (jetDive) until its nose
// meets the sand, and the wreck stays there nose in, tail up.

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
  /** Brought down at server time `at` at (x, y, z) heading `yaw`; its nose hits the sand near (lx, ly, lz) at `land`.
   *  `soft`: jammed (shared/jammer.ts), not shot: it rolls over harder as it dives, a thin trail instead of smoke. */
  down?: { at: number; x: number; y: number; z: number; yaw: number; land: number; lx: number; ly: number; lz: number; soft?: true };
};

/** Hits that bring one down. */
export const JET_HP = 3;
/** Down (shot or jammed) it falls like a plane, not a drone: it keeps its way, the nose drops towards DIVE_PITCH
 *  (time constant DIVE_TIP s; slower shot, the wings still flying it a while) and the path follows the nose, gaining
 *  DIVE_ACCEL m/s every second, while it rolls over about its length, winding up to ROLL rad/s over ROLL_RAMP s. */
const DIVE_PITCH = 1.25;
const DIVE_TIP = 2.2;
const SHOT_TIP = 3.4;
const DIVE_ACCEL = 9;
const ROLL = 2.4;
const SHOT_ROLL = 0.9;
const ROLL_RAMP = 2.5;
/** The integration step (s): the same steps on both sides, so they agree. */
export const DIVE_STEP = 0.05;
/** Nose ahead of the centre (m), and how deep it ploughs into the sand past where it first touches (m). */
export const JET_NOSE = 15;
const BURY = 4;
export type Dive = { fwd: number; drop: number; pitch: number; roll: number; v: number };
const _dv: Dive = { fwd: 0, drop: 0, pitch: 0, roll: 0, v: 0 };
/** How far along its heading (m) and down (m) a downed jet is `s` s on, its pitch (rad, nose up) and roll, and speed. */
export function jetDive(speed: number, s: number, soft: boolean, out: Dive = _dv): Dive {
  const tip = soft ? DIVE_TIP : SHOT_TIP;
  const pitch = (t: number) => -DIVE_PITCH * (1 - Math.exp(-t / tip));
  let fwd = 0, drop = 0, t = 0;
  // Midpoint steps: fixed DIVE_STEP, then the bit left over.
  while (t < s) {
    const h = Math.min(DIVE_STEP, s - t), m = t + h / 2, v = speed + DIVE_ACCEL * m, th = pitch(m);
    fwd += v * Math.cos(th) * h;
    drop -= v * Math.sin(th) * h;
    t += h;
  }
  out.fwd = fwd;
  out.drop = drop;
  out.pitch = pitch(s);
  out.roll = (soft ? ROLL : SHOT_ROLL) * (s - ROLL_RAMP * (1 - Math.exp(-s / ROLL_RAMP)));
  out.v = speed + DIVE_ACCEL * s;
  return out;
}
/** The wreck on the sand: the dive at the moment its nose touched, pushed BURY m on along its nose. */
export function jetWreck(speed: number, landS: number, soft: boolean, out: Dive = _dv): Dive {
  jetDive(speed, landS, soft, out);
  out.fwd += BURY * Math.cos(out.pitch);
  out.drop -= BURY * Math.sin(out.pitch);
  out.v = 0;
  return out;
}
/** The flight's own wreck lies on the sand this long (ms) before it is handed over to the crash site (shared/jetcrash.ts), which stays. */
export const WRECK_MS = 3_000;

/** Wingspan (m): a searchlight drone is about 2. The plane (tools/blender/machines/plane.py) is modelled at this size. */
export const JET_SPAN = 32;
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

/** Down: diving in, nose dropping and rolling over (jetDive); then the wreck, nose buried, tail up, as it hit. */
function downAt(j: Jet, t: number, out: JetPose): boolean {
  const d = j.down!, landS = (d.land - d.at) / 1000, s = (t - d.at) / 1000, soft = !!d.soft;
  const m = s >= landS ? jetWreck(j.speed, landS, soft) : jetDive(j.speed, s, soft);
  out.x = d.x + Math.sin(d.yaw) * m.fwd;
  out.y = d.y - m.drop;
  out.z = d.z + Math.cos(d.yaw) * m.fwd;
  out.yaw = d.yaw;
  out.pitch = m.pitch;
  out.bank = (j.id % 2 ? 1 : -1) * m.roll;
  const h = m.v * Math.cos(m.pitch);
  out.vx = Math.sin(d.yaw) * h;
  out.vz = Math.cos(d.yaw) * h;
  out.state = s >= landS ? 2 : 1;
  return true;
}
