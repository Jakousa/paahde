// The benchmarks' front end (docs/bench.md). Times can't be kept from one machine to the next, so a comparison always
// runs both commits here, one after the other and in turns (base, head, head, base, ...), each run a fresh process.
//
//   npm run bench                              this tree: every suite, the medians
//   npm run bench -- --base origin/main        ...and the same at another commit (a temporary git worktree of it, with
//                                              these benchmarks copied in), and what changed
//   node tools/bench/cli.ts ab <base dir> [--suites auto|worldgen,physics,ai,server,client] [--out results.json]
//                              [--md report.md] [--link <url>] [--discord] [--always]
//   node tools/bench/cli.ts report <results.json> [--md report.md]
//
// --rounds n (each suite's default: SUITE_ROUNDS), --suites (default: all; `auto`: those the commits' changed files can
// move). The client suite needs a build in each tree's dist/ (npx vite build) and Chrome. --discord posts what was
// flagged to the webhook in BENCH_DISCORD_WEBHOOK (only when something was, unless --always).
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Sample } from './common.ts';
import { discordText, reportMd, SUITES, worthTelling, type Results } from './stats.ts';

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, '../..');
const args = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name: string) => args.includes(`--${name}`);

/** Runs per side: the loops are steady and quick, the server and the browser slow. */
const SUITE_ROUNDS: Record<string, number> = { worldgen: 7, physics: 7, ai: 7, server: 3, client: 2 };
/** The files each suite measures: `auto` runs a suite only if the commits differ in one of them. */
const SUITE_PATHS: Record<string, RegExp> = {
  worldgen: /^shared\//,
  physics: /^shared\//,
  ai: /^(shared|server)\//,
  server: /^(shared|server)\/|^package/,
  client: /^(shared|src|public)\/|^index\.html$|^vite\.config\.ts$|^package|^tools\/perf\.ts$/,
};

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** One run of `suite` on the tree `dir`. A case runs from the copy in `dir`/tools/bench (it imports that tree's game code);
 *  the server and the client are driven by these drivers (and this tools/perf.ts) on both sides. */
function runOnce(suite: string, dir: string): Promise<Sample> {
  const [script, a] = suite === 'server' ? [join(HERE, 'server.ts'), [dir]] : suite === 'client' ? [join(HERE, 'client.ts'), [dir]] : [join(dir, 'tools/bench/case.ts'), [suite]];
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ['--no-warnings', script, ...a], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      const line = out.trim().split('\n').pop() ?? '';
      if (code === 0 && line.startsWith('{')) res(JSON.parse(line) as Sample);
      else rej(new Error(`${suite} exited ${code}: ${err.trim().split('\n').filter((l) => !/warning:|^\s+at /.test(l)).slice(-6).join(' | ')}`));
    });
  });
}

/** Every suite in `suites`, `rounds` times on each side, in turns. */
async function ab(base: string, head: string, suites: string[], skipped: string[]): Promise<Results> {
  const r: Results = { base: git(base, 'rev-parse', 'HEAD'), head: git(head, 'rev-parse', 'HEAD'), suites: {}, skipped };
  for (const suite of suites) {
    const runs = (r.suites[suite] = { base: [] as Sample[], head: [] as Sample[], errors: {} as { base?: string; head?: string } });
    const n = Number(opt('rounds', String(SUITE_ROUNDS[suite] ?? 3)));
    const t0 = Date.now();
    // The first Chrome on a fresh runner starts cold (disk, fonts, shader cache): a run thrown away, or the side that went
    // first would look a second slower to start.
    if (suite === 'client') await runOnce(suite, head).catch(() => {});
    for (let i = 0; i < n; i++) {
      for (const side of i % 2 ? (['head', 'base'] as const) : (['base', 'head'] as const)) {
        if (runs.errors[side]) continue;
        try {
          runs[side].push(await runOnce(suite, side === 'base' ? base : head));
        } catch (e) {
          runs.errors[side] = (e as Error).message;
        }
      }
    }
    process.stderr.write(`bench: ${suite} ×${n} in ${((Date.now() - t0) / 1000).toFixed(0)} s${runs.errors.head ? ' (FAILED here)' : ''}${runs.errors.base ? ' (failed at the base)' : ''}\n`);
  }
  return r;
}

function pickSuites(base: string | null): { run: string[]; skipped: string[] } {
  const asked = opt('suites', 'all')!;
  if (asked !== 'auto') return { run: asked === 'all' ? Object.keys(SUITES) : asked.split(','), skipped: [] };
  if (!base) return { run: Object.keys(SUITES), skipped: [] };
  const changed = git(ROOT, 'diff', '--name-only', git(base, 'rev-parse', 'HEAD'), 'HEAD').split('\n').filter(Boolean);
  const bench = changed.some((f) => f.startsWith('tools/bench/')); // (another yardstick: measure everything)
  const run = Object.keys(SUITES).filter((s) => bench || changed.some((f) => SUITE_PATHS[s].test(f)));
  return { run, skipped: Object.keys(SUITES).filter((s) => !run.includes(s)) };
}

async function post(text: string) {
  const url = process.env.BENCH_DISCORD_WEBHOOK;
  if (!url) return process.stderr.write('bench: no BENCH_DISCORD_WEBHOOK, not posting\n');
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'bench', content: text }) });
  if (!res.ok) throw new Error(`Discord: ${res.status} ${await res.text()}`);
}

async function finish(r: Results) {
  if (opt('out')) writeFileSync(opt('out')!, JSON.stringify(r));
  const md = reportMd(r, opt('link'));
  if (opt('md')) writeFileSync(opt('md')!, md);
  console.log(md);
  if (flag('discord') && (flag('always') || worthTelling(r))) await post(discordText(r, opt('link')));
}

const cmd = args[0] && !args[0].startsWith('--') ? args[0] : 'local';
if (cmd === 'ab') {
  const base = resolve(args[1]);
  // The base measured with these benchmarks (another yardstick would be another number), its own game code.
  rmSync(join(base, 'tools/bench'), { recursive: true, force: true });
  cpSync(HERE, join(base, 'tools/bench'), { recursive: true });
  const { run, skipped } = pickSuites(base);
  await finish(await ab(base, ROOT, run, skipped));
} else if (cmd === 'report') {
  const r = JSON.parse(readFileSync(args[1], 'utf8')) as Results;
  const md = reportMd(r, opt('link'));
  if (opt('md')) writeFileSync(opt('md')!, md);
  console.log(md);
} else {
  const ref = opt('base');
  if (!ref) {
    // This tree only: both sides are this tree, so the report's "change" is the noise between runs.
    const { run } = pickSuites(null);
    if (run.includes('client') && !existsSync(join(ROOT, 'dist/index.html'))) execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'ignore' });
    await finish(await ab(ROOT, ROOT, run, []));
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'bench-base-'));
    execFileSync('git', ['worktree', 'add', '--detach', dir, ref], { cwd: ROOT, stdio: 'ignore' });
    try {
      cpSync(HERE, join(dir, 'tools/bench'), { recursive: true });
      symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules')); // (locally the same packages: CI installs the base's own)
      const { run, skipped } = pickSuites(dir);
      if (run.includes('client')) for (const d of [ROOT, dir]) execFileSync('npx', ['vite', 'build'], { cwd: d, stdio: 'ignore' });
      await finish(await ab(dir, ROOT, run, skipped));
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: ROOT, stdio: 'ignore' });
    }
  }
}
