import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyScale, isLook, LOOK_END, LOOK_SLOTS, packLook, unpackLook } from '../shared/look.ts';

test('looks saved before the body slot keep their pieces and the human body', () => {
  // the last look there was before 'body': every older slot at its last option
  const before = LOOK_SLOTS.filter((s) => s.key !== 'body');
  const old = before.reduce((n, s) => n * s.options.length, 1) - 1;
  const look = unpackLook(old);
  for (const s of before) assert.equal(look[s.key], s.options.length - 1, s.key);
  assert.equal(look.body, 0);
  assert.equal(bodyScale(look).height, 1);
  assert.equal(bodyScale(unpackLook(0)).stride, 1);
});

test('every body packs, unpacks and is smaller than the last, with a bigger head', () => {
  assert.ok(Number.isSafeInteger(LOOK_END));
  const slot = LOOK_SLOTS.find((s) => s.key === 'body');
  assert.deepEqual([...slot.options], ['human', 'dwarf', 'gnome']);
  let last = null;
  for (let i = 0; i < slot.options.length; i++) {
    const look = unpackLook(0);
    look.body = i;
    const n = packLook(look);
    assert.ok(isLook(n));
    assert.equal(unpackLook(n).body, i);
    const b = bodyScale(look);
    for (const k of ['size', 'legs', 'chest', 'head', 'height', 'stride']) assert.ok(b[k] >= 0.4 && b[k] <= 2, `${slot.options[i]} ${k}: ${b[k]}`);
    if (last) assert.ok(b.height < last.height && b.head > last.head, slot.options[i]);
    last = b;
  }
  // a dwarf about 1.35 m, a gnome about 1 m (the human 1.85 m)
  assert.ok(Math.abs(bodyScale({ ...unpackLook(0), body: 1 }).height * 1.85 - 1.35) < 0.05);
  assert.ok(Math.abs(bodyScale({ ...unpackLook(0), body: 2 }).height * 1.85 - 1.0) < 0.05);
});
