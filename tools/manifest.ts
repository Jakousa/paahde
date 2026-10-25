// After `vite build`: dist/manifest.json, every file of the build with a hash of its content. The desktop app
// (desktop/update.mjs, docs/desktop.md) reads the server's copy to update itself, downloading only the files whose
// hash it doesn't have.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { TEXT } from '../shared/text.ts';

const DIST = 'dist';
// The desktop startup view uses the same centralized player-facing words as the browser game.
writeFileSync(join(DIST, 'desktop-text.json'), JSON.stringify(TEXT.desktop));

const files: Record<string, string> = {};
for (const d of readdirSync(DIST, { recursive: true, withFileTypes: true })) {
  if (!d.isFile() || /\.(br|gz)$/.test(d.name) || d.name === 'manifest.json') continue;
  const f = join(d.parentPath, d.name);
  files[relative(DIST, f).split(sep).join('/')] = createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 32);
}
const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
writeFileSync(join(DIST, 'manifest.json'), JSON.stringify({ build: process.env.BUILD_SHA ?? 'dev', files: sorted }));
