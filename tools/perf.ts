// Automated performance run (docs/perf.md): opens the game in a real Chrome (GPU on), waits until it is playable, walks a fixed
// route and writes the result (CPU / GPU / frame times, the startup timeline) and a Chrome trace of the same stretch to data/perf/.
//
//   node tools/perf.ts [--base http://localhost:5173/] [--seconds 30] [--trace play|startup|none] [--world <id>]
//                      [--set resScale=0.7 --set shadows=false ...] [--chrome <path>] [--headless] [--out data/perf] [--label name]
//
//   --seconds    gameplay to record (0 = the startup timeline only, no walking)
//   --trace      play: trace only the recorded walk (default); startup: trace from page load until playable; none
//   --set k=v    a graphics option (src/graphics.ts: resScale, minRes, dynamicRes, fpsLimit, shadows, shadowDistance, cascades, shadowMap,
//                shadowFilter, shadowRefresh, antialias) written to localStorage before the page loads
//   --world      an existing world id; without it a new world is made (POST api/worlds). The game server must be running (npm run dev)
// The trace reads with `python tools/trace-report.py data/perf/<file>.trace.json.gz`.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name: string) => args.includes(`--${name}`);
const sets = args.flatMap((a, i) => (a === '--set' && args[i + 1] ? [args[i + 1]] : []));

const base = (opt('base', 'http://localhost:5173/') as string).replace(/\/?$/, '/');
const seconds = Number(opt('seconds', '30'));
const trace = opt('trace', 'play') as 'play' | 'startup' | 'none';
const out = opt('out', 'data/perf') as string;
const label = opt('label', '') as string;

const CHROME = [opt('chrome'), process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`, '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && existsSync(p));
if (!CHROME) throw new Error('Chrome not found: pass --chrome <path>');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function worldId(): Promise<string> {
  const given = opt('world');
  if (given) return given;
  const res = await fetch(`${base}api/worlds`, { method: 'POST' });
  if (!res.ok) throw new Error(`could not make a world (${res.status}): is the game running (npm run dev)?`);
  return ((await res.json()) as { id: string }).id;
}

const prefs: Record<string, unknown> = {};
for (const kv of sets) {
  const [k, v] = kv.split('=');
  prefs[k] = v === 'true' ? true : v === 'false' ? false : Number(v);
}

const world = await worldId();
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'dadajam-perf-'));
const port = 9222 + Math.floor(Math.random() * 500);
const chrome: ChildProcess = spawn(CHROME, [
  `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-webgpu', '--enable-webgpu-developer-features', // (precise GPU timestamps: otherwise rounded to 0.1 ms)
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--window-size=1280,800', ...(flag('headless') ? ['--headless=new'] : []), 'about:blank',
], { stdio: 'ignore' });
const stop = () => {
  chrome.kill();
  setTimeout(() => rmSync(dir, { recursive: true, force: true }), 1500);
};
process.on('SIGINT', () => (stop(), process.exit(1)));

async function connect(): Promise<WebSocket> {
  for (let i = 0; i < 60; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      const page = list.find((t) => t.type === 'page');
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise<void>((res, rej) => ((ws.onopen = () => res()), (ws.onerror = () => rej(new Error('ws')))));
        return ws;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('could not reach Chrome');
}

try {
  const ws = await connect();
  let id = 0;
  const pending = new Map<number, (r: { result?: any; error?: { message: string } }) => void>();
  const events: ((m: { method: string; params: any }) => void)[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) pending.get(m.id)!(m);
    else if (m.method) for (const f of events) f(m);
  };
  const send = (method: string, params: object = {}) =>
    new Promise<any>((res, rej) => {
      const n = ++id;
      pending.set(n, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression: string) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.value;

  // The prologue is skipped (a tab's later loads are short), graphics settings are the asked ones, and stats stay as they were.
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { sessionStorage.setItem('prologueSeen', '1'); const k = 'dadajam.graphics'; localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) || '{}'), ...${JSON.stringify(prefs)} })); } catch {}`,
  });

  // Tracing: Chrome's Performance recording categories, streamed back as a file.
  const categories = ['-*', 'devtools.timeline', 'v8.execute', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'toplevel',
    'blink.console', 'blink.user_timing', 'latencyInfo', 'gpu', 'disabled-by-default-v8.cpu_profiler', 'disabled-by-default-v8.cpu_profiler.hires'].join(',');
  const traceEvents: unknown[] = [];
  events.push((m) => {
    if (m.method === 'Tracing.dataCollected') traceEvents.push(...m.params.value);
  });
  let tracing = false;
  const traceStart = async () => {
    if (tracing || trace === 'none') return;
    tracing = true;
    await send('Tracing.start', { categories, transferMode: 'ReportEvents' });
  };
  const traceStop = async () => {
    if (!tracing) return;
    tracing = false;
    const done = new Promise<void>((res) => events.push((m) => m.method === 'Tracing.tracingComplete' && res()));
    await send('Tracing.end');
    await done;
  };

  const url = `${base}?w=${world}&perf=${seconds === 0 ? 'startup' : seconds}&perfdl=0`;
  console.log(`world ${world}; ${url}\nChrome: ${CHROME}\n${Object.keys(prefs).length ? `settings ${JSON.stringify(prefs)}\n` : ''}waiting for the game to load...`);
  if (trace === 'startup') await traceStart();
  await send('Page.navigate', { url });

  let phase = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 10 * 60_000) {
    const state = (await evaluate('window.__perfState && window.__perfState.phase')) as string | undefined;
    if (state && state !== phase) {
      phase = state;
      console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)} s: ${phase}`);
      if (phase === 'settling' && trace === 'startup') await traceStop();
      if (phase === 'recording') await traceStart();
    }
    if (phase === 'done') break;
    await sleep(500);
  }
  if (phase !== 'done') throw new Error('the run did not finish (the game never became playable?)');
  await traceStop();
  const result = (await evaluate('window.__perfResult')) as Record<string, any>;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${stamp}${label ? `-${label}` : ''}`;
  writeFileSync(join(out, `${name}.json`), JSON.stringify(result, null, 2));
  if (traceEvents.length) writeFileSync(join(out, `${name}.trace.json.gz`), gzipSync(JSON.stringify({ traceEvents })));
  const g = result.gameplay;
  console.log(`\nwritten ${join(out, name)}.json${traceEvents.length ? ' and .trace.json.gz' : ''}`);
  console.log('startup (ms):', JSON.stringify(result.startup.milestonesMs), '| long tasks', JSON.stringify(result.startup.longTasks));
  if (g) {
    console.log(`gameplay: ${g.fps} fps (1% low ${g.lows1pctFps}), frames ${g.frames}, > 20 ms: ${g.framesOver20ms}, > 50 ms: ${g.framesOver50ms}`);
    console.log(`  frame gap ms p50/p90/p99/max: ${['p50', 'p90', 'p99', 'max'].map((k) => g.gapMs[k]).join(' / ')}`);
    console.log(`  cpu ms p50/p90/p99: ${g.cpuMs ? ['p50', 'p90', 'p99'].map((k) => g.cpuMs[k]).join(' / ') : '-'}   gpu ms p50/p90/p99: ${g.gpuMs ? ['p50', 'p90', 'p99'].map((k) => g.gpuMs[k]).join(' / ') : '-'}   bound: ${g.bound}`);
    console.log(`  draws ${g.draws.p50}, triangles ${g.trianglesK.p50}k, render scale ${g.renderScale.p50}`);
  }
} finally {
  stop();
}
process.exit(0);
