// Draws the loading cover's prologue off the main thread (src/prologue.ts has the page side).
import { createPrologue } from './prologueRunner';

type In =
  | { t: 'init'; canvas: OffscreenCanvas; w: number; h: number; dpr: number }
  | { t: 'size'; w: number; h: number; dpr: number }
  | { t: 'progress'; p: number }
  | { t: 'stop' };
const ctx = self as unknown as { onmessage: ((e: MessageEvent<In>) => void) | null; close(): void };

let run: ReturnType<typeof createPrologue> | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
ctx.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'init') {
    run = createPrologue(m.canvas.getContext('2d')!, (w, h) => new OffscreenCanvas(w, h));
    run.resize(m.w, m.h, m.dpr);
    let last = performance.now();
    timer = setInterval(() => {
      const now = performance.now();
      run!.frame((now - last) / 1000);
      last = now;
    }, 1000 / 60);
  } else if (m.t === 'size') run?.resize(m.w, m.h, m.dpr);
  else if (m.t === 'progress') run?.progress(m.p);
  else if (m.t === 'stop') {
    clearInterval(timer);
    ctx.close();
  }
};
