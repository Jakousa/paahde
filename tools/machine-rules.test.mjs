import test from 'node:test';
import assert from 'node:assert/strict';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Group } from 'three/webgpu';
import { buildJunk, JUNK_KINDS } from '../src/teardown/junk.ts';
import { stepList, stepAllowed, partAllowed } from '../shared/machineSteps.ts';

test('authoritative prerequisites match rendered machines, including conditional mounts', async () => {
  // Geometry can be built without fetching any model; this checks the real recipe order, not mock rules.
  const load = GLTFLoader.prototype.loadAsync;
  GLTFLoader.prototype.loadAsync = async () => ({ scene: new Group() });
  try {
    for (const kind of JUNK_KINDS) for (const seed of [1, 7919, 23757]) {
      const j = buildJunk(kind, seed, 2), rules = stepList(kind, seed, 2);
      assert.deepEqual(rules.list.map((s) => s.after), j.steps.map((s) => s.after.map((a) => j.steps.indexOf(a))), `${kind} steps ${seed}`);
      assert.deepEqual(rules.parts, j.slots.map((s) => s.piece.holds.map((a) => j.steps.indexOf(a))), `${kind} parts ${seed}`);
      const done = new Set();
      assert.equal(stepAllowed(rules, done, rules.list.length), false);
      assert.equal(partAllowed(rules, done, rules.parts.length), false);
      while (done.size < rules.list.length) {
        const i = rules.list.findIndex((_, i) => stepAllowed(rules, done, i));
        assert.notEqual(i, -1, `${kind} prerequisite cycle`);
        done.add(i);
      }
      assert.ok(rules.parts.every((_, i) => partAllowed(rules, done, i)));
    }
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    GLTFLoader.prototype.loadAsync = load;
  }
});
