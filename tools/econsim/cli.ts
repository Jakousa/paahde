// The economy simulator's front end (docs/econsim.md).
//
//   npm run econ                         simulate this tree, print the summary
//   npm run econ -- --base origin/main   ...and the same worlds at another commit (this simulator copied into a temporary
//                                        git worktree of it), and print what changed
//   node tools/econsim/cli.ts run [--worlds 200] [--jobs n] [--out results.json] [--sha <sha>]
//   node tools/econsim/cli.ts compare <base.json> <head.json> [--md report.md] [--link <url>] [--discord] [--always]
//
// `--discord` posts the flagged changes to the webhook in ECON_DISCORD_WEBHOOK (only when something moved, unless --always).
// Each world runs in a process of its own (tools/econsim/run.ts: the seed comes from WORLD_ID at import time).
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { COSTS } from './costs.ts';
import { compare, compareMd, discordText, summaryMd, type Results } from './stats.ts';

const HERE = import.meta.dirname;
const args = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name: string) => args.includes(`--${name}`);

/** A hash of the simulator's own code: results from different simulators measure with different yardsticks. */
function simHash(dir: string): string {
  const h = createHash('sha1');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()) h.update(f).update(readFileSync(join(dir, f)));
  return h.digest('hex').slice(0, 12);
}

function gitSha(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** Simulate `n` worlds (ids sim0000.., seeds 0..) with the simulator in `dir`, `jobs` at a time. */
async function simulate(dir: string, n: number, jobs: number, sha: string): Promise<Results> {
  const runs: Results['runs'] = [];
  let next = 0, failed = 0;
  const one = (i: number) => new Promise<void>((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', join(dir, 'run.ts'), String(i)], { env: { ...process.env, WORLD_ID: `sim${String(i).padStart(4, '0')}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      if (code === 0) runs.push(JSON.parse(out));
      else if (failed++ < 3) process.stderr.write(`world ${i} failed (${code}):\n${err.slice(-2000)}\n`);
      resolve();
    });
  });
  const worker = async () => {
    while (next < n) await one(next++);
  };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(jobs, n) }, worker));
  if (failed) throw new Error(`${failed} of ${n} worlds failed`);
  runs.sort((a, b) => a.seed - b.seed);
  process.stderr.write(`econsim: ${n} worlds in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
  return { sha, simHash: simHash(dir), capS: COSTS.capS, runs };
}

async function post(text: string) {
  const url = process.env.ECON_DISCORD_WEBHOOK;
  if (!url) return process.stderr.write('econsim: no ECON_DISCORD_WEBHOOK, not posting\n');
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'econsim', content: text }) });
  if (!res.ok) throw new Error(`Discord: ${res.status} ${await res.text()}`);
}

const cmd = args[0] && !args[0].startsWith('--') ? args[0] : 'local';
const worlds = Number(opt('worlds', '200'));
const jobs = Number(opt('jobs', String(availableParallelism())));

if (cmd === 'run') {
  const r = await simulate(HERE, worlds, jobs, opt('sha') ?? gitSha(HERE));
  writeFileSync(opt('out', 'econ-results.json')!, JSON.stringify(r));
  console.log(summaryMd(r));
} else if (cmd === 'compare') {
  const [base, head] = [args[1], args[2]].map((f) => JSON.parse(readFileSync(f, 'utf8')) as Results);
  const changes = compare(base, head);
  const md = compareMd(base, head, changes, opt('link'));
  if (opt('md')) writeFileSync(opt('md')!, md);
  console.log(md);
  if (flag('discord') && (flag('always') || changes.some((c) => c.flag))) await post(discordText(base, head, changes, opt('link')));
} else {
  const head = await simulate(HERE, worlds, jobs, gitSha(HERE));
  const ref = opt('base');
  if (!ref) {
    console.log(summaryMd(head));
  } else {
    // The other commit in a temporary worktree, measured with this simulator.
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: HERE, encoding: 'utf8' }).trim();
    const dir = mkdtempSync(join(tmpdir(), 'econ-base-'));
    execFileSync('git', ['worktree', 'add', '--detach', dir, ref], { cwd: root, stdio: 'ignore' });
    try {
      cpSync(HERE, join(dir, 'tools/econsim'), { recursive: true });
      const base = await simulate(join(dir, 'tools/econsim'), worlds, jobs, gitSha(dir));
      console.log(compareMd(base, head, compare(base, head)));
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: root, stdio: 'ignore' });
    }
  }
}
