import { JUMP, LEFT, RIGHT } from '../shared/sim.ts';

const keys = new Set<string>();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

export function readInput(): number {
  let input = 0;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) input |= LEFT;
  if (keys.has('ArrowRight') || keys.has('KeyD')) input |= RIGHT;
  if (keys.has('Space') || keys.has('ArrowUp') || keys.has('KeyW')) input |= JUMP;
  return input;
}
