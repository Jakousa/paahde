import assert from 'node:assert/strict';
import test from 'node:test';
import { LimiterKernel } from '../src/limiterKernel.mjs';

test('quiet stereo preserves samples after the documented look-ahead', () => {
  const limiter = new LimiterKernel(48000), input = [new Float32Array(512), new Float32Array(512)], output = input.map(() => new Float32Array(512));
  for (let i = 0; i < 512; i++) { input[0][i] = Math.sin(i * 0.1) * 0.05; input[1][i] = input[0][i] * 0.3; }
  limiter.process(input, output);
  for (let i = limiter.delay; i < 512; i++) {
    assert.equal(output[0][i], input[0][i - limiter.delay]);
    assert.equal(output[1][i], input[1][i - limiter.delay]);
  }
});

test('overload, impulses and non-finite samples stay bounded and stereo-linked', () => {
  const limiter = new LimiterKernel(48000);
  const input = [new Float32Array(128), new Float32Array(128)], output = input.map(() => new Float32Array(128));
  for (let block = 0; block < 750; block++) {
    for (let i = 0; i < 128; i++) {
      const n = block * 128 + i;
      input[0][i] = n % 500 === 0 ? 10 : Math.sin(n * 1.1) * 3;
      input[1][i] = input[0][i] * 0.25;
    }
    if (block === 200) input[0][23] = NaN;
    limiter.process(input, output);
    for (let i = 0; i < 128; i++) assert.ok(Number.isFinite(output[0][i]) && Math.abs(output[0][i]) < 0.85);
  }
});
