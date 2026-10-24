// The client in a browser (docs/bench.md): the production build in `dir`/dist served by that tree's server (fresh data,
// the bench world, tools/bench/serverHook.ts seeding the server's dice), measured by tools/perf.ts in headless Chrome with
// no graphics card (--software: SwiftShader draws on the CPU, as on a CI runner). Low settings at 480×300, so a frame is a
// few hundred ms rather than seconds; then a spin on the spot beside a scrap field in the morning (the same views every
// run). What it tells: the startup timeline, the game's own CPU time per frame (median), draws and triangles, and the software
// rasterizer's time as a rough measure of what the frame asks of a graphics card. Prints a Sample (tools/bench/common.ts).
//
//   node tools/bench/client.ts [dir] [--seconds 15] [--port 8790] [--chrome <path>]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BENCH_WORLD_ID, type Sample } from './common.ts';

const args = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const seconds = opt('seconds', '15')!;
const port = opt('port', '8790')!;
if (!existsSync(join(dir, 'dist/index.html'))) throw new Error(`no build in ${dir}/dist: npx vite build there first`);

const data = mkdtempSync(join(tmpdir(), 'dadajam-bench-client-'));
mkdirSync(join(data, 'worlds'));
writeFileSync(join(data, 'worlds', `${BENCH_WORLD_ID}.db`), ''); // (an empty file is a world that exists: its process makes the tables)
const server = spawn(process.execPath, ['--no-warnings', '--import', pathToFileURL(join(import.meta.dirname, 'serverHook.ts')).href, 'server/index.ts'], {
  cwd: dir, env: { ...process.env, PORT: port, DB_PATH: join(data, 'dadajam.db') }, stdio: 'ignore',
});
const stop = () => {
  server.kill('SIGTERM');
  rmSync(data, { recursive: true, force: true });
};

try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/`)).ok) break;
    } catch {}
    if (i > 100) throw new Error('the server did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  const out = join(data, 'perf');
  const low = ['resScale=0.5', 'dynamicRes=false', 'shadows=false', 'antialias=false', 'sandDetail=0', 'occlusion=0', 'fpsLimit=0'];
  const perf = spawnSync(process.execPath, [
    '--no-warnings', join(import.meta.dirname, '../perf.ts'), '--base', `http://localhost:${port}/`, '--world', BENCH_WORLD_ID, '--seconds', seconds,
    '--trace', 'none', '--headless', '--software', '--peaceful', '--route', 'spin', '--spawn', 'field', '--tod', '0.4', '--size', '480x300', '--out', out,
    ...low.flatMap((s) => ['--set', s]), ...(opt('chrome') ? ['--chrome', opt('chrome')!] : []),
  ], { encoding: 'utf8', timeout: 10 * 60_000 });
  process.stderr.write(perf.stdout ?? '');
  const file = existsSync(out) ? readdirSync(out).find((f) => f.endsWith('.json')) : undefined;
  if (!file) {
    // What tools/perf.ts said last (not the page's shader warnings), for the report.
    const said = `${perf.stdout ?? ''}\n${perf.stderr ?? ''}`.split('\n').filter((l) => l.trim() && !/warning:|^\s+(at |-)|Vertex attribute/.test(l));
    throw new Error(`tools/perf.ts ${perf.error ? perf.error.message : `exited ${perf.status}`}: ${said.slice(-5).join(' | ')}`);
  }
  const r = JSON.parse(readFileSync(join(out, file), 'utf8'));
  if (!r.valid) throw new Error(`invalid run: ${r.invalidReasons.join('; ')}${r.gameplay?.events?.length ? ` (${JSON.stringify(r.gameplay.events)})` : ''}`);
  const ms = r.startup.milestonesMs as Record<string, number>, g = r.gameplay;
  const sample: Sample = {
    m: {
      'page to renderer ready': [ms['renderer-ready'], 'ms'],
      'page to joined': [ms.joined, 'ms'],
      'page to models in': [ms['models-in'], 'ms'],
      'page to loaded': [ms.loaded, 'ms'],
      'page to playable': [ms.playable, 'ms'],
      'long tasks before playable': [r.startup.longTasks.beforePlayableMs, 'ms'],
      'frame CPU, p50': [g.cpuMs.p50, 'ms'],
      'render submit, p50': [g.submitMs.p50, 'ms'],
      ...(g.gpuMs ? { 'software raster, p50': [g.gpuMs.p50, 'ms'] as [number, string] } : {}),
      'draws': [g.draws.p50, ''],
      'triangles': [g.trianglesK.p50, 'k'],
    },
  };
  process.stdout.write(JSON.stringify(sample) + '\n');
} finally {
  stop();
}
