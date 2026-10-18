// The colossus (shared/bosses.ts): a 67 m bipedal war machine with a furnace in its chest. What its brain
// (server/colossus.ts) and its view (src/world/colossus.ts) both need: the rig's measurements (the model,
// tools/blender/colossus.py, is built to them), the gait, the stomps, and the snapshot layout.
//
// Coordinates are three.js: forward = (sin yaw, cos yaw), body-local +X = (cos yaw, −sin yaw). Leg/foot 0 is the
// +X one, leg 1 the −X one.

/** Hips over the ground under the feet (m), walking: the knees a little bent. */
export const HIP_H = 38.5;
/** Hip sockets at pelvis-local (±HIP_X, 0, 0); the waist (the torso's origin) at (0, WAIST_Y, 0). */
export const HIP_X = 6.5;
export const WAIST_Y = 3.2;
/** Thigh (hip → knee) and shin (knee → ankle) lengths, and the ankle over the sole (m). */
export const THIGH = 19;
export const SHIN = 20;
export const ANKLE_H = 3;
/** Torso-local shoulder sockets (±x, y, 0) and the neck (the head's origin). */
export const SHOULDER_X = 13.5;
export const SHOULDER_Y = 15.5;
export const NECK: [number, number, number] = [0, 20, 0.5];
/** Arms hang along −Y: shoulder → elbow, elbow → wrist. */
export const UPPER_ARM = 14;
export const FOREARM = 13;
/** Where its weak points sit (shared/bosses.ts BOSSES.colossus.points = 5): 0 the chest core (torso-local, facing +Z),
 *  1 and 2 the knees (shin-local, on the kneecap's underside facing the shin's front +Y), 3 and 4 the exhaust stacks on
 *  its back (torso-local, facing up and back). Radii (m). */
export const CORE: [number, number, number] = [0, 9.5, 9.2];
export const CORE_R = 3;
export const KNEE: [number, number, number] = [0, 3.1, 3.8];
export const KNEE_R = 1.8;
export const VENT: [number, number, number] = [6.95, 21.3, -12.95];
/** The +X stack's opening faces this way (torso-local, unit); the other one's is mirrored. */
export const VENT_DIR: [number, number, number] = [0.171, 0.901, -0.398];
export const VENT_R = 2.1;

/** Feet rest this far out to each side (m). */
export const FOOT_X = 7;
/** Walking speed (m/s), slowed (× down to TURN_SLOW) while turning hard; turn rate (rad/s) roaming and hunting. */
export const WALK = 3.6;
export const TURN_SLOW = 0.35;
export const TURN_RATE = 0.09;
export const HUNT_TURN_RATE = 0.16;
/** A planted foot steps once its rest spot is STEP_AT m away (SETTLE standing still), after both feet have been down
 *  DOUBLE_S; a swing takes SWING_S (SETTLE_S settling), landing half a swing's travel ahead of its rest spot. A step
 *  of STRIDE m (the foot's travel) is a full-weight footfall. */
export const STEP_AT = 11;
export const SETTLE = 3;
export const DOUBLE_S = 0.35;
export const SWING_S = 2.3;
export const SETTLE_S = 2.6;
export const STRIDE = 24;
/** Every footfall: kills within STEP_KILL_R (m) of the foot, and digs a crater STEP_CRATER_R wide and STEP_CRATER_MM
 *  deep (less for a small step). */
export const STEP_KILL_R = 12;
export const STEP_CRATER_R = 9.5;
export const STEP_CRATER_MM = 2800;

/** The big stomp, close to its prey (within STOMP_NEAR m): the foot rises for RAISE_S to BIG_LIFT m over the spot,
 *  holds there HOLD_S (the tell: a hiss, the glow), slams down in SLAM_S. It aims at its prey while raising, then
 *  the spot is set. Kills within BIG_KILL_R, crater BIG_CRATER_R wide and BIG_CRATER_MM deep. Not again for
 *  STOMP_GAP_S; it stands RECOVER_S after. The spot is at most STOMP_REACH from its hips (horizontally). Fair: from
 *  the moment the spot is set, walking (7.5 m/s, no sprint) gets you HOLD_S + SLAM_S = 2.05 s ≈ 15 m, past BIG_KILL_R.
 *  A step's spot is known a whole swing (SWING_S ≈ 17 m of walking) before it lands, past STEP_KILL_R. */
export const STOMP_NEAR = 26;
export const RAISE_S = 1.8;
export const HOLD_S = 1.6;
export const SLAM_S = 0.45;
export const BIG_S = RAISE_S + HOLD_S + SLAM_S;
export const BIG_LIFT = 15;
export const BIG_KILL_R = 14;
export const BIG_CRATER_R = 12;
export const BIG_CRATER_MM = 3500;
export const STOMP_GAP_S = 8;
export const RECOVER_S = 1.2;
export const STOMP_REACH = 22;

/** Dying: the knees buckle for BUCKLE_S, then it topples like a tower and hits the sand FALL_S after it died, lying
 *  along its fall direction from FALL_FROM to FALL_TO m out from where it stood; the wreck sinks in at the end. */
export const BUCKLE_S = 1.3;
export const FALL_S = 4.8;
export const FALL_FROM = 12;
export const FALL_TO = 66;

/** The client draws the bosses this far in the past (src/world/botFrames.ts BOT_DELAY_MS): footfalls (their craters
 *  and kills) happen on the server this much later than the foot comes down, so they line up with what's seen. */
export const SEEN_LAG_MS = 250;

/** The shoulder salvo, only against a crowd (server/bossCrowd.ts: two or more people near it; the more, the bigger and
 *  the more often): the pods on its shoulders open and their lamps blink for SALVO_TELL_S (a klaxon), then a missile
 *  every SALVO_STAGGER_S, alternating shoulders, each at someone a little way off (MISSILE_MIN..MISSILE_MAX m), aimed
 *  where they're heading (half their speed's lead, a little scatter). A missile climbs out of its pod and arcs down
 *  over missileT(d) seconds, its landing spot glowing on the sand the whole way: kills within MISSILE_KILL_R. Fair:
 *  the shortest flight (MISSILE_T0 + MISSILE_MIN / MISSILE_V ≈ 3.2 s) is ≈ 24 m of walking. */
export const SALVO_TELL_S = 1.6;
export const SALVO_STAGGER_S = 0.22;
export const MISSILE_MIN = 35;
export const MISSILE_MAX = 320;
export const MISSILE_T0 = 2.8;
export const MISSILE_V = 90;
export const MISSILE_KILL_R = 6.5;
export const MISSILE_CRATER_R = 5;
export const MISSILE_CRATER_MM = 1400;
/** The pods: torso-local top centre of each (±x), on the upper back behind the pauldrons, the tubes facing up. */
export const POD: [number, number, number] = [12, 21, -11];

/** A missile's flight time (s) to a spot `d` m away (flat); a hand rocket's (faster, flatter). */
export const missileT = (d: number, hand = false) => (hand ? HAND_T0 + d / HAND_V : MISSILE_T0 + d / MISSILE_V);

/** The hand volley, at its prey whoever it's up against (one player too): the arm on their side swings up and points
 *  at them while the palm glows and whines for VOLLEY_TELL_S, then VOLLEY_SHOTS rockets (more for a crowd) leave the
 *  hand every VOLLEY_STAGGER_S, each on a low arc to where they'd be (no lead, then more and more: running straight
 *  doesn't dodge them all, turning does), the same burst as a missile. Only at someone VOLLEY_MIN..VOLLEY_MAX m off,
 *  not under its feet (that's what stomps are for). Fair: the shortest flight (HAND_T0 + VOLLEY_MIN / HAND_V ≈ 2.6 s)
 *  is ≈ 19 m of walking, its spot glowing the whole way. HAND_L: the forearm's origin (the elbow) to the palm (m). */
export const VOLLEY_TELL_S = 1.3;
export const VOLLEY_STAGGER_S = 0.4;
export const VOLLEY_SHOTS = 3;
export const VOLLEY_MIN = 32;
export const VOLLEY_MAX = 300;
export const HAND_T0 = 2.2;
export const HAND_V = 110;
export const HAND_L = 15;

/** A missile's position `t` s after leaving (x0, y0, z0) for (x1, y1, z1), landing at T: up out of the pod, over in an
 *  arc (higher for a longer shot), and down onto the spot; a hand rocket flies out along a low arc. */
export function missileAt(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, T: number, t: number, out: { x: number; y: number; z: number }, hand = false) {
  const u = Math.max(0, Math.min(1, t / T));
  // Across slowly at first (it climbs out), fastest coming down; a hand rocket leaves fast.
  const e = hand ? u * (1.25 - 0.25 * u) : u * u * (1.6 - 0.6 * u);
  const apex = hand ? 6 + Math.hypot(x1 - x0, z1 - z0) * 0.08 : 30 + Math.hypot(x1 - x0, z1 - z0) * 0.25;
  out.x = x0 + (x1 - x0) * e;
  out.z = z0 + (z1 - z0) * e;
  out.y = y0 + (y1 - y0) * u * u + apex * Math.sin(Math.PI * u);
  return out;
}

/** BossSnap.s for the colossus: per foot (0, 1) its spot x, y, z, seconds left of its swing (0 planted) and the
 *  swing's kind (0 a step, 1 the big stomp); then its mood (MOOD_*), where it looks (x, z), the fall's yaw, and the
 *  pods (1 open: a salvo coming or under way, 0 shut); the hand volley's arm (1 the +X one, −1 the −X one, 0 none)
 *  and where it points (x, z). */
export const S_FOOT = 5;
export const S_MOOD = 10;
export const S_LOOK = 11;
export const S_FALL = 13;
export const S_PODS = 14;
export const S_ARM = 15;
export const S_AIM = 16;
export const MOOD_ROAM = 0, MOOD_HUNT = 1, MOOD_STOMP = 2;
