// Deterministic movement simulation shared by client (prediction) and server (authority).
// Both sides must step with the same fixed DT and the same inputs, or prediction will drift.
// World axes: Y is up, the ground is the heightfield in terrain.ts.
//
// Sand feel:
// - Slope-aware speed: walking uphill is a slog, downhill is a little quicker.
// - Slip faces steeper than the angle of repose (~34°) avalanche: you slide down them and can only steer
//   sideways; trying to climb one just slows the slide.
// - Ctrl slide (Titanfall-style): sprint into it for a speed burst, then coast on low friction. Downhill
//   speeds you up, uphill bleeds it off; steering only bends your heading. Jump out of it to keep the speed.
// - Soft sand: you build up and lose speed a bit slowly (momentum), and hard landings bog you down briefly.
import { collideScrap } from './scrap.ts';
import { heightAt, WORLD_HALF } from './terrain.ts';

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export const PLAYER_HEIGHT = 1.8; // y is the player's feet
/** Horizontal collision radius against scrap (shared/scrap.ts). */
export const PLAYER_RADIUS = 0.35;
/** Scrap whose top is at most this far above the feet is stepped onto instead of blocking. */
const STEP_UP = 0.35;
const GRAVITY = -25;
export const WALK_SPEED = 6;
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
const SLIDE_ACCEL = 8; // steering accel on a slip face; below the slide pull on anything much steeper than 34°
const MAX_GROUND_SPEED = 18;

// Intentional slide (Ctrl).
const SLIDE_MIN_START = 4.5; // m/s needed to start one (a walk-speed jog is enough)
const SLIDE_MIN_KEEP = 3.2; // the slide ends when you drop below this
const SLIDE_BOOST = 3; // m/s added on entry
const SLIDE_START_CAP = 14; // the entry boost never takes you above this
const SLIDE_COOLDOWN = 50; // ticks from the start of one slide to the next
const SLIDE_DECEL = 8; // flat-sand friction while sliding (m/s²); steep downhill beats it
const SLIDE_GRAVITY = 0.9; // fraction of gravity along the slope that acts on a slide
const SLIDE_TURN = 1.6; // rad/s the heading can swing towards the input

// Ctrl below slide speed (or after a slide runs out) crouches: slow, no sprint.
const CROUCH_SPEED = 3;

// Landing.
const HARD_LANDING = 13; // impact speed (m/s) above which a landing bogs you down
const LAND_SLOW = 0.4; // speed factor right after a hard landing, recovering linearly
const MAX_LAND_TICKS = 24;

export const SPAWN = { x: 0, z: 0 };

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
  sliding: boolean; // in an intentional (Ctrl) slide
  crouching: boolean; // Ctrl held on the ground without sliding
  slideCool: number; // ticks until another slide can start (integer)
};

// Input is a bitmask so it is tiny on the wire and trivially comparable.
export const FORWARD = 1;
export const BACK = 2;
export const LEFT = 4;
export const RIGHT = 8;
export const JUMP = 16;
export const SPRINT = 32;
// Digging changes the world, not the player: step() ignores it; the server applies it to the terrain.
export const DIG = 64;
export const PILE = 128; // like DIG, but puts sand back (shared/dig.ts)
export const SLIDE = 256; // Ctrl: slide
export const INPUT_MASK = 511;

// Camera yaw is sent with every input, quantized to 16 bits so client and server agree exactly.
export const YAW_STEPS = 65536;
export function quantizeYaw(yaw: number): number {
  const q = Math.round((yaw / (Math.PI * 2)) * YAW_STEPS) % YAW_STEPS;
  return q < 0 ? q + YAW_STEPS : q;
}
export function yawFromQ(q: number): number {
  return (q / YAW_STEPS) * Math.PI * 2;
}

export function spawnState(x = SPAWN.x, z = SPAWN.z): PlayerState {
  return {
    x, y: heightAt(x, z), z, vx: 0, vy: 0, vz: 0, facing: 0,
    grounded: true, airJumps: AIR_JUMPS, jumpHeld: false, landTicks: 0,
    sliding: false, crouching: false, slideCool: 0,
  };
}

const SLOPE_E = 0.3;
/** Ground gradient (dh/dx, dh/dz) at (x, z), written into `out`. Used by step() and for visuals. */
export function slopeAt(x: number, z: number, out: { gx: number; gz: number }) {
  out.gx = (heightAt(x + SLOPE_E, z) - heightAt(x - SLOPE_E, z)) / (2 * SLOPE_E);
  out.gz = (heightAt(x, z + SLOPE_E) - heightAt(x, z - SLOPE_E)) / (2 * SLOPE_E);
  return out;
}

/** True if standing at (x, z) would slide (ground steeper than the angle of repose). */
export function isSlipFace(x: number, z: number): boolean {
  const g = slopeAt(x, z, tmpSlope);
  return Math.hypot(g.gx, g.gz) > SLIP_TAN;
}

const tmpSlope = { gx: 0, gz: 0 };
const flatSlope = { gx: 0, gz: 0 };
const tmpCollide = { x: 0, z: 0, vx: 0, vz: 0 };

/**
 * Advance one tick. `yawQ` is the quantized camera yaw: yaw 0 looks down -Z, and increases
 * counter-clockwise seen from above (three.js camera rotation.y convention).
 */
export function step(s: PlayerState, input: number, yawQ: number): PlayerState {
  const yaw = yawFromQ(yawQ);
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
  let speed = input & SPRINT ? SPRINT_SPEED : WALK_SPEED;
  if (landTicks > 0) speed *= LAND_SLOW + (1 - LAND_SLOW) * (1 - landTicks / MAX_LAND_TICKS);

  let vx = s.vx;
  let vz = s.vz;
  // Intentional slide: starts from a run on the ground, lasts while Ctrl is held and speed holds up.
  const slideDown = (input & SLIDE) !== 0;
  let slideCool = s.slideCool > 0 ? s.slideCool - 1 : 0;
  let sliding = s.sliding;
  const hs0 = Math.hypot(vx, vz);
  if (sliding && !(slideDown && s.grounded && hs0 >= SLIDE_MIN_KEEP)) sliding = false;
  if (!sliding && slideDown && s.grounded && slideCool === 0 && hs0 >= SLIDE_MIN_START) {
    sliding = true;
    slideCool = SLIDE_COOLDOWN;
    const boosted = Math.max(hs0, Math.min(hs0 + SLIDE_BOOST, SLIDE_START_CAP));
    vx *= boosted / hs0;
    vz *= boosted / hs0;
  }
  const crouching = slideDown && s.grounded && !sliding;
  if (crouching) speed = Math.min(speed, CROUCH_SPEED);
  if (sliding) {
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
    if (steep > SLIP_TAN) {
      // Slip face: the sand gives way. Gravity along the slope minus kinetic friction pulls you down;
      // input only steers, it can't hold you in place.
      const ux = -g.gx / steep, uz = -g.gz / steep; // downhill unit vector
      const cos = 1 / Math.sqrt(1 + steep * steep);
      const sin = steep * cos;
      const slide = -GRAVITY * (sin - SLIDE_FRICTION * cos) + SLIDE_PUSH;
      const down = Math.max(0, vx * ux + vz * uz); // keep downhill momentum, don't let control brake it
      const tx = dx * speed * SLIDE_CONTROL + ux * down;
      const tz = dz * speed * SLIDE_CONTROL + uz * down;
      [vx, vz] = approach2(vx, vz, tx, tz, SLIDE_ACCEL * DT);
      vx += ux * slide * DT;
      vz += uz * slide * DT;
    } else {
      // Normal sand: speed depends on the slope along the direction you want to go.
      const rise = dx * g.gx + dz * g.gz;
      const k = rise > 0 ? 1 / (1 + UPHILL_DRAG * rise) : 1 + DOWNHILL_BOOST * Math.min(-rise, 0.6);
      [vx, vz] = approach2(vx, vz, dx * speed * k, dz * speed * k, (len > 0 ? ACCEL : BRAKE) * DT);
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
  // Scrap: tall pieces push you out (and absorb the velocity into them), low ones become the ground.
  const c = tmpCollide;
  c.x = s.x + vx * DT;
  c.z = s.z + vz * DT;
  c.vx = vx;
  c.vz = vz;
  const scrapTop = collideScrap(c, y, s.y, PLAYER_RADIUS, STEP_UP);
  vx = c.vx;
  vz = c.vz;
  const x = clamp(c.x, -WORLD_HALF, WORLD_HALF);
  const z = clamp(c.z, -WORLD_HALF, WORLD_HALF);
  const ground = Math.max(heightAt(x, z), scrapTop);
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
  return { x, y, z, vx, vy, vz, facing, grounded, airJumps, jumpHeld: jumpDown, landTicks, sliding, crouching, slideCool };
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
