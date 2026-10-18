// The brood queen (shared/bosses.ts): the crawlers' mother, a giant low eight-legged spider machine. What its brain
// (server/queen.ts) and its view (src/world/queen.ts) both need: the body's measurements (they must match
// tools/blender/queen.py), the legs' rest spots and gait, and the attack's numbers.
//
// Feet are the server's: it steps them (an alternating tetrapod, two groups of four), so it knows where each one
// stabs into the sand (a hole, and death to whoever is under it). The client swings the legs to them with IK.
import { heightAt } from './terrain.ts';

/** Thorax centre above the average ground under the feet (m). */
export const BODY_H = 7.2;
/** Leg segments (m): hip to knee, knee to ankle, ankle to the tip that stabs into the sand. */
export const FEMUR = 9;
export const TIBIA = 11.5;
export const TARSUS = 4.5;
/** The last segment leans out from the vertical by this much (rad): the ankle stands inward of the tip. */
export const TARSUS_LEAN = 0.42;
/** Legs: 0–3 on the +X side front to back, 4–7 on −X. Hip sockets on the thorax (body frame, +Z forward). */
export const SOCKETS: [number, number, number][] = [
  [3.7, 0.2, 3.0], [4.2, 0.2, 1.0], [4.2, 0.2, -1.0], [3.7, 0.2, -3.0],
  [-3.7, 0.2, 3.0], [-4.2, 0.2, 1.0], [-4.2, 0.2, -1.0], [-3.7, 0.2, -3.0],
];
/** Rest spots: angle from straight ahead (rad, to the leg's side) and distance from the body's centre (m). */
const REST_A = [0.62, 1.25, 1.9, 2.55];
const REST_D = [16, 15, 15, 16];
/** The tetrapod: legs 0, 2, 5, 7 step together, then 1, 3, 4, 6. */
export const GROUP = [0, 1, 0, 1, 1, 0, 1, 0];
/** The front pair (rear up and slam). */
export const FRONT = [0, 4];
export const LEGS = 8;

/** Abdomen: hung at the pedicel (body frame), drooping back by this much (rad). Its weak points are given unpitched. */
export const PEDICEL = { y: 0.4, z: -4.8 };
export const ABD_PITCH = -0.25;

/** Speeds (m/s; a player walks 7.5, so a charge can be outwalked) and turn rates (rad/s). */
export const WALK = 4;
export const CHARGE = 7.2;
export const TURN = 0.5;
export const HUNT_TURN = 1.1;
/** Notices people out in the open this close (m); gives up past GIVE_UP or after CHASE_MS without getting them. */
export const SIGHT = 160;
export const GIVE_UP = 260;
export const CHASE_MS = 60_000;
/** A stab within this (m, horizontally) of you kills. */
export const STAB_R = 2.5;
/** Each stab leaves a hole (server/terrain.ts crater: radius m, depth mm). */
export const STAB_HOLE = { r: 1.2, mm: 650 };
/** Prey within REAR_R (m, from the body's centre) and REAR_CONE (rad) of straight ahead: it rears up for REAR_MS
 *  (screeching), then slams its front feet down SLAM_FWD ahead, SLAM_SIDE either side: everyone within SLAM_R of
 *  the point between them dies, two big holes. Then it stands for RECOVER_MS. */
export const REAR_R = 23;
export const REAR_CONE = 0.6;
export const REAR_MS = 900;
export const SLAM_FWD = 15;
export const SLAM_SIDE = 3.6;
export const SLAM_R = 9;
export const SLAM_HOLE = { r: 4, mm: 1500 };
export const RECOVER_MS = 1800;
/** Dead: its body comes down in a hole this big. */
export const DEATH_HOLE = { r: 7, mm: 800 };

/** Brain modes, sent as BossSnap.s[0] with the server time they began as s[1]. */
export const ROAM = 0, HUNT = 1, REAR = 2, RECOVER = 3, LEAVE = 4;
/** BossSnap.s: mode, since (server ms), then per leg x, y (tip), z, s of swing left (−1: held up). */
export const S_FEET = 2;

/** The gait: a stride (m) and swing time (s) for speed v; a foot further than SETTLE (m) from its spot settles. */
export const stride = (v: number) => 5 + 0.5 * v;
export const swingTime = (v: number) => Math.min(0.9, Math.max(0.45, stride(v) / (2 * Math.max(0.5, v))));
export const SETTLE = 1.2;
export const SETTLE_S = 0.8;

/** Leg i's rest spot for a body at (x, z) facing yaw, into out (x, z). */
export function restSpot<T extends { x: number; z: number }>(x: number, z: number, yaw: number, i: number, out: T): T {
  const k = i % 4, side = i < 4 ? 1 : -1;
  const lx = Math.sin(REST_A[k]) * REST_D[k] * side, lz = Math.cos(REST_A[k]) * REST_D[k];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out.x = x + lx * c + lz * s;
  out.z = z - lx * s + lz * c;
  return out;
}

/** Where a tip stabs at (x, z): into the sand, so a little below it. */
export const stabY = (x: number, z: number) => heightAt(x, z) - 0.3;

/** The two slam points of a body at (x, z) facing yaw: [x0, z0, x1, z1]. */
export function slamPoints(x: number, z: number, yaw: number): [number, number, number, number] {
  const fx = Math.sin(yaw), fz = Math.cos(yaw), sx = fz, sz = -fx;
  const cx = x + fx * SLAM_FWD, cz = z + fz * SLAM_FWD;
  return [cx + sx * SLAM_SIDE, cz + sz * SLAM_SIDE, cx - sx * SLAM_SIDE, cz - sz * SLAM_SIDE];
}

// --- The brood: spiderlings it drops from its sac while it fights (server/queen.ts simulates them) ---

/** After the feet, BossSnap.s[S_BROOD] is the rear's length (ms, shorter against a crowd), s[S_BROOD + 1] when its
 *  sac last began to open (server ms, 0 never), then BROOD_N numbers per spiderling: id, x, z, yaw, state, since
 *  (server ms). */
export const S_BROOD = S_FEET + LEGS * 4;
export const BROOD_N = 6;
/** Never more than this many out at once, however many people. */
export const BROOD_CAP = 16;
/** Spiderling states: dropping out of the sac, running, crouched to spring, in the air, landed (getting up), dying. */
export const SP_DROP = 0, SP_RUN = 1, SP_CROUCH = 2, SP_LEAP = 3, SP_REST = 4, SP_DIE = 5;
/** The sac opens for BIRTH_MS (glowing, pulsing), then the clutch drops out from under it (body frame: BIRTH_Z
 *  along, BIRTH_Y down from the thorax centre), each falling for DROP_MS. */
export const BIRTH_MS = 1400;
export const BIRTH_Z = -13;
export const BIRTH_Y = -2.2;
export const DROP_MS = 650;
/** Running speed (m/s): faster than a walk (7.5), slower than a sprint (11). */
export const SP_SPEED = 8.4;
/** Once where its prey will be is within LEAP_MAX (m) (or the prey is within LEAP_R), it crouches CROUCH_MS (a sharp
 *  rattle), then springs there in LEAP_MS: whoever is within LEAP_HIT (m) of where it lands dies. Then it gets up
 *  for REST_MS. */
export const LEAP_R = 2.5;
export const LEAP_MAX = 9;
export const LEAP_HIT = 1.5;
export const CROUCH_MS = 380;
export const LEAP_MS = 340;
export const REST_MS = 900;
/** Shot (one hit) or its mother dead, it curls up over DIE_MS. Nothing else ends it. */
export const DIE_MS = 1400;
/** Body height over the sand (m). */
export const SP_BODY_Y = 0.55;
