// Gamepad: the usual third-person shooter layout on a standard-mapped pad (Xbox names; PlayStation in brackets).
//   left stick   move                       right stick  look
//   A (✕)        jump                       B (○)        crouch (hold); closes the inventory
//   X (□)        interact (pick up, fill)   Y (△)        bike on / off
//   LT (L2)      aim                        RT (R2)      use / fire
//   LB / RB      hotbar previous / next (filled slots and empty hands)
//   L3           sprint / slide: clicked, it stays on until the stick lets go
//   R3           third person
//   d-pad ↑ / ↓  zoom the scope or spyglass   d-pad ← rotate (placing, the table)   d-pad → pick up a placed thing
//   View (Share) inventory (worked with a cursor: src/padCursor.ts)   Menu (Options) Esc menu; again (or B) back into the game
// The pad doesn't drive the game itself: it presses the keys bound to each action (src/bindings.ts), as synthetic
// key events, so everything that reads keys (held or on keydown) works the same and follows rebinding. Only the
// look is its own: the camera's (src/camera.ts look) and the mouse travel the disassembly reads (src/input.ts).
// The stick moves on the same digital bits as WASD (shared/sim.ts input is a bitmask): eight ways, full speed.
// The game must have the mouse captured, as with the keyboard: a click starts it (browsers don't let a pad do that).
import { HOTBAR_ACTIONS, slots, type Action } from './bindings';
import { addMouse, aimDown, capture, tools, ui } from './input';
import type { FirstPersonCamera } from './camera';
import { hidePadCursor, padCursor } from './padCursor';

// Standard mapping (https://w3c.github.io/gamepad/#remapping).
const A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, LT = 6, RT = 7, VIEW = 8, MENU = 9, L3 = 10, R3 = 11;
const UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15;

/** Buttons that hold an action down while pressed. */
const HOLD: [number, Action][] = [
  [A, 'jump'], [B, 'crouch'], [X, 'interact'], [Y, 'bike'], [LT, 'aim'], [RT, 'use'], [VIEW, 'inventory'],
  [R3, 'thirdPerson'], [LEFT, 'rotate'], [RIGHT, 'pickPlaced'],
];
const MOVE_DEAD = 0.3;
/** Past this share of the stick's push towards an axis it counts (sin 22.5°: eight equal sectors). */
const SECTOR = 0.383;
const LOOK_DEAD = 0.12;
/** Turn rate at full tilt (rad/s), yaw and pitch; aiming takes it down. */
const YAW_RATE = 3.4, PITCH_RATE = 2.3, AIM_SCALE = 0.5;
/** Held at the edge, the turn speeds up to this much more over EDGE_RAMP s (to turn around quickly). */
const EDGE_BOOST = 0.8, EDGE_RAMP = 0.4;
/** The disassembly's cursor and gestures (mouse px/s at full tilt). */
const MOUSE_RATE = 900;
/** The d-pad zooms as the wheel would (deltaY per s). */
const ZOOM_RATE = 700;

/** The key codes we hold down now (synthetic keydowns sent, keyups not yet). */
const held = new Set<string>();
let prev: boolean[] = [];
let sprintLatch = false;
let edge = 0;

const code = (a: Action) => {
  const [x, y] = slots(a);
  return x || y;
};
const send = (type: 'keydown' | 'keyup', c: string) => dispatchEvent(new KeyboardEvent(type, { code: c, bubbles: true }));
const tap = (c: string) => (send('keydown', c), send('keyup', c));
const captured = () => !!document.pointerLockElement;

// Everything held is let go when the keyboard's keys are (src/input.ts clears them): pressed again on the next poll if
// still down and in the game.
const release = () => held.clear();
addEventListener('blur', release);
document.addEventListener('pointerlockchange', () => {
  if (captured()) return;
  for (const c of held) send('keyup', c);
  release();
});

/** Read the first connected pad once a frame: before the input is read and the camera placed. `bag`: the hotbar's
 *  slots (empty ones are skipped by LB / RB). */
export function pollPad(dt: number, view: FirstPersonCamera, canvas: HTMLElement, bag: readonly unknown[] | undefined) {
  const pad = navigator.getGamepads?.().find((p) => p?.connected && p.mapping === 'standard') ?? null;
  if (!pad) {
    if (held.size) for (const c of held) send('keyup', c);
    release();
    prev = [];
    return;
  }
  const down = pad.buttons.map((b) => b.pressed);
  const was = prev;
  const pressed = (i: number) => !!down[i] && !was[i];
  prev = down;

  // Out of the game: the inventory and the workbench menu are worked with a cursor (src/padCursor.ts); Menu (or B)
  // goes back in from the Esc menu.
  if (ui.inventoryOpen && !captured()) return padCursor(dt, { down, pressed, axes: pad.axes }, tap, { inventory: code('inventory'), rotate: code('rotate') });
  hidePadCursor();
  if (!captured()) {
    if ((pressed(MENU) || pressed(B)) && document.getElementById('menu')?.classList.contains('open')) capture(canvas);
    return;
  }
  if (pressed(MENU)) return document.exitPointerLock(); // the Esc menu opens (src/menu.ts)

  const want = new Set<string>();
  for (const [b, a] of HOLD) if (down[b]) want.add(code(a));

  // Move: the stick's direction in eight sectors.
  const [lx, ly, rx, ry] = pad.axes;
  const m = Math.hypot(lx, ly);
  if (m > MOVE_DEAD) {
    if (ly / m < -SECTOR) want.add(code('forward'));
    if (ly / m > SECTOR) want.add(code('back'));
    if (lx / m < -SECTOR) want.add(code('left'));
    if (lx / m > SECTOR) want.add(code('right'));
  }
  // Sprint: L3 turns it on until the stick comes back; held, it also holds your breath while aiming (src/input.ts breathHeld).
  if (pressed(L3)) sprintLatch = !sprintLatch;
  if (m <= MOVE_DEAD) sprintLatch = false;
  if (down[L3] || (sprintLatch && !aimDown())) want.add(code('sprint'));

  want.delete('');
  for (const c of held) if (!want.has(c)) send('keyup', c);
  for (const c of want) if (!held.has(c)) send('keydown', c);
  held.clear();
  for (const c of want) held.add(c);

  // Hotbar: LB / RB step through the filled slots and empty hands (a slot's key picks it; its own key again empties the hands).
  const step = pressed(RB) ? 1 : pressed(LB) ? -1 : 0;
  if (step) {
    const n = HOTBAR_ACTIONS.length;
    let s = tools.slot;
    for (let i = 0; i <= n; i++) {
      s = ((s + 1 + step + n + 1) % (n + 1)) - 1;
      if (s < 0 || bag?.[s]) break;
    }
    if (s !== tools.slot) tap(code(HOTBAR_ACTIONS[s < 0 ? tools.slot : s]));
  }

  // Zoom: the d-pad turns the wheel.
  const zoom = (down[DOWN] ? 1 : 0) - (down[UP] ? 1 : 0);
  if (zoom) dispatchEvent(new WheelEvent('wheel', { deltaY: zoom * ZOOM_RATE * dt }));

  // Look: dead zone, then a squared response for fine aim, faster when held at the edge.
  const r = Math.hypot(rx, ry);
  if (r <= LOOK_DEAD) {
    edge = 0;
    return;
  }
  const k = ((r - LOOK_DEAD) / (1 - LOOK_DEAD)) ** 2 / r;
  edge = r > 0.95 ? Math.min(1, edge + dt / EDGE_RAMP) : 0;
  const speed = k * (aimDown() ? AIM_SCALE : 1) * (1 + EDGE_BOOST * edge * edge) * dt;
  view.look(rx * speed * YAW_RATE, ry * speed * PITCH_RATE);
  addMouse(rx * k * MOUSE_RATE * dt, ry * k * MOUSE_RATE * dt);
}

/** A little rumble (shots, hits), if the pad has it. */
export function rumble(strong: number, weak: number, ms: number) {
  const pad = navigator.getGamepads?.().find((p) => p?.connected && p.mapping === 'standard');
  const act = (pad as (Gamepad & { vibrationActuator?: { playEffect(t: string, p: object): Promise<unknown> } }) | undefined)?.vibrationActuator;
  act?.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
}
