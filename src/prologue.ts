// The loading cover (#cover in index.html): the prologue (src/prologueRunner.ts), started from src/entry.ts before
// the big game bundle has downloaded and stopped by src/main.ts when the cover leaves. The main thread is blocked for
// long stretches while the world builds, so it is drawn by a worker into an OffscreenCanvas. Without OffscreenCanvas
// it runs on the page instead.
import { createPrologue } from './prologueRunner';

let off: (() => void) | null = null;
let progress: (p: number) => void = () => {};

function start() {
  const cover = document.getElementById('cover');
  if (!cover || off) return;
  const c = document.createElement('canvas');
  cover.prepend(c);
  const size = () => ({ w: innerWidth, h: innerHeight, dpr: window.devicePixelRatio || 1 });

  let resize = () => {};
  let stop = () => {};
  let worker: Worker | null = null;
  if (typeof c.transferControlToOffscreen === 'function' && typeof Worker !== 'undefined') {
    try {
      worker = new Worker(new URL('./prologueWorker.ts', import.meta.url), { type: 'module' });
      const offscreen = c.transferControlToOffscreen();
      worker.postMessage({ t: 'init', canvas: offscreen, ...size() }, [offscreen]);
      const w = worker;
      resize = () => w.postMessage({ t: 'size', ...size() });
      progress = (p) => w.postMessage({ t: 'progress', p });
      stop = () => w.postMessage({ t: 'stop' });
    } catch {
      worker = null;
    }
  }
  if (!worker) {
    const run = createPrologue(c.getContext('2d')!, (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }));
    resize = () => {
      const s = size();
      run.resize(s.w, s.h, s.dpr);
    };
    resize();
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      run.frame((now - last) / 1000);
      last = now;
    };
    raf = requestAnimationFrame(frame);
    progress = run.progress;
    stop = () => cancelAnimationFrame(raf);
  }
  addEventListener('resize', resize);
  off = () => {
    stop();
    removeEventListener('resize', resize);
    c.remove();
  };
}

function stopPrologue() {
  off?.();
  off = null;
  progress = () => {};
}

export const prologue = { start, stop: stopPrologue, progress: (p: number) => progress(p) };
