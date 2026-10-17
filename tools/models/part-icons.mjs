// Renders the inventory icons of the code-built parts (tools/models/part-icons.ts) in headless Chrome and saves
// them as public/icons/items/<part>_<tier>.png, plus a contact sheet.
//   npx vite --port 5391 &   (any dev server of this checkout)
//   node tools/models/part-icons.mjs [http://localhost:5391/tools/models/part-icons.html] [sheet.png]
// Kills only the Chrome it started.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [url = 'http://localhost:5391/tools/models/part-icons.html', sheet] = process.argv.slice(2);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'icons-'))}`,
  '--window-size=800,800', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal',
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
  await send('Page.navigate', { url });
  let icons = null;
  for (let i = 0; i < 120 && !icons; i++) {
    await sleep(500);
    const r = await send('Runtime.evaluate', { expression: 'window.icons ?? null', returnByValue: true });
    icons = r?.result?.value ?? null;
  }
  if (!icons) throw new Error('no icons after 60 s');
  for (const [name, data] of Object.entries(icons)) {
    const file = join(ROOT, 'public', 'icons', 'items', `${name}.png`);
    writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
    console.log('saved', file);
  }
  if (sheet) {
    await send('Emulation.setDeviceMetricsOverride', { width: 560, height: 700, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(sheet, Buffer.from(shot.data, 'base64'));
    console.log('saved', sheet);
  }
  ws.close();
} finally {
  chrome.kill();
}
