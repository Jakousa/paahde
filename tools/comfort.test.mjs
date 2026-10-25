import assert from 'node:assert/strict';
import test from 'node:test';

test('comfort preferences restore safely, clamp to their ranges and persist without changing other controls', async () => {
  let saved = JSON.stringify({ mouseX: 2, mouseY: 'bad', fov: 1000, hudScale: -1, invertY: true, instantText: 'yes' });
  const css = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => saved, setItem: (_key, value) => { saved = value; },
  } });
  globalThis.document = { documentElement: { style: { setProperty: (key, value) => css.set(key, value) } },
    createElement: () => ({}), head: { append() {} } };
  const { comfort, setComfort, onComfort } = await import('../src/comfort.ts');
  assert.equal(comfort.mouseX, 2);
  assert.equal(comfort.mouseY, 1);
  assert.equal(comfort.fov, 100);
  assert.equal(comfort.hudScale, 0.75);
  assert.equal(comfort.invertY, true);
  assert.equal(comfort.instantText, false);
  let changes = 0;
  const off = onComfort(() => changes++);
  setComfort('motion', 0);
  setComfort('subtitleScale', 1.5);
  assert.equal(comfort.mouseX, 2);
  assert.equal(JSON.parse(saved).motion, 0);
  assert.equal(css.get('--subtitle-scale'), '1.5');
  assert.equal(changes, 2);
  off();
  setComfort('fov', NaN);
  assert.equal(comfort.fov, 100);
  assert.equal(changes, 2);
  assert.doesNotThrow(() => JSON.parse(saved));
});
