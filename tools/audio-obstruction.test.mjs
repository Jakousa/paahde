import assert from 'node:assert/strict';
import test from 'node:test';
import { obstruction } from '../src/obstruction.ts';
import { sheltersNear, shelterToWorld } from '../shared/shelters.ts';
import { ORIGIN } from '../shared/origin.ts';

test('shelter air stays clear while its roof blocks a direct audio path', () => {
  const shelter = sheltersNear(ORIGIN.x, ORIGIN.z, 2400)[0];
  assert.ok(shelter, 'the deterministic world has a shelter fixture');
  const z = (shelter.L.room.z + shelter.L.hall) / 2;
  const left = { ...shelterToWorld(shelter, -1, z), y: shelter.y + shelter.L.floor + 1 };
  const right = { ...shelterToWorld(shelter, 1, z), y: left.y };
  assert.equal(obstruction(left, right, 1), 0, 'terrain over the room must not muffle sounds inside it');
  assert.ok(obstruction(left, { ...left, y: shelter.y + 15 }, 2) > 0, 'the buried roof blocks the direct path');
  const high = { ...left, y: shelter.y + 100 };
  assert.equal(obstruction(high, { ...right, y: high.y }, 3), 0);
});
