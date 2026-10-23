// Players' ground velocities, smoothed, for a brain to lead its shots at them (a missile, a bomb, a leap). Each brain
// keeps its own, tuned to how it uses them.
import type { BossPlayer } from './bosses.ts';

/** A player's track: where it last sampled them, when (ms), and their velocity (m/s, smoothed). */
export type Track = { x: number; z: number; t: number; vx: number; vz: number };

export type TrackOpts = {
  /** How much of a new sample `dt` s long goes into the velocity (0–1). */
  k: (dt: number) => number;
  /** Faster than this (m/s) is a respawn or a teleport, not a run: the velocity then 'ease's to 0 (smoothed like any
   *  sample), 'stop's at once, or is 'keep't as it was. */
  jump: number;
  onJump: 'ease' | 'stop' | 'keep';
  /** Samples at least this far apart (s, timed by `now`); 0: every update, `dt` long. */
  minS?: number;
};

export class Tracks {
  private o: TrackOpts;
  private m = new Map<number, Track>();
  private here = new Set<number>();

  constructor(o: TrackOpts) {
    this.o = o;
  }

  /** One tick (`dt` s, at `now` ms): everyone sampled; those who left forgotten. */
  update(now: number, dt: number, players: BossPlayer[]) {
    const { k, jump, onJump, minS = 0 } = this.o;
    this.here.clear();
    for (const p of players) {
      this.here.add(p.id);
      const t = this.m.get(p.id);
      if (!t) {
        this.m.set(p.id, { x: p.x, z: p.z, t: now, vx: 0, vz: 0 });
        continue;
      }
      const s = minS > 0 ? (now - t.t) / 1000 : Math.max(dt, 1e-3);
      if (s < minS) continue;
      let vx = (p.x - t.x) / s, vz = (p.z - t.z) / s, w = k(s);
      if (Math.hypot(vx, vz) > jump) {
        (vx = 0), (vz = 0);
        if (onJump === 'stop') w = 1;
        else if (onJump === 'keep') w = 0;
      }
      t.vx += (vx - t.vx) * w;
      t.vz += (vz - t.vz) * w;
      t.x = p.x;
      t.z = p.z;
      t.t = now;
    }
    for (const id of this.m.keys()) if (!this.here.has(id)) this.m.delete(id);
  }

  /** Player `id`'s track (undefined: not seen yet). */
  get(id: number): Track | undefined {
    return this.m.get(id);
  }
}
