import { isBound, norm, setDevice, slots, type Action } from './bindings';
import { graphics } from './graphics';
import { BACK, BIKE, CROUCH, FORWARD, JUMP, LEFT, RIGHT, SLIDE } from '../shared/sim.ts';

const keys = new Set<string>();
let pickupPressed = false;
/** slot: the selected hotbar slot (-1 none).
 *  frozen: the disassembly mode (src/teardown) owns the keyboard and mouse, so the player stands still. */
export const tools = { frozen: false, slot: -1, getOff: false, engaged: false, spinning: false };
/* engaged: the crosshair is on something the disassembly (src/teardown) works, so the use button is its, not the hand's. */
/** The Tab inventory is open (src/inventory.ts): it frees the mouse but we stay fullscreen with the keyboard locked. */
/** `debugFreed`: the F3 panel just freed the mouse (src/debugMenu.ts), so losing it doesn't open the Esc menu (src/menu.ts). */
/** `escClosedAt`: when Esc last closed the inventory/chest/workbench, so the same press (or the lock change after it) doesn't open the Esc menu (src/menu.ts). */
/** `closeAsked`: the browser just asked before closing the tab (Ctrl+W while windowed), so the Esc menu says why. */
export const ui = { inventoryOpen: false, debugFreed: false, escClosedAt: -Infinity, closeAsked: false };
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
  const canvas = e.target;
  // Going fullscreen cancels the lock the same click just asked for (src/camera.ts): ask again once it's done.
  void fullscreen().then((went) => {
    if (went && !document.pointerLockElement) Promise.resolve(canvas.requestPointerLock()).catch(() => {});
  });
});
/** Fullscreen with the keyboard locked, if that's the setting and we aren't already; resolves when it's done, with
 *  whether it went fullscreen now. */
function fullscreen(): Promise<boolean> {
  if (!keyboard || !graphics.fullscreen || document.fullscreenElement || !document.documentElement.requestFullscreen) return Promise.resolve(false);
  return document.documentElement.requestFullscreen().then(() => (keyboard.lock(), true), () => false);
}
/** Back into the game from a click outside the canvas (the Esc menu): capture the mouse, go fullscreen. Resolves
 *  whether the mouse was taken. Chrome refuses within ~1 s of its own Esc releasing it, and after that without a fresh
 *  click (Esc is no gesture); after the page released it itself (fullscreen, keyboard locked: see keydown below) no
 *  gesture is needed. (By the events, not requestPointerLock's promise, which not every browser returns.) */
export function capture(canvas: HTMLElement): Promise<boolean> {
  if (document.pointerLockElement === canvas) return Promise.resolve(true);
  // Fullscreen first: going fullscreen cancels a lock asked for before it.
  return fullscreen().then(() => lock(canvas));
}

function lock(canvas: HTMLElement): Promise<boolean> {
  if (document.pointerLockElement === canvas) return Promise.resolve(true);
  const got = new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      document.removeEventListener('pointerlockchange', change);
      document.removeEventListener('pointerlockerror', error);
      clearTimeout(timer);
      resolve(ok);
    };
    const change = () => done(document.pointerLockElement === canvas);
    const error = () => done(false);
    const timer = setTimeout(() => done(false), 1000);
    document.addEventListener('pointerlockchange', change);
    document.addEventListener('pointerlockerror', error);
  });
  Promise.resolve(canvas.requestPointerLock()).catch(() => {});
  return got;
}
// Real keys and mouse (not the gamepad's synthetic events, src/gamepad.ts) put the hints back on the keyboard's names.
const keysUsed = (e: Event) => e.isTrusted && setDevice('keys');
addEventListener('mousedown', keysUsed);
addEventListener('wheel', keysUsed, { passive: true });
addEventListener('mousemove', (e) => {
  if (Math.abs(e.movementX) + Math.abs(e.movementY) > 3) keysUsed(e);
});
addEventListener('keydown', (e) => {
  keysUsed(e);
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
/** Mouse travel from the gamepad's right stick (src/gamepad.ts), for the same gestures. */
export function addMouse(dx: number, dy: number) {
  mdx += dx;
  mdy += dy;
}
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
// Without the keyboard lock (windowed, or not Chromium) Ctrl+W still reaches the browser; crouch + forward is an
// easy slip, so while in the game the browser asks before closing the tab. Its text can't be set; the mouse is freed
// for its buttons, and staying lands in the Esc menu, whose button goes fullscreen.
addEventListener('beforeunload', (e) => {
  if (!captured()) return;
  e.preventDefault();
  ui.closeAsked = true;
  document.exitPointerLock();
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) keyboard?.unlock();
});

/** Options → Graphics → Display: go fullscreen now (needs the click that chose it) or leave it (also releases the keyboard lock). */
export function setFullscreen(on: boolean) {
  if (!on) {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  } else if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().then(() => keyboard?.lock(), () => {});
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
  const getOff = tools.getOff;
  tools.getOff = false;
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
  // The bike key (Z or 9 by default): get off the motorcycle, or stop getting on it (shared/sim.ts); a press of F while
  // riding too (`getOff`, one tick, from src/main.ts: F also gets on).
  if (actionHeld('bike') || getOff) input |= BIKE;
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
  return !tools.frozen && !tools.spinning && actionHeld('aim');
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
