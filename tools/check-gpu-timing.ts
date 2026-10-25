import assert from 'node:assert/strict';
import { GpuTiming } from '../src/gpuTiming.ts';

const timing = new GpuTiming();
const batch = new Map([['r:1:scene:f1', 4], ['r:2:scene:f1', 2], ['r:3:post:f1', 1], ['r:1:scene:f2', 5]]);
const frames = timing.read(batch, () => 16.7);
assert.equal(frames.length, 2);
assert.equal(frames[0].ms, 7);
assert.equal(frames[0].passes.get('scene'), 6);
assert.equal(timing.read(batch, () => 16.7).length, 0, 'cached batches must not be counted again');
assert.equal(timing.read(new Map([['r:1:scene:f3', 567]]), () => 16.7).length, 0);
assert.equal(timing.read(new Map([['r:1:scene:f4', NaN]]), () => 16.7).length, 0);
assert.equal(timing.read(new Map([['r:1:scene:f5', 2]]), () => undefined).length, 0);
assert.equal(timing.reliable, false);
for (let frame = 6; frame < 80; frame++) timing.read(new Map([[`r:1:scene:f${frame}`, 6]]), () => 16.7);
assert.equal(timing.reliable, true, 'reliability recovers after a sustained valid window');
for (let frame = 80; frame < 95; frame++) timing.read(new Map([[`r:1:scene:f${frame}`, 500]]), () => 16.7);
assert.equal(timing.reliable, false, 'frequent implausible totals suppress GPU attribution');
console.log('GPU timestamp freshness, aggregation, validation and recovery checks passed.');
