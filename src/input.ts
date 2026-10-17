import { BACK, FORWARD, JUMP, LEFT, RIGHT, SPRINT } from '../shared/sim.ts';

const keys = new Set<string>();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

export function readInput(): number {
  let input = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) input |= FORWARD;
  if (keys.has('KeyS') || keys.has('ArrowDown')) input |= BACK;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) input |= LEFT;
  if (keys.has('KeyD') || keys.has('ArrowRight')) input |= RIGHT;
  if (keys.has('Space')) input |= JUMP;
  if (keys.has('ShiftLeft') || keys.has('ShiftRight')) input |= SPRINT;
  return input;
}
