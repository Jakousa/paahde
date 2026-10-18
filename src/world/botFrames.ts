// Guardians and drones between server updates ('bots', ~10 Hz, shared/guardians.ts): drawn BOT_DELAY_MS in the
// past and interpolated between the two messages around that time, like remote players (src/net.ts).
import type { ServerMsg } from '../../shared/protocol.ts';
import { CRAWLER, GUARDIAN, type Kind } from '../../shared/guardians.ts';

type BotsMsg = Extract<ServerMsg, { t: 'bots' }>;

/** How far behind the server clock (ms) they're drawn: two updates and some jitter. */
export const BOT_DELAY_MS = 250;
export const G_STRIDE = 13;
export const D_STRIDE = 12;

/** gun: -1 idle, 0 aiming at (ax, ay, az), 1 charging. broken: weak points shot (bit mask, shared/rifle.ts); dead: 0
 *  alive, else seconds since it died. */
export type GuardianFrame = {
  id: number; kind: Kind; legs: 3 | 4; x: number; z: number; yaw: number; hunt: number; ax: number; ay: number; az: number; gun: number;
  broken: number; dead: number;
};
/** hurt: rifle hits taken; down: 0 flying, else seconds since it was shot down; jammed: brought down by a jammer. */
export type DroneFrame = { id: number; x: number; y: number; z: number; yaw: number; dx: number; dy: number; dz: number; lock: number; hurt: number; down: number; jammed: boolean };

const lerpAngle = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

function index(arr: number[], stride: number) {
  const m = new Map<number, number>();
  for (let i = 0; i < arr.length; i += stride) m.set(arr[i], i);
  return m;
}

/** The two messages around `time` and how far between them (both the latest when it's past the end). */
function around(msgs: readonly BotsMsg[], time: number): [BotsMsg, BotsMsg, number] | null {
  if (!msgs.length) return null;
  for (let i = msgs.length - 1; i > 0; i--) {
    const a = msgs[i - 1], b = msgs[i];
    if (a.time <= time) return [a, b, Math.min(1, Math.max(0, (time - a.time) / Math.max(1, b.time - a.time)))];
  }
  return [msgs[0], msgs[0], 0];
}

export function guardiansAt(msgs: readonly BotsMsg[], time: number): GuardianFrame[] {
  const ab = around(msgs, time);
  if (!ab) return [];
  const [a, b, t] = ab;
  const ia = index(a.g, G_STRIDE), out: GuardianFrame[] = [];
  for (let j = 0; j < b.g.length; j += G_STRIDE) {
    const g = b.g, i = ia.get(g[j]);
    const p = i === undefined ? g : a.g, k = i === undefined ? j : i;
    out.push({
      id: g[j], kind: g[j + 1] === CRAWLER ? CRAWLER : GUARDIAN, legs: g[j + 2] === 3 ? 3 : 4,
      x: p[k + 3] + (g[j + 3] - p[k + 3]) * t, z: p[k + 4] + (g[j + 4] - p[k + 4]) * t,
      yaw: lerpAngle(p[k + 5], g[j + 5], t), hunt: g[j + 6],
      // The aim point only blends while it aims in both.
      ax: p[k + 10] >= 0 ? p[k + 7] + (g[j + 7] - p[k + 7]) * t : g[j + 7],
      ay: p[k + 10] >= 0 ? p[k + 8] + (g[j + 8] - p[k + 8]) * t : g[j + 8],
      az: p[k + 10] >= 0 ? p[k + 9] + (g[j + 9] - p[k + 9]) * t : g[j + 9],
      gun: g[j + 10], broken: g[j + 11], dead: g[j + 12],
    });
  }
  return out;
}

export function dronesAt(msgs: readonly BotsMsg[], time: number): DroneFrame[] {
  const ab = around(msgs, time);
  if (!ab) return [];
  const [a, b, t] = ab;
  const ia = index(a.d, D_STRIDE), out: DroneFrame[] = [];
  for (let j = 0; j < b.d.length; j += D_STRIDE) {
    const d = b.d, i = ia.get(d[j]);
    const p = i === undefined ? d : a.d, k = i === undefined ? j : i;
    const l = (n: number) => p[k + n] + (d[j + n] - p[k + n]) * t;
    const dx = l(5), dy = l(6), dz = l(7), len = Math.hypot(dx, dy, dz) || 1;
    out.push({ id: d[j], x: l(1), y: l(2), z: l(3), yaw: lerpAngle(p[k + 4], d[j + 4], t), dx: dx / len, dy: dy / len, dz: dz / len, lock: d[j + 8], hurt: d[j + 9], down: d[j + 10], jammed: d[j + 11] === 1 });
  }
  return out;
}
