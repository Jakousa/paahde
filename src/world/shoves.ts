// Our own hits' knockback (shared/knockback.ts), shown at once. The server moves what's knocked, but walkers and drones
// are drawn BOT_DELAY_MS in the past (src/world/botFrames.ts), so our hit would be seen to shove it only that much
// later. Until the frames catch up, each is drawn as far along as the knock has carried it now, less what the delayed
// frames already show: knockOffset(t) - knockOffset(t - delay), which goes back to 0 as they arrive.
import { knockOffset } from '../../shared/knockback.ts';
import { BOT_DELAY_MS } from './botFrames';

type Shove = { at: number; v: number; dx: number; dy: number; dz: number };

/** How long one is kept (s past the delay): by then it's all in the frames. */
const KEEP_S = 1.5;

export class Shoves {
  private list = new Map<number, Shove[]>();

  /** Thing `id` knocked at `v` m/s along unit (dx, dy, dz), now. */
  add(id: number, v: number, dx: number, dy: number, dz: number) {
    if (!v) return;
    const s = this.list.get(id) ?? [];
    s.push({ at: performance.now() / 1000, v, dx, dy, dz });
    this.list.set(id, s);
  }

  /** Move frame `f` (as interpolated for drawing) by our shoves of it still on their way. */
  apply(f: { id: number; x: number; y?: number; z: number }) {
    const s = this.list.get(f.id);
    if (!s) return;
    const now = performance.now() / 1000, delay = BOT_DELAY_MS / 1000;
    for (let i = s.length - 1; i >= 0; i--) {
      const t = now - s[i].at;
      if (t > delay + KEEP_S) {
        s.splice(i, 1);
        continue;
      }
      const o = knockOffset(s[i].v, t) - knockOffset(s[i].v, t - delay);
      f.x += s[i].dx * o;
      f.z += s[i].dz * o;
      if (f.y !== undefined) f.y += s[i].dy * o;
    }
    if (!s.length) this.list.delete(f.id);
  }
}
