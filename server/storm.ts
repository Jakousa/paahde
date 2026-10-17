// Server side of sandstorms (shared/storm.ts): now and then one blows up somewhere near a random player,
// and the list goes out to everyone whenever it changes. In memory only: a restart clears the weather.
import { MAX_LEN_MS, MIN_LEN_MS, WARN_MS, type Storm } from '../shared/storm.ts';
import type { ServerMsg } from '../shared/protocol.ts';

/** Quiet time between one storm's announcement and the next (ms). */
const GAP_MIN_MS = 2 * 60_000;
const GAP_MAX_MS = 6 * 60_000;
/** A new storm's centre lands this far (m) from the player it was picked for, at most. */
const OFFSET = 220;
const R_MIN = 110;
const R_MAX = 250;
const MAX_STORMS = 3;

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class StormServer {
  storms: Storm[] = [];
  private nextId = 1;
  private nextAt: number;
  private changed = false;

  constructor(now: number) {
    this.nextAt = now + rand(GAP_MIN_MS, GAP_MAX_MS) / 2;
  }

  /** Server time `now` (ms) and where the players are. Returns a 'storms' message when the list changed. */
  tick(now: number, players: { x: number; z: number }[]): ServerMsg | null {
    const live = this.storms.filter((s) => s.end > now);
    if (live.length !== this.storms.length) {
      this.storms = live;
      this.changed = true;
    }
    if (now >= this.nextAt) {
      this.nextAt = now + rand(GAP_MIN_MS, GAP_MAX_MS);
      const p = players[Math.floor(Math.random() * players.length)];
      if (p && this.storms.length < MAX_STORMS) this.spawn(p.x, p.z, OFFSET, now);
    }
    if (!this.changed) return null;
    this.changed = false;
    return this.msg();
  }

  /** A storm whose centre lands within `offset` m of (x, z), starting after the warning. */
  spawn(x: number, z: number, offset: number, now: number) {
    const a = Math.random() * Math.PI * 2, d = offset * Math.sqrt(Math.random());
    const start = now + WARN_MS;
    this.storms.push({
      id: this.nextId++,
      x: Math.round(x + Math.cos(a) * d),
      z: Math.round(z + Math.sin(a) * d),
      r: Math.round(rand(R_MIN, R_MAX)),
      speed: Math.round(rand(1, 4) * 10) / 10,
      start: Math.round(start),
      end: Math.round(start + rand(MIN_LEN_MS, MAX_LEN_MS)),
    });
    this.changed = true;
  }

  msg(): ServerMsg {
    return { t: 'storms', storms: this.storms };
  }
}
