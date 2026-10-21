// Rebindable keys and mouse buttons. Bindings are physical keys (KeyboardEvent.code) or 'Mouse<button>', so WASD
// stays under the left hand on AZERTY / Dvorak; labels shown to the player come from the layout map. Each action has
// two slots and always keeps at least one: binding a key another action holds takes it from there (the two swap if
// that would leave the other empty), and the last key of an action can't be cleared. Saved in localStorage.
// Not rebindable: Esc (the browser frees the mouse with it; also cancels a rebind) and Meta keys.
// Also the registry of control hints: every key or button shown to the player comes from promptKey / kbd / ctl (or
// hintKeys inside a sentence), for the device last used: the keyboard and mouse, or the gamepad (src/padMap.ts
// names its buttons). Switching device relabels every hint on screen.
import { TEXT, type HintKeys } from '../shared/text.ts';
import { PAD_PROMPT, type PadGlyph } from './padMap';

export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'crouch' | 'use' | 'aim' | 'spyglass'
  | 'interact' | 'bike' | 'inventory' | 'thirdPerson' | 'rotate' | 'pickPlaced' | 'freeLook' | 'chat' | 'debug'
  | 'slot1' | 'slot2' | 'slot3' | 'slot4' | 'slot5';

/** What a hint can name: an action, or an input that is no action of its own (the pad's hotbar steps, the wheel's zoom,
 *  the Esc menu, the inventory's mouse moves). */
export type Prompt = Action | 'hotbarPrev' | 'hotbarNext' | 'zoom' | 'menu' | 'uiDrag' | 'uiHalf' | 'uiSend' | 'uiTurn' | 'uiClose';

/** The hotbar's slots in order (shared/items.ts HOTBAR = 5). */
export const HOTBAR_ACTIONS: Action[] = ['slot1', 'slot2', 'slot3', 'slot4', 'slot5'];

type Slots = [string, string];

/** In menu order (their names: shared/text.ts controls.actions). '' is an empty slot. */
export const ACTIONS: { id: Action; keys: Slots }[] = [
  { id: 'forward', keys: ['KeyW', 'ArrowUp'] },
  { id: 'back', keys: ['KeyS', 'ArrowDown'] },
  { id: 'left', keys: ['KeyA', 'ArrowLeft'] },
  { id: 'right', keys: ['KeyD', 'ArrowRight'] },
  { id: 'jump', keys: ['Space', ''] },
  { id: 'sprint', keys: ['ShiftLeft', ''] },
  { id: 'crouch', keys: ['ControlLeft', 'KeyC'] },
  { id: 'use', keys: ['Mouse0', 'KeyE'] },
  { id: 'aim', keys: ['Mouse2', 'KeyX'] },
  { id: 'spyglass', keys: ['KeyQ', ''] },
  { id: 'interact', keys: ['KeyF', ''] },
  { id: 'bike', keys: ['KeyZ', 'Digit9'] },
  { id: 'slot1', keys: ['Digit1', ''] },
  { id: 'slot2', keys: ['Digit2', ''] },
  { id: 'slot3', keys: ['Digit3', ''] },
  { id: 'slot4', keys: ['Digit4', ''] },
  { id: 'slot5', keys: ['Digit5', ''] },
  { id: 'inventory', keys: ['Tab', ''] },
  { id: 'thirdPerson', keys: ['KeyT', ''] },
  { id: 'freeLook', keys: ['AltLeft', ''] },
  { id: 'rotate', keys: ['KeyR', ''] },
  { id: 'pickPlaced', keys: ['KeyG', ''] },
  { id: 'chat', keys: ['Enter', 'NumpadEnter'] },
  { id: 'debug', keys: ['F3', 'Backquote'] },
];

const KEY = 'dadajam.bindings3';
const RESERVED = /^(Escape|Meta.*|ContextMenu)$/;

/** Left and right Shift / Ctrl / Alt are one key to the game. */
export function norm(code: string): string {
  return code.replace(/^(Shift|Control|Alt)Right$/, '$1Left');
}

const map = new Map<Action, Slots>();
const listeners = new Set<() => void>();

function defaults() {
  for (const a of ACTIONS) map.set(a.id, [...a.keys]);
}

function load() {
  defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    const next = new Map<Action, Slots>();
    for (const a of ACTIONS) {
      const s = saved[a.id];
      if (!Array.isArray(s) || s.length !== 2 || !s.every((c) => typeof c === 'string' && !RESERVED.test(c))) continue;
      const pair: Slots = [norm(s[0]), norm(s[1])];
      if (pair[0] || pair[1]) next.set(a.id, pair);
    }
    // Take the saved set only if nothing ends up bound twice; otherwise keep the defaults.
    const used = new Set<string>();
    for (const a of ACTIONS) {
      for (const c of next.get(a.id) ?? a.keys) {
        if (!c) continue;
        if (used.has(c)) return;
        used.add(c);
      }
    }
    for (const [a, s] of next) map.set(a, s);
  } catch {}
}
load();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {}
  changed();
}

function changed() {
  for (const el of document.querySelectorAll<HTMLElement>('kbd[data-act]')) {
    el.textContent = promptKey(el.dataset.act as Prompt);
    el.hidden = !el.textContent;
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-ctl]')) el.hidden = !promptKey(el.dataset.ctl as Prompt);
  for (const l of listeners) l();
}

// ---- The device in use --------------------------------------------------------------------------------------------

export type Device = 'keys' | 'xbox' | 'playstation';
let device: Device = 'keys';

/** The keyboard or mouse (src/input.ts) or the gamepad (src/gamepad.ts) was just used: hints follow it. */
export function setDevice(d: Device) {
  if (d === device) return;
  device = d;
  document.body.classList.toggle('pad', d !== 'keys');
  changed();
}

export function usingPad(): boolean {
  return device !== 'keys';
}

// Hidden hints take no room, whatever their own display.
const style = document.createElement('style');
style.textContent = 'kbd[data-act][hidden], [data-ctl][hidden] { display: none !important; }';
document.head.append(style);

export function slots(a: Action): Slots {
  return map.get(a)!;
}

/** Is this key (a KeyboardEvent.code) bound to the action? */
export function isBound(a: Action, code: string): boolean {
  const c = norm(code);
  const s = map.get(a)!;
  return s[0] === c || s[1] === c;
}

export function canBind(code: string): boolean {
  return !RESERVED.test(code);
}

/** Bind `code` to a slot ('' clears it). Returns a short note for the menu when something happened besides the bind. */
export function bind(a: Action, slot: 0 | 1, code: string): string | undefined {
  code = norm(code);
  const mine = map.get(a)!;
  const other = (1 - slot) as 0 | 1;
  const old = mine[slot];
  if (code === old) return;
  if (!code) {
    if (!mine[other]) return TEXT.controls.needsKey;
    mine[slot] = '';
    save();
    return;
  }
  let note: string | undefined;
  for (const o of ACTIONS) {
    if (o.id === a) continue;
    const s = map.get(o.id)!;
    const i = s[0] === code ? 0 : s[1] === code ? 1 : undefined;
    if (i === undefined) continue;
    const j = (1 - i) as 0 | 1;
    if (s[j]) s[i] = '';
    else if (old) s[i] = old; // would be left with nothing: swap
    else return TEXT.controls.onlyKey(keyName(code), TEXT.controls.actions[o.id]);
    note = TEXT.controls.takenFrom(keyName(code), TEXT.controls.actions[o.id]);
  }
  // Moving a key between this action's own slots just empties the other one.
  if (mine[other] === code) mine[other] = '';
  mine[slot] = code;
  save();
  return note;
}

const keyOf = (a: Action) => {
  const s = map.get(a)!;
  return s[0] || s[1];
};
const padName = (g: PadGlyph) => TEXT.controls.pad[device === 'playstation' ? 'playstation' : 'xbox'][g];

/** The key or button to show for a prompt on the device in use; '' where it has none (its hint hides). Keys: an
 *  action's first set slot. */
export function promptKey(p: Prompt): string {
  if (device !== 'keys') return (PAD_PROMPT[p] ?? []).map(padName).join('/');
  switch (p) {
    case 'hotbarPrev': case 'hotbarNext': case 'uiDrag': case 'uiClose': return ''; // the number keys; the mouse itself
    case 'zoom': return TEXT.controls.wheel;
    case 'menu': return '';
    case 'uiHalf': return keyName('Mouse2');
    case 'uiSend': return TEXT.controls.combo(keyName('ShiftLeft'), keyName('Mouse0'));
    case 'uiTurn': return keyName(keyOf('rotate'));
    default: return keyName(keyOf(p));
  }
}

/** `<kbd>` markup for HUD prompts; follows rebinding and the device (hidden where the device has no such input). */
export function kbd(p: Prompt): string {
  const k = promptKey(p);
  return `<kbd data-act="${p}"${k ? '' : ' hidden'}>${k}</kbd>`;
}

/** A key and its label (`<kbd>` + text) that hides as a whole where the device has no such input. */
export function ctl(p: Prompt, label: string): string {
  return `<span data-ctl="${p}"${promptKey(p) ? '' : ' hidden'}>${kbd(p)}${label}</span>`;
}

/** A key or button inside a sentence: "the left mouse button", "Tab", "RT"; zoom is the wheel or the d-pad. */
function spoken(p: Prompt): string {
  const S = TEXT.controls.spoken;
  if (device !== 'keys') return p === 'zoom' ? S.dpad : promptKey(p);
  if (p === 'zoom') return S.wheel;
  return S.mouse[keyOf(p as Action)] ?? promptKey(p);
}

/** The names the hint banners and gear texts take (shared/text.ts HintKeys). */
export function hintKeys(): HintKeys {
  return { inventory: spoken('inventory'), bike: spoken('bike'), use: spoken('use'), aim: spoken('aim'), zoom: spoken('zoom') };
}

export function resetAll() {
  defaults();
  save();
}

export function onChange(fn: () => void) {
  listeners.add(fn);
}

// Layout-aware names ("Z" for KeyY on QWERTZ). getLayoutMap is Chromium-only; elsewhere the code is prettified.
let layout: { get(code: string): string | undefined } | undefined;
(navigator as Navigator & { keyboard?: { getLayoutMap?(): Promise<typeof layout> } }).keyboard
  ?.getLayoutMap?.()
  .then((m) => {
    layout = m;
    changed();
  }, () => {});


export function keyName(code: string): string {
  const T = TEXT.controls;
  if (!code) return T.noKey;
  if (T.keys[code]) return T.keys[code];
  if (code.startsWith('Mouse')) return T.mouse(Number(code.slice(5)) + 1);
  const l = layout?.get(code);
  if (l) return l.length === 1 ? l.toUpperCase() : l;
  const key = code.replace(/^(Key|Digit)/, '');
  return key.startsWith('Numpad') ? T.numpad(key.slice(6)) : key;
}
