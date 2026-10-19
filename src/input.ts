import { isBound, norm, slots, type Action } from './bindings';
import { BACK, BIKE, CROUCH, FORWARD, JUMP, LEFT, RIGHT, SLIDE } from '../shared/sim.ts';

const keys = new Set<string>();
let pickupPressed = false;
/** slot: the selected hotbar slot (-1 none).
 *  frozen: the disassembly mode (src/teardown) owns the keyboard and mouse, so the player stands still. */
export const tools = { frozen: false, slot: -1, bike: false, engaged: false };
/* engaged: the crosshair is on something the disassembly (src/teardown) works, so the use button is its, not the hand's. */
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
  if (document.pointerLockElement || !keyboard || !(e.target instanceof HTMLCanvasElement) || e.target.dataset.nofs) return; // not the minigame's (src/loadingGame.ts)
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
  keys.add(norm(e.code));
  if (isBound('interact', e.code) && !e.repeat) pickupPressed = true;
});
addEventListener('keyup', (e) => {
  if (captured()) e.preventDefault();
  keys.delete(norm(e.code));
});
addEventListener('blur', () => {
  keys.clear();
});
// The mouse buttons count only while the pointer is locked: the first click just captures the mouse.
addEventListener('mousedown', (e) => {
  if (!document.pointerLockElement) return;
  keys.add(`Mouse${e.button}`);
});
addEventListener('mouseup', (e) => {
  keys.delete(`Mouse${e.button}`);
});
addEventListener('contextmenu', (e) => e.preventDefault());
// Mouse travel since it was last asked for, for what is done with the mouse itself (the disassembly's gestures).
let mdx = 0, mdy = 0;
addEventListener('mousemove', (e) => {
  if (!document.pointerLockElement) return;
  mdx += e.movementX;
  mdy += e.movementY;
});
export function takeMouse(): [number, number] {
  const r: [number, number] = [mdx, mdy];
  mdx = mdy = 0;
  return r;
}
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement) {
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
  return keys.has(norm(code));
}

/** Is any key bound to this action down right now? */
export function actionHeld(a: Action): boolean {
  const [x, y] = slots(a);
  return keys.has(x) || keys.has(y);
}

export function readInput(): number {
  let input = 0;
  if (tools.frozen) return input;
  if (actionHeld('forward')) input |= FORWARD;
  if (actionHeld('back')) input |= BACK;
  if (actionHeld('left')) input |= LEFT;
  if (actionHeld('right')) input |= RIGHT;
  if (actionHeld('jump')) input |= JUMP;
  // Shift slides, except with the rifle up: there it holds your breath (breathHeld).
  if (actionHeld('sprint') && !aimDown()) input |= SLIDE;
  // Ctrl has C as an alias by default: browsers swallow Ctrl+W (close tab) so W-then-Ctrl can't always be used.
  if (actionHeld('crouch')) input |= CROUCH;
  // The bike key (Z or 9 by default): get on / off the motorcycle (shared/sim.ts: only with a repaired one equipped), whatever's in hand
  // (getting on puts it away, src/water.ts).
  if (actionHeld('bike')) input |= BIKE;
  // A repaired motorcycle in hand (src/water.ts): the use button gets on and off it instead.
  if (tools.bike && actionHeld('use')) input |= BIKE;
  return input;
}

/** Use button (left mouse or E) held down: drinks while the canteen is held, fires a gun, throws scrap... */
export function useHeld(): boolean {
  return !tools.frozen && !tools.engaged && actionHeld('use');
}

/** Any use button held (left/right mouse, E, Q or X): raises the spyglass while it's out. */
export function aimHeld(): boolean {
  return actionHeld('use') || actionHeld('aim') || actionHeld('spyglass');
}

/** Aim button held (right mouse or X): the rifle up to the eye. */
export function aimDown(): boolean {
  return !tools.frozen && actionHeld('aim');
}

/** Shift held (hold your breath while aiming the rifle). */
export function breathHeld(): boolean {
  return actionHeld('sprint');
}

/** F held down (pickup / fill). */
export function interactHeld(): boolean {
  return actionHeld('interact');
}

/** True once per press of the pickup key (F). */
export function takePickup(): boolean {
  const p = pickupPressed;
  pickupPressed = false;
  return p;
}
