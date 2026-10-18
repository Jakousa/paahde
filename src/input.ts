import { BACK, BIKE, CROUCH, DIG, FORWARD, JUMP, LEFT, PILE, RIGHT, SLIDE } from '../shared/sim.ts';

const keys = new Set<string>();
let mouseDig = false;
let mousePile = false;
let pickupPressed = false;
/** Hands full (canteen or spyglass out, src/water.ts): left mouse / E and right mouse / Q don't dig or pile.
 *  slot: the selected hotbar slot (-1 none), digging with what's in it (src/net.ts, a shovel).
 *  frozen: the disassembly mode (src/teardown) owns the keyboard and mouse, so the player stands still. */
export const tools = { blocked: false, frozen: false, slot: -1, bike: false };
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
    // Fullscreen and the keyboard lock stay on, so Esc only opens the menu; its button leaves fullscreen.
  }
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) keyboard?.unlock();
});

/** Menu button: enter or leave fullscreen (leaving also releases the keyboard lock). */
export function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen?.().then(() => keyboard?.lock(), () => {});
}

/** Is this key down right now (for the disassembly mode, which reads A / D itself while the player is frozen)? */
export function keyHeld(code: string): boolean {
  return keys.has(code);
}

/** Right mouse or X (always the same button). */
function rightHeld(): boolean {
  return mousePile || keys.has('KeyX');
}

export function readInput(): number {
  let input = 0;
  if (tools.frozen) return input;
  if (keys.has('KeyW') || keys.has('ArrowUp')) input |= FORWARD;
  if (keys.has('KeyS') || keys.has('ArrowDown')) input |= BACK;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) input |= LEFT;
  if (keys.has('KeyD') || keys.has('ArrowRight')) input |= RIGHT;
  if (keys.has('Space')) input |= JUMP;
  // Shift slides, except with the rifle up: there it holds your breath (breathHeld).
  if ((keys.has('ShiftLeft') || keys.has('ShiftRight')) && !aimDown()) input |= SLIDE;
  // C is an alias: browsers swallow Ctrl+W (close tab) so W-then-Ctrl can't always be used.
  if (keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC')) input |= CROUCH;
  // 9: get on / off the motorcycle (shared/sim.ts: only with a repaired one equipped), whatever's in hand
  // (getting on puts it away, src/water.ts).
  if (keys.has('Digit9')) input |= BIKE;
  // A repaired motorcycle in hand (src/water.ts): the use button gets on and off it instead.
  if (tools.bike && (mouseDig || keys.has('KeyE'))) return input | BIKE;
  if (tools.blocked) return input;
  if (mouseDig || keys.has('KeyE')) input |= DIG;
  else if (rightHeld() || keys.has('KeyQ')) input |= PILE;
  return input;
}

/** Use button (left mouse or E) held down: digs normally, drinks while the canteen is held. */
export function useHeld(): boolean {
  return !tools.frozen && (mouseDig || keys.has('KeyE'));
}

/** Any use button held (left/right mouse, E, Q or X): raises the spyglass while it's out. */
export function aimHeld(): boolean {
  return mouseDig || rightHeld() || keys.has('KeyE') || keys.has('KeyQ');
}

/** Aim button held (right mouse or X): the rifle up to the eye. */
export function aimDown(): boolean {
  return !tools.frozen && rightHeld();
}

/** Shift held (hold your breath while aiming the rifle). */
export function breathHeld(): boolean {
  return keys.has('ShiftLeft') || keys.has('ShiftRight');
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
