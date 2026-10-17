// Deterministic movement simulation shared by client (prediction) and server (authority).
// Both sides must step with the same fixed DT and the same inputs, or prediction will drift.

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export const SIZE = 1; // players are 1×1 squares; x/y is the centre
const HALF = SIZE / 2;
const GRAVITY = -40;
const MOVE_SPEED = 8;
const ACCEL = 60;
const JUMP_SPEED = 15;
const AIR_JUMP_SPEED = 13;
const AIR_JUMPS = 1; // double jump
const MAX_FALL = -30;
const KILL_Y = -20;

export const SPAWN = { x: 0, y: 3 };

export type Box = { x: number; y: number; w: number; h: number }; // centre + size

export const PLATFORMS: Box[] = [
  { x: 0, y: -0.5, w: 30, h: 1 },
  { x: -6, y: 2.5, w: 4, h: 0.5 },
  { x: 0, y: 5, w: 4, h: 0.5 },
  { x: 6, y: 2.5, w: 4, h: 0.5 },
  { x: -10, y: 7, w: 3, h: 0.5 },
  { x: 10, y: 7, w: 3, h: 0.5 },
  { x: 0, y: 9.5, w: 2, h: 0.5 },
];

export type PlayerState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
  airJumps: number; // air jumps left; refilled on landing
  jumpHeld: boolean; // jump was down last tick, so an air jump needs a fresh press
};

// Input is a bitmask so it is tiny on the wire and trivially comparable.
export const LEFT = 1;
export const RIGHT = 2;
export const JUMP = 4;

export function spawnState(): PlayerState {
  return { x: SPAWN.x, y: SPAWN.y, vx: 0, vy: 0, grounded: false, airJumps: AIR_JUMPS, jumpHeld: false };
}

export function step(s: PlayerState, input: number): PlayerState {
  const dir = (input & RIGHT ? 1 : 0) - (input & LEFT ? 1 : 0);
  let vx = approach(s.vx, dir * MOVE_SPEED, ACCEL * DT);
  const jumpDown = (input & JUMP) !== 0;
  let airJumps = s.airJumps;
  let vy: number;
  if (s.grounded && jumpDown) {
    vy = JUMP_SPEED; // holding jump keeps hopping on landing
  } else if (!s.grounded && jumpDown && !s.jumpHeld && airJumps > 0) {
    vy = AIR_JUMP_SPEED;
    airJumps--;
  } else {
    vy = Math.max(s.vy + GRAVITY * DT, MAX_FALL);
  }

  // Resolve each axis separately against the static level.
  let x = s.x + vx * DT;
  for (const p of PLATFORMS) {
    if (overlaps(x, s.y, p)) {
      x = vx > 0 ? p.x - p.w / 2 - HALF : p.x + p.w / 2 + HALF;
      vx = 0;
    }
  }

  let y = s.y + vy * DT;
  let grounded = false;
  for (const p of PLATFORMS) {
    if (overlaps(x, y, p)) {
      if (vy <= 0) {
        y = p.y + p.h / 2 + HALF;
        grounded = true;
      } else {
        y = p.y - p.h / 2 - HALF;
      }
      vy = 0;
    }
  }

  if (y < KILL_Y) return spawnState();
  if (grounded) airJumps = AIR_JUMPS;
  return { x, y, vx, vy, grounded, airJumps, jumpHeld: jumpDown };
}

function overlaps(x: number, y: number, p: Box): boolean {
  return Math.abs(x - p.x) < p.w / 2 + HALF && Math.abs(y - p.y) < p.h / 2 + HALF;
}

function approach(v: number, target: number, maxDelta: number): number {
  return v < target ? Math.min(v + maxDelta, target) : Math.max(v - maxDelta, target);
}
