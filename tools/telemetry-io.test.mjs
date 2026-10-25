import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TelemetryTail, telemetryFiles, telemetryLines } from './telemetry-io.ts';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'paahde-telemetry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const event = (name) => JSON.stringify({ at: new Date().toISOString(), w: 'alpha', kind: 'tick', ms: 110, name }) + '\n';

test('world selection includes legacy logs and bounded reports retain complete recent lines', (t) => {
  const dir = fixture(t), base = join(dir, 'telemetry.jsonl');
  writeFileSync(base, event('legacy'));
  writeFileSync(join(dir, 'telemetry.alpha.jsonl.1'), event('rotated'));
  writeFileSync(join(dir, 'telemetry.beta.jsonl'), event('another world'));
  const current = join(dir, 'telemetry.alpha.jsonl');
  writeFileSync(current, Array.from({ length: 30 }, (_, i) => event(`event ${i}`)).join(''));
  utimesSync(current, new Date(), new Date(Date.now() + 1000));
  const selected = telemetryFiles(base, 'alpha');
  assert.equal(selected.length, 3);
  assert.ok(selected.every((f) => !f.includes('beta')));
  const budget = { remaining: 400, truncated: false };
  const lines = [...telemetryLines(selected, budget)].map(JSON.parse);
  assert.equal(budget.remaining, 0); assert.equal(budget.truncated, true);
  assert.equal(lines.at(-1).name, 'event 29');
  assert.ok(lines.every((e) => e.name.startsWith('event ')));
  // A file can be renamed after directory discovery.
  unlinkSync(current);
  assert.doesNotThrow(() => [...telemetryLines([current], { remaining: 1000, truncated: false })]);
});

test('tail retains split UTF-8/JSON lines and drains unread records across rotation and missing-path gaps', (t) => {
  const dir = fixture(t), file = join(dir, 'telemetry.alpha.jsonl'), tail = new TelemetryTail();
  const data = Buffer.from(event('hämärä'));
  const split = data.indexOf(Buffer.from('ä')) + 1;
  writeFileSync(file, data.subarray(0, split));
  assert.deepEqual(tail.poll([file]), []);
  appendFileSync(file, data.subarray(split));
  assert.equal(JSON.parse(tail.poll([file])[0]).name, 'hämärä');
  appendFileSync(file, event('before rotate'));
  renameSync(file, `${file}.1`);
  assert.equal(JSON.parse(tail.poll([file])[0]).name, 'before rotate');
  writeFileSync(file, event('after rotate'));
  assert.equal(JSON.parse(tail.poll([file])[0]).name, 'after rotate');
  assert.deepEqual(tail.poll([file]), []);
  writeFileSync(file, '{}\n'); // Same inode, shorter file: start again at byte zero.
  assert.deepEqual(tail.poll([file]), ['{}']);
});

test('SSH report bounds and filename quoting work without a live SSH server', (t) => {
  const dir = fixture(t), bin = join(dir, 'bin'), logs = join(dir, 'logs');
  mkdirSync(bin); mkdirSync(logs);
  writeFileSync(join(logs, 'telemetry.alpha.jsonl'), event('selected'));
  writeFileSync(join(logs, 'telemetry.beta.jsonl'), event('unselected-fixture-marker'));
  // The fake transport runs the generated read command only against this disposable fixture.
  writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const command = process.argv[3].replaceAll('/opt/dadajam/data', process.env.TELEMETRY_TEST_LOGS);
const child = spawnSync('/bin/sh', ['-c', command], { stdio: 'inherit' });
process.exit(child.status ?? 1);
`, { mode: 0o755 });
  const out = join(dir, 'report.html');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TELEMETRY_TEST_LOGS: logs };
  const run = (world) => execFileSync(process.execPath, ['tools/telemetry.ts', '--host', 'fixture', '--world', world, '--out', out, '--no-open'], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' });
  assert.match(run('alpha'), /1 events/);
  const html = readFileSync(out, 'utf8');
  assert.ok(html.includes('selected')); assert.ok(!html.includes('unselected-fixture-marker'));
  // Literal shell substitutions in a filter are data, not executable shell syntax.
  assert.match(run("alpha'$(exit 47)'"), /no telemetry yet/);
});
