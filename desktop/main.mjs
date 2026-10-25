// The desktop app (docs/desktop.md): the web build in an Electron window, the first step towards a Steam build.
// By default it serves the bundled dist/ from app://game/ and passes api/ to the game server, whose WebSocket the
// page dials itself (src/desktop.ts). --remote loads the page from the server instead, so it always matches the
// server's build.
import { app, BrowserWindow, net, protocol, shell } from 'electron';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Packaged: dist/ is copied into the app (package.json "build.extraResources"); from the checkout: ../dist.
const DIST = app.isPackaged ? path.join(process.resourcesPath, 'dist') : path.join(HERE, '..', 'dist');
const SERVER = withSlash(process.env.PAAHDE_SERVER ?? 'https://dev.paahde.herkku.org/');
const REMOTE = process.argv.includes('--remote');
// --shot=<file>: load, wait, save a screenshot and quit (a smoke test; docs/desktop.md).
const SHOT = process.argv.find((a) => a.startsWith('--shot='))?.slice(7);
// --open=<query>: the page with that query, e.g. --open=w=<id> for a world's lobby (what a Steam invite will open).
const QUERY = process.argv.find((a) => a.startsWith('--open='))?.slice(7);
const PAGE = `${REMOTE ? SERVER : 'app://game/'}${QUERY ? `?${QUERY}` : ''}`;

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
  protocol.handle('app', (req) => {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      return net.fetch(new URL(url.pathname.slice(1) + url.search, SERVER), {
        method: req.method,
        headers: req.headers,
        body: req.body,
        duplex: 'half',
      });
    }
    const file = path.join(DIST, path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ''));
    if (!file.startsWith(DIST)) return new Response('', { status: 403 });
    const isFile = statSync(file, { throwIfNoEntry: false })?.isFile();
    return net.fetch(pathToFileURL(isFile ? file : path.join(DIST, 'index.html')).href);
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
    if (!existsSync(path.join(DIST, 'index.html'))) {
      console.error(`No build at ${DIST}: run npm run build in the repo first (or start with --remote).`);
      app.exit(1);
      return;
    }
    serveApp();
  }
  open();
});

app.on('window-all-closed', () => app.quit());
