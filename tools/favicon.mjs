// Renders public/favicon.svg to the PNG icons, favicon.ico and the desktop app's icon, and public/landing.svg plus the title to the
// link-preview image (public/og.png), with headless Chrome. Run after changing either SVG:
//   node tools/favicon.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pub = new URL('../public/', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'favicon-'));

function shot(html, w, h, out) {
  const page = join(tmp, 'page.html');
  writeFileSync(page, `<!doctype html><style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:transparent}</style>${html}`);
  execFileSync(CHROME, ['--headless', '--mute-audio', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000',
    `--window-size=${w},${h}`, `--screenshot=${out}`, `file://${page}`], { stdio: 'ignore' });
}

const svg = readFileSync(join(pub, 'favicon.svg'), 'utf8');
const icon = (s, out, pad = 0) => shot(`<div style="width:${s}px;height:${s}px;padding:${pad}px;box-sizing:border-box">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div>`, s, s, out);
icon(32, join(tmp, 'ico32.png'));
icon(16, join(tmp, 'ico16.png'));
// Apple and Android mask the corners themselves: a full square, no transparent margin.
const square = svg.replace('<rect width="64" height="64" rx="12"/>', '<rect width="64" height="64"/>');
const full = (s, out) => shot(square.replace('<svg ', `<svg width="${s}" height="${s}" `), s, s, out);
full(180, join(pub, 'apple-touch-icon.png'));
full(192, join(pub, 'icon-192.png'));
full(512, join(pub, 'icon-512.png'));
// The desktop app (desktop/build/icon.png; electron-builder makes the .icns and .ico from it): on macOS's icon grid,
// an 824 px rounded square in the middle of 1024.
const app = svg.replace('rx="12"', 'rx="14.4"').replace('<svg ', '<svg width="100%" height="100%" ');
shot(`<div style="width:1024px;height:1024px;padding:100px;box-sizing:border-box">${app}</div>`, 1024, 1024,
  new URL('../desktop/build/icon.png', import.meta.url).pathname);

// favicon.ico with the 16 and 32 px PNGs inside (PNG-in-ICO, every browser since Vista reads it).
const imgs = [16, 32].map((s) => [s, readFileSync(join(tmp, `ico${s}.png`))]);
const head = Buffer.alloc(6 + 16 * imgs.length);
head.writeUInt16LE(1, 2); head.writeUInt16LE(imgs.length, 4);
let off = head.length;
imgs.forEach(([s, png], i) => {
  const e = 6 + 16 * i;
  head[e] = s; head[e + 1] = s; head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(off, e + 12);
  off += png.length;
});
writeFileSync(join(pub, 'favicon.ico'), Buffer.concat([head, ...imgs.map(([, png]) => png)]));

// Link preview, 1200×630: the landing backdrop with the title over it, as the landing page shows it.
const font = `file://${join(pub, 'fonts/neuropol.woff2')}`;
shot(`<style>@font-face{font-family:N;src:url(${font})}</style>
<div style="position:relative;width:1200px;height:630px;background:url(file://${join(pub, 'landing.svg')}) 72% bottom/cover">
<h1 style="position:absolute;inset:0;margin:0;display:flex;align-items:center;justify-content:center;padding-bottom:260px;
font:96px N;letter-spacing:.3em;color:#fff4d0;text-shadow:0 2px 6px rgba(60,20,5,.6)">PAAHDE</h1></div>`, 1200, 630, join(pub, 'og.png'));
console.log('wrote favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png, og.png, desktop/build/icon.png');
