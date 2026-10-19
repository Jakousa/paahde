// Server side of sandstorms (shared/storm.ts): now and then one blows up somewhere near a random player,
// and the list goes out to everyone whenever it changes. In memory only: a restart clears the weather.
import { MAX_LEN_MS, MIN_LEN_MS, WARN_MS, type Storm } from '../shared/storm.ts';
import type { ServerMsg } from '../shared/protocol.ts';

/** Quiet time between one storm's announcement and the next (ms). */
const GAP_MIN_MS = 4 * 60_000;
const GAP_MAX_MS = 10 * 60_000;
/** The gap is this many times longer when the sun is down (storms are rarer at night). */
const NIGHT_GAP = 2.5;
/** A new storm's centre lands this far (m) from the player it was picked for, at most. */
const OFFSET = 220;
const R_MIN = 140;
const R_MAX = 300;
const MAX_STORMS = 3;

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class StormServer {
  storms: Storm[] = [];
  private nextId = 1;
  private nextAt: number;
  private changed = false;
  /** Debug menu: no random storms (and any blowing now are cleared). */
  off = false;

  constructor(now: number) {
    this.nextAt = now + rand(GAP_MIN_MS, GAP_MAX_MS) / 2;
  }

  /** Server time `now` (ms) and where the players are. Returns a 'storms' message when the list changed. */
  tick(now: number, players: { x: number; z: number }[], night = false): ServerMsg | null {
    const live = this.off ? [] : this.storms.filter((s) => s.end > now);
    if (live.length !== this.storms.length) {
      this.storms = live;
      this.changed = true;
    }
    if (now >= this.nextAt) {
      this.nextAt = now + rand(GAP_MIN_MS, GAP_MAX_MS) * (night ? NIGHT_GAP : 1);
      const p = players[Math.floor(Math.random() * players.length)];
      if (p && !this.off && this.storms.length < MAX_STORMS) this.spawn(p.x, p.z, OFFSET, now);
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
      speed: Math.round(rand(2, 5) * 10) / 10,
      start: Math.round(start),
      end: Math.round(start + rand(MIN_LEN_MS, MAX_LEN_MS)),
    });
    this.changed = true;
  }

  msg(): ServerMsg {
    return { t: 'storms', storms: this.storms };
  }
}
