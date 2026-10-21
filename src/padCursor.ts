// The gamepad in the inventory and the workbench menu (src/gamepad.ts hands it the pad while ui.inventoryOpen): a
// drawn cursor that works them as the mouse does, through synthetic pointer events at its tip, so dragging, swapping,
// splitting and the buttons all go through src/inventory.ts and src/benchMenu.ts unchanged.
//   left stick   move the cursor                  d-pad      step to the next slot, cell or button that way
//   A (✕)        press / release: hold and move to drag an item, tap to click a button
//   Y (△)        the same with the right button: drag half a stack
//   X (□)        shift-click: send the item across (src/inventory.ts shiftClick)
//   LB / RB      turn the dragged item (the rotate key)
//   right stick  scroll a long chest
//   B (○)        close; View (Share) closes the inventory too
// The mouse still works alongside: moving it hides the drawn cursor and takes it to the mouse.

// Standard mapping (https://w3c.github.io/gamepad/#remapping).
const A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, VIEW = 8;
const UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15;

const DEAD = 0.15;
/** Cursor speed at full tilt (px/s); the response is squared, for fine moves. */
const SPEED = 1100;
const SCROLL = 900;
/** The d-pad's step: one grid cell (src/inventory.ts CELL + GAP); it looks this many steps on for something new. */
const STEP = 58, LOOK_STEPS = 10;
/** Held, the d-pad repeats after this long, then every REPEAT_S. */
const REPEAT_DELAY_S = 0.35, REPEAT_S = 0.09;
/** What the d-pad lands on. */
const TARGETS = '#invOverlay .slot, #invOverlay .cell, #invOverlay button, #benchMenu button';
/** Where the cursor starts when the inventory or the menu opens. */
const START = '#invOverlay.open .slot[data-box="bag"], #benchMenu.open button';

const css = `
#padCursor { position: fixed; left: 0; top: 0; z-index: 1000; width: 20px; height: 20px; margin: -10px 0 0 -10px;
  border-radius: 50%; pointer-events: none; display: none; box-sizing: border-box;
  border: 2px solid #fff4e4; background: rgba(255, 210, 140, 0.25); box-shadow: 0 0 0 1px rgba(20, 10, 5, 0.7), 0 2px 6px rgba(0, 0, 0, 0.5); }
#padCursor.down { transform: scale(0.75); background: rgba(255, 210, 140, 0.6); }
`;

type Pad = { down: boolean[]; pressed: (i: number) => boolean; axes: readonly number[] };

let el: HTMLElement | undefined;
let x = innerWidth / 2, y = innerHeight / 2;
/** Open last frame (the cursor is placed anew on opening). */
let wasOpen = false;
/** The pointer button the pad holds down (0 left, 2 right), and where it went down. */
let button = -1;
let x0 = 0, y0 = 0;
let dpadDir = -1, dpadNext = 0;

function cursor() {
  if (el) return el;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  el = document.createElement('div');
  el.id = 'padCursor';
  document.body.append(el);
  // The mouse takes over: the drawn cursor goes, and comes back where the mouse is.
  addEventListener('pointermove', (e) => {
    if (!e.isTrusted || !el) return;
    x = e.clientX;
    y = e.clientY;
    el.style.display = 'none';
  });
  return el;
}

const under = () => document.elementFromPoint(x, y);

function pointer(type: 'pointerdown' | 'pointermove' | 'pointerup', b: number, shift = false) {
  const opts: PointerEventInit = {
    bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse',
    isPrimary: true, button: type === 'pointermove' ? -1 : b, buttons: type === 'pointerup' || b < 0 ? 0 : b === 2 ? 2 : 1, shiftKey: shift,
  };
  (under() ?? document.body).dispatchEvent(new PointerEvent(type, opts));
}

function draw() {
  const c = cursor();
  c.style.display = 'block';
  c.style.transform = `translate(${x}px, ${y}px)`;
  c.classList.toggle('down', button >= 0);
}

function centre(t: Element) {
  const r = t.getBoundingClientRect();
  x = r.left + r.width / 2;
  y = r.top + r.height / 2;
}

/** The d-pad: on to the middle of the next slot, cell or button that way, else one cell's step. */
function step(dx: number, dy: number) {
  const from = under()?.closest(TARGETS) ?? null;
  for (let k = 1; k <= LOOK_STEPS; k++) {
    const px = x + dx * STEP * k, py = y + dy * STEP * k;
    if (px < 0 || py < 0 || px > innerWidth || py > innerHeight) break;
    const t = document.elementFromPoint(px, py)?.closest(TARGETS);
    if (t && t !== from) return centre(t);
  }
  x = Math.max(0, Math.min(innerWidth - 1, x + dx * STEP));
  y = Math.max(0, Math.min(innerHeight - 1, y + dy * STEP));
}

/** The nearest box under the cursor that scrolls (a long chest), if any. */
function scroller(): HTMLElement | null {
  for (let e = under() as HTMLElement | null; e && e !== document.body; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY;
    if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight) return e;
  }
  return null;
}

/** Let go of anything held and hide (the inventory closed, or the pad left it). */
export function hidePadCursor() {
  if (button >= 0) pointer('pointerup', button);
  button = -1;
  wasOpen = false;
  if (el) el.style.display = 'none';
}

/** Every frame while the inventory or the workbench menu is open. `tap`: press a key; `keys`: the codes bound to the
 *  inventory and rotate actions. */
export function padCursor(dt: number, pad: Pad, tap: (code: string) => void, keys: { inventory: string; rotate: string }) {
  const { down, pressed, axes } = pad;
  if (pressed(B) || pressed(VIEW)) {
    hidePadCursor();
    // View is the inventory's own key; the workbench menu closes on Esc.
    return tap(pressed(VIEW) && document.getElementById('invOverlay')?.classList.contains('open') ? keys.inventory : 'Escape');
  }
  if (!wasOpen) {
    wasOpen = true;
    const s = document.querySelector(START);
    if (s) centre(s);
  }
  let moved = false;
  // Stick: free movement.
  const [lx, ly, , ry] = axes;
  const m = Math.hypot(lx, ly);
  if (m > DEAD) {
    const k = (((m - DEAD) / (1 - DEAD)) ** 2 / m) * SPEED * dt;
    x = Math.max(0, Math.min(innerWidth - 1, x + lx * k));
    y = Math.max(0, Math.min(innerHeight - 1, y + ly * k));
    moved = true;
  }
  // D-pad: steps, repeating while held.
  const dir = down[UP] ? UP : down[DOWN] ? DOWN : down[LEFT] ? LEFT : down[RIGHT] ? RIGHT : -1;
  const now = performance.now() / 1000;
  if (dir !== dpadDir) dpadNext = now + REPEAT_DELAY_S;
  if (dir >= 0 && (dir !== dpadDir || now >= dpadNext)) {
    if (dir === dpadDir) dpadNext = now + REPEAT_S;
    step(dir === LEFT ? -1 : dir === RIGHT ? 1 : 0, dir === UP ? -1 : dir === DOWN ? 1 : 0);
    moved = true;
  }
  dpadDir = dir;
  // Right stick: scroll what's under the cursor.
  if (Math.abs(ry) > DEAD) {
    const s = scroller();
    if (s) {
      s.scrollTop += Math.sign(ry) * ((Math.abs(ry) - DEAD) / (1 - DEAD)) ** 2 * SCROLL * dt;
      moved = true;
    }
  }
  if (moved || !el || el.style.display === 'none') draw();
  if (moved) pointer('pointermove', button);

  // A (left) and Y (right): press and release where the cursor is; a release where it went down is a click.
  for (const [b, btn] of [[A, 0], [Y, 2]] as const) {
    if (pressed(b) && button < 0) {
      button = btn;
      x0 = x;
      y0 = y;
      pointer('pointerdown', btn);
      draw();
    } else if (!down[b] && button === btn) {
      pointer('pointerup', btn);
      button = -1;
      if (btn === 0 && Math.hypot(x - x0, y - y0) < 4) under()?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      draw();
    }
  }
  if (pressed(X) && button < 0) {
    pointer('pointerdown', 0, true);
    pointer('pointerup', 0, true);
  }
  if (pressed(LB) || pressed(RB)) tap(keys.rotate);
}
