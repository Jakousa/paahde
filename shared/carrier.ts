// The hive carrier (shared/bosses.ts 'carrier'): the searchlight drones' mothership, a huge armoured hull on four
// ducted fans hovering ~75 m up. It drifts slowly across the desert (its downwash scouring a shallow trench), turns
// after anyone it sees out in the open and bombs them from its belly bay. Brain: server/carrier.ts; drawn by
// src/world/carrier.ts (model tools/blender/carrier.py), heard via src/carrierSound.ts.
//
// Shared here: the layout (where the fans and the bay are on the hull, for the brain's list and the view), the
// bomb's fall (the brain resolves the impact at the time this gives, the view draws the same path) and the numbers
// its snapshot carries (BossSnap.s, CS_*).
//
// It also launches small gun drones out of the bay (DRONE_*): each flies out to someone, circles them, and every few
// seconds stops, paints a red aim on where they stand (DRONE_CHARGE s) and fires: anyone still there is killed. It
// keeps at it until it's shot down (one hit) or there's nobody about (then it flies home to the bay); all of them
// fall when the carrier does. More of them, and
// more often, with more people about (server/bossCrowd.ts).

/** Hover height over the highest sand under it (m), and how much lower it sinks per broken fan. */
export const CARRIER_ALT = 74;
export const SINK_PER_FAN = 7;
/** Drift and chase speeds (m/s), and how fast it can turn (rad/s). */
export const CRUISE = 3.5;
export const CHASE = 6.2;
export const TURN_RATE = 0.07;
/** Sees players in the open within this horizontal distance (m); bombs when one is within BOMB_REACH. */
export const SEE_R = 260;
export const BOMB_REACH = 160;
/** A bomb every BOMB_GAP s (random within); kills within BOMB_KILL_R m; its crater (radius m, depth mm). */
export const BOMB_GAP: [number, number] = [1.8, 2.8];
export const BOMB_KILL_R = 7;
export const BOMB_CRATER_R = 5;
export const BOMB_CRATER_MM = 1500;
/** The downwash scours a shallow bowl every SCOUR_STEP m it moves (radius m, depth mm). */
export const SCOUR_STEP = 8;
export const SCOUR_R = 6.5;
export const SCOUR_MM = 320;
/** Dead: it falls this hard (m/s², less than g: it tumbles and the dead fans still bite the air), then the wreck
 *  craters (main bowl and one under each fan) and kills within CRASH_KILL_R. */
export const FALL_G = 6.5;
export const CRASH_R = 11;
export const CRASH_MM = 2400;
export const CRASH_FAN_R = 7;
export const CRASH_FAN_MM = 1200;
export const CRASH_KILL_R = 26;
export const GRAVITY = 9.8;

/** Fan (duct) centres on the hull frame (forward +Z, +X its left as three.js yaw goes), duct inner radius (m). */
export const FANS: readonly [number, number, number][] = [
  [30, 0.6, 23],
  [-30, 0.6, 23],
  [-30, 0.6, -23],
  [30, 0.6, -23],
];
export const DUCT_R = 10;
/** The bomb bay, under the hull's middle. */
export const BAY: [number, number, number] = [0, -5.6, -2];
/** Hull half extents (x, y, z m): the hit box for sparks and the brain's `near`. */
export const HULL: [number, number, number] = [18, 5.5, 30];

/** BossSnap.s for the carrier: lean (roll, pitch rad, the view's 'YXZ' Euler), velocity (m/s), the player its
 *  searchlight is on (x, z; lit 1 or 0), and once dead: where it was when it died relative to where it lands (m),
 *  how long the fall takes (s) and which way it tumbles (±1). */
export const CS_ROLL = 0, CS_PITCH = 1, CS_VX = 2, CS_VZ = 3, CS_TX = 4, CS_TZ = 5, CS_LOCK = 6;
export const CS_OX = 7, CS_OY = 8, CS_OZ = 9, CS_FALL = 10, CS_SPIN = 11;
export const CS_LEN = 12;
/** The gun drones out, after CS_LEN: DRONE_SLOTS slots of DS_LEN numbers each (out 1 or 0, position). An empty slot
 *  sits at the bay, so a new drone comes out of it in the view (positions are interpolated). */
export const DRONE_SLOTS = 8;
export const DS_ON = 0, DS_X = 1, DS_Y = 2, DS_Z = 3;
export const DS_LEN = 4;
export const CS_ALL = CS_LEN + DRONE_SLOTS * DS_LEN;

/** A gun drone: aims this long (s) at a spot before it fires there (the 'daim' bossFx), and kills anyone whose chest
 *  is within DRONE_HIT_R m of the spot when it does ('dshot'). */
export const DRONE_CHARGE = 0.9;
export const DRONE_HIT_R = 1.7;
/** Its body's radius (m), for the view. */
export const DRONE_R = 0.9;

/** The bay's centre in the world for a hull at (x, y, z) turned `yaw` (lean ignored). */
export function bayAt(x: number, y: number, z: number, yaw: number): { x: number; y: number; z: number } {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { x: x + BAY[0] * c + BAY[2] * s, y: y + BAY[1], z: z - BAY[0] * s + BAY[2] * c };
}

/** A bomb dropped at (x, y, z) with horizontal velocity (vx, vz), t s later (falls from rest vertically). */
export function bombAt(x: number, y: number, z: number, vx: number, vz: number, t: number, out: { x: number; y: number; z: number }) {
  out.x = x + vx * t;
  out.y = y - 0.5 * GRAVITY * t * t;
  out.z = z + vz * t;
  return out;
}

/** How long a bomb dropped at height y takes to reach height `ground` (s). */
export const bombFall = (y: number, ground: number) => Math.sqrt((2 * Math.max(1, y - ground)) / GRAVITY);

/** A fan's centre in the world for a hull at (x, y, z) turned `yaw` (lean ignored). */
export function fanAt(i: number, x: number, y: number, z: number, yaw: number): { x: number; y: number; z: number } {
  const [fx, fy, fz] = FANS[i];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { x: x + fx * c + fz * s, y: y + fy, z: z - fx * s + fz * c };
}
