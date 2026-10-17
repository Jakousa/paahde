// Headless-Chrome screenshot of a page (for reviewing models-lab.html without a GUI).
//   node tools/models/screenshot.mjs <url> <out.png> [width=1600] [height=800] [waitMs=8000]
// Launches Chrome with remote debugging on a free port, waits in real time (WebGPU init + glb load),
// prints console errors, saves a PNG, and kills only the Chrome it started.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const [url, out, w = '1600', h = '800', wait = '8000'] = process.argv.slice(2);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'shot-'))}`,
  `--window-size=${w},${h}`, '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal',
  '--no-first-run', '--hide-scrollbars', '--mute-audio', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0;
  const pending = new Map();
  ws.on('message', (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg.result);
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type))
      console.log('console.' + msg.params.type, msg.params.args.map((a) => a.value ?? a.description).join(' '));
    if (msg.method === 'Runtime.exceptionThrown') console.log('exception', msg.params.exceptionDetails.exception?.description);
  });
  const send = (method, params = {}) => new Promise((r) => {
    pending.set(++id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(+wait);
  // EVAL='js' runs in the page before the shot (e.g. to turn the camera), then waits a second.
  if (process.env.EVAL) { await send('Runtime.evaluate', { expression: process.env.EVAL, awaitPromise: true }); await sleep(1000); }
  const info = await send('Runtime.evaluate', { expression: 'document.getElementById("info")?.textContent ?? document.getElementById("label")?.textContent', returnByValue: true });
  console.log('page text:', info?.result?.value);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('saved', out);
  ws.close();
} finally {
  chrome.kill();
}
