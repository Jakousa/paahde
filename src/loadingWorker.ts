// Runs the loading screen's game off the main thread (src/loadingGame.ts has the page side).
import { createRunner, H, W } from './loadingRunner';

type In =
  | { t: 'init'; canvas: OffscreenCanvas; dpr: number; best: number }
  | { t: 'press' | 'release' | 'stop' }
  | { t: 'progress'; p: number };
const ctx = self as unknown as { onmessage: ((e: MessageEvent<In>) => void) | null; postMessage(m: unknown): void; close(): void };

let run: ReturnType<typeof createRunner> | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
ctx.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'init') {
    m.canvas.width = W * m.dpr;
    m.canvas.height = H * m.dpr;
    run = createRunner(m.canvas.getContext('2d')!, m.dpr, m.best, (n) => ctx.postMessage({ t: 'best', n }));
    let last = performance.now();
    timer = setInterval(() => {
      const now = performance.now();
      run!.frame((now - last) / 1000);
      last = now;
    }, 1000 / 60);
  } else if (m.t === 'press') run?.press();
  else if (m.t === 'release') run?.release();
  else if (m.t === 'progress') run?.progress(m.p);
  else if (m.t === 'stop') {
    clearInterval(timer);
    ctx.close();
  }
};
