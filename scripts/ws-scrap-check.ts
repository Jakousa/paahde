// End-to-end check of scrap pickups against a running server: node scripts/ws-scrap-check.ts [ws://localhost:8805/ws]
// Player A walks to the nearest scrap piece from spawn and picks it up; player B should see it taken.
// Then A asks for a piece far away, which the server must refuse (and send back).
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { quantizePitch } from '../shared/dig.ts';
import { scrapPieces, scrapReach, PICKUP_REACH } from '../shared/scrap.ts';
import { FORWARD, quantizeYaw, spawnState, step, type PlayerState } from '../shared/sim.ts';

const url = process.argv[2] ?? 'ws://localhost:8805/ws';

function client() {
  const ws = new WebSocket(url);
  const log: { t: string; [k: string]: unknown }[] = [];
  let state: PlayerState = spawnState();
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', browserId: randomUUID() })));
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'welcome') state = m.state;
    if (m.t === 'scrap' || m.t === 'inventory') log.push(m);
  });
  return { ws, log, get state() { return state; }, set state(s) { state = s; } };
}

const a = client(), b = client();
await new Promise((r) => setTimeout(r, 600));

// Walk A towards the nearest piece, simulating locally like the client does, until it is in reach.
const target = scrapPieces(0, 0).reduce((p, q) => (Math.hypot(q.x, q.z) < Math.hypot(p.x, p.z) ? q : p));
let seq = 0;
for (let i = 0; i < 600 && scrapReach(a.state, target) > PICKUP_REACH - 0.5; i++) {
  const yaw = quantizeYaw(Math.atan2(-(target.x - a.state.x), -(target.z - a.state.z)));
  a.state = step(a.state, FORWARD, yaw);
  a.ws.send(JSON.stringify({ t: 'input', seq: ++seq, input: FORWARD, yaw, pitch: quantizePitch(0) }));
  await new Promise((r) => setTimeout(r, 1000 / 60));
}
console.log('A reach to target', scrapReach(a.state, target).toFixed(2), 'target', target.key);
a.ws.send(JSON.stringify({ t: 'pickup', ix: target.ix, iz: target.iz, i: target.i }));
await new Promise((r) => setTimeout(r, 300));
let far = undefined as ReturnType<typeof scrapPieces>[number] | undefined;
for (let ix = 2; ix < 9 && !far; ix++) far = scrapPieces(ix, 2)[0];
if (far) a.ws.send(JSON.stringify({ t: 'pickup', ix: far.ix, iz: far.iz, i: far.i }));
a.ws.send(JSON.stringify({ t: 'pickup', ix: 'x', iz: 1.5, i: -1 })); // junk: ignored
await new Promise((r) => setTimeout(r, 400));
console.log('A got', JSON.stringify(a.log.map((m) => m.t === 'inventory' ? { inv: m.items } : { taken: (m.taken as number[]).length / 3, back: m.back, reset: m.reset })));
console.log('B got', JSON.stringify(b.log.map((m) => m.t === 'inventory' ? { inv: m.items } : { taken: m.taken, back: m.back, reset: m.reset })));
a.ws.close();
b.ws.close();
