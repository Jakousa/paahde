import { BACK, DIG, FORWARD, JUMP, LEFT, PILE, RIGHT, SLIDE, SPRINT } from '../shared/sim.ts';

const keys = new Set<string>();
let mouseDig = false;
let mousePile = false;
let pickupPressed = false;
// While the pointer is locked the game owns the keyboard: swallow browser shortcuts (Tab, F-keys, Alt, Ctrl+S...).
// Esc frees the mouse (the browser does that itself), and then keys behave normally again.
const captured = () => !!document.pointerLockElement;
// Ctrl+W/T/N and friends are reserved by the browser; only the Keyboard Lock API (Chromium, fullscreen
// only) can take them, so a click that captures the mouse also goes fullscreen and locks the keyboard.
type KeyboardLock = { lock(codes?: string[]): Promise<void>; unlock(): void };
const keyboard = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
addEventListener('click', () => {
  if (document.pointerLockElement || !keyboard) return;
  document.documentElement.requestFullscreen?.().then(() => keyboard.lock(), () => {});
});
addEventListener('keydown', (e) => {
  if (captured()) e.preventDefault();
  keys.add(e.code);
  if (e.code === 'KeyF' && !e.repeat) pickupPressed = true;
});
addEventListener('keyup', (e) => {
  if (captured()) e.preventDefault();
  keys.delete(e.code);
});
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
  if (!document.pointerLockElement) {
    mouseDig = mousePile = false;
    keys.clear();
    keyboard?.unlock();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
});

export function readInput(): number {
  let input = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) input |= FORWARD;
  if (keys.has('KeyS') || keys.has('ArrowDown')) input |= BACK;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) input |= LEFT;
  if (keys.has('KeyD') || keys.has('ArrowRight')) input |= RIGHT;
  if (keys.has('Space')) input |= JUMP;
  if (keys.has('ShiftLeft') || keys.has('ShiftRight')) input |= SPRINT;
  // C is an alias: browsers swallow Ctrl+W (close tab) so W-then-Ctrl can't always be used.
  if (keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC')) input |= SLIDE;
  if (mouseDig || keys.has('KeyE')) input |= DIG;
  else if (mousePile || keys.has('KeyQ')) input |= PILE;
  return input;
}

/** True once per press of the pickup key (F). */
export function takePickup(): boolean {
  const p = pickupPressed;
  pickupPressed = false;
  return p;
}
