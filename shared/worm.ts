// The Borer: a mechanical worm about two hundred metres long that swims through the dunes (shared/bosses.ts 'worm';
// brain server/worm.ts, view src/world/worm.ts, model tools/blender/worm.py).
//
// It moves the way Terraria's worms do, the classic recipe for a burrowing worm: only the head is simulated, and every
// body segment sits a fixed distance behind the one before it along the path the head took ("follow the leader").
// Under the sand the head steers: it turns towards where it wants to go at most TURN rad/s and speeds up or slows
// towards its cruise speed. Out of the sand nothing holds it up: gravity bends the leap into an arc and it plunges back
// in, the body pouring out of the hole after it and back into the sand along the same arc.
//
// It roams deep under the dunes, now and then running just under the surface with its back breaking the sand (a
// furrow behind it). It can't swim through rock (shared/rocks.ts): it turns away from it, and anyone standing on rock
// (or on sand thinly over it) is out of its reach. Someone out on the sand within NOTICE_R draws it. Some hunts it
// closes in deep, and once under them it rises and bursts out of the sand (the sand shivers first: get moving),
// swallowing anyone near its head; others it comes half out of the sand, its back ploughing a furrow, and charges
// straight through them, jaws open (step aside); and now and then, a way off, it bursts out short of them and flies a
// huge arc high over the desert, firing missiles out of its back (server/worm.ts salvo). The weak points sit on its back and can only be shot while out of the sand.

/** Body segments behind the head and their spacing along the path (m). */
export const SEGS = 44;
export const SEG_LEN = 4.4;
/** Body radius (m) at the front; the last TAPER segments thin down to TIP of that. */
export const RADIUS = 3.6;
export const TAPER = 12;
export const TIP = 0.4;
/** Head radius (m): the maw's rim. */
export const HEAD_R = 4.2;

/** Radius scale of segment i (0 the first behind the head). */
export function segScale(i: number): number {
  const k = i - (SEGS - TAPER);
  return k < 0 ? 1 : 1 - (1 - TIP) * ((k + 1) / TAPER);
}

/** The segments carrying a weak point, on the top of the segment (BOSSES.worm.points of them). */
export const POINT_SEGS = [3, 9, 15, 21, 27, 33];
/** Weak point lens radius (m). */
export const POINT_R = 1.1;

/** Steering under the sand: turn rate (rad/s) and how fast it gets up to speed (m/s²); speeds (m/s). Gravity out of it. */
export const TURN = 1.1;
export const RISE_TURN = 2.6;
export const ACCEL = 9;
export const ROAM_SPEED = 9;
export const HUNT_SPEED = 17;
export const RISE_SPEED = 36;
export const GRAVITY = 15;
/** It notices someone out on the sand this close (m). */
export const NOTICE_R = 200;
/** Before it bursts out, the sand over it shivers this long (s, one player; a crowd gets less): the time to run. */
export const TELL = 1.3;

/** BossSnap.s for the worm: [mode, then (x, y, z) of each segment relative to the head]. */
export const MODE_ROAM = 0, MODE_HUNT = 1, MODE_RISE = 2, MODE_AIR = 3, MODE_DIVE = 4, MODE_LUNGE = 5;
