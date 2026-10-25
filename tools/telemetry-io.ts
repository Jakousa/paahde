// Bounded local telemetry reads. File names may disappear/reappear while a world rotates its log.
import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync, type Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const BLOCK_BYTES = 64 * 1024;
export const REPORT_BYTES = 16 * 1024 * 1024;
export const TAIL_FILES = 64;
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
const identity = (s: Stats) => `${s.dev}:${s.ino}`;

/** Newest files first; a selected world still includes legacy shared logs (filtered by event later). */
export function telemetryFiles(base: string, world?: string): string[] {
  const dir = dirname(base), name = basename(base), stem = name.replace(/\.jsonl$/, '');
  let names: string[];
  try { names = readdirSync(dir); } catch (error) { if (missing(error)) return []; throw error; }
  const out: { file: string; at: number }[] = [];
  for (const f of names) {
    const own = world ? f === `${stem}.${world}.jsonl` || f === `${stem}.${world}.jsonl.1`
      : f.startsWith(`${stem}.`) && /\.jsonl(?:\.1)?$/.test(f);
    if (f !== name && f !== `${name}.1` && !own) continue;
    const file = join(dir, f);
    try { const s = statSync(file); if (s.isFile()) out.push({ file, at: s.mtimeMs }); }
    catch (error) { if (!missing(error)) throw error; }
  }
  return out.sort((a, b) => b.at - a.at || a.file.localeCompare(b.file)).map((o) => o.file);
}

function openLog(file: string): { fd: number; stat: Stats } | null {
  let fd: number | undefined;
  try { fd = openSync(file, 'r'); return { fd, stat: fstatSync(fd) }; }
  catch (error) { if (fd !== undefined) closeSync(fd); if (missing(error)) return null; throw error; }
}

export type ReadBudget = { remaining: number; truncated: boolean };

/** Read newest file tails up to one shared byte budget, yielding complete lines without concatenating files. */
export function* telemetryLines(files: string[], budget: ReadBudget): Generator<string> {
  const bytes = Buffer.alloc(BLOCK_BYTES);
  for (const file of files) {
    const log = openLog(file);
    if (!log) continue;
    try {
      const end = log.stat.size;
      const start = Math.max(0, end - budget.remaining);
      if (start > 0) budget.truncated = true;
      if (!budget.remaining) { if (end) budget.truncated = true; continue; }
      let at = start, rest = '', skip = start > 0;
      const decoder = new StringDecoder('utf8');
      while (at < end && budget.remaining > 0) {
        const n = readSync(log.fd, bytes, 0, Math.min(bytes.length, end - at, budget.remaining), at);
        if (!n) break;
        at += n; budget.remaining -= n;
        rest += decoder.write(bytes.subarray(0, n));
        let cut: number;
        while ((cut = rest.indexOf('\n')) >= 0) {
          const line = rest.slice(0, cut); rest = rest.slice(cut + 1);
          if (skip) skip = false; else yield line;
        }
      }
      // An unfinished final append is ignored by reports, never treated as a complete event.
    } finally { closeSync(log.fd); }
  }
}

type Cursor = { id: string; offset: number; rest: string; skip: boolean; decoder: StringDecoder };
const cursor = (stat: Stats, offset = 0): Cursor => ({ id: identity(stat), offset, rest: '', skip: offset > 0, decoder: new StringDecoder('utf8') });

/** Keep byte offsets and partial UTF-8/JSON lines, recover the unread old tail after rotation, and discover new files.
 *  Each poll reads at most 64 KiB per file; callers cap the selected active file set with TAIL_FILES. */
export class TelemetryTail {
  private cursors = new Map<string, Cursor>();
  private bytes = Buffer.alloc(BLOCK_BYTES);

  poll(files: string[]): string[] {
    const lines: string[] = [], keep = new Set(files);
    for (const file of this.cursors.keys()) if (!keep.has(file)) this.cursors.delete(file);
    for (const file of files) {
      let state = this.cursors.get(file);
      const log = openLog(file);
      if (!log) {
        if (state) this.oldTail(file, state, lines);
        continue;
      }
      try {
        if (state && state.id !== identity(log.stat)) {
          if (!this.oldTail(file, state, lines)) continue;
          state = cursor(log.stat);
        }
        if (!state) state = cursor(log.stat, Math.max(0, log.stat.size - BLOCK_BYTES));
        if (state.offset > log.stat.size) state = cursor(log.stat); // in-place truncation
        this.cursors.set(file, state);
        this.consume(log, state, lines);
      } finally { closeSync(log.fd); }
    }
    return lines;
  }

  private oldTail(file: string, state: Cursor, lines: string[]): boolean {
    const old = openLog(`${file}.1`);
    if (!old) return true;
    try { return identity(old.stat) !== state.id || this.consume(old, state, lines); }
    finally { closeSync(old.fd); }
  }

  private consume(log: { fd: number; stat: Stats }, state: Cursor, lines: string[]): boolean {
    const n = readSync(log.fd, this.bytes, 0, Math.min(this.bytes.length, Math.max(0, log.stat.size - state.offset)), state.offset);
    state.offset += n;
    state.rest += state.decoder.write(this.bytes.subarray(0, n));
    let cut: number;
    while ((cut = state.rest.indexOf('\n')) >= 0) {
      const line = state.rest.slice(0, cut); state.rest = state.rest.slice(cut + 1);
      if (state.skip) state.skip = false; else lines.push(line);
    }
    // Malformed local data cannot turn a missing newline into unlimited memory growth.
    if (state.rest.length > BLOCK_BYTES) { state.rest = ''; state.skip = true; }
    return state.offset >= log.stat.size;
  }
}
