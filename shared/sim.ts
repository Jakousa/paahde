// Deterministic movement simulation shared by client (prediction) and server (authority).
// Both sides must step with the same fixed DT and the same inputs, or prediction will drift.
// World axes: Y is up, the ground is the heightfield in terrain.ts.
//
// Sand feel:
// - Slope-aware speed: walking uphill is a slog, downhill is a little quicker.
// - Slip faces steeper than the angle of repose (~34°) avalanche: you slide down them and can only steer
//   sideways; trying to climb one just slows the slide.
// - No sprint: Shift is a speed slide (Deadshot-style). A press throws you into a fast slide that coasts on
//   low friction; a tap slides a short way, holding rides it until it slows. Downhill speeds you up, uphill
//   bleeds it off; steering only bends your heading. Jump out of it to keep the speed, then slide again on
//   landing (hold Shift in the air to slide the moment you touch down). Ctrl / C crouches.
// - Soft sand: you build up and lose speed a bit slowly (momentum), and hard landings bog you down briefly.
// - Rock (shared/rocks.ts) holds: bare rock up to ROCK_CLIMB_TAN doesn't slide; steeper rock is a wall you
//   can't walk up, only jump onto. Off its edge you fall or slide.
// - Sand bike (a motorcycle standing in the world, shared/vehicles.ts): see stepBike() below.
import { BUNKER_SPAWN, baseCeiling, collideBase, collideOutdoor } from './base.ts';
import { collideShelter, sandHidden, shelterCeiling } from './shelters.ts';
import { collideCrash } from './crashsites.ts';
import { collideMachines } from './machineBoxes.ts';
import { collideJetWrecks } from './jetcrash.ts';
import { bikeEngine, bikeTopSpeed } from './gear.ts';
import { GUARDIAN, KINDS, LEG_POST_H, LEG_POST_R } from './guardians.ts';
import { collideScrap } from './scrap.ts';
import { collideTrophies } from './trophies.ts';
import { collideShip, shipSpawn } from './ship.ts';
import { WIND } from './dunes.ts';
import { heightAt, onRock } from './terrain.ts';

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export const PLAYER_HEIGHT = 1.8; // y is the player's feet
/** Horizontal collision radius against scrap (shared/scrap.ts). */
export const PLAYER_RADIUS = 0.35;
/** Scrap whose top is at most this far above the feet is stepped onto instead of blocking. */
export const STEP_UP = 0.35;
const GRAVITY = -25;
export const WALK_SPEED = 7.5;
/** No sprint any more: the speed where "fast" effects (FOV kick, being winded) are in full swing, reached by sliding. */
export const SPRINT_SPEED = 11;
const ACCEL = 38; // ground acceleration towards the wanted velocity (m/s²)
const BRAKE = 28; // ground deceleration with no input: sand lets you skid a little
const AIR_ACCEL = 12;
const JUMP_SPEED = 9;
const AIR_JUMP_SPEED = 8;
const AIR_JUMPS = 1; // double jump
const MAX_FALL = -50;

// Slopes. `rise` is the slope (tan of the angle) along the movement direction.
const UPHILL_DRAG = 1.6; // speed factor uphill = 1 / (1 + UPHILL_DRAG * rise)
const DOWNHILL_BOOST = 0.35; // speed factor downhill = 1 + DOWNHILL_BOOST * min(-rise, 0.6)
/** tan(30°): just under the dunes' 32° slip faces (shared/dunes.ts), so they slide. Steeper ground is a slip face. */
export const SLIP_TAN = 0.58;
const SLIDE_FRICTION = 0.45; // kinetic friction of a sliding sand layer (lower than the static 0.67)
const SLIDE_PUSH = 3; // extra downhill shove (m/s²) so a slip face always moves you
const SLIDE_CONTROL = 0.45; // fraction of normal speed you can steer with while sliding
/** tan(52°): bare rock up to this steep is scrambled up without sliding; steeper rock is a wall. */
export const ROCK_CLIMB_TAN = 1.3;
const SLIDE_ACCEL = 8; // steering accel on a slip face; below the slide pull on anything much steeper than 34°
const MAX_GROUND_SPEED = 18;

// Speed slide (Shift).
const SLIDE_MIN_START = 1.5; // m/s needed to start one without a direction held
const SLIDE_MIN_KEEP = WALK_SPEED; // the slide ends when it slows to a run
const SLIDE_SPEED = 15; // a slide starts at least this fast...
const SLIDE_BOOST = 3; // ...or this much faster than you were going (up to MAX_GROUND_SPEED)
const SLIDE_TAP_TICKS = 36; // a tap slides this long; holding Shift keeps it going until it slows
const SLIDE_COOLDOWN = 45; // ticks from the start of one slide to the next (>= SLIDE_TAP_TICKS)
const SLIDE_DECEL = 9; // flat-sand friction while sliding (m/s²); steep downhill beats it
const SLIDE_GRAVITY = 0.9; // fraction of gravity along the slope that acts on a slide
const SLIDE_TURN = 1.6; // rad/s the heading can swing towards the input

// Ctrl / C crouches: slow, short careful steps (src/models/crouchGait.ts strides to it).
export const CROUCH_SPEED = 2;
/** Speed lost on foot at full sandstorm strength (shared/storm.ts), whichever way you go. The storm's strength passed
 *  to step() goes past 1 in a front (stormDrag, FRONT_PUSH): that pushes harder but slows no more. */
const STORM_SLOW = 0.2;
/** The storm pushes downwind (WIND, the way storms drift): this much (m/s) added to the velocity you're
 *  steering towards on the ground at full strength, so you drift standing still and lose it walking into it;
 *  in the air, sliding and on the bike it is an acceleration (m/s²) instead. */
const STORM_PUSH = 2;
const STORM_PUSH_ACCEL = 4;
const STORM_PUSH_BIKE = 3;

// Landing.
const HARD_LANDING = 13; // impact speed (m/s) above which a landing bogs you down
const LAND_SLOW = 0.4; // speed factor right after a hard landing, recovering linearly
const MAX_LAND_TICKS = 24;

/** Where new players start: at the foot of the crashed ship's ramp (shared/ship.ts); in the dev test lab, which has no
 *  ship, down in the bunker (the server puts them in the lab's room). */
export function spawnPoint(): { x: number; z: number } {
  return shipSpawn() ?? BUNKER_SPAWN;
}

export type PlayerState = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  facing: number; // radians, direction the body faces (= camera yaw, first person)
  grounded: boolean;
  airJumps: number; // air jumps left; refilled on landing
  jumpHeld: boolean; // jump was down last tick, so an air jump needs a fresh press
  landTicks: number; // ticks of hard-landing recovery left (integer)
  sliding: boolean; // in a speed (Shift) slide
  crouching: boolean; // Ctrl / C held on the ground without sliding
  slideCool: number; // ticks until another slide can start (integer)
  slideSpent: boolean; // this Shift press already started a slide: the next one needs a fresh press
  riding: boolean; // on the sand bike (stepBike)
  bikeHeld: boolean; // the bike key was down last tick, so getting off needs a fresh press
  heading: number; // the bike's heading (radians, same convention as facing); the body faces it while riding
  bike: number; // the motorcycle being ridden (shared/gear.ts bikeLevel): 0 none, else 1 + its quality; set by the server
  nose: number; // the bike's pitch (rad, + = nose up): along the sand on the ground, steered by throttle/brake in the air
  noseSpin: number; // how fast it is pitching (rad/s), in the air
};

// Input is a bitmask so it is tiny on the wire and trivially comparable.
export const FORWARD = 1;
export const BACK = 2;
export const LEFT = 4;
export const RIGHT = 8;
export const JUMP = 16;
export const CROUCH = 32; // Ctrl / C: crouch
// 64 and 128 were dig and pile (no digging now): free.
export const SLIDE = 256; // Shift: speed slide
export const BIKE = 512; // Z / 9 (or F while riding): get off the motorcycle
export const INPUT_MASK = 1023;

// Camera yaw is sent with every input, quantized to 16 bits so client and server agree exactly.
export const YAW_STEPS = 65536;
export function quantizeYaw(yaw: number): number {
  const q = Math.round((yaw / (Math.PI * 2)) * YAW_STEPS) % YAW_STEPS;
  return q < 0 ? q + YAW_STEPS : q;
}
export function yawFromQ(q: number): number {
  return (q / YAW_STEPS) * Math.PI * 2;
}

/** The sand's height as ground for feet that were at `prevY`: none inside the base's or a shelter's entrance and rooms. */
function sandAt(x: number, z: number, prevY: number): number {
  return sandHidden(x, z, prevY) ? -Infinity : heightAt(x, z);
}

export function spawnState(x = spawnPoint().x, z = spawnPoint().z, y = x === BUNKER_SPAWN.x && z === BUNKER_SPAWN.z ? BUNKER_SPAWN.y : heightAt(x, z)): PlayerState {
  return {
    x, y, z, vx: 0, vy: 0, vz: 0, facing: 0,
    grounded: true, airJumps: AIR_JUMPS, jumpHeld: false, landTicks: 0,
    sliding: false, crouching: false, slideCool: 0, slideSpent: false, riding: false, bikeHeld: false, heading: 0, bike: 0,
    nose: 0, noseSpin: 0,
  };
}

const SLOPE_E = 0.3;
/** Ground gradient (dh/dx, dh/dz) at (x, z), written into `out`. Used by step() and for visuals. */
export function slopeAt(x: number, z: number, out: { gx: number; gz: number }) {
  out.gx = (heightAt(x + SLOPE_E, z) - heightAt(x - SLOPE_E, z)) / (2 * SLOPE_E);
  out.gz = (heightAt(x, z + SLOPE_E) - heightAt(x, z - SLOPE_E)) / (2 * SLOPE_E);
  return out;
}

/** True if standing at (x, z) would slide (sand steeper than the angle of repose, or a rock face). */
export function isSlipFace(x: number, z: number): boolean {
  const g = slopeAt(x, z, tmpSlope);
  return Math.hypot(g.gx, g.gz) > (onRock(x, z) ? ROCK_CLIMB_TAN : SLIP_TAN);
}

/** Would moving from (fx, fz) to (x, z) with feet at `feet` walk into a rock face? */
function rockWall(fx: number, fz: number, x: number, z: number, feet: number): boolean {
  const mx = x - fx, mz = z - fz;
  const run = Math.sqrt(mx * mx + mz * mz);
  if (run < 1e-6 || heightAt(x, z) < feet + 0.05 || !onRock(x, z)) return false;
  const g = slopeAt(x, z, tmpSlope);
  return (g.gx * mx + g.gz * mz) / run > ROCK_CLIMB_TAN;
}

/** Stop a move from (fx, fz) to c that runs into a rock face: slide along it on one axis if that is free. */
function blockRock(c: { x: number; z: number; vx: number; vz: number }, fx: number, fz: number, feet: number) {
  if (!rockWall(fx, fz, c.x, c.z, feet)) return;
  if (!rockWall(fx, fz, c.x, fz, feet)) { c.z = fz; c.vz = 0; return; }
  if (!rockWall(fx, fz, fx, c.z, feet)) { c.x = fx; c.vx = 0; return; }
  c.x = fx;
  c.z = fz;
  c.vx = 0;
  c.vz = 0;
}

/** No walker feet near (step()'s default). */
export const NO_LEGS: readonly number[] = [];

/**
 * Push a mover of `radius` out of the guardians' planted feet (shared/guardians.ts LEG_POST_R): `legs` holds a post
 * per foot as (x, sole y, z). The server passes the feet it has planted; the client the planted ones in the latest
 * 'bots' it has (src/net.ts). Planted feet don't move, so the two agree except for a moment as a foot lifts or lands.
 */
export function collideLegs(c: { x: number; z: number; vx: number; vz: number }, y: number, radius: number, legs: readonly number[]) {
  const sc = KINDS[GUARDIAN].scale, R = LEG_POST_R * sc + radius, H = LEG_POST_H * sc;
  for (let i = 0; i + 2 < legs.length; i += 3) {
    const lx = legs[i], ly = legs[i + 1], lz = legs[i + 2];
    if (y > ly + H || y + PLAYER_HEIGHT < ly) continue;
    let ex = c.x - lx, ez = c.z - lz;
    const d2 = ex * ex + ez * ez;
    if (d2 >= R * R) continue;
    const d = Math.sqrt(d2);
    if (d > 1e-9) { ex /= d; ez /= d; } else { ex = 1; ez = 0; }
    c.x = lx + ex * R;
    c.z = lz + ez * R;
    const vn = c.vx * ex + c.vz * ez;
    if (vn < 0) { c.vx -= vn * ex; c.vz -= vn * ez; }
  }
}

const tmpSlope = { gx: 0, gz: 0 };
const flatSlope = { gx: 0, gz: 0 };
const tmpCollide = { x: 0, z: 0, vx: 0, vz: 0 };

/**
 * Advance one tick. `yawQ` is the quantized camera yaw: yaw 0 looks down -Z, and increases
 * counter-clockwise seen from above (three.js camera rotation.y convention).
 */
export function step(s: PlayerState, input: number, yawQ: number, storm = 0, legs: readonly number[] = NO_LEGS): PlayerState {
  const yaw = yawFromQ(yawQ);
  const bikeDown = (input & BIKE) !== 0;
  if (!s.bike && s.riding) s = { ...s, riding: false }; // gone from under you
  if (bikeDown && !s.bikeHeld && s.riding && s.grounded) {
    // Get off at once with the bike's momentum (it stays where you got off: server/vehicles.ts).
    s = { ...s, riding: false, bike: 0 };
  }
  // Getting on is at once too: the server puts you on it (server/vehicles.ts mount).
  if (s.riding) return stepBike(s, input, bikeDown, storm, legs);
  const fwd = (input & FORWARD ? 1 : 0) - (input & BACK ? 1 : 0);
  const strafe = (input & RIGHT ? 1 : 0) - (input & LEFT ? 1 : 0);
  // Camera forward is (-sin yaw, -cos yaw), right is (cos yaw, -sin yaw).
  let dx = -Math.sin(yaw) * fwd + Math.cos(yaw) * strafe;
  let dz = -Math.cos(yaw) * fwd - Math.sin(yaw) * strafe;
  const len = Math.hypot(dx, dz);
  if (len > 0) {
    dx /= len;
    dz /= len;
  }

  let landTicks = s.landTicks > 0 ? s.landTicks - 1 : 0;
  let speed = WALK_SPEED;
  if (landTicks > 0) speed *= LAND_SLOW + (1 - LAND_SLOW) * (1 - landTicks / MAX_LAND_TICKS);
  speed *= 1 - STORM_SLOW * Math.min(1, storm);
  const pushX = WIND.x * storm, pushZ = WIND.z * storm;

  let vx = s.vx;
  let vz = s.vz;
  // Speed slide: a Shift press on the ground (or held through a landing) throws you forward; a tap
  // lasts SLIDE_TAP_TICKS, holding keeps it going while the speed holds up. Leaving the ground ends it.
  const slideDown = (input & SLIDE) !== 0;
  let slideCool = s.slideCool > 0 ? s.slideCool - 1 : 0;
  let slideSpent = slideDown && s.slideSpent;
  let sliding = s.sliding;
  const hs0 = Math.hypot(vx, vz);
  const slid = SLIDE_COOLDOWN - slideCool; // ticks since the slide started
  if (sliding && !(s.grounded && hs0 >= SLIDE_MIN_KEEP && (slideDown || slid < SLIDE_TAP_TICKS))) sliding = false;
  if (!sliding && slideDown && !slideSpent && s.grounded && slideCool === 0 && (len > 0 || hs0 >= SLIDE_MIN_START)) {
    sliding = true;
    slideSpent = true;
    slideCool = SLIDE_COOLDOWN;
    // Off in the direction held (else the way you were going), at least SLIDE_SPEED.
    const ux = len > 0 ? dx : vx / hs0, uz = len > 0 ? dz : vz / hs0;
    const boosted = Math.min(MAX_GROUND_SPEED, Math.max(SLIDE_SPEED, hs0 + SLIDE_BOOST));
    vx = ux * boosted;
    vz = uz * boosted;
  }
  const crouching = (input & CROUCH) !== 0 && s.grounded && !sliding;
  if (crouching) speed = Math.min(speed, CROUCH_SPEED);
  if (sliding) {
    vx += pushX * STORM_PUSH_ACCEL * DT;
    vz += pushZ * STORM_PUSH_ACCEL * DT;
    const onScrap = s.y > heightAt(s.x, s.z) + 0.02;
    const g = onScrap ? flatSlope : slopeAt(s.x, s.z, tmpSlope);
    const steep = Math.hypot(g.gx, g.gz);
    if (steep > 1e-4) {
      // Gravity along the slope: speeds you up going down it, bleeds speed going up it.
      const cos = 1 / Math.sqrt(1 + steep * steep);
      const pull = -GRAVITY * steep * cos * SLIDE_GRAVITY;
      vx += (-g.gx / steep) * pull * DT;
      vz += (-g.gz / steep) * pull * DT;
    }
    if (len > 0) {
      // Steer: swing the heading towards the input, speed untouched.
      const sp = Math.hypot(vx, vz);
      const diff = Math.atan2(vx * dz - vz * dx, vx * dx + vz * dz);
      const turn = clamp(diff, -SLIDE_TURN * DT, SLIDE_TURN * DT);
      const c = Math.cos(turn), sn = Math.sin(turn);
      if (sp > 0) [vx, vz] = [vx * c - vz * sn, vx * sn + vz * c];
    }
    const sp = Math.hypot(vx, vz);
    const left = Math.max(0, sp - SLIDE_DECEL * DT);
    if (sp > 0) {
      vx *= left / sp;
      vz *= left / sp;
    }
    const cap = Math.hypot(vx, vz);
    if (cap > MAX_GROUND_SPEED) {
      vx *= MAX_GROUND_SPEED / cap;
      vz *= MAX_GROUND_SPEED / cap;
    }
  } else if (s.grounded) {
    // Standing on scrap (above the sand) is flat ground: no slope drag, no slip-face slide.
    const onScrap = s.y > heightAt(s.x, s.z) + 0.02;
    const g = onScrap ? flatSlope : slopeAt(s.x, s.z, tmpSlope);
    const steep = Math.hypot(g.gx, g.gz);
    if (steep > (onScrap || !onRock(s.x, s.z) ? SLIP_TAN : ROCK_CLIMB_TAN)) {
      // Slip face: the sand gives way. Gravity along the slope minus kinetic friction pulls you down;
      // input only steers, it can't hold you in place.
      const ux = -g.gx / steep, uz = -g.gz / steep; // downhill unit vector
      const cos = 1 / Math.sqrt(1 + steep * steep);
      const sin = steep * cos;
      const slide = -GRAVITY * (sin - SLIDE_FRICTION * cos) + SLIDE_PUSH;
      const down = Math.max(0, vx * ux + vz * uz); // keep downhill momentum, don't let control brake it
      const tx = dx * speed * SLIDE_CONTROL + ux * down + pushX * STORM_PUSH;
      const tz = dz * speed * SLIDE_CONTROL + uz * down + pushZ * STORM_PUSH;
      [vx, vz] = approach2(vx, vz, tx, tz, SLIDE_ACCEL * DT);
      vx += ux * slide * DT;
      vz += uz * slide * DT;
    } else {
      // Normal sand: speed depends on the slope along the direction you want to go.
      const rise = dx * g.gx + dz * g.gz;
      const k = rise > 0 ? 1 / (1 + UPHILL_DRAG * rise) : 1 + DOWNHILL_BOOST * Math.min(-rise, 0.6);
      [vx, vz] = approach2(vx, vz, dx * speed * k + pushX * STORM_PUSH, dz * speed * k + pushZ * STORM_PUSH, (len > 0 ? ACCEL : BRAKE) * DT);
    }
    const hs = Math.hypot(vx, vz);
    if (hs > MAX_GROUND_SPEED) {
      vx *= MAX_GROUND_SPEED / hs;
      vz *= MAX_GROUND_SPEED / hs;
    }
  } else {
    // Air control keeps whatever momentum you had (a jump off a slide keeps its speed).
    const hs = Math.hypot(vx, vz);
    const cap = Math.max(speed, hs);
    [vx, vz] = approach2(vx, vz, len > 0 ? dx * cap : vx, len > 0 ? dz * cap : vz, AIR_ACCEL * DT);
    vx += pushX * STORM_PUSH_ACCEL * DT;
    vz += pushZ * STORM_PUSH_ACCEL * DT;
  }
  const facing = yaw; // first person: the body faces where the camera looks

  const jumpDown = (input & JUMP) !== 0;
  let airJumps = s.airJumps;
  let vy: number;
  if (s.grounded && jumpDown && !s.jumpHeld) {
    vy = JUMP_SPEED * (landTicks > 0 ? 0.75 : 1);
  } else if (!s.grounded && jumpDown && !s.jumpHeld && airJumps > 0) {
    vy = AIR_JUMP_SPEED;
    airJumps--;
  } else {
    vy = Math.max(s.vy + GRAVITY * DT, MAX_FALL);
  }

  let y = s.y + vy * DT;
  // Scrap and crash-site wrecks: tall pieces push you out (and absorb the velocity into them), low ones become the ground.
  const c = tmpCollide;
  c.x = s.x + vx * DT;
  c.z = s.z + vz * DT;
  c.vx = vx;
  c.vz = vz;
  const scrapTop = Math.max(collideScrap(c, y, s.y, PLAYER_RADIUS, STEP_UP), collideCrash(c, y, s.y, PLAYER_RADIUS, STEP_UP),
    collideMachines(c, y, s.y, PLAYER_RADIUS, STEP_UP), collideJetWrecks(c, y, s.y, PLAYER_RADIUS, STEP_UP), collideTrophies(c, y, s.y, PLAYER_RADIUS, STEP_UP), collideShip(c, y, s.y, PLAYER_RADIUS, STEP_UP));
  const baseTop = Math.max(collideBase(c, y, s.y, PLAYER_RADIUS, PLAYER_HEIGHT, STEP_UP, s.x, s.z), collideShelter(c, y, s.y, PLAYER_RADIUS, PLAYER_HEIGHT, STEP_UP, s.x, s.z),
    collideOutdoor(c, y, s.y, PLAYER_RADIUS, PLAYER_HEIGHT, STEP_UP));
  if (legs.length) collideLegs(c, y, PLAYER_RADIUS, legs);
  blockRock(c, s.x, s.z, Math.max(y, s.y));
  vx = c.vx;
  vz = c.vz;
  const x = c.x;
  const z = c.z;
  const ground = Math.max(sandAt(x, z, s.y), scrapTop, baseTop);
  // Under the roof: bump your head.
  const ceiling = Math.min(baseCeiling(x, z, s.y, PLAYER_HEIGHT, PLAYER_RADIUS), shelterCeiling(x, z, s.y, PLAYER_HEIGHT, PLAYER_RADIUS));
  if (y > ceiling) {
    y = ceiling;
    if (vy > 0) vy = 0;
  }
  let grounded = false;
  // Snap to the ground when on or just above it (walking downhill shouldn't launch you).
  // The snap distance grows with speed so sliding/sprinting down a steep face stays glued.
  const snap = 0.4 + Math.hypot(vx, vz) * DT * 1.2;
  if (y <= ground || (s.grounded && vy <= 0 && y - ground < snap)) {
    if (!s.grounded) {
      const impact = -vy;
      if (impact > HARD_LANDING) landTicks = Math.min(MAX_LAND_TICKS, Math.round((impact - HARD_LANDING) * 3) + 8);
      // Soft sand eats some horizontal speed on landing.
      vx *= 0.85;
      vz *= 0.85;
    }
    y = ground;
    vy = 0;
    grounded = true;
  }

  if (grounded) airJumps = AIR_JUMPS;
  return {
    x, y, z, vx, vy, vz, facing, grounded, airJumps, jumpHeld: jumpDown, landTicks, sliding, crouching, slideCool,
    slideSpent, riding: false, bikeHeld: bikeDown, heading: s.heading, bike: s.bike, nose: 0, noseSpin: 0,
  };
}

// --- Sand bike -----------------------------------------------------------------------------------
// A balloon-tyred dirt bike. W throttle, S brake then reverse, A/D steer, Space
// held pulls a wheelie (drawn by src/bike.ts), released hops. The mouse only looks
// around (the client turns the camera with the bike).
// - Steering is a bicycle model: turn rate = forward speed × tan(steer) / wheelbase, with the steer angle
//   shrinking at speed. Sideways velocity is bled off by limited tyre grip, so hard turns drift.
// - Gravity along the slope speeds it up downhill and slows it uphill; the engine fades towards top speed.
// - On the ground it rides the surface; where the sand drops away faster than gravity could follow (a dune
//   crest at speed) it launches and flies ballistically, steering only a little, until it lands.
export const BIKE_RADIUS = 0.6;
// Top speed and engine (m/s² at a standstill, fading linearly to 0 at top speed) come from the motorcycle's
// quality: bikeTopSpeed / bikeEngine in shared/gear.ts.
const BIKE_BRAKE = 22;
const BIKE_REVERSE = 4; // top reverse speed (m/s)
const BIKE_ROLL = 1.2; // rolling resistance in sand (m/s²)
const BIKE_DRAG = 0.006; // air drag (per m, times v²)

/** The speed (m/s) a bike of quality `q` levels off at on the flat with the throttle held: where the engine's
 *  push, engine·(1 − v/top), meets rolling resistance and drag (src/engineSound.ts sets its gears by it). */
export function bikeCruise(q: number): number {
  const top = bikeTopSpeed(q), engine = bikeEngine(q);
  const b = engine / top, c = BIKE_ROLL - engine;
  return (-b + Math.sqrt(b * b - 4 * BIKE_DRAG * c)) / (2 * BIKE_DRAG);
}
const BIKE_GRIP = 26; // sideways tyre grip (m/s²): above this the back steps out
const BIKE_WHEELBASE = 1.36;
const BIKE_STEER = 0.55; // max steer angle (rad) at a standstill…
const BIKE_STEER_FADE = 9; // …divided by (1 + speed / this)
const BIKE_SLOPE_G = 0.75; // fraction of gravity that acts along the slope (tyres sink in, the rest is lost)
const BIKE_AIR_SPIN = 1.4; // rad/s of heading change in the air
const BIKE_HOP = 6.5;
const BIKE_LAUNCH_EPS = 0.03; // the ground must fall this far below the ballistic path to leave it
const BIKE_LAND_KEEP = 0.92; // horizontal speed kept on a landing
// Pitch in the air (PlayerState.nose): rad/s² the throttle lifts and the brake drops the nose, how strongly it
// settles towards the flight path (per rad off it) and how quickly spin dies (per s); it goes no further than
// BIKE_MAX_NOSE either way.
const BIKE_AIR_THROTTLE = 2.5;
const BIKE_AIR_BRAKE = 3.5;
const BIKE_AIR_SETTLE = 1.5;
const BIKE_AIR_DAMP = 1;
const BIKE_MAX_NOSE = 1.2;
// Landing with the nose off the slope (rad): free up to SLACK; past it, up to SKEW_LOSS of the speed is lost
// (more than in proportion), all of it at WORST, and the engine bogs down when it was well off.
const BIKE_LAND_SLACK = 0.1;
const BIKE_LAND_WORST = 1;
const BIKE_SKEW_LOSS = 0.85;
export const BIKE_HARD_LANDING = 22; // impact (m/s into the sand) that costs speed and bogs the engine; src/bikeLandSound.ts crashes above it

function stepBike(s: PlayerState, input: number, bikeDown: boolean, storm: number, legs: readonly number[]): PlayerState {
  const top = bikeTopSpeed(s.bike - 1), engine = bikeEngine(s.bike - 1);
  const throttle = (input & FORWARD ? 1 : 0) - (input & BACK ? 1 : 0);
  const steer = (input & LEFT ? 1 : 0) - (input & RIGHT ? 1 : 0); // + turns left (heading grows counter-clockwise)
  const jumpDown = (input & JUMP) !== 0;
  let h = s.heading;
  const fx = -Math.sin(h), fz = -Math.cos(h); // forward
  const rx = Math.cos(h), rz = -Math.sin(h); // right
  let vf = s.vx * fx + s.vz * fz;
  let vr = s.vx * rx + s.vz * rz;
  let vy = s.vy;
  let landTicks = s.landTicks > 0 ? s.landTicks - 1 : 0;
  const hop = s.grounded && !jumpDown && s.jumpHeld; // on letting go of the wheelie

  if (s.grounded) {
    const onScrap = s.y > heightAt(s.x, s.z) + 0.02;
    const g = onScrap ? flatSlope : slopeAt(s.x, s.z, tmpSlope);
    // Gravity along the slope (its horizontal part), split into forward and sideways.
    const k = (GRAVITY * BIKE_SLOPE_G) / (1 + g.gx * g.gx + g.gz * g.gz);
    vf += k * (g.gx * fx + g.gz * fz) * DT;
    vr += k * (g.gx * rx + g.gz * rz) * DT;
    // Engine and brakes. A hard landing chokes the engine for a moment.
    const power = landTicks > 0 ? 0.4 : 1;
    if (throttle > 0) vf += (vf < 0 ? BIKE_BRAKE : engine * power * Math.max(0, 1 - vf / top)) * DT;
    else if (throttle < 0) vf = vf > 0 ? Math.max(0, vf - BIKE_BRAKE * DT) : Math.max(-BIKE_REVERSE, vf - engine * 0.5 * DT);
    const resist = (BIKE_ROLL + BIKE_DRAG * vf * vf) * DT;
    vf = vf > 0 ? Math.max(0, vf - resist) : Math.min(0, vf + resist);
    // The storm's push, before the tyres: mostly a head- or tailwind, they hold most of the sideways part.
    vf += WIND.x * storm * STORM_PUSH_BIKE * DT * fx + WIND.z * storm * STORM_PUSH_BIKE * DT * fz;
    vr += WIND.x * storm * STORM_PUSH_BIKE * DT * rx + WIND.z * storm * STORM_PUSH_BIKE * DT * rz;
    // Tyres: grip pulls the sideways slip towards zero, up to their limit.
    vr = vr > 0 ? Math.max(0, vr - BIKE_GRIP * DT) : Math.min(0, vr + BIKE_GRIP * DT);
    h += (vf * Math.tan((steer * BIKE_STEER) / (1 + Math.abs(vf) / BIKE_STEER_FADE)) / BIKE_WHEELBASE) * DT;
  } else {
    h += steer * BIKE_AIR_SPIN * DT;
  }
  let vx = vf * fx + vr * rx;
  let vz = vf * fz + vr * rz;

  // Collide like a fat player: scrap and base walls push the bike out and eat the speed into them.
  const c = tmpCollide;
  c.x = s.x + vx * DT;
  c.z = s.z + vz * DT;
  c.vx = vx;
  c.vz = vz;
  const airborneY = s.y + (vy + GRAVITY * DT) * DT;
  const scrapTop = Math.max(collideScrap(c, airborneY, s.y, BIKE_RADIUS, STEP_UP), collideCrash(c, airborneY, s.y, BIKE_RADIUS, STEP_UP),
    collideMachines(c, airborneY, s.y, BIKE_RADIUS, STEP_UP), collideJetWrecks(c, airborneY, s.y, BIKE_RADIUS, STEP_UP), collideTrophies(c, airborneY, s.y, BIKE_RADIUS, STEP_UP),
    collideShip(c, airborneY, s.y, BIKE_RADIUS, STEP_UP));
  const baseTop = Math.max(collideBase(c, airborneY, s.y, BIKE_RADIUS, PLAYER_HEIGHT, STEP_UP, s.x, s.z), collideShelter(c, airborneY, s.y, BIKE_RADIUS, PLAYER_HEIGHT, STEP_UP, s.x, s.z),
    collideOutdoor(c, airborneY, s.y, BIKE_RADIUS, PLAYER_HEIGHT, STEP_UP));
  if (legs.length) collideLegs(c, airborneY, BIKE_RADIUS, legs);
  blockRock(c, s.x, s.z, Math.max(airborneY, s.y));
  vx = c.vx;
  vz = c.vz;
  const x = c.x;
  const z = c.z;
  const ground = Math.max(sandAt(x, z, s.y), scrapTop, baseTop);
  const hs = Math.hypot(vx, vz);

  let y: number;
  let grounded: boolean;
  let nose = s.nose, noseSpin = s.noseSpin;
  const nfx = -Math.sin(h), nfz = -Math.cos(h); // forward after this tick's turn
  const ballisticVy = Math.max(vy + GRAVITY * DT, MAX_FALL);
  if (s.grounded && !hop && ground >= s.y + ballisticVy * DT - BIKE_LAUNCH_EPS) {
    // Riding the surface: climb with it. Capped so a step onto scrap doesn't fire the bike into the sky.
    vy = Math.min((ground - s.y) / DT, hs * 0.8 + 1);
    y = ground;
    grounded = true;
  } else {
    // Leaving the ground keeps the climb rate it had (that's what throws it off a crest); a hop adds to it.
    vy = hop ? Math.max(vy, 0) + BIKE_HOP : ballisticVy;
    y = s.y + vy * DT;
    grounded = false;
    // In the air the nose turns with the wheel: throttle lifts it, the brake drops it; the rider's weight slowly
    // settles it towards the flight path, so a jump left alone lands about right.
    const path = Math.atan2(vy, Math.max(hs, 4));
    noseSpin += ((throttle > 0 ? BIKE_AIR_THROTTLE : throttle < 0 ? -BIKE_AIR_BRAKE : 0) + BIKE_AIR_SETTLE * (path - nose) - BIKE_AIR_DAMP * noseSpin) * DT;
    nose += noseSpin * DT;
    if (Math.abs(nose) > BIKE_MAX_NOSE) {
      nose = Math.sign(nose) * BIKE_MAX_NOSE;
      noseSpin = 0;
    }
    if (y <= ground) {
      // Landing: what goes into the sand is the speed across the slope, not the fall speed, so touching down
      // on a down-slope along the flight path is smooth. A hard one costs speed and bogs the engine down.
      const g = ground > heightAt(x, z) + 0.02 ? flatSlope : slopeAt(x, z, tmpSlope);
      const impact = g.gx * vx + g.gz * vz - vy;
      if (impact > BIKE_HARD_LANDING) landTicks = Math.min(MAX_LAND_TICKS, Math.round(impact - BIKE_HARD_LANDING) * 2 + 8);
      // Not on both wheels (the nose off the slope): the bike slams over onto them, and that costs speed too.
      const off = Math.abs(nose - Math.atan(g.gx * nfx + g.gz * nfz));
      const skew = Math.min(1, Math.max(0, (off - BIKE_LAND_SLACK) / (BIKE_LAND_WORST - BIKE_LAND_SLACK)));
      if (skew > 0.4) landTicks = Math.max(landTicks, Math.round(skew * MAX_LAND_TICKS));
      const keep = (impact > 4 ? BIKE_LAND_KEEP : 1) * (1 - BIKE_SKEW_LOSS * skew ** 1.5);
      vx *= keep;
      vz *= keep;
      y = ground;
      // Touch down moving with the sand, not at vy = 0: on a down-slope that would leave the ground again
      // next tick and skip the bike down it in little bounces.
      vy = Math.min(g.gx * vx + g.gz * vz, hs * 0.8 + 1);
      grounded = true;
    }
  }
  if (grounded) {
    // On the ground the nose lies along the sand (flat on scrap and floors).
    const g = y > heightAt(x, z) + 0.02 ? flatSlope : slopeAt(x, z, tmpSlope);
    nose = Math.atan(g.gx * nfx + g.gz * nfz);
    noseSpin = 0;
  }
  const ceiling = Math.min(baseCeiling(x, z, s.y, PLAYER_HEIGHT, BIKE_RADIUS), shelterCeiling(x, z, s.y, PLAYER_HEIGHT, BIKE_RADIUS));
  if (y > ceiling) {
    y = ceiling;
    if (vy > 0) vy = 0;
  }
  h = Math.atan2(Math.sin(h), Math.cos(h));
  return {
    x, y, z, vx, vy, vz, facing: h, grounded, airJumps: AIR_JUMPS, jumpHeld: jumpDown, landTicks,
    sliding: false, crouching: false, slideCool: s.slideCool, slideSpent: s.slideSpent, riding: true, bikeHeld: bikeDown, heading: h, bike: s.bike,
    nose, noseSpin,
  };
}

/** Move the 2D vector (vx, vz) towards (tx, tz) by at most maxDelta (length, not per axis). */
function approach2(vx: number, vz: number, tx: number, tz: number, maxDelta: number): [number, number] {
  const ex = tx - vx, ez = tz - vz;
  const d = Math.hypot(ex, ez);
  if (d <= maxDelta || d === 0) return [tx, tz];
  return [vx + (ex / d) * maxDelta, vz + (ez / d) * maxDelta];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
