// The desktop app (docs/desktop.md): the web build in an Electron window, the first step towards a Steam build.
// By default it serves the game's files from app://game/ (the dist/ it shipped with, kept up to the server's build by
// update.mjs) and passes api/ to the game server, whose WebSocket the page dials itself (src/desktop.ts). --remote
// loads the page from the server instead, like a browser tab.
import { app, BrowserWindow, net, protocol, shell } from 'electron';
import { existsSync } from 'node:fs';
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

// A standard, secure scheme: the page gets a stable origin (so localStorage, and the browser ID in it, survives
// restarts), a secure context (WebGPU, pointer lock) and module workers.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function serveApp() {
  const game = gameFiles(DIST, SERVER);
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      return net.fetch(new URL(url.pathname.slice(1) + url.search, SERVER), {
        method: req.method,
        headers: req.headers,
        body: req.body,
        duplex: 'half',
      });
    }
    let file = decodeURIComponent(url.pathname).replace(/^\/+/, '');
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
    return new Response(res.body, { status: res.status, headers: { 'content-type': type } });
  });
}

function open() {
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
    },
  });
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
    win.webContents.once('did-finish-load', () => {
      if (process.env.SHOT_JS) setTimeout(() => void win.webContents.executeJavaScript(process.env.SHOT_JS), 1500);
    });
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        const { writeFile } = await import('node:fs/promises');
        await writeFile(SHOT, img.toPNG());
        app.exit(0); // (not quit: the game asks before unloading)
      }, Number(process.env.SHOT_WAIT_MS ?? 8000)),
    );
  }
  void win.loadURL(PAGE);
}

app.whenReady().then(() => {
  if (!REMOTE) {
    if (!existsSync(path.join(DIST, 'manifest.json'))) {
      console.error(`No build at ${DIST}: run npm run build in the repo first (or start with --remote).`);
      app.exit(1);
      return;
    }
    serveApp();
  }
  open();
});

app.on('window-all-closed', () => app.quit());
