import assert from 'node:assert/strict';
import test from 'node:test';
import { neighbour } from '../src/uiFocus.ts';

test('directional navigation follows rows at every interface scale and across panel gaps', () => {
  for (const scale of [0.7, 1, 1.5, 3, 4.5]) {
    const rect = (x, y, w = 54, h = 54) => ({ left: x * scale, top: y * scale, width: w * scale, height: h * scale });
    const from = rect(0, 0);
    const candidates = [
      { rect: rect(58, 0), element: 'right' },
      { rect: rect(0, 58), element: 'down' },
      { rect: rect(-58, 0), element: 'left' },
      { rect: rect(0, -58), element: 'up' },
    ];
    assert.equal(neighbour(from, candidates, 1, 0), 'right');
    assert.equal(neighbour(from, candidates, 0, 1), 'down');
    assert.equal(neighbour(from, candidates, -1, 0), 'left');
    assert.equal(neighbour(from, candidates, 0, -1), 'up');
    assert.equal(neighbour(from, [{ rect: rect(300, 0), element: 'other panel' }], 1, 0), 'other panel');
    assert.equal(neighbour(from, candidates.filter((c) => c.element !== 'right'), 1, 0), null);
  }
});
