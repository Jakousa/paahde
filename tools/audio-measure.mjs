// Capture the real browser mix after its limiter, then measure BS.1770 loudness and reconstructed true peaks.
// Start Vite first; node tools/audio-measure.mjs --base http://127.0.0.1:5179/ --out /tmp/paahde-audio
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const base = opt('base', 'http://127.0.0.1:5179/').replace(/\/?$/, '/');
const seconds = Number(opt('seconds', '20'));
const scenarios = opt('scenarios', 'exploration,storm,combat,multiplayer').split(',');
const volumes = opt('volumes', '0.4,1').split(',').map(Number);
const componentGroups = opt('components')?.split(';').map((g) => g.split(',')) ?? [null];
if (!(seconds >= 1 && seconds <= 60) || scenarios.some((s) => !['exploration', 'storm', 'combat', 'multiplayer'].includes(s))
  || volumes.some((v) => !Number.isFinite(v) || v <= 0 || v > 1)
  || componentGroups.some((g) => g?.some((c) => !['ambience', 'music', 'shots', 'steps', 'booms', 'tells', 'drones', 'crawler'].includes(c))))
  throw new Error('Invalid seconds, scenarios, volumes or components');
const chromePath = [opt('chrome'), process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => p && existsSync(p));
if (!chromePath) throw new Error('Chrome not found; use --chrome <path>');
const out = resolve(opt('out', 'data/audio'));
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'paahde-audio-'));
const port = 9400 + Math.floor(Math.random() * 500);
const chrome = spawn(chromePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run',
  '--no-default-browser-check', '--headless=new', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
const report = { measuredAt: new Date().toISOString(), seconds, seed: 20261025, base,
  sha: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim(),
  dirty: !!spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout?.trim(),
  method: 'Chrome post-limiter float32 PCM; ffmpeg ebur128=peak=true; music=1; fresh page and seeded random per capture', runs: [] };

function measure(files, name) {
  const filter = files.length > 1 ? ['-filter_complex', `${files.map((_, i) => `[${i}:a]`).join('')}concat=n=${files.length}:v=0:a=1,ebur128=peak=true`]
    : ['-af', 'ebur128=peak=true'];
  const meter = spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...files.flatMap((f) => ['-i', f]), ...filter, '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (meter.error || meter.status) throw new Error(`ffmpeg failed: ${meter.error ?? meter.stderr}`);
  writeFileSync(join(out, `${name}.meter.txt`), meter.stderr);
  const summary = meter.stderr.slice(meter.stderr.lastIndexOf('Summary:'));
  const value = (pattern) => { const hit = summary.match(pattern); if (!hit) throw new Error(`Missing meter result: ${summary}`); return hit[1] === '-inf' ? null : Number(hit[1]); };
  return { integratedLufs: value(/\bI:\s+(-inf|-?[\d.]+) LUFS/), loudnessRangeLu: value(/\bLRA:\s+([\d.]+) LU/),
    truePeakDbtp: value(/Peak:\s+(-inf|-?[\d.]+) dBFS/) };
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  ws?.close(); chrome.kill();
  setTimeout(() => { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); process.exit(signal === 'SIGINT' ? 130 : 143); }, 500);
});

try {
  for (let i = 0; i < 100 && !ws; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((p) => p.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
      }
    } catch { ws = undefined; }
    if (!ws) await sleep(100);
  }
  if (!ws) throw new Error('Chrome did not start');
  let id = 0;
  const pending = new Map(), problems = [];
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(String(data));
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); p?.(m); }
    else if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type))
      problems.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 500));
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); reject(new Error(`${method}: browser timed out`)); }, (seconds + 30) * 1000);
    pending.set(n, (m) => {
      clearTimeout(timer);
      if (m.error) reject(new Error(`${method}: ${m.error.message}`)); else resolve(m.result);
    });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  report.browser = await send('Browser.getVersion');
  await send('Page.addScriptToEvaluateOnNewDocument', { source:
    `let audioSeed=20261025; Math.random=()=>{audioSeed=(Math.imul(audioSeed,1664525)+1013904223)>>>0;return audioSeed/4294967296;};` });
  for (const scenario of scenarios) for (const volume of volumes) for (const components of componentGroups) {
    const name = `${scenario}-${String(volume).replace('.', '_')}${components ? `-${components.join('+')}` : ''}`;
    console.log(`Capturing ${scenario}, volume ${volume}, ${seconds}s...`);
    problems.length = 0;
    await send('Page.navigate', { url: `${base}tools/audio-bench.html?w=audiofixture&capture=${name}` });
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      try { ready = await evaluate('typeof window.measureAudio === "function"'); } catch {}
      if (!ready) await sleep(100);
    }
    if (!ready) throw new Error(`Audio harness did not load: ${problems.join('; ')}`);
    const point = await evaluate('(()=>{const r=document.getElementById("start").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    const capture = await evaluate(`window.measureAudio(${JSON.stringify(scenario)},${volume},${seconds},${JSON.stringify(components ?? undefined)})`, true);
    const file = join(out, `${name}.wav`);
    writeFileSync(file, Buffer.from(capture.wav, 'base64'));
    delete capture.wav;
    const result = { ...capture, file, ...measure([file], name), problems: [...new Set(problems)] };
    report.runs.push(result);
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`${name}: ${result.integratedLufs} LUFS, ${result.truePeakDbtp} dBTP, LRA ${result.loudnessRangeLu} LU; voice peak ${result.metrics.voicePeak}, dropped ${result.metrics.voiceDrops}, echo peak ${result.metrics.echoPeak}`);
  }
  report.suites = [];
  for (const volume of volumes) for (const components of componentGroups) {
    const runs = report.runs.filter((r) => r.volume === volume && JSON.stringify(r.components) === JSON.stringify(components ?? 'all'));
    if (runs.length < 2) continue;
    const name = `suite-${String(volume).replace('.', '_')}${components ? `-${components.join('+')}` : ''}`;
    const result = { volume, components: components ?? 'all', scenarios: runs.map((r) => r.scenario), ...measure(runs.map((r) => r.file), name) };
    report.suites.push(result);
    console.log(`${name}: ${result.integratedLufs} LUFS, ${result.truePeakDbtp} dBTP (equal-duration concatenation, not player-time weighting)`);
  }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${join(out, 'report.json')}`);
} finally {
  ws?.close();
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
