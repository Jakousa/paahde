// Electron-independent content store: validate, bound, verify, then atomically activate complete builds.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const HASH = /^[a-f0-9]{32}$/;
const MAX_FILE = 64 * 1024 * 1024;
export function safeContentPath(file) {
  return typeof file === 'string' && file.length > 0 && file.length <= 512 &&
    !/[\\\x00-\x1f?#:%]/.test(file) && !file.startsWith('/') &&
    file.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}
export function validateManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.build !== 'string' || m.build.length > 128 ||
      !m.files || typeof m.files !== 'object' || Array.isArray(m.files)) throw new Error('Invalid content manifest');
  const files = Object.entries(m.files);
  if (files.length > 5000 || !Object.hasOwn(m.files, 'index.html') || !files.some(([f]) => f.endsWith('.js'))) throw new Error('Incomplete content manifest');
  for (const [file, hash] of files) if (!safeContentPath(file) || typeof hash !== 'string' || !HASH.test(hash)) throw new Error('Invalid content entry');
  return { build: m.build, files: Object.fromEntries(files) };
}
function readManifest(file) {
  try {
    if (statSync(file).size > 2 * 1024 * 1024) return null;
    return validateManifest(JSON.parse(readFileSync(file, 'utf8')));
  } catch { return null; }
}
const hashOf = (data) => createHash('sha256').update(data).digest('hex').slice(0, 32);

export function contentStore({ dist, userData, server, fetchFile = fetch, progress = () => {}, timeoutMs = 120_000, requestMs = 15_000 }) {
  const store = path.join(userData, 'content'), current = path.join(userData, 'manifest.json');
  const shipped = readManifest(path.join(dist, 'manifest.json'));
  if (!shipped) throw new Error('Invalid shipped content manifest');
  const shippedByHash = new Map(Object.entries(shipped.files).map(([file, hash]) => [hash, file]));
  const verified = new Map();
  function validFile(file, hash) {
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > MAX_FILE) return false;
      const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
      if (verified.get(file) === key) return true;
      if (hashOf(readFileSync(file)) !== hash) return false;
      verified.set(file, key);
      return true;
    } catch { return false; }
  }
  function fileFor(hash) {
    if (!HASH.test(hash)) return null;
    const kept = path.join(store, hash);
    if (validFile(kept, hash)) return kept;
    const file = shippedByHash.get(hash), disk = file && path.join(dist, file);
    return disk && validFile(disk, hash) ? disk : null;
  }
  const saved = readManifest(current);
  let active = saved && Object.values(saved.files).every(fileFor) ? saved : shipped;
  let previous = null, checking = null;
  async function bytes(file, limit, signal) {
    const address = new URL(file.split('/').map(encodeURIComponent).join('/'), server).href;
    const res = await fetchFile(address, { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(requestMs)]) });
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    if (Number(res.headers.get('content-length')) > limit) { await res.body?.cancel(); throw new Error(`${file}: too large`); }
    const reader = res.body?.getReader();
    if (!reader) throw new Error(`${file}: empty response`);
    let length = 0;
    const chunks = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > limit) throw new Error(`${file}: too large`);
        chunks.push(value);
      }
    } catch (e) { await reader.cancel().catch(() => {}); throw e; }
    return Buffer.concat(chunks, length);
  }
  async function check() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      progress({ phase: 'checking', done: 0, total: 0 });
      const next = validateManifest(JSON.parse((await bytes('manifest.json', 2 * 1024 * 1024, controller.signal)).toString('utf8')));
      if (JSON.stringify(next.files) === JSON.stringify(active.files) && Object.values(next.files).every(fileFor)) return;
      const missing = new Map();
      for (const [file, hash] of Object.entries(next.files)) if (!fileFor(hash)) missing.set(hash, file);
      mkdirSync(store, { recursive: true });
      const queue = [...missing];
      let done = 0, downloaded = 0;
      progress({ phase: 'downloading', done, total: queue.length });
      await Promise.all(Array.from({ length: 6 }, async () => {
        for (let job; !controller.signal.aborted && (job = queue.shift()); ) {
          const [hash, file] = job;
          let data;
          for (let attempt = 0; attempt < 2; attempt++) {
            try { data = await bytes(file, MAX_FILE, controller.signal); break; }
            catch (e) { if (attempt || controller.signal.aborted) throw e; }
          }
          if (hashOf(data) !== hash) throw new Error(`${file}: changed while updating`);
          downloaded += data.length;
          if (downloaded > 512 * 1024 * 1024) throw new Error('Content update too large');
          const tmp = path.join(store, `${hash}.part`);
          writeFileSync(tmp, data);
          renameSync(tmp, path.join(store, hash));
          progress({ phase: 'downloading', done: ++done, total: missing.size });
        }
      }));
      if (controller.signal.aborted || !Object.values(next.files).every(fileFor)) throw new Error('Incomplete content update');
      const temp = `${current}.part`;
      writeFileSync(temp, JSON.stringify(next));
      renameSync(temp, current);
      previous = active;
      active = next;
      const used = new Set([...Object.values(active.files), ...Object.values(previous.files)]);
      for (const name of readdirSync(store)) if (HASH.test(name) && !used.has(name)) {
        rmSync(path.join(store, name), { force: true });
        verified.delete(path.join(store, name));
      }
    } finally { clearTimeout(timer); controller.abort(); }
  }
  return {
    update() {
      checking ??= check().catch((e) => console.warn(`Update failed, staying on ${active.build}: ${e.message}`))
        .finally(() => { progress({ phase: 'ready', done: 0, total: 0 }); checking = null; });
      return checking;
    },
    path(file) {
      if (!safeContentPath(file)) return null;
      const hash = (Object.hasOwn(active.files, file) && active.files[file]) || (previous && Object.hasOwn(previous.files, file) && previous.files[file]);
      return hash ? fileFor(hash) : null;
    },
  };
}
