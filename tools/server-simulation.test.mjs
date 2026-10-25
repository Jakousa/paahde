import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../shared/protocol.ts';
import { FORWARD, JUMP, WALK_SPEED } from '../shared/sim.ts';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(condition, ms = 4000) {
  const end = performance.now() + ms;
  while (!condition()) { if (performance.now() > end) throw new Error('condition timed out'); await sleep(10); }
}

test('loading, sparse inputs and bursts cannot bypass authoritative simulation', { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'paahde-fixed-tick-'));
  const child = fork(new URL('../server/world.ts', import.meta.url), {
    env: { ...process.env, WORLD_ID: 'lab', DADAJAM_LAB: '1', DB_PATH: join(dir, 'world.db'), TELEMETRY_PATH: join(dir, 'trace.jsonl') },
    execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', (s) => { output += s; }); child.stderr.on('data', (s) => { output += s; });
  const peers = [];
  t.after(async () => {
    peers.forEach((ws) => ws.terminate());
    if (child.exitCode === null && child.signalCode === null) await new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); });
    await rm(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timeout: ${output}`)), 8000);
    child.on('message', (m) => { if (m.t === 'port') { clearTimeout(timer); resolve(m.port); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`world exited ${code}: ${output}`)); });
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); peers.push(ws);
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, browserId: randomUUID(), name: 'Physics' }));
  await until(() => messages.some((m) => m.t === 'welcome'));
  const welcome = messages.find((m) => m.t === 'welcome');
  const snap = () => messages.findLast((m) => m.t === 'snap');
  const state = () => snap()?.state ?? snap()?.players.find((p) => p.id === welcome.id);
  for (let seq = 1; seq < 100; seq++) ws.send(JSON.stringify({ t: 'input', seq, input: FORWARD | JUMP, yaw: 0, pitch: 0 }));
  await until(() => snap());
  await sleep(150);
  assert.equal(snap().ack, 0, 'loading inputs must not be acknowledged or simulated');
  assert.ok(Math.hypot(state().x - welcome.state.x, state().z - welcome.state.z) < 0.01);
  ws.send(JSON.stringify({ t: 'ready' }));
  await until(() => snap().players.some((p) => (Array.isArray(p) ? p[0] : p.id) === welcome.id));
  const ground = state().y;
  ws.send(JSON.stringify({ t: 'input', seq: 1, input: JUMP, yaw: 0, pitch: 0 }));
  await until(() => snap().ack >= 1 && state().y > ground + 0.1);
  await sleep(1500);
  assert.ok(state().grounded, 'gravity must finish the jump without another input packet');
  const before = { ...state() }, start = performance.now();
  for (let seq = 2; seq <= 401; seq++) ws.send(JSON.stringify({ t: 'input', seq, input: FORWARD, yaw: 0, pitch: 0 }));
  await sleep(700);
  const distance = Math.hypot(state().x - before.x, state().z - before.z);
  assert.ok(distance <= WALK_SPEED * (performance.now() - start) / 1000 + 0.5, `burst moved ${distance}m`);
  const settled = { ...state() };
  await sleep(500);
  assert.ok(Math.hypot(state().x - settled.x, state().z - settled.z) < 0.25, 'stale held controls must release');
  assert.equal(ws.readyState, WebSocket.OPEN, output);

  const incompatible = new WebSocket(`ws://127.0.0.1:${port}/ws`); peers.push(incompatible);
  const closed = new Promise((r) => incompatible.once('close', r));
  incompatible.on('open', () => incompatible.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION + 1, browserId: randomUUID(), name: 'OldClient' })));
  assert.equal(await closed, 4406);
  assert.equal(child.exitCode, null, output);
});
