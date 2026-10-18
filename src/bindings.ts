// Rebindable keys. Bindings are physical keys (KeyboardEvent.code), so WASD stays under the left hand on AZERTY /
// Dvorak; labels shown to the player come from the layout map. Each action has two slots; binding a key that another
// action holds takes it from there. Saved in localStorage. Fixed (not rebindable): mouse buttons, Esc, Enter (chat),
// 1–9 (hotbar, 9 = bike), F3 / ` (debug panel), Meta keys.

export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'crouch' | 'use' | 'aim' | 'spyglass'
  | 'interact' | 'bike' | 'inventory' | 'thirdPerson' | 'rotate' | 'pickPlaced';

type Slots = [string, string];

/** In menu order; `label` is the action's name there. '' is an empty slot. */
export const ACTIONS: { id: Action; label: string; keys: Slots }[] = [
  { id: 'forward', label: 'forward', keys: ['KeyW', 'ArrowUp'] },
  { id: 'back', label: 'back', keys: ['KeyS', 'ArrowDown'] },
  { id: 'left', label: 'left', keys: ['KeyA', 'ArrowLeft'] },
  { id: 'right', label: 'right', keys: ['KeyD', 'ArrowRight'] },
  { id: 'jump', label: 'jump', keys: ['Space', ''] },
  { id: 'sprint', label: 'slide · hold breath', keys: ['ShiftLeft', ''] },
  { id: 'crouch', label: 'crouch', keys: ['ControlLeft', 'KeyC'] },
  { id: 'use', label: 'use · throw', keys: ['KeyE', ''] },
  { id: 'aim', label: 'aim', keys: ['KeyX', ''] },
  { id: 'spyglass', label: 'spyglass', keys: ['KeyQ', ''] },
  { id: 'interact', label: 'pick up · interact', keys: ['KeyF', ''] },
  { id: 'bike', label: 'motorcycle', keys: ['KeyZ', ''] },
  { id: 'inventory', label: 'inventory', keys: ['Tab', ''] },
  { id: 'thirdPerson', label: 'third person', keys: ['KeyT', ''] },
  { id: 'rotate', label: 'rotate', keys: ['KeyR', ''] },
  { id: 'pickPlaced', label: 'pick up placed', keys: ['KeyG', ''] },
];

const KEY = 'dadajam.bindings';
const RESERVED = /^(Escape|Enter|NumpadEnter|F3|Backquote|Digit[1-9]|Meta.*|ContextMenu)$/;

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
    for (const a of ACTIONS) {
      const s = saved[a.id];
      if (Array.isArray(s) && s.length === 2 && s.every((c) => typeof c === 'string' && !RESERVED.test(c))) {
        map.set(a.id, [norm(s[0]), norm(s[1])]);
      }
    }
  } catch {}
}
load();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {}
  for (const l of listeners) l();
}

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

/** Bind `code` to a slot ('' clears it). Returns the label of the action it was taken from, if any. */
export function bind(a: Action, slot: 0 | 1, code: string): string | undefined {
  code = norm(code);
  let taken: string | undefined;
  if (code) {
    for (const o of ACTIONS) {
      const s = map.get(o.id)!;
      for (const i of [0, 1] as const) {
        if (s[i] !== code || (o.id === a && i === slot)) continue;
        s[i] = '';
        if (o.id !== a) taken = o.label;
      }
    }
  }
  map.get(a)![slot] = code;
  save();
  return taken;
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
    for (const l of listeners) l();
  }, () => {});

const NAMES: Record<string, string> = {
  Space: 'Space', ShiftLeft: 'Shift', ControlLeft: 'Ctrl', AltLeft: 'Alt', Tab: 'Tab', CapsLock: 'Caps',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backspace: 'Bksp',
};

export function keyName(code: string): string {
  if (!code) return '—';
  if (NAMES[code]) return NAMES[code];
  const l = layout?.get(code);
  if (l) return l.length === 1 ? l.toUpperCase() : l;
  return code.replace(/^(Key|Digit)/, '').replace(/^Numpad/, 'Num ');
}
