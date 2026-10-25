import test from 'node:test';
import assert from 'node:assert/strict';
import { InputQueue, MAX_QUEUED_INPUTS, HOLD_INPUT_MS } from '../server/inputQueue.ts';
import { decodeChunk, encodeChunk, packPlayerPose, unpackPlayerPose } from '../shared/network.ts';
import { TerrainServer, newTerrainView } from '../server/terrain.ts';
import { edits, TerrainEdits, EDIT_CHUNK } from '../shared/terrain.ts';
import { heal } from '../shared/dig.ts';
import { DT, FORWARD, spawnState, step } from '../shared/sim.ts';
import { MAX_BACKLOG_BYTES, SOFT_BACKLOG_BYTES, sendJson, sendStream } from '../server/outgoing.ts';

test('packet bursts cannot accelerate the fixed simulation; missing packets still fall', () => {
  const slow = new InputQueue(), fast = new InputQueue();
  let a = spawnState(8000, 8000), b = { ...a }, fall = { ...a, y: a.y + 100, grounded: false };
  let seq = 0;
  for (let tick = 1; tick <= 120; tick++) {
    const now = tick * DT * 1000;
    slow.receive({ seq: tick, input: FORWARD, yaw: 0, pitch: 0 }, now);
    for (let i = 0; i < 20; i++) fast.receive({ seq: ++seq, input: FORWARD, yaw: 0, pitch: 0 }, now);
    assert.ok(fast.length <= MAX_QUEUED_INPUTS);
    const ca = slow.take(now), cb = fast.take(now);
    a = step(a, ca.input, ca.yaw); b = step(b, cb.input, cb.yaw);
    fall = step(fall, 0, 0);
  }
  assert.deepEqual(a, b);
  assert.ok(fall.y < spawnState(8000, 8000).y + 60);
  assert.equal(slow.receive({ seq: 120, input: 0, yaw: 0, pitch: 0 }, 3000), false);
  while (fast.length) fast.take(3000);
  assert.equal(fast.take(3000 + HOLD_INPUT_MS + 1), null);
  assert.equal(fast.ack, seq);
});

test('bounded delayed input acknowledgments leave exactly the replayable suffix', () => {
  const q = new InputQueue();
  for (let seq = 1; seq <= 100; seq++) q.receive({ seq, input: seq & 1, yaw: 0, pitch: 0 }, 1000);
  assert.equal(q.ack, 100 - MAX_QUEUED_INPUTS);
  const consumed = [];
  while (q.length) { consumed.push(q.take(1000).seq); assert.equal(q.ack, consumed.at(-1)); }
  assert.deepEqual(consumed, Array.from({ length: MAX_QUEUED_INPUTS }, (_, i) => 101 - MAX_QUEUED_INPUTS + i));
  q.clear(); assert.equal(q.ack, 100); assert.equal(q.take(1000), null);
});

test('remote pose flags and terrain chunks round-trip without changing owner physics', () => {
  for (let flags = 0; flags < 32; flags++) {
    const s = { ...spawnState(8000, 8000), grounded: !!(flags & 1), sliding: !!(flags & 2), crouching: !!(flags & 4), riding: !!(flags & 8), jumpHeld: !!(flags & 16) };
    const p = unpackPlayerPose(packPlayerPose(7, s, 123), { id: 7, color: 42 });
    for (const key of ['grounded', 'sliding', 'crouching', 'riding', 'jumpHeld', 'bike']) assert.equal(p[key], s[key]);
    assert.equal(p.pitch, 123);
    assert.ok(Math.abs(p.y - s.y) <= 0.00051);
  }
  for (const c of [new Int32Array(1024), Int32Array.from({ length: 1024 }, (_, i) => i < 20 ? -1234 : 0), Int32Array.from({ length: 1024 }, (_, i) => i * 17 - 12000)]) {
    assert.deepEqual(decodeChunk(encodeChunk(c)), c);
  }
  assert.equal(decodeChunk({ data: [1025, 4], rle: 1 }), null);
  assert.equal(decodeChunk({ data: [-1, 4], rle: 1 }), null);
});

test('backpressure skips obsolete poses, retains ordered changes, and bounds slow sockets', () => {
  const sent = [], closed = [];
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: SOFT_BACKLOG_BYTES + 1, send: (s) => sent.push(s), close: (...a) => closed.push(a), terminate() {} };
  assert.equal(sendJson(ws, 'pose', true), false);
  assert.equal(sendJson(ws, 'terrain'), true);
  assert.deepEqual(sent, ['terrain']);
  ws.bufferedAmount = MAX_BACKLOG_BYTES;
  assert.equal(sendJson(ws, 'terrain'), false);
  assert.equal(closed[0][0], 1013);
});


test('terrain windows reconstruct negative-coordinate changes and recover healing missed while away', () => {
  const reset = () => { for (const [cx, cz] of edits.entries()) edits.deleteChunk(cx, cz); };
  reset();
  const terrain = new TerrainServer({ loadChunks: () => [] });
  const view = newTerrainView(), client = new TerrainEdits();
  const apply = (messages) => {
    for (const msg of messages) {
      if (msg.t === 'terrainChunks') {
        for (const c of msg.chunks) client.setChunk(c.cx, c.cz, decodeChunk(c));
        for (const [cx, cz] of msg.remove ?? []) client.deleteChunk(cx, cz);
      } else for (const [cx, cz, cells] of msg.chunks) {
        for (let i = 0; i < cells.length; i += 2) client.setMm(cx * EDIT_CHUNK + cells[i] % EDIT_CHUNK, cz * EDIT_CHUNK + Math.floor(cells[i] / EDIT_CHUNK), cells[i + 1]);
      }
    }
  };
  try {
    // Both negative chunk coordinates and negative local world vertices are intentional.
    terrain.crater(-4000, -4000, 4, 700, false);
    const delta = terrain.flush();
    assert.ok(delta?.chunks.length > 0);
    const baseline = [...terrain.viewMessages(view, -4000, -4000)];
    assert.equal(baseline[0].reset, true); assert.equal(baseline.at(-1).done, true);
    apply(baseline);
    terrain.crater(-4002, -4001, 3, 300, false);
    const next = [...terrain.forView(terrain.flush(), view)];
    assert.ok(next.flatMap((m) => m.chunks).every(([cx, cz, cells]) => cx < 0 && cz < 0 && cells.every((v, i) => i % 2 || (v >= 0 && v < 1024))));
    apply(next);
    for (const [cx, cz, c] of edits.entries()) assert.deepEqual(client.chunk(cx, cz), c);
    const held = [...client.entries()].map(([cx, cz]) => [cx, cz]);
    apply(terrain.viewMessages(view, 8000, 8000));
    assert.equal(client.size, 0);
    heal(edits); heal(edits);
    assert.deepEqual([...terrain.forView(delta, view)], []);
    apply(terrain.viewMessages(view, -4000, -4000));
    for (const [cx, cz] of held) assert.deepEqual(client.chunk(cx, cz), edits.chunk(cx, cz));
  } finally { reset(); }
});

test('streamed baselines sample each batch at send time and exceed total socket budget without buffering it all', async () => {
  for (const [cx, cz] of edits.entries()) edits.deleteChunk(cx, cz);
  const terrain = new TerrainServer({ loadChunks: () => [] });
  try {
    for (let cx = 0; cx < 32; cx++) edits.setChunk(cx, 0, new Int32Array(1024).fill(-700));
    const messages = terrain.viewMessages(newTerrainView(), 0, 0);
    const first = messages.next().value;
    assert.equal(first.chunks.length, 16);
    heal(edits);
    const second = messages.next().value;
    for (const c of second.chunks) assert.deepEqual(decodeChunk(c), edits.chunk(c.cx, c.cz));
  } finally { for (const [cx, cz] of edits.entries()) edits.deleteChunk(cx, cz); }
  let sent = 0, high = 0, closed = 0;
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0,
    send(json) { this.bufferedAmount += Buffer.byteLength(json); high = Math.max(high, this.bufferedAmount); sent++; setImmediate(() => { this.bufferedAmount = 0; }); },
    close() { closed++; this.readyState = 3; }, terminate() {} };
  function* large() { for (let i = 0; i < 64; i++) yield { i, data: 'x'.repeat(32768) }; }
  assert.equal(await sendStream(ws, large()), true);
  assert.equal(sent, 64); assert.equal(closed, 0);
  assert.ok(sent * 32768 > MAX_BACKLOG_BYTES);
  assert.ok(high < SOFT_BACKLOG_BYTES + 65536);
});


test('large simultaneous terrain updates stay in bounded chunk frames', () => {
  const terrain = new TerrainServer({ loadChunks: () => [] });
  const view = newTerrainView();
  [...terrain.viewMessages(view, 0, 0)];
  const chunks = Array.from({ length: 100 }, (_, i) => [i % 10, Math.floor(i / 10), Array.from({ length: 2048 }, (_, j) => j % 2 ? -12000 : j / 2)]);
  const messages = [...terrain.forView({ t: 'terrainEdit', chunks }, view)];
  assert.deepEqual(messages.flatMap((m) => m.chunks), chunks);
  assert.ok(messages.every((m) => m.chunks.length <= 16 && Buffer.byteLength(JSON.stringify(m)) < MAX_BACKLOG_BYTES / 4));
});
