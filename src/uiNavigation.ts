// One focus model for the landing page, options and game overlays. Inventory transfers keep their own rules;
// the pad's free cursor remains available there, with directional movement based on actual element bounds.
import { isBound, setDevice, slots } from './bindings';
import { BTN, padStyle } from './padMap';
import { hidePadCursor, padCursor } from './padCursor';
import { TEXT } from '../shared/text.ts';
import { neighbour } from './uiFocus';

const ROOTS = ['#graphicsRecovery', '#uiKeyboard', '#landing.over', '#menu.open', '#buildMenu.open', '#benchMenu.open', '#invOverlay.open', '#landing'];
const TARGETS = 'button, a[href], input:not([type="hidden"]), select, textarea, [data-ui-focus]';
const visible = (e: HTMLElement) => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'
  && !e.closest('[hidden], [inert]') && !(e as HTMLButtonElement).disabled;
export const menuRoot = () => ROOTS.map((s) => document.querySelector<HTMLElement>(s)).find((e) => e && visible(e)) ?? null;
const targets = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(TARGETS)].filter(visible);
const textInput = (e: Element | null): e is HTMLInputElement | HTMLTextAreaElement =>
  (e instanceof HTMLTextAreaElement || e instanceof HTMLInputElement && ['text', 'password', 'search', 'email', 'url', 'tel', 'number'].includes(e.type))
  && !e.readOnly && !e.disabled;
const keyOf = (e: HTMLElement) => e.dataset.box !== undefined ? `box:${e.dataset.box}:${e.dataset.i}` : e.id || '';
let lastRoot: HTMLElement | null = null, lastKey = '', navigating = false;

function focus(e: HTMLElement | undefined | null) {
  if (!e) return;
  e.focus({ preventScroll: true });
  e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  lastKey = keyOf(e);
}

function ensureFocus(root: HTMLElement) {
  const list = targets(root);
  if (root.contains(document.activeElement) && visible(document.activeElement as HTMLElement)) return;
  focus(list.find((e) => lastKey && keyOf(e) === lastKey) ?? list[0]);
}

function direction(root: HTMLElement, dx: number, dy: number) {
  ensureFocus(root);
  const from = document.activeElement as HTMLElement | null;
  if (!from) return;
  focus(neighbour(from.getBoundingClientRect(), targets(root).filter((e) => e !== from)
    .map((element) => ({ element, rect: element.getBoundingClientRect() })), dx, dy));
}

function inventoryAction(action: string, half = false) {
  const root = document.getElementById('invOverlay');
  const target = root?.contains(document.activeElement) ? document.activeElement : root;
  target?.dispatchEvent(new CustomEvent('inventoryNavigate', { bubbles: true, detail: { action, half } }));
}

/** Increment controls ourselves for a pad; synthetic arrow events do not perform the browser's default action. */
function adjust(e: HTMLElement | null, delta: number): boolean {
  if (e instanceof HTMLInputElement && e.type === 'range') {
    const lo = Number(e.min || 0), hi = Number(e.max || 100), step = Number(e.step) || 1;
    e.value = String(Math.min(hi, Math.max(lo, Number(e.value) + delta * step)));
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (e instanceof HTMLSelectElement) {
    const options = [...e.options].filter((o) => !o.disabled);
    const i = options.findIndex((o) => o.value === e.value);
    e.value = options[Math.max(0, Math.min(options.length - 1, i + delta))]?.value ?? e.value;
    e.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

let dispatching = false;
const tap = (code: string) => {
  dispatching = true;
  try { for (const type of ['keydown', 'keyup']) window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true })); }
  finally { dispatching = false; }
};
function back(root: HTMLElement) {
  if (root.id === 'uiKeyboard') return closeKeyboard();
  const button = [...root.querySelectorAll<HTMLElement>('.optBack, .back, [data-ui-back], .resume')].find(visible);
  if (button) return button.click();
  if (root.id === 'invOverlay') inventoryAction('cancel');
  else if (root.id === 'buildMenu' || root.id === 'benchMenu') tap('Escape');
}

const style = document.createElement('style');
style.textContent = `
body.ui-navigation :is(#menu, #landing, #invOverlay, #buildMenu, #benchMenu, #uiKeyboard, #graphicsRecovery) :focus {
  outline: 3px solid #fff4d0 !important; outline-offset: 3px; }
#uiKeyboard { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; background: #140a08de; color: #fff4d0; font: 16px var(--mono); }
#uiKeyboard .panel { width: min(640px, 90vw); max-height: 86vh; overflow-y: auto; padding: 16px; background: #2a160a; border-radius: 8px; }
#uiKeyboard .keys { display: grid; grid-template-columns: repeat(10, 1fr); gap: 5px; margin: 16px 0; }
#uiKeyboard button { padding: 10px 3px; border: 1px solid #b99b70; background: #51371e; color: inherit; border-radius: 4px; }
#uiKeyboard .actions { display: flex; gap: 8px; } #uiKeyboard .actions button { flex: 1; }
#uiKeyboard .value { overflow-wrap: anywhere; min-height: 24px; }
`;
document.head.append(style);

let keyboardInput: HTMLInputElement | HTMLTextAreaElement | null = null;
function closeKeyboard() {
  document.getElementById('uiKeyboard')?.remove();
  focus(keyboardInput);
  keyboardInput = null;
}
function openKeyboard(input: HTMLInputElement | HTMLTextAreaElement) {
  keyboardInput = input;
  const root = document.createElement('div');
  root.id = 'uiKeyboard';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', TEXT.controls.keyboard);
  root.setAttribute('aria-modal', 'true');
  root.innerHTML = '<div class="panel"><div class="value"></div><div class="keys"></div><div class="actions"></div></div>';
  const value = root.querySelector<HTMLElement>('.value')!;
  const show = () => { value.textContent = input.type === 'password' ? '•'.repeat(input.value.length) : input.value; };
  const change = (s: string) => {
    input.value = input.maxLength >= 0 ? s.slice(0, input.maxLength) : s;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    show();
  };
  const button = (label: string, into: string, action: () => void) => {
    const b = document.createElement('button'); b.textContent = label; b.addEventListener('click', action); root.querySelector(into)!.append(b);
  };
  for (const ch of TEXT.controls.keyboardCharacters) button(ch, '.keys', () => change(input.value + ch));
  button(TEXT.controls.keyboardSpace, '.actions', () => change(input.value + ' '));
  button(TEXT.controls.keyboardErase, '.actions', () => change(input.value.slice(0, -1)));
  button(TEXT.controls.keyboardDone, '.actions', closeKeyboard);
  document.body.append(root); show(); focus(root.querySelector('button'));
}

// Capture on window before gameplay listeners: Tab belongs to the open menu, never closes it or moves the player.
window.addEventListener('keydown', (e) => {
  if (dispatching) return;
  const root = menuRoot();
  if (!root || document.pointerLockElement || root.querySelector('.listening') || e.ctrlKey || e.metaKey || e.altKey) return;
  navigating = true; document.body.classList.add('ui-navigation');
  const active = document.activeElement as HTMLElement | null;
  if (e.code === 'Tab') {
    const list = targets(root), i = list.indexOf(active!);
    if (list.length) focus(list[((i < 0 && e.shiftKey ? 0 : i) + (e.shiftKey ? -1 : 1) + list.length) % list.length]);
  } else if (e.code === 'Escape') {
    back(root);
  } else if (textInput(active)) return;
  else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
    const dx = e.code === 'ArrowLeft' ? -1 : e.code === 'ArrowRight' ? 1 : 0;
    const dy = e.code === 'ArrowUp' ? -1 : e.code === 'ArrowDown' ? 1 : 0;
    if (!(dx && adjust(active, dx))) direction(root, dx, dy);
  } else if (root.id === 'invOverlay' && active?.matches('[data-ui-focus]')) {
    if (e.repeat) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.code === 'Enter' || e.code === 'NumpadEnter') inventoryAction('select', e.shiftKey);
    else if (e.code === 'Space') inventoryAction('transfer');
    else if (e.code === 'Delete') inventoryAction('drop');
    else if (isBound('rotate', e.code)) inventoryAction('rotate');
    else return;
  } else {
    // Keep native activation, but do not send Enter into chat or Space into gameplay behind the menu.
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') e.stopImmediatePropagation();
    return;
  }
  e.preventDefault(); e.stopImmediatePropagation();
}, true);
document.addEventListener('focusin', (e) => {
  if (e.target instanceof HTMLElement && menuRoot()?.contains(e.target)) lastKey = keyOf(e.target);
});
window.addEventListener('pointerdown', (e) => {
  if (e.isTrusted) { navigating = false; document.body.classList.remove('ui-navigation'); }
}, true);

let previous: boolean[] = [], dir = '', next = 0, lastFrame = performance.now();
function poll(now: number) {
  requestAnimationFrame(poll);
  const dt = Math.min(0.05, (now - lastFrame) / 1000); lastFrame = now;
  const root = document.pointerLockElement ? null : menuRoot();
  const pad = navigator.getGamepads?.().find((p) => p?.connected && p.mapping === 'standard');
  const down = pad?.buttons.map((b) => b.pressed) ?? [];
  const pressed = (i: number) => !!down[i] && !previous[i];
  const active = !!pad && (down.some((d, i) => d && !previous[i]) || pad.axes.some((v) => Math.abs(v) > 0.45));
  if (root !== lastRoot) { lastRoot = root; lastKey = ''; dir = ''; }
  if (active && root) { navigating = true; setDevice(padStyle(pad!.id)); document.body.classList.add('ui-navigation'); }
  if (root && navigating) ensureFocus(root);
  if (!root || !pad) { previous = down; hidePadCursor(); return; }
  if (root.id === 'invOverlay') {
    if (active || document.body.classList.contains('pad')) padCursor(dt, { down, pressed, axes: pad.axes }, tap,
      { inventory: slots('inventory').find(Boolean) ?? '', rotate: slots('rotate').find(Boolean) ?? '' });
    previous = down; return;
  }
  hidePadCursor();
  if (root.querySelector('.listening')) {
    if (pressed(BTN.b) || pressed(BTN.menu)) tap('Escape');
    previous = down;
    return;
  }
  if (pressed(BTN.b) || pressed(BTN.menu)) back(root);
  else if (pressed(BTN.a)) {
    ensureFocus(root);
    const focused = document.activeElement as HTMLElement | null;
    if (textInput(focused)) openKeyboard(focused);
    else if (focused instanceof HTMLInputElement && focused.type === 'color') focus(root.querySelector('.swatches button'));
    else focused?.click();
  }
  const dx = down[BTN.left] || pad.axes[0] < -0.55 ? -1 : down[BTN.right] || pad.axes[0] > 0.55 ? 1 : 0;
  const dy = down[BTN.up] || pad.axes[1] < -0.55 ? -1 : down[BTN.down] || pad.axes[1] > 0.55 ? 1 : 0;
  const nextDir = dx || dy ? `${dx}:${dy}` : '';
  if (nextDir && (nextDir !== dir || now >= next)) {
    next = now + (nextDir !== dir ? 350 : 100);
    if (!(dx && adjust(document.activeElement as HTMLElement | null, dx))) direction(root, dx, dy);
  }
  dir = nextDir;
  if (pressed(BTN.lb) || pressed(BTN.rb)) {
    const tabs = [...root.querySelectorAll<HTMLElement>('.tab')].filter(visible);
    if (tabs.length) { const i = tabs.findIndex((b) => b.classList.contains('on')); const b = tabs[(i + (pressed(BTN.rb) ? 1 : -1) + tabs.length) % tabs.length]; b.click(); focus(b); }
  }
  const scroll = pad.axes[3] ?? 0;
  if (Math.abs(scroll) > 0.2) (root.querySelector<HTMLElement>('.panel') ?? root).scrollTop += scroll * 700 * dt;
  previous = down;
}
requestAnimationFrame(poll);
