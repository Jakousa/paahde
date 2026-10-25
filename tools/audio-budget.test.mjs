import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioBudget } from '../src/audioBudget.ts';

test('a crowded soundscape preserves warnings and releases expired voices', () => {
  const budget = new AudioBudget(4), stopped = [];
  for (let i = 0; i < 4; i++) assert.equal(budget.reserve(0, 2, 1, i + 1, () => stopped.push(i)), true);
  assert.equal(budget.reserve(0.1, 3, 3, 0.1, () => stopped.push('warning')), true);
  assert.deepEqual(stopped, [0]);
  for (let i = 0; i < 100; i++) budget.reserve(0.2, 1, 1, i + 1);
  assert.equal(budget.count(0.2), 4);
  assert.equal(stopped.includes('warning'), false);
  assert.equal(budget.count(2.1), 1);
  assert.equal(budget.count(4), 0);
  assert.equal(budget.peak, 4);
});
