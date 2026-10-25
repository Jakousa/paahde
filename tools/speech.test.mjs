import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

// Exercise the actual browser engine with only its DOM/audio and line registry replaced.
const source = stripTypeScriptTypes(readFileSync(new URL('../src/speech.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export class Speech', 'class Speech'));
const build = new Function('LINES', 'speechSound', 'comfort', 'document', 'location', 'localStorage', `${source}\nreturn Speech;`);
function fixture() {
  const item = { id: 1, kind: 'receiver', n: 1 };
  const state = { dead: false, bag: [item] };
  const comfort = { instantText: false, subtitleDuration: 1 };
  const lines = [
    { id: 'ambient', on: 'near', say: 'There is a lot of sand around here.' },
    { id: 'find', on: 'got', say: 'I can use this receiver.', priority: 1, queueFor: 20000, when: (_s, it) => it.kind === 'receiver' },
    { id: 'danger', on: 'aggro', say: 'Move now.', priority: 3, again: 60000 },
  ];
  const el = () => ({ textContent: '', classList: { add() {}, remove() {} }, append() {} });
  const document = { createElement: el, head: { appendChild() {} }, body: { appendChild() {} } };
  const Speech = build(lines, { blip() {} }, comfort, document, { search: '?w=test' }, { getItem: () => '[]', setItem() {} });
  const speech = new Speech();
  const said = [];
  speech.onSaid = (id, seconds) => said.push({ id, seconds });
  speech.update(5, state);
  return { speech, item, state, comfort, said };
}

test('danger preempts immediately and an interrupted discovery remains eligible until delivered', () => {
  const { speech, item, state, said } = fixture();
  speech.event('got', item);
  speech.event('aggro', {});
  assert.equal(speech.shown.textContent, 'Move now.');
  assert.equal(speech.once.has('find'), false);
  speech.update(6, state);
  assert.deepEqual(said.map((s) => s.id), ['find', 'danger', 'find']);
  speech.update(3, state);
  assert.equal(speech.once.has('find'), true);
  speech.event('aggro', {});
  assert.equal(said.filter((s) => s.id === 'danger').length, 1);
});

test('queued discoveries expire and are discarded when their item leaves the bag', () => {
  for (const reason of ['expired', 'dropped']) {
    const { speech, item, state, said } = fixture();
    speech.event('near', {});
    speech.event('got', item);
    if (reason === 'dropped') state.bag = [];
    speech.update(reason === 'expired' ? 30 : 10, state);
    assert.deepEqual(said.map((s) => s.id), ['ambient']);
    assert.equal(speech.once.has('find'), false);
  }
});

test('instant subtitles apply during a line and the duration control extends reading time', () => {
  const a = fixture();
  a.speech.event('near', {});
  a.comfort.instantText = true;
  a.speech.update(0.01, a.state);
  assert.equal(a.speech.shown.textContent, 'There is a lot of sand around here.');
  const normal = fixture(), longer = fixture();
  normal.comfort.instantText = longer.comfort.instantText = true;
  longer.comfort.subtitleDuration = 3;
  normal.speech.event('near', {});
  longer.speech.event('near', {});
  assert.equal(longer.said[0].seconds, normal.said[0].seconds * 3);
});
