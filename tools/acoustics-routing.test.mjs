import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { AudioBudget } from '../src/audioBudget.ts';

const source = stripTypeScriptTypes(readFileSync(new URL('../src/acoustics.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, ''));
const build = new Function('audio', 'echoTaps', 'enclosure', 'AudioBudget', 'obstruction', `${source}\nreturn {placed,audioMetrics};`);
const param = () => ({ value: 0, setValueAtTime() {}, setTargetAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} });
function node() {
  return { destinations: [], gain: param(), frequency: param(), Q: param(), delayTime: param(),
    positionX: param(), positionY: param(), positionZ: param(),
    connect(to) { this.destinations.push(to); return to; }, disconnect() {} };
}
function fixture() {
  const convolvers = [];
  const ctx = { currentTime: 0, sampleRate: 128,
    createGain: node, createBiquadFilter: node, createDelay: node, createPanner: node,
    createBuffer: (_channels, n) => ({ getChannelData: () => new Float32Array(n) }),
    createConvolver: () => { const n = node(); convolvers.push(n); return n; },
  };
  const audio = { ctx, out: node(), warning: node(), running: true, protectWarning() {} };
  const taps = () => [{ delay: 0.1, path: 20, gain: 0.3, x: 1, y: 1, z: 1 }];
  return { ...build(audio, taps, 1, AudioBudget, () => 0), audio, convolvers };
}

test('a warning created first keeps direct priority without capturing shared reverb routing', () => {
  const { placed, audio, convolvers } = fixture();
  const warning = placed(null, null, 1, 4, 40, { warning: true, duration: 0.6 });
  assert.ok(warning.input.destinations.includes(audio.warning));
  assert.equal(convolvers.length, 2);
  for (const node of convolvers) assert.deepEqual(node.destinations, [audio.out]);
  placed(null, null, 1, 4, 40, { duration: 0.6 });
  assert.equal(convolvers.length, 2, 'later effects reuse the same correctly routed tails');
});

test('short-source echo reservations include travel time and expire with the actual tail', () => {
  const { placed, audioMetrics } = fixture();
  placed({ x: 34.3, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 1, 4, 100, { duration: 0.5 });
  assert.equal(audioMetrics.voices.count(0.55), 1);
  assert.equal(audioMetrics.voices.count(0.65), 0);
  assert.equal(audioMetrics.echoes.count(0.65), 1);
  assert.equal(audioMetrics.echoes.count(0.75), 0);
});
