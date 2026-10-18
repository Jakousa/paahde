// Building the world is a lot of work on the one browser thread, and while it runs the page can't take a click, so the
// loading screen's game (src/loadingGame.ts) would feel dead. Between the big steps, `await slice()` gives the browser
// a turn whenever the current stretch has run past the budget, which keeps every stretch near a 15 fps frame.
export const LOADING_FRAME_MS = 66;
const BUDGET_MS = 30;
let since = performance.now();

export function slice(): Promise<void> | undefined {
  if (performance.now() - since < BUDGET_MS) return undefined;
  return new Promise((resolve) =>
    setTimeout(() => {
      since = performance.now();
      resolve();
    }, 0),
  );
}
