import assert from 'node:assert/strict';
import test from 'node:test';
import { boltTurns } from '../src/teardown/boltGesture.ts';

test('the same four-second circular gesture works at every supported refresh rate', () => {
  const totals = [30, 60, 120, 144, 240].map((hz) => {
    const state = { sx: 0, sy: 0, angle: NaN };
    let turns = 0;
    for (let i = 0; i < hz * 4; i++) {
      const a = i / hz * Math.PI * 2;
      turns += boltTurns(state, Math.cos(a) * 180 / hz, Math.sin(a) * 180 / hz, 1 / hz);
    }
    return turns;
  });
  assert.ok(Math.min(...totals) > 7.5, String(totals));
  assert.ok(Math.max(...totals) - Math.min(...totals) < 0.15, String(totals));
});

test('straight travel and resuming after a stall do not unscrew a bolt', () => {
  const state = { sx: 0, sy: 0, angle: NaN };
  for (let i = 0; i < 100; i++) assert.equal(boltTurns(state, 5, 0, 1 / 60), 0);
  assert.equal(boltTurns(state, -100, 100, 1), 0);
  assert.equal(boltTurns(state, -5, 0, 1 / 60), 0);
  assert.equal(boltTurns(state, 0, 0, 0), 0);
});
