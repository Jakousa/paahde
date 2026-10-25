// SQLite's online backup API includes committed WAL contents; copying a live .db alone does not.
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function backupData(source, destination) {
  source = realpathSync(source); destination = resolve(destination);
  if (existsSync(destination)) throw new Error('Choose a new backup directory');
  // Resolve an existing ancestor before creating parents: a symlink must not put backups inside live data.
  let ancestor = dirname(destination);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  destination = resolve(realpathSync(ancestor), relative(ancestor, destination));
  if (destination === source || destination.startsWith(`${source}${sep}`)) throw new Error('Backup must be outside the live data directory');
  const files = readdirSync(source, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.db')).map((d) => join(d.parentPath, d.name));
  if (!files.length) throw new Error('No SQLite databases found');
  mkdirSync(dirname(destination), { recursive: true });
  destination = join(realpathSync(dirname(destination)), basename(destination));
  if (destination === source || destination.startsWith(`${source}${sep}`)) throw new Error('Backup must be outside the live data directory');
  mkdirSync(destination, { mode: 0o700 }); // Exclusive: concurrent backups must never share a destination.
  const manifest = { created: new Date().toISOString(), complete: false, files: [] };
  for (const file of files) {
    const name = relative(source, file), target = join(destination, name);
    mkdirSync(dirname(target), { recursive: true });
    const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
    try { await backup(db, `${target}.part`, { rate: 128 }); } finally { db.close(); }
    const check = new DatabaseSync(`${target}.part`, { readOnly: true });
    try {
      const result = check.prepare('PRAGMA quick_check').all();
      if (!result.every((r) => Object.values(r)[0] === 'ok')) throw new Error(`Integrity check failed: ${name}`);
    } finally { check.close(); }
    renameSync(`${target}.part`, target);
    manifest.files.push({ file: name, bytes: statSync(target).size, sha256: hashFile(target) });
  }
  manifest.complete = true;
  writeFileSync(join(destination, 'backup.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function verifyBackup(directory) {
  directory = resolve(directory);
  const manifest = JSON.parse(readFileSync(join(directory, 'backup.json'), 'utf8'));
  if (!manifest.complete || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Incomplete backup');
  for (const entry of manifest.files) {
    if (typeof entry.file !== 'string' || !entry.file.endsWith('.db') || entry.file.split(/[\\/]/).some((p) => p === '..') || resolve(directory, entry.file) === directory || !resolve(directory, entry.file).startsWith(`${directory}/`)) throw new Error('Invalid backup path');
    const file = join(directory, entry.file);
    if (statSync(file).size !== entry.bytes || hashFile(file) !== entry.sha256) throw new Error(`Backup hash mismatch: ${entry.file}`);
    const db = new DatabaseSync(file, { readOnly: true });
    try { if (!db.prepare('PRAGMA quick_check').all().every((r) => Object.values(r)[0] === 'ok')) throw new Error(`Backup integrity: ${entry.file}`); }
    finally { db.close(); }
  }
  return manifest;
}

function hashFile(file) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = openSync(file, 'r');
  try {
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      hash.update(buffer.subarray(0, n));
    }
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , command, source, destination] = process.argv;
  if (command === 'create' && source && destination) console.log(JSON.stringify(await backupData(source, destination), null, 2));
  else if (command === 'verify' && source) console.log(JSON.stringify(verifyBackup(source), null, 2));
  else throw new Error('Usage: node tools/db-backup.mjs create <data-dir> <new-backup-dir> | verify <backup-dir>');
}
