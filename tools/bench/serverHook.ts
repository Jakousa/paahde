// Loaded into a world process with `node --import` by tools/bench/server.ts (and the server of tools/bench/client.ts), so the
// game's code is measured as it is, not changed for it: Math.random seeded (both commits roll the same dice), and every
// setInterval callback timed by its period (server/world.ts's 60 Hz loop, the power second, the save). Asked over IPC
// ('bench-reset' starts the window, 'bench-stats' answers with it), it tells how long the loops took, the CPU used and
// how busy the event loop was.
import { performance } from 'node:perf_hooks';
import { seedRandom } from './common.ts';

seedRandom(1);

type Loop = { n: number; ms: number[] };
let loops = new Map<number, Loop>();
let cpu0 = process.cpuUsage(), elu0 = performance.eventLoopUtilization(), t0 = performance.now();

const realSetInterval = globalThis.setInterval;
globalThis.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
  const period = ms ?? 0;
  return realSetInterval((...a: unknown[]) => {
    const s = performance.now();
    try {
      fn(...a);
    } finally {
      let l = loops.get(period);
      if (!l) loops.set(period, (l = { n: 0, ms: [] }));
      l.n++;
      l.ms.push(performance.now() - s);
    }
  }, ms, ...rest);
}) as typeof setInterval;

process.on('message', (m: { t?: string }) => {
  if (m?.t === 'bench-reset') {
    loops = new Map();
    cpu0 = process.cpuUsage();
    elu0 = performance.eventLoopUtilization();
    t0 = performance.now();
  } else if (m?.t === 'bench-stats') {
    const wall = performance.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const q = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0);
    process.send?.({
      t: 'bench-stats', wallMs: wall, cpuMs: (cpu.user + cpu.system) / 1000, elu: performance.eventLoopUtilization(elu0).utilization,
      rssMB: process.memoryUsage().rss / 1048576, heapMB: process.memoryUsage().heapUsed / 1048576,
      loops: Object.fromEntries([...loops].map(([period, l]) => [period, { n: l.n, p50: q(l.ms, 0.5), p99: q(l.ms, 0.99), max: Math.max(0, ...l.ms), mean: l.ms.reduce((a, b) => a + b, 0) / Math.max(1, l.n) }])),
    });
  }
});
