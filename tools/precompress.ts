// After `vite build`: write .br and .gz copies of the compressible files in dist/ (sirv serves them to browsers
// that accept them, server/index.ts), then give every file a modification time derived from its content.
// sirv's ETag is size + mtime, and a deploy rebuilds every file with a new mtime, so without this every
// deploy made browsers download all the models again even when they had not changed.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const DIST = 'dist';
const COMPRESS = /\.(js|css|html|glb|json|svg|txt|wasm|bin)$/;
const EPOCH = Date.UTC(2020, 0, 1) / 1000;
const SPAN = 5 * 365 * 86400; // stays in the past

const files = readdirSync(DIST, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile() && !/\.(br|gz)$/.test(d.name))
  .map((d) => join(d.parentPath, d.name));
for (const f of files) {
  if (!COMPRESS.test(f)) continue;
  const data = readFileSync(f);
  const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
  const gz = gzipSync(data, { level: 9 });
  // Not worth it for already-compressed data (textures embedded in a .glb).
  if (br.length < data.length * 0.9) writeFileSync(f + '.br', br);
  if (gz.length < data.length * 0.9) writeFileSync(f + '.gz', gz);
}
for (const d of readdirSync(DIST, { recursive: true, withFileTypes: true })) {
  if (!d.isFile()) continue;
  const f = join(d.parentPath, d.name);
  const t = EPOCH + (createHash('sha1').update(readFileSync(f)).digest().readUInt32BE(0) % SPAN);
  utimesSync(f, t, t);
}
