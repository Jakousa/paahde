// Deterministic movement simulation shared by client (prediction) and server (authority).
// Both sides must step with the same fixed DT and the same inputs, or prediction will drift.
// World axes: Y is up, the ground is the heightfield in terrain.ts.
import { heightAt, WORLD_HALF } from './terrain.ts';

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export const PLAYER_HEIGHT = 1.8; // y is the player's feet
const GRAVITY = -25;
const WALK_SPEED = 6;
const SPRINT_SPEED = 11;
const ACCEL = 50;
const AIR_ACCEL = 12;
const JUMP_SPEED = 9;
const AIR_JUMP_SPEED = 8;
const AIR_JUMPS = 1; // double jump
const MAX_FALL = -50;

export const SPAWN = { x: 0, z: 0 };

export type PlayerState = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  facing: number; // radians, direction the body faces (follows movement)
  grounded: boolean;
  airJumps: number; // air jumps left; refilled on landing
  jumpHeld: boolean; // jump was down last tick, so an air jump needs a fresh press
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
export const INPUT_MASK = 127;

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
    grounded: true, airJumps: AIR_JUMPS, jumpHeld: false,
  };
}

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
  const speed = input & SPRINT ? SPRINT_SPEED : WALK_SPEED;
  const accel = (s.grounded ? ACCEL : AIR_ACCEL) * DT;
  const vx = approach(s.vx, dx * speed, accel);
  const vz = approach(s.vz, dz * speed, accel);
  const facing = len > 0 ? Math.atan2(-dx, -dz) : s.facing;

  const jumpDown = (input & JUMP) !== 0;
  let airJumps = s.airJumps;
  let vy: number;
  if (s.grounded && jumpDown && !s.jumpHeld) {
    vy = JUMP_SPEED;
  } else if (!s.grounded && jumpDown && !s.jumpHeld && airJumps > 0) {
    vy = AIR_JUMP_SPEED;
    airJumps--;
  } else {
    vy = Math.max(s.vy + GRAVITY * DT, MAX_FALL);
  }

  const x = clamp(s.x + vx * DT, -WORLD_HALF, WORLD_HALF);
  const z = clamp(s.z + vz * DT, -WORLD_HALF, WORLD_HALF);
  let y = s.y + vy * DT;
  const ground = heightAt(x, z);
  let grounded = false;
  // Snap to the ground when on or just above it (walking downhill shouldn't launch you).
  if (y <= ground || (s.grounded && vy <= 0 && y - ground < 0.4)) {
    y = ground;
    vy = 0;
    grounded = true;
  }

  if (grounded) airJumps = AIR_JUMPS;
  return { x, y, z, vx, vy, vz, facing, grounded, airJumps, jumpHeld: jumpDown };
}

function approach(v: number, target: number, maxDelta: number): number {
  return v < target ? Math.min(v + maxDelta, target) : Math.max(v - maxDelta, target);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
