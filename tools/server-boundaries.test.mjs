import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { clientMessage } from '../server/messages.ts';
import { boxKind } from '../shared/boxes.ts';
import { minigameApi } from '../server/minigame.ts';

test('untrusted input numbers and registry keys cannot reach game handlers', () => {
  const valid = { t: 'input', seq: 1, input: 0, yaw: 0, pitch: 0 };
  assert.equal(clientMessage(valid), true);
  for (const key of ['seq', 'input', 'yaw', 'pitch']) for (const value of [null, {}, [], '1', Infinity, NaN, 0.5, -1]) {
    assert.equal(clientMessage({ ...valid, [key]: value }), false, `${key}: ${String(value)}`);
  }
  for (const value of [null, 1, [], {}, { t: 'unknown' }]) assert.equal(clientMessage(value), false);
  for (const key of ['constructor', 'toString', '__proto__']) {
    assert.equal(clientMessage({ t: 'craft', recipe: key }), false);
    assert.equal(clientMessage({ t: 'debugGive', kind: key }), false);
    assert.equal(boxKind(`${key}1`), null);
    assert.equal(clientMessage({ t: 'sort', box: `${key}1` }), false);
  }
  assert.deepEqual(boxKind('store12'), { kind: 'store', id: 12 });
  assert.equal(boxKind('store99999999999999999999'), null);
});

test('minigame POST rejects JSON primitives and containers without throwing', () => {
  let address = 0;
  const board = { top: () => [], submit: () => { throw new Error('invalid payload submitted'); } };
  for (const raw of ['null', '12', '[]', '"x"', '{}', '{"mode":{},"score":1000,"machines":5}']) {
    const req = new EventEmitter();
    req.url = '/api/minigame'; req.method = 'POST'; req.socket = { remoteAddress: `test-${address++}` };
    const res = { statusCode: 0, setHeader() {}, end() {} };
    assert.equal(minigameApi(board, req, res), true);
    req.emit('data', raw);
    assert.doesNotThrow(() => req.emit('end'));
    assert.equal(res.statusCode, 400);
  }
});
