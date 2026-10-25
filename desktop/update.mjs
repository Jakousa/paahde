// The game's files, kept up to date with the server's build without reinstalling the app (docs/desktop.md).
// dist/manifest.json (tools/manifest.ts) lists every file of a build with a hash of its content. Before the page
// loads, the app reads the server's manifest and downloads the files it has no copy of into a store by hash
// (userData/content); the rest come from the dist/ the app shipped with. Offline, the last build stays.
import { app, net } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PARALLEL = 6;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The game in `dist` (the shipped build), updated from `server`. */
export function gameFiles(dist, server) {
  const store = path.join(app.getPath('userData'), 'content');
  const current = path.join(app.getPath('userData'), 'manifest.json');
  const shipped = readJson(path.join(dist, 'manifest.json')) ?? { build: 'unknown', files: {} };
  const shippedByHash = new Map(Object.entries(shipped.files).map(([file, hash]) => [hash, file]));

  /** Where the file with this hash is on disk, or null. */
  const fileFor = (hash) => {
    const kept = path.join(store, hash);
    if (existsSync(kept)) return kept;
    const file = shippedByHash.get(hash);
    return file ? path.join(dist, file) : null;
  };
  const complete = (m) => Object.values(m.files).every(fileFor);

  const saved = readJson(current);
  let active = saved && complete(saved) ? saved : shipped;
  // The build before an update while the game runs: the running page may still load its files until it reloads.
  let previous = null;
  let checking = null;

  async function download(file, hash) {
    const res = await net.fetch(new URL(file.split('/').map(encodeURIComponent).join('/'), server).href, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    // Another deploy between the manifest and this file: give up, the next load tries again.
    if (createHash('sha256').update(data).digest('hex').slice(0, 32) !== hash) throw new Error(`${file}: changed while updating`);
    const tmp = path.join(store, `${hash}.part`);
    writeFileSync(tmp, data);
    renameSync(tmp, path.join(store, hash));
  }

  async function check() {
    const res = await net.fetch(new URL('manifest.json', server).href, { cache: 'no-store' });
    if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
    const next = await res.json();
    if (JSON.stringify(next.files) === JSON.stringify(active.files)) return;
    const missing = new Map();
    for (const [file, hash] of Object.entries(next.files)) if (!fileFor(hash)) missing.set(hash, file);
    console.log(`Updating ${active.build} → ${next.build}: ${missing.size} files`);
    mkdirSync(store, { recursive: true });
    const queue = [...missing];
    await Promise.all(
      Array.from({ length: PARALLEL }, async () => {
        for (let job; (job = queue.shift()); ) await download(job[1], job[0]);
      }),
    );
    previous = active;
    active = next;
    writeFileSync(current, JSON.stringify(next));
    // Drop what neither build needs (the shipped files never go in the store).
    const used = new Set([...Object.values(next.files), ...Object.values(previous.files)]);
    for (const name of readdirSync(store)) if (!used.has(name)) rmSync(path.join(store, name), { force: true });
  }

  return {
    /** Brings the files up to the server's build; a failure (offline, a deploy mid-update) keeps the current one. */
    update() {
      checking ??= check()
        .catch((e) => console.warn(`Update failed, staying on ${active.build}: ${e.message}`))
        .finally(() => (checking = null));
      return checking;
    },
    /** The file on disk for a path of the page ('assets/x.js'), or null. */
    path(file) {
      const hash = active.files[file] ?? previous?.files[file];
      return hash ? fileFor(hash) : null;
    },
  };
}
