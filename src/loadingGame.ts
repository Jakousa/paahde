// The loading screen's game (src/loadingRunner.ts) on the #cover from index.html, started from src/entry.ts before
// the big game bundle has downloaded and stopped by src/main.ts when the cover leaves. The main thread is blocked for
// long stretches while the world builds, so the game and the bar are drawn by a worker into an OffscreenCanvas; only
// the pointer events come through the page. Without OffscreenCanvas it runs on the page instead.
import { createRunner, H, W } from './loadingRunner';

let canvas: HTMLCanvasElement | null = null;
let off: (() => void) | null = null;
let progress: (p: number) => void = () => {};

function start() {
  const cover = document.getElementById('cover');
  if (!cover || canvas) return;
  const c = (canvas = document.createElement('canvas'));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.style.cssText = `width:min(${W}px,94vw);aspect-ratio:${W}/${H};touch-action:none;user-select:none;`;
  cover.prepend(c);
  cover.classList.add('play'); // hides the plain bar: the canvas draws its own
  cover.style.pointerEvents = 'auto';

  let down = (_x: number, _y: number) => {};
  let move = (_x: number, _y: number) => {};
  let up = () => {};
  let stop = () => {};
  let worker: Worker | null = null;
  if (typeof c.transferControlToOffscreen === 'function' && typeof Worker !== 'undefined') {
    try {
      worker = new Worker(new URL('./loadingWorker.ts', import.meta.url), { type: 'module' });
      const offscreen = c.transferControlToOffscreen();
      worker.postMessage({ t: 'init', canvas: offscreen, dpr }, [offscreen]);
      const w = worker;
      down = (x, y) => w.postMessage({ t: 'down', x, y });
      move = (x, y) => w.postMessage({ t: 'move', x, y });
      up = () => w.postMessage({ t: 'up' });
      progress = (p) => w.postMessage({ t: 'progress', p });
      stop = () => w.postMessage({ t: 'stop' });
    } catch {
      worker = null;
    }
  }
  if (!worker) {
    c.width = W * dpr;
    c.height = H * dpr;
    const run = createRunner(c.getContext('2d')!, dpr);
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      run.frame((now - last) / 1000);
      last = now;
    };
    raf = requestAnimationFrame(frame);
    down = run.down;
    move = run.move;
    up = run.up;
    progress = run.progress;
    stop = () => cancelAnimationFrame(raf);
  }

  // Canvas pixels in the game's own units (W x H).
  const at = (e: PointerEvent): [number, number] => {
    const r = c.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    down(...at(e));
  };
  const onMove = (e: PointerEvent) => move(...at(e));
  const onUp = () => up();
  c.addEventListener('pointerdown', onDown);
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  addEventListener('pointercancel', onUp);
  off = () => {
    stop();
    c.removeEventListener('pointerdown', onDown);
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('pointercancel', onUp);
  };
}

function stopGame() {
  off?.();
  off = null;
  canvas?.remove();
  canvas = null;
  progress = () => {};
}

export const loading = { start, stop: stopGame, progress: (p: number) => progress(p) };
