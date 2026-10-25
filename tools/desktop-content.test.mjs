import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { contentStore, safeContentPath, validateManifest } from '../desktop/content.mjs';

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);
function fixture(t, fetchFile, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'paahde-content-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, 'dist'), userData = path.join(root, 'user');
  mkdirSync(dist); mkdirSync(userData);
  writeFileSync(path.join(dist, 'index.html'), 'old page');
  writeFileSync(path.join(dist, 'game.js'), 'old script');
  const manifest = { build: 'old', files: { 'index.html': hash('old page'), 'game.js': hash('old script') } };
  writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest));
  return { root, dist, userData, game: contentStore({ dist, userData, server: 'https://game.example/sub/', fetchFile, ...options }) };
}

test('manifest rejects traversal, malformed hashes and missing entrypoints', () => {
  for (const p of ['../secret', '/secret', 'a/../b', 'a\\b', 'a//b', 'https:x', 'a%2fb', 'a?b', '']) assert.equal(safeContentPath(p), false, p);
  for (const value of [null, [], {}, { build: 'x', files: { 'index.html': '../secret', 'a.js': hash('a') } },
    { build: 'x', files: { '../a.js': hash('a'), 'index.html': hash('b') } }, { build: 'x', files: {} }]) assert.throws(() => validateManifest(value));
});

test('successful update activates atomically, retains running build and verifies cached contents', async (t) => {
  const next = { build: 'new', files: { 'index.html': hash('new page'), 'new.js': hash('new script') } };
  const responses = { 'manifest.json': JSON.stringify(next), 'index.html': 'new page', 'new.js': 'new script' };
  let allowScript;
  const script = new Promise((r) => { allowScript = r; });
  const { game, userData } = fixture(t, async (url) => {
    const file = new URL(url).pathname.split('/').at(-1);
    if (file === 'new.js') await script;
    return new Response(responses[file]);
  });
  const update = game.update();
  assert.equal(readFileSync(game.path('index.html'), 'utf8'), 'old page');
  allowScript(); await update;
  assert.equal(readFileSync(game.path('index.html'), 'utf8'), 'new page');
  assert.equal(readFileSync(game.path('game.js'), 'utf8'), 'old script');
  assert.equal(JSON.parse(readFileSync(path.join(userData, 'manifest.json'))).build, 'new');
  assert.equal(game.path('../manifest.json'), null);
  writeFileSync(game.path('new.js'), 'corrupted');
  assert.equal(game.path('new.js'), null);
  await game.update();
  assert.equal(readFileSync(game.path('new.js'), 'utf8'), 'new script');
});

test('changed file or oversized response leaves the previous build active', async (t) => {
  const next = { build: 'new', files: { 'index.html': hash('new page'), 'game.js': hash('new script') } };
  const { game } = fixture(t, async (url) => new URL(url).pathname.endsWith('manifest.json') ?
    Response.json(next) : new Response('wrong content'));
  await game.update();
  assert.equal(readFileSync(game.path('index.html'), 'utf8'), 'old page');
});

test('stalled downloads time out and fall back to a playable build', async (t) => {
  const { game } = fixture(t, (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), { timeoutMs: 40, requestMs: 20 });
  await game.update();
  assert.equal(readFileSync(game.path('index.html'), 'utf8'), 'old page');
});
