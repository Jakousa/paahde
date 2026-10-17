import { BACK, BIKE, DIG, FORWARD, JUMP, LEFT, PILE, RIGHT, SLIDE, SPRINT } from '../shared/sim.ts';

const keys = new Set<string>();
const bikeAllowed = import.meta.env.DEV || location.search.includes('debug');
let mouseDig = false;
let mousePile = false;
let pickupPressed = false;
/** Hands full (canteen or spyglass out, src/water.ts): left mouse / E and right mouse / Q don't dig or pile.
 *  frozen: the disassembly mode (src/teardown) owns the keyboard and mouse, so the player stands still. */
export const tools = { blocked: false, frozen: false };
/** The Tab inventory is open (src/inventory.ts): it frees the mouse but we stay fullscreen with the keyboard locked. */
/** `debugFreed`: the F3 panel just freed the mouse (src/debugMenu.ts), so losing it doesn't open the Esc menu (src/menu.ts). */
export const ui = { inventoryOpen: false, debugFreed: false };
// While the pointer is locked the game owns the keyboard: swallow browser shortcuts (Tab, F-keys, Alt, Ctrl+S...).
// Esc frees the mouse (the browser does that itself), and then keys behave normally again.
const captured = () => !!document.pointerLockElement;
// Ctrl+W/T/N and friends are reserved by the browser; only the Keyboard Lock API (Chromium, fullscreen
// only) can take them, so a click that captures the mouse also goes fullscreen and locks the keyboard.
type KeyboardLock = { lock(codes?: string[]): Promise<void>; unlock(): void };
const keyboard = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
// Only clicks on the game canvas capture the mouse (src/camera.ts) and the Esc menu's Resume; a click on
// anything else must not go fullscreen.
addEventListener('click', (e) => {
  if (document.pointerLockElement || !keyboard || !(e.target instanceof HTMLCanvasElement)) return;
  fullscreen();
});
function fullscreen() {
  if (keyboard) document.documentElement.requestFullscreen?.().then(() => keyboard.lock(), () => {});
}
/** Back into the game from a click outside the canvas (the Esc menu): capture the mouse, go fullscreen. */
export function capture(canvas: HTMLElement) {
  if (document.pointerLockElement === canvas) return;
  // Can be refused (too soon after the browser's own Esc): then a click on the game does it.
  Promise.resolve(canvas.requestPointerLock()).catch(() => {});
  fullscreen();
}
addEventListener('keydown', (e) => {
  // A locked keyboard hands Esc to the page instead of releasing the mouse, so release it ourselves.
  if (e.code === 'Escape' && captured()) document.exitPointerLock();
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
    if (ui.inventoryOpen) return;
    keyboard?.unlock();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
});

/** Is this key down right now (for the disassembly mode, which reads A / D itself while the player is frozen)? */
export function keyHeld(code: string): boolean {
  return keys.has(code);
}

export function readInput(): number {
  let input = 0;
  if (tools.frozen) return input;
  if (keys.has('KeyW') || keys.has('ArrowUp')) input |= FORWARD;
  if (keys.has('KeyS') || keys.has('ArrowDown')) input |= BACK;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) input |= LEFT;
  if (keys.has('KeyD') || keys.has('ArrowRight')) input |= RIGHT;
  if (keys.has('Space')) input |= JUMP;
  if (keys.has('ShiftLeft') || keys.has('ShiftRight')) input |= SPRINT;
  // C is an alias: browsers swallow Ctrl+W (close tab) so W-then-Ctrl can't always be used.
  if (keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC')) input |= SLIDE;
  if (tools.blocked) return input;
  if (mouseDig || keys.has('KeyE')) input |= DIG;
  else if (mousePile || keys.has('KeyQ')) input |= PILE;
  // 9: get on / off the sand bike. A dev helper: only in `npm run dev` or with ?debug.
  if (bikeAllowed && keys.has('Digit9')) input |= BIKE;
  return input;
}

/** Use button (left mouse or E) held down: digs normally, drinks while the canteen is held. */
export function useHeld(): boolean {
  return !tools.frozen && (mouseDig || keys.has('KeyE'));
}

/** Any use button held (left/right mouse, E or Q): raises the spyglass while it's out. */
export function aimHeld(): boolean {
  return mouseDig || mousePile || keys.has('KeyE') || keys.has('KeyQ');
}

/** F held down (pickup / fill). */
export function interactHeld(): boolean {
  return keys.has('KeyF');
}

/** True once per press of the pickup key (F). */
export function takePickup(): boolean {
  const p = pickupPressed;
  pickupPressed = false;
  return p;
}
