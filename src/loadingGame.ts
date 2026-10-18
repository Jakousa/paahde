// The loading screen's game (src/loadingRunner.ts) on the #cover from index.html, started from src/entry.ts before
// the big game bundle has downloaded and stopped by src/main.ts when the cover leaves. The main thread is blocked for
// long stretches while the world builds, so the game and the bar are drawn by a worker into an OffscreenCanvas; only
// the key and mouse events come through the busy page. Without OffscreenCanvas it runs on the page instead.
import { createRunner, H, W } from './loadingRunner';

const BEST_KEY = 'dadajam.runner';
const KEYS = ['Space', 'ArrowUp', 'KeyW'];

let canvas: HTMLCanvasElement | null = null;
let off: (() => void) | null = null;
let progress: (p: number) => void = () => {};

function best(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}
function saveBest(n: number) {
  try {
    localStorage.setItem(BEST_KEY, String(n));
  } catch {}
}

function start() {
  const cover = document.getElementById('cover');
  if (!cover || canvas) return;
  const c = (canvas = document.createElement('canvas'));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.style.cssText = `width:min(${W}px,92vw);aspect-ratio:${W}/${H};touch-action:manipulation;cursor:pointer;`;
  cover.prepend(c);
  cover.classList.add('play'); // hides the plain bar: the canvas draws its own
  cover.style.pointerEvents = 'auto';

  let press = () => {};
  let release = () => {};
  let stop = () => {};
  let worker: Worker | null = null;
  if (typeof c.transferControlToOffscreen === 'function' && typeof Worker !== 'undefined') {
    try {
      worker = new Worker(new URL('./loadingWorker.ts', import.meta.url), { type: 'module' });
      const offscreen = c.transferControlToOffscreen();
      worker.postMessage({ t: 'init', canvas: offscreen, dpr, best: best() }, [offscreen]);
      worker.onmessage = (e) => e.data.t === 'best' && saveBest(e.data.n);
      const w = worker;
      press = () => w.postMessage({ t: 'press' });
      release = () => w.postMessage({ t: 'release' });
      progress = (p) => w.postMessage({ t: 'progress', p });
      stop = () => w.postMessage({ t: 'stop' });
    } catch {
      worker = null;
    }
  }
  if (!worker) {
    c.width = W * dpr;
    c.height = H * dpr;
    const run = createRunner(c.getContext('2d')!, dpr, best(), saveBest);
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      run.frame((now - last) / 1000);
      last = now;
    };
    raf = requestAnimationFrame(frame);
    press = run.press;
    release = run.release;
    progress = run.progress;
    stop = () => cancelAnimationFrame(raf);
  }

  const onKey = (e: KeyboardEvent) => {
    if (!KEYS.includes(e.code)) return;
    e.preventDefault();
    if (!e.repeat) press();
  };
  const onKeyUp = (e: KeyboardEvent) => KEYS.includes(e.code) && release();
  const onDown = (e: PointerEvent) => {
    e.preventDefault();
    press();
  };
  const onUp = () => release();
  addEventListener('keydown', onKey);
  addEventListener('keyup', onKeyUp);
  cover.addEventListener('pointerdown', onDown);
  addEventListener('pointerup', onUp);
  off = () => {
    stop();
    removeEventListener('keydown', onKey);
    removeEventListener('keyup', onKeyUp);
    removeEventListener('pointerup', onUp);
    cover.removeEventListener('pointerdown', onDown);
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
