import { BACK, DIG, FORWARD, JUMP, LEFT, PILE, RIGHT, SPRINT } from '../shared/sim.ts';

const keys = new Set<string>();
let mouseDig = false;
let mousePile = false;
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => {
  keys.clear();
  mouseDig = mousePile = false;
});
// Mouse digs only while the pointer is locked: the first click just captures the mouse.
addEventListener('mousedown', (e) => {
  if (!document.pointerLockElement) return;
  if (e.button === 0) mouseDig = true;
  if (e.button === 2) mousePile = true;
});
addEventListener('mouseup', (e) => {
  if (e.button === 0) mouseDig = false;
  if (e.button === 2) mousePile = false;
});
addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement) mouseDig = mousePile = false;
});

export function readInput(): number {
  let input = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) input |= FORWARD;
  if (keys.has('KeyS') || keys.has('ArrowDown')) input |= BACK;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) input |= LEFT;
  if (keys.has('KeyD') || keys.has('ArrowRight')) input |= RIGHT;
  if (keys.has('Space')) input |= JUMP;
  if (keys.has('ShiftLeft') || keys.has('ShiftRight')) input |= SPRINT;
  if (mouseDig || keys.has('KeyE')) input |= DIG;
  else if (mousePile || keys.has('KeyQ')) input |= PILE;
  return input;
}
