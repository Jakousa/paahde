// Stall tracing (docs/netcode.md "Telemetry"): one JSON line per event in TELEMETRY_PATH (next to the database, so
// it outlives redeploys), written in the background. Events come from clients ('telemetry', src/telemetry.ts: stalls
// they saw and a summary a minute) and from the world itself: a late tick (the event loop was blocked) and a player
// whose sends are piling up (TCP can't get them out).
import { appendFile, renameSync, statSync } from 'node:fs';
import { WORLD_ID } from '../shared/world.ts';

const PATH = process.env.TELEMETRY_PATH ?? 'data/telemetry.jsonl';
/** Past this size the file becomes `.1` (the one before is dropped). */
const MAX_BYTES = 20 * 1024 * 1024;

let size = (() => {
  try {
    return statSync(PATH).size;
  } catch {
    return 0;
  }
})();
let queue: string[] = [];
let writing = false;

/** Log an event (`kind` and its fields) with the world and when it happened (Unix ms, default now). */
export function trace(kind: string, fields: Record<string, unknown>, at = Date.now()) {
  queue.push(JSON.stringify({ at: new Date(at).toISOString(), w: WORLD_ID, kind, ...fields }) + '\n');
  if (!writing) flush();
}

function flush() {
  const text = queue.join('');
  queue = [];
  if (!text) return void (writing = false);
  writing = true;
  if (size > MAX_BYTES) {
    try {
      renameSync(PATH, `${PATH}.1`);
    } catch {}
    size = 0;
  }
  size += text.length;
  appendFile(PATH, text, () => flush());
}
