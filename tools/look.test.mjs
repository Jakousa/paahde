import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyScale, isLook, LOOK_END, LOOK_SLOTS, packLook, unpackLook } from '../shared/look.ts';

test('looks saved before the body slots keep their pieces and the plain body', () => {
  // the last look there was before 'height' and 'head': every older slot at its last option
  const before = LOOK_SLOTS.filter((s) => s.key !== 'height' && s.key !== 'head');
  const old = before.reduce((n, s) => n * s.options.length, 1) - 1;
  const look = unpackLook(old);
  for (const s of before) assert.equal(look[s.key], s.options.length - 1, s.key);
  assert.deepEqual(bodyScale(look), { height: 1, head: 1 });
  assert.deepEqual(bodyScale(unpackLook(0)), { height: 1, head: 1 });
});

test('every body option packs, unpacks and has a size', () => {
  assert.ok(Number.isSafeInteger(LOOK_END));
  for (const key of ['height', 'head']) {
    const slot = LOOK_SLOTS.find((s) => s.key === key);
    for (let i = 0; i < slot.options.length; i++) {
      const look = unpackLook(0);
      look[key] = i;
      const n = packLook(look);
      assert.ok(isLook(n));
      assert.equal(unpackLook(n)[key], i);
      const size = bodyScale(look)[key];
      assert.ok(size >= 0.5 && size <= 2, `${key} ${slot.options[i]}: ${size}`);
    }
  }
});
