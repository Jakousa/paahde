// Real WebSocket regression: a bad peer must not disconnect the other seven players.
// Run with: node --test tools/server-resilience.test.mjs
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';

function message(ws, accept) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); ws.off('message', onMessage); ws.off('close', onClose); };
    const onMessage = (data) => {
      const msg = JSON.parse(String(data));
      if (accept(msg)) { cleanup(); resolve(msg); }
    };
    const onClose = (code) => { cleanup(); reject(new Error(`closed before expected message: ${code}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('message timeout')); }, 5000);
    ws.on('message', onMessage); ws.on('close', onClose);
  });
}

test('one malformed peer leaves seven other players connected and receiving snapshots', { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dadajam-resilience-'));
  const child = fork(new URL('../server/world.ts', import.meta.url), {
    env: { ...process.env, WORLD_ID: 'resilience', DB_PATH: join(dir, 'world.db') },
    execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const peers = new Set();
  t.after(async () => {
    for (const ws of peers) ws.terminate();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); });
    }
    await rm(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`world startup timeout\n${output}`)), 10000);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`world exited ${code}\n${output}`)); });
    child.on('message', (m) => { if (m.t === 'port') { clearTimeout(timer); resolve(m.port); } });
  });
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    peers.add(ws);
    ws.on('error', () => {});
    const welcome = message(ws, (m) => m.t === 'welcome');
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', browserId: randomUUID(), name: 'Tester' })));
    const self = await welcome;
    const ready = message(ws, (m) => m.t === 'snap' && m.players.some((p) => p.id === self.id));
    ws.send(JSON.stringify({ t: 'ready' }));
    await ready;
    return ws;
  };
  const observers = await Promise.all(Array.from({ length: 7 }, connect));
  for (const [name, payload, options, expectedCode] of [
    ['null', 'null', {}, 1003],
    ['number', '42', {}, 1003],
    ['array', '[]', {}, 1003],
    ['missing message type', '{}', {}, 1003],
    ['non-string message type', '{"t":null}', {}, 1003],
    ['invalid JSON', '{', {}, 1003],
    ['oversized frame', JSON.stringify({ t: 'chat', text: 'x'.repeat(2048) }), {}, 1009],
    ['invalid UTF-8 text frame', Buffer.from([0xc0, 0xaf]), { binary: false }, 1007],
  ]) {
    await t.test(name, async () => {
      const bad = await connect();
      await message(observers[0], (m) => m.t === 'snap' && m.players.length === 8);
      const closed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('bad peer was not closed')), 3000);
        bad.once('close', (code) => { clearTimeout(timer); resolve(code); });
      });
      bad.send(payload, options);
      assert.equal(await closed, expectedCode, output);
      await Promise.all(observers.map((ws) => message(ws, (m) => m.t === 'snap' && m.players.length === 7)));
      assert.ok(observers.every((ws) => ws.readyState === WebSocket.OPEN));
      assert.equal(child.exitCode, null, output);
    });
  }
});
