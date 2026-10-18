// New builds: a deploy restarts the server, every client reconnects and hears the build the server now serves
// ('version', shared/protocol.ts). A client from another build fetches the new page and its scripts in the
// background while the game runs on, waits for a quiet moment (not fighting, riding or taking a machine apart;
// at most MAX_WAIT_MS), fades to dark and reloads, so the reload comes out of the browser's cache.
// Position is kept server-side by browserId.

const MAX_WAIT_MS = 60_000;
const FADE_MS = 400;

/** Set by main.ts: true while a reload would interrupt something. */
export const update = { busy: () => false };

let pending: string | null = null;

/** The server serves `build`. Dev builds never reload, and each build is tried only once per tab in case a
 *  cache still hands us the old page. */
export function serverBuild(build: string) {
  if (build === __BUILD_SHA__ || build === 'dev' || __BUILD_SHA__ === 'dev' || pending === build) return;
  try {
    if (sessionStorage.getItem('reloadedFor') === build) return;
  } catch {
    return;
  }
  pending = build;
  void prefetch().finally(() => waitForQuiet(build, performance.now()));
}

/** Fetches the new index.html and the scripts it loads into the HTTP cache (hashed, cached for a year). */
async function prefetch() {
  try {
    const html = await (await fetch('./', { cache: 'no-cache' })).text();
    const urls = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    await Promise.all(urls.map((u) => fetch(u).then((r) => r.arrayBuffer())));
  } catch {
    // the reload loads them then
  }
}

function waitForQuiet(build: string, since: number) {
  if (pending !== build) return;
  if (update.busy() && performance.now() - since < MAX_WAIT_MS) {
    setTimeout(() => waitForQuiet(build, since), 1000);
    return;
  }
  try {
    sessionStorage.setItem('reloadedFor', build);
  } catch {
    return;
  }
  // The same dark cover the new page starts with (index.html), so the reload reads as one fade.
  const cover = document.createElement('div');
  cover.id = 'cover';
  cover.style.opacity = '0';
  cover.style.zIndex = '1000';
  document.body.append(cover);
  requestAnimationFrame(() => (cover.style.opacity = '1'));
  setTimeout(() => location.reload(), FADE_MS);
}
