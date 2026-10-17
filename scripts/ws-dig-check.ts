// End-to-end check against a running server: node scripts/ws-dig-check.ts [ws://localhost:8805/ws] [dig|look]
// "dig": player A digs for 2 s while player B listens for terrainEdit; "look": just print joined chunks.
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { quantizePitch } from '../shared/dig.ts';
import { DIG } from '../shared/sim.ts';

const url = process.argv[2] ?? 'ws://localhost:8805/ws';
const mode = process.argv[3] ?? 'dig';

function client(name: string) {
  const ws = new WebSocket(url);
  const stats = { chunks: 0, nonzero: 0, edits: 0, minMm: 0, dugs: 0, welcome: false };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', browserId: randomUUID() })));
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'welcome') stats.welcome = true;
    if (m.t === 'terrainChunks') for (const c of m.chunks) {
      stats.chunks++;
      for (const v of c.mm) if (v) stats.nonzero++, (stats.minMm = Math.min(stats.minMm, v));
    }
    if (m.t === 'terrainEdit') for (let i = 0; i < m.cells.length; i += 3) stats.edits++, (stats.minMm = Math.min(stats.minMm, m.cells[i + 2]));
    if (m.t === 'dug') stats.dugs++;
  });
  return { ws, stats, name };
}

const a = client('A'), b = client('B');
await new Promise((r) => setTimeout(r, 500));
if (mode === 'dig') {
  let seq = 0;
  const pitch = quantizePitch(-1.0);
  const iv = setInterval(() => a.ws.send(JSON.stringify({ t: 'input', seq: ++seq, input: DIG, yaw: 0, pitch })), 1000 / 60);
  await new Promise((r) => setTimeout(r, 2500));
  clearInterval(iv);
  await new Promise((r) => setTimeout(r, 2000)); // let sand settle
}
console.log('A', a.stats);
console.log('B', b.stats);
a.ws.close();
b.ws.close();
