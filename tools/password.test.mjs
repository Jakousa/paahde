import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { derivePassword, PasswordBusy } from '../server/password.ts';
import { registry } from '../server/registry.ts';

test('async password derivation is compatible, yields the event loop, and bounds queued work', async () => {
  const salt = Buffer.alloc(16, 7);
  const expected = scryptSync('secret', salt, 32);
  let yielded = false;
  const timer = new Promise((resolve) => setTimeout(() => { yielded = true; resolve(); }, 0));
  const work = Array.from({ length: 20 }, () => derivePassword('secret', salt));
  const result = await Promise.allSettled(work);
  await timer;
  assert.ok(yielded);
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 18);
  assert.ok(result.filter((r) => r.status === 'rejected').every((r) => r.reason instanceof PasswordBusy));
  for (const r of result) if (r.status === 'fulfilled') assert.deepEqual(r.value, expected);
});

test('registry returns the new key once and verifies passwords asynchronously', async () => {
  const games = registry(':memory:');
  try {
    const key = await games.create('test', { name: 'Test', public: true, max: 8, password: 'secret' });
    assert.ok(games.keyOk('test', key));
    assert.equal(await games.unlock('test', 'secret'), key);
    assert.equal(await games.unlock('test', 'wrong'), null);
    assert.equal(games.publicGames(1).length, 1);
    games.remove('test');
    assert.equal(games.publicGames().length, 0);
  } finally { games.db.close(); }
});
