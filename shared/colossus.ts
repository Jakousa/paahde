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

/** BossSnap.s for the colossus: per foot (0, 1) its spot x, y, z, seconds left of its swing (0 planted) and the
 *  swing's kind (0 a step, 1 the big stomp); then its mood (MOOD_*), where it looks (x, z), and the fall's yaw. */
export const S_FOOT = 5;
export const S_MOOD = 10;
export const S_LOOK = 11;
export const S_FALL = 13;
export const MOOD_ROAM = 0, MOOD_HUNT = 1, MOOD_STOMP = 2;
