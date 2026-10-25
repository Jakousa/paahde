import type { WebSocket } from 'ws';

/** Obsolete poses may be skipped; reliable world changes remain ordered, or the connection resynchronizes. */
export const SOFT_BACKLOG_BYTES = 64 * 1024;
export const MAX_BACKLOG_BYTES = 1024 * 1024;

export function sendJson(ws: WebSocket, json: string, volatile = false): boolean {
  if (ws.readyState !== ws.OPEN) return false;
  if (ws.bufferedAmount + Buffer.byteLength(json) > MAX_BACKLOG_BYTES) {
    ws.close(1013, 'connection too slow; resync');
    const timer = setTimeout(() => ws.terminate(), 1000);
    timer.unref();
    return false;
  }
  if (volatile && ws.bufferedAmount > SOFT_BACKLOG_BYTES) return false;
  ws.send(json);
  return true;
}


/** Terrain baselines can be much larger than a socket's budget. Encode/send them incrementally, yielding
 *  between batches and waiting for the transport to drain. Live absolute edits/heals may interleave: a
 *  generator must read each chunk's current values when yielding it, not retain an old encoded snapshot. */
export async function sendStream(ws: WebSocket, messages: Iterable<unknown>): Promise<boolean> {
  let batch = 0;
  const iterator = messages[Symbol.iterator]();
  try {
    for (;;) {
      while (ws.readyState === ws.OPEN && ws.bufferedAmount > SOFT_BACKLOG_BYTES) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (ws.readyState !== ws.OPEN) return false;
      const next = iterator.next();
      if (next.done) return true;
      if (!sendJson(ws, JSON.stringify(next.value))) return false;
      if (++batch % 4 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    iterator.return?.();
  }
}
