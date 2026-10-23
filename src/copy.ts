// A button that copies something to the clipboard (the game's code in the lobby, the code and invite link in the Esc menu), says so for a
// moment, then shows its label again.
import { TEXT } from '../shared/text.ts';

/** Copy `value`; resolves false if the browser wouldn't. */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** `button` copies `value` when clicked, showing "Copied" for a moment (or the value itself, to copy by hand). */
export function copies(button: HTMLButtonElement, value: () => string) {
  const label = button.innerHTML; // (an icon, or text)
  let timer = 0;
  button.addEventListener('click', async () => {
    const v = value();
    button.textContent = (await copyText(v)) ? TEXT.menu.copied : v;
    clearTimeout(timer);
    timer = window.setTimeout(() => (button.innerHTML = label), 2500);
  });
}
