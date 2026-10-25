// The controls: Options → Controls (src/options.ts), in the Esc menu and on the main menu. A row per action with its two
// keys or buttons; click one, press the new key (Esc cancels, Backspace clears). Bindings live in src/bindings.ts.
import { ACTIONS, bind, keyName, onChange, resetAll, slots } from './bindings';
import { TEXT } from '../shared/text.ts';

/** The Controls tab's pane. */
export function controlsHtml(): string {
  return `<div class="pane" data-pane="controls"><h3>${TEXT.controls.how}</h3><div class="binds"></div><div class="note bindNote"></div>
<button class="reset">${TEXT.controls.reset}</button><div class="foot">${TEXT.controls.fixed}</div></div>`;
}

/** Wire the rebinding rows in `root`; `leave` (when the pane is hidden) stops listening. Returns the unbinding. */
export function bindRebind(root: HTMLElement): { leave: () => void; unbind: () => void } {
  const grid = root.querySelector<HTMLElement>('.binds')!;
  grid.innerHTML = ACTIONS.map((a) => `<span>${TEXT.controls.actions[a.id]}</span><button data-a="${a.id}" data-s="0"></button><button data-a="${a.id}" data-s="1"></button>`).join('');
  const note = root.querySelector<HTMLElement>('.bindNote')!;
  const buttons = [...grid.querySelectorAll<HTMLButtonElement>('button')];
  let listening: HTMLButtonElement | undefined;
  const show = () => {
    for (const b of buttons) {
      const s = slots(b.dataset.a as never);
      b.textContent = b === listening ? '…' : keyName(s[Number(b.dataset.s)]);
      b.classList.toggle('listening', b === listening);
    }
  };
  const offChange = onChange(show);
  show();
  // Capture phase on window and registered before the Esc menu's: while listening, no other handler sees the key.
  const keydown = (e: KeyboardEvent) => {
    if (listening && !grid.offsetParent) leave(); // (the view was left with a key still waiting)
    if (!listening) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    // Modifier keys bind on release, so a chord isn't taken as the modifier alone.
    if (/^(Shift|Control|Alt)/.test(e.code)) {
      pendingMod = e.code;
      return;
    }
    pendingMod = '';
    finish(e.code);
  };
  let pendingMod = '';
  let ignoreClick = false;
  // A mouse button binds too; the click that follows must not toggle the button again.
  const mousedown = (e: MouseEvent) => {
    if (listening && !grid.offsetParent) leave();
    if (!listening) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    ignoreClick = true;
    setTimeout(() => (ignoreClick = false), 0);
    finish(`Mouse${e.button}`);
  };
  const keyup = (e: KeyboardEvent) => {
    if (!listening || e.code !== pendingMod) return;
    e.stopImmediatePropagation();
    pendingMod = '';
    finish(e.code);
  };
  addEventListener('keydown', keydown, true);
  addEventListener('mousedown', mousedown, true);
  addEventListener('keyup', keyup, true);
  const finish = (code: string) => {
    const b = listening!;
    listening = undefined;
    note.textContent = '';
    if (code === 'Escape') return show();
    const a = b.dataset.a as never;
    const slot = Number(b.dataset.s) as 0 | 1;
    note.textContent = (code === 'Backspace' || code === 'Delete' ? bind(a, slot, '') : bind(a, slot, code)) ?? '';
    show();
  };
  grid.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b || ignoreClick) return;
    listening = listening === b ? undefined : b;
    note.textContent = listening ? TEXT.controls.listening : '';
    show();
  });
  root.querySelector('.reset')!.addEventListener('click', (e) => {
    listening = undefined;
    note.textContent = '';
    resetAll();
  });
  const leave = () => {
    listening = undefined;
    note.textContent = '';
    show();
  };
  return {
    leave,
    unbind: () => {
      leave();
      offChange();
      removeEventListener('keydown', keydown, true);
      removeEventListener('mousedown', mousedown, true);
      removeEventListener('keyup', keyup, true);
    },
  };
}
