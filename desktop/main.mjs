// The desktop app (docs/desktop.md): the web build in an Electron window, the first step towards a Steam build.
// By default it serves the game's files from app://game/ (the dist/ it shipped with, kept up to the server's build by
// update.mjs) and passes api/ to the game server, whose WebSocket the page dials itself (src/desktop.ts). --remote
// loads the page from the server instead, like a browser tab.
import { app, BrowserWindow, net, protocol, shell } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gameFiles } from './update.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Packaged: dist/ is copied into the app (package.json "build.extraResources"); from the checkout: ../dist.
const DIST = app.isPackaged ? path.join(process.resourcesPath, 'dist') : path.join(HERE, '..', 'dist');
const SERVER = withSlash(process.env.PAAHDE_SERVER ?? 'https://dev.paahde.herkku.org/');
const REMOTE = process.argv.includes('--remote');
// --shot=<file>: load, wait, save a screenshot and quit (a smoke test; docs/desktop.md).
const SHOT = process.argv.find((a) => a.startsWith('--shot='))?.slice(7);
// --open=<query>: the page with that query, e.g. --open=w=<id> for a world's lobby (what a Steam invite will open).
const QUERY = process.argv.find((a) => a.startsWith('--open='))?.slice(7);
// --profile=<name>: separate saved data (browser ID, downloaded builds): a second player on one machine, or a test.
const PROFILE = process.argv.find((a) => a.startsWith('--profile='))?.slice(10);
if (PROFILE) app.setPath('userData', `${app.getPath('userData')}-${PROFILE}`);
const PAGE = `${REMOTE ? SERVER : 'app://game/'}${QUERY ? `?${QUERY}` : ''}`;

// Downloaded files are stored by hash, without their extension, so the type comes from the page's path (a file://
// fetch would guess from the name on disk and serve an updated index.html as text).
const TYPES = {
  html: 'text/html',
  js: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  ico: 'image/x-icon',
  glb: 'model/gltf-binary',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  woff2: 'font/woff2',
  txt: 'text/plain',
};

function withSlash(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

function gameAddress(value) {
  try {
    const url = new URL(value), server = new URL(SERVER);
    return REMOTE ? url.origin === server.origin && url.pathname.startsWith(server.pathname) : url.protocol === 'app:' && url.host === 'game';
  } catch { return false; }
}

let loadingWindow = null;
let bootstrapping = false;
function showProgress(state) {
  const win = loadingWindow;
  if (!win || win.isDestroyed()) return;
  win.setProgressBar(state.phase === 'ready' ? -1 : state.total ? state.done / state.total : 2);
  if (bootstrapping) void win.webContents.executeJavaScript(`window.progress?.(${JSON.stringify(state)})`).catch(() => {});
}

// A standard, secure scheme: the page gets a stable origin (so localStorage, and the browser ID in it, survives
// restarts), a secure context (WebGPU, pointer lock) and module workers.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function serveApp() {
  const game = gameFiles(DIST, SERVER, showProgress);
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    if (url.host !== 'game') return new Response('', { status: 403 });
    if (url.pathname.startsWith('/api/')) {
      return net.fetch(new URL(url.pathname.slice(1) + url.search, SERVER), {
        method: req.method,
        headers: req.headers,
        body: req.body,
        duplex: 'half',
      });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('', { status: 405 });
    let file;
    try { file = decodeURIComponent(url.pathname).replace(/^\/+/, ''); }
    catch { return new Response('', { status: 400 }); }
    // The page: on every start, and when src/update.ts reloads into the server's new build (it fetches the page
    // first, so the download happens while the game still runs). The page's other files are then of the same build.
    if (file === '' || file === 'index.html') {
      await game.update();
      file = 'index.html';
    }
    const disk = game.path(file);
    if (!disk) return new Response('', { status: 404 });
    const res = await net.fetch(pathToFileURL(disk).href);
    const type = TYPES[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
    const serverOrigin = new URL(SERVER).origin;
    const socketOrigin = serverOrigin.replace(/^http/, 'ws');
    return new Response(res.body, { status: res.status, headers: {
      'content-type': type,
      'content-security-policy': `default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' ${serverOrigin} ${socketOrigin}; object-src 'none'; base-uri 'self'`,
    } });
  });
  return game;
}

async function open(game) {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    backgroundColor: '#1a1214',
    autoHideMenuBar: true,
    show: !SHOT,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      additionalArguments: [`--paahde-server=${REMOTE ? '' : SERVER}`],
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  loadingWindow = win;
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === win.webContents && gameAddress(details.requestingUrl) && (permission === 'pointerLock' || permission === 'fullscreen'));
  });
  win.webContents.session.setPermissionCheckHandler((contents, permission, origin) =>
    contents === win.webContents && gameAddress(origin) && (permission === 'pointerLock' || permission === 'fullscreen'));
  win.webContents.on('will-navigate', (event, url) => { if (!gameAddress(url)) event.preventDefault(); });
  win.webContents.on('will-redirect', (event, url) => { if (!gameAddress(url)) event.preventDefault(); });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  // Links out of the game (credits, ...) open in the player's browser, not in the game's window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    }
  });
  if (SHOT) {
    win.webContents.on('console-message', (e) => console.log(`[page ${e.level}] ${e.message}`));
    // SHOT_JS: script to run in the page once loaded (fill in a name, press Join, ...).
    win.webContents.on('did-finish-load', () => {
      if (win.webContents.getURL() !== PAGE) return;
      if (process.env.SHOT_JS) setTimeout(() => void win.webContents.executeJavaScript(process.env.SHOT_JS), 1500);
    });
    win.webContents.on('did-finish-load', () => {
      if (win.webContents.getURL() !== PAGE) return;
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        const { writeFile } = await import('node:fs/promises');
        await writeFile(SHOT, img.toPNG());
        app.exit(0); // (not quit: the game asks before unloading)
      }, Number(process.env.SHOT_WAIT_MS ?? 8000));
    });
  }
  if (game) {
    const words = JSON.parse(readFileSync(path.join(DIST, 'desktop-text.json'), 'utf8'));
    const labels = JSON.stringify(words).replaceAll('<', '\\u003c');
    const nonce = randomBytes(16).toString('base64');
    bootstrapping = true;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
      body{margin:0;background:#1a1214;color:#fff0db;display:grid;place-content:center;height:100vh;font:16px system-ui;text-align:center}
      progress{width:260px;accent-color:#d7b16b;margin-top:18px}</style><div id="status"></div><progress></progress><script nonce="${nonce}">
      const words=${labels}; window.progress=s=>{document.getElementById('status').textContent=words[s.phase];
      const p=document.querySelector('progress');if(s.total){p.max=s.total;p.value=s.done}else p.removeAttribute('value')};progress({phase:'checking'});
      </script>`)}`);
    await game.update();
    bootstrapping = false;
  }
  await win.loadURL(PAGE);
}

app.whenReady().then(() => {
  let game;
  if (!REMOTE) {
    if (!existsSync(path.join(DIST, 'manifest.json'))) {
      console.error(`No build at ${DIST}: run npm run build in the repo first (or start with --remote).`);
      app.exit(1);
      return;
    }
    game = serveApp();
  }
  void open(game);
});

app.on('window-all-closed', () => app.quit());
