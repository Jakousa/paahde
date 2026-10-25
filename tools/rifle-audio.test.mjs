import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = stripTypeScriptTypes(readFileSync(new URL('../src/rifleSound.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export const rifleSound = new RifleSound();', ''));
const build = new Function('audio', 'placed', `${source}\nreturn RifleSound;`);
test('sample voices reserve their played duration at every pitch, not eight seconds', () => {
  const sources = [], reservations = [];
  const node = () => ({ gain: { value: 0 }, connect(to) { return to; }, disconnect() {} });
  const audio = { running: true, onStart() {}, ctx: {
    createGain: node,
    createBufferSource() { const src = { ...node(), playbackRate: { value: 1 }, start() {} }; sources.push(src); return src; },
  } };
  const RifleSound = build(audio, (...args) => { reservations.push(args.at(-1).duration); return { input: node(), t: 0 }; });
  const sound = new RifleSound();
  sound.pulses = [{ duration: 0.55 }]; sound.fireworks = [{ duration: 2.2 }];
  sound.shot(); sound.shot(null, null, true); sound.cannon({}, {}); sound.firework({}, {}, 1, 0.75);
  assert.equal(reservations.length, 4);
  for (let i = 0; i < 4; i++) assert.equal(reservations[i], sources[i].buffer.duration / sources[i].playbackRate.value + 0.1);
  assert.ok(reservations[0] < 0.7 && reservations[1] < reservations[0]);
  assert.ok(reservations[2] > 1 && reservations[2] < 1.3);
});
