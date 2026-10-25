// Flattens the code-built models (tools/icons/code-models.ts) to tools/icons/out/code-models.json for render.py.
//   node tools/icons/dump.mjs
// Starts its own Vite dev server and headless Chrome, and stops both (only the processes it started).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const vitePort = 5300 + Math.floor(Math.random() * 300);
const cdpPort = 9400 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vite = spawn('node_modules/.bin/vite', ['--port', String(vitePort), '--strictPort'], { stdio: 'ignore' });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'dump-'))}`,
  '--no-first-run', '--mute-audio', 'about:blank',
], { stdio: 'ignore' });

try {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((t) => t.type === 'page'); } catch { /* not up */ }
  }
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://localhost:${vitePort}/tools/icons/code-models.html`)).ok) break; } catch { /* not up */ }
    await sleep(200);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0;
  const pending = new Map();
  ws.on('message', (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg.result);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') console.log('console.error', msg.params.args.map((a) => a.value ?? a.description).join(' '));
    if (msg.method === 'Runtime.exceptionThrown') console.log('exception', msg.params.exceptionDetails.exception?.description);
  });
  const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://localhost:${vitePort}/tools/icons/code-models.html` });
  let res;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    res = await send('Runtime.evaluate', { expression: 'window.dump ? window.dump().then(JSON.stringify) : null', awaitPromise: true, returnByValue: true });
    if (res?.result?.value) break;
  }
  if (!res?.result?.value) throw new Error('no dump: ' + JSON.stringify(res).slice(0, 400));
  mkdirSync('tools/icons/out', { recursive: true });
  writeFileSync('tools/icons/out/code-models.json', res.result.value);
  const d = JSON.parse(res.result.value);
  for (const [k, v] of Object.entries(d)) console.log(k, v.mat.length, 'tris', v.mats.length, 'materials');
  ws.close();
} finally {
  chrome.kill();
  vite.kill();
}
