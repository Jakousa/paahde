// Automated performance run (docs/perf.md): opens the game in a real Chrome (GPU on), waits until it is playable, walks a fixed
// route and writes the result (CPU / GPU / frame times, the startup timeline) and a Chrome trace of the same stretch to data/perf/.
//
//   node tools/perf.ts [--base http://localhost:5173/] [--seconds 30] [--trace play|startup|none] [--world <id>]
//                      [--set resScale=0.7 --set shadows=false ...] [--chrome <path>] [--spawn field|crash|shelter|base] [--tod 0.333] [--yaw 3.14] [--allow-death] [--size 2560x1440] [--route walk|spin] [--view <m above the player, for the picture>] [--face sun] [--pitch <degrees down, with --view>] [--query k=v&k2=v2 (extra address parameters, e.g. dev comparisons)] [--headless] [--software] [--peaceful] [--shot [--ab key=value]] [--out data/perf] [--label name]
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
/** Where the player starts (a dev helper of the server, shared/protocol.ts): field = beside a scrap field, crash = beside a crash site's machine, shelter, base; none = the saved position (the bunker in a new world). */
const spawnAt = opt('spawn', '') as string;
/** Time of day the run starts at (0..1: 0.333 = 8 am, 0.833 = 8 pm, the sun at 28°, long shadows); the clock then runs on as usual. Without it, the world's own time. */
const tod = opt('tod', '') as string;
/** Viewport in CSS pixels, WxH (the game renders one pixel per CSS pixel: a bigger window costs the graphics card more). Default: Chrome's own, about 1280x800. */
const size = opt('size', '') as string;
/** Radians to turn from the way the player faces at the start (3.14 = about face: away from the scrap field the field spawn looks at). */
const yaw = opt('yaw', '') as string;

const CHROME = [opt('chrome'), process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`, '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && existsSync(p));
if (!CHROME) throw new Error('Chrome not found: pass --chrome <path>');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function worldId(): Promise<string> {
  const given = opt('world');
  if (given) return given;
  const res = await fetch(`${base}api/worlds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Perf run', public: false, max: 16 }) });
  if (!res.ok) throw new Error(`could not make a world (${res.status}): is the game running (npm run dev)?`);
  return ((await res.json()) as { id: string }).id;
}

/** `--ls key=value`: raw localStorage entries (other settings than the graphics ones, e.g. dadajam.ao=0 for no ambient occlusion). */
const rawLs = args.flatMap((a, i) => (a === '--ls' && args[i + 1] ? [args[i + 1].split('=')] : []));
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
  '--window-size=1280,800', ...(flag('headless') ? ['--headless=new'] : []),
  // --software: no graphics card (a CI runner): WebGL2 drawn by SwiftShader on the CPU
  ...(flag('software') ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'] : []), 'about:blank',
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
  // the page's errors and warnings (a shader that does not compile, a GPU validation error): counted, the first few printed
  const problems: string[] = [];
  await send('Runtime.enable');
  await send('Log.enable');
  events.push((m) => {
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) problems.push(`${m.params.type}: ${m.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 400));
    if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`.slice(0, 400));
    if (m.method === 'Log.entryAdded' && (m.params.entry.level === 'error' || m.params.entry.level === 'warning')) problems.push(`${m.params.entry.level}: ${m.params.entry.text}`.slice(0, 400));
  });
  if (size) {
    const [w, h] = size.split('x').map(Number);
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  }
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { sessionStorage.setItem('prologueSeen', '1'); localStorage.setItem('dadajam.name', localStorage.getItem('dadajam.name') || 'Perf'); const k = 'dadajam.graphics'; localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) || '{}'), ...${JSON.stringify(prefs)} })); for (const [lk, lv] of ${JSON.stringify(rawLs)}) localStorage.setItem(lk, lv); } catch {}${flag('software') ? ' delete Navigator.prototype.gpu;' : ''}`, // (no WebGPU in software: three falls back to WebGL2)
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

  const url = `${base}?w=${world}&perf=${seconds === 0 ? 'startup' : seconds}&perfdl=0${spawnAt ? `&spawn=${spawnAt}` : ''}${tod ? `&ptod=${tod}` : ''}${yaw ? `&pyaw=${yaw}` : ''}${flag('allow-death') ? '&pdeath=continue' : ''}${opt('query') ? `&${opt('query')}` : ''}${opt('route') ? `&proute=${opt('route')}` : ''}${opt('view') ? `&pview=${opt('view')}` : ''}${opt('face') ? `&pface=${opt('face')}` : ''}${opt('pitch') ? `&ppitch=${opt('pitch')}` : ''}`;
  console.log(`world ${world}; ${url}\nChrome: ${CHROME}\n${Object.keys(prefs).length ? `settings ${JSON.stringify(prefs)}\n` : ''}waiting for the game to load...`);
  if (trace === 'startup') await traceStart();
  await send('Page.navigate', { url });

  let phase = '';
  let shotData: Buffer | null = null;
  let shotB: Buffer | null = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 10 * 60_000) {
    const state = (await evaluate('window.__perfState && window.__perfState.phase')) as string | undefined;
    if (state && state !== phase) {
      phase = state;
      console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)} s: ${phase}`);
      if (phase === 'settling' && trace === 'startup') await traceStop();
      // --peaceful: no heat and no weather for this player (the debug menu's switches), so a long load in the sun or a
      // storm doesn't end the run (CI: tools/bench/client.ts)
      if (flag('peaceful')) await evaluate('window.__dbg && (window.__dbg.net.debugHeat(true), window.__dbg.net.debugWeather(true))');
      if (phase === 'recording') await traceStart();
    }
    if (phase === 'done') break;
    await sleep(500);
  }
  if (phase !== 'done') throw new Error('the run did not finish (the game never became playable?)');
  await traceStop();
  if (flag('shot')) {
    // the view where the walk ended (it stands still there), then again with one option changed, to compare the two pictures
    const grab = async () => Buffer.from(((await send('Page.captureScreenshot', { format: 'png' })) as { data: string }).data, 'base64');
    await sleep(4000); // (the eye adapts to the new view's brightness over a few seconds)
    shotData = await grab();
    const ab = opt('ab');
    if (ab) {
      const [k, v] = ab.split('=');
      await evaluate(`window.__setGraphics(${JSON.stringify(k)}, ${v})`);
      await sleep(2500);
      shotB = await grab();
    }
  }
  const ev = opt('eval'); // a dev probe: an expression evaluated in the page once the run is done (window.__dbg has the renderer, sky, net, terrain)
  if (ev) console.log('eval:', JSON.stringify((await send('Runtime.evaluate', { expression: ev, returnByValue: true, awaitPromise: true })).result?.value ?? null));
  const result = (await evaluate('window.__perfResult')) as Record<string, any>;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${stamp}${label ? `-${label}` : ''}${result.valid ? '' : '-INVALID'}`;
  writeFileSync(join(out, `${name}.json`), JSON.stringify(result, null, 2));
  if (traceEvents.length) writeFileSync(join(out, `${name}.trace.json.gz`), gzipSync(JSON.stringify({ traceEvents })));
  if (shotData) writeFileSync(join(out, `${name}.png`), shotData);
  if (shotB) writeFileSync(join(out, `${name}.ab.png`), shotB);
  if (problems.length) {
    const uniq = [...new Set(problems)];
    console.log(`page errors/warnings: ${problems.length} (${uniq.length} different)`);
    for (const p of uniq.slice(0, 8)) console.log(`  ${p}`);
  }
  const g = result.gameplay;
  console.log(`\nwritten ${join(out, name)}.json${traceEvents.length ? ' and .trace.json.gz' : ''}`);
  if (!result.valid) {
    console.log(`\n!! INVALID RUN: ${(result.invalidReasons as string[]).join('; ')}`);
    console.log('   Do not compare these numbers with other runs. Use --spawn field --yaw 3.14 (no enemies, open ground) and an early --tod, or --allow-death to keep the run going and leave the player-down frames out.');
    process.exitCode = 2;
  }
  console.log('startup (ms):', JSON.stringify(result.startup.milestonesMs), '| long tasks', JSON.stringify(result.startup.longTasks));
  if (g) {
    for (const e of g.events as { type: string; atS: number; x: number; z: number; heat: number }[]) console.log(`  event: player ${e.type} at ${e.atS} s, (${e.x}, ${e.z}), heat ${e.heat}`);
    if (g.framesExcluded) console.log(`  ${g.framesExcluded} frames left out of the numbers (player down or just respawned)`);
    console.log(`  travelled ${g.travelledM} m`);
    console.log(`  walk ${JSON.stringify(g.startedAt)} -> ${JSON.stringify(g.endedAt)}`);
    console.log(`gameplay: ${g.fps} fps (1% low ${g.lows1pctFps}), frames ${g.frames}, > 20 ms: ${g.framesOver20ms}, > 50 ms: ${g.framesOver50ms}`);
    console.log(`  frame gap ms p50/p90/p99/max: ${['p50', 'p90', 'p99', 'max'].map((k) => g.gapMs[k]).join(' / ')}`);
    console.log(`  cpu ms p50/p90/p99: ${g.cpuMs ? ['p50', 'p90', 'p99'].map((k) => g.cpuMs[k]).join(' / ') : '-'}   gpu ms p50/p90/p99: ${g.gpuMs ? ['p50', 'p90', 'p99'].map((k) => g.gpuMs[k]).join(' / ') : '-'}   bound: ${g.bound}`);
    if (g.gpuPasses?.length) console.log('  gpu ms per frame by render pass (ctx: per-frame ms / when drawn / share of frames):', g.gpuPasses.slice(0, 8).map((x: any) => `${x.ctx}: ${x.perFrameMs} (${x.meanMs} x ${Math.round(x.share * 100)}%)`).join(' | '));
    console.log(`  draws ${g.draws.p50}, triangles ${g.trianglesK.p50}k, render scale ${g.renderScale.p50}`);
  }
} finally {
  stop();
}
process.exit(process.exitCode ?? 0);
