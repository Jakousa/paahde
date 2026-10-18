// Server side of the bosses (shared/bosses.ts): spawns them (rarely near someone out in the open, or from the debug
// menu), ticks each kind's brain (server/<kind>.ts), checks rifle hits, and hands the deaths, sand marks and one-off
// effects back to server/index.ts. In memory only: a restart sends them all away.
import { BASE } from '../shared/base.ts';
import { BOSS_KINDS, BOSS_SEND_R, BOSSES, bossDown, type BossKind, type BossSnap } from '../shared/bosses.ts';
import type { DeathCause, ServerMsg } from '../shared/protocol.ts';
import { RANGE } from '../shared/rifle.ts';
import { indoors } from '../shared/shelters.ts';
import { carrier } from './carrier.ts';
import { colossus } from './colossus.ts';
import { queen } from './queen.ts';
import { worm } from './worm.ts';

/** A player as the bosses see them: feet position; `safe`: down or just respawned, can't be hurt. */
export type BossPlayer = { id: number; x: number; y: number; z: number; safe: boolean };

export type Boss = {
  id: number; kind: BossKind;
  /** See BossSnap. */
  x: number; y: number; z: number; yaw: number;
  /** Weak points broken (bit mask); died when (-1 alive). */
  broken: number; deadAt: number;
  /** Stays until then (server ms), then `leaving`: its brain takes it away and says when it's gone. */
  until: number; leaving: boolean;
  /** Shot by this player (-1 none) until then: its brain may turn on them. */
  angry: number; angryUntil: number;
  /** The brain's own state. */
  st: any;
};

/** What a tick did, for server/index.ts: players killed (how, thrown which way), craters to blow into the sand
 *  (server/terrain.ts crater: radius m, depth mm), and messages for everyone within BOSS_SEND_R of (x, z). */
export type BossOut = {
  kills: { id: number; cause: DeathCause; push: [number, number, number] }[];
  craters: { x: number; z: number; r: number; mm: number }[];
  events: { msg: ServerMsg; x: number; z: number }[];
};

/** What a kind's brain does. All times server ms (performance.now()). */
export type Brain = {
  /** Put a new boss somewhere near (x, z) (summoned: close by, in sight; else further off) and set up `st`. */
  spawn(b: Boss, x: number, z: number, summoned: boolean, now: number): void;
  /** One tick (`dt` s). While b.leaving, take it away: return true once it's gone. Dead bosses aren't ticked. */
  tick(b: Boss, dt: number, now: number, players: BossPlayer[], out: BossOut): boolean;
  /** Could a shot ending at (x, y, z) have hit it (generous: lag, its size)? */
  near(b: Boss, x: number, y: number, z: number): boolean;
  /** The kind's own numbers for BossSnap.s (rounded). */
  snap(b: Boss): number[];
  /** All its weak points broken, at `now`: stop, fall, whatever it does when it dies (optional). */
  die?(b: Boss, now: number, out: BossOut): void;
};

const BRAINS: Record<BossKind, Brain> = { worm, carrier, colossus, queen };

/** A summoned boss stays this long (ms); a rare one RARE_STAY. */
const SUMMON_STAY = 10 * 60_000;
const RARE_STAY: [number, number] = [6 * 60_000, 10 * 60_000];
/** A rare one turns up every RARE_GAP ms (random within) near someone out in the open at least RARE_FROM_BASE m
 *  from the base, while no other boss is about. */
const RARE_GAP: [number, number] = [25 * 60_000, 50 * 60_000];
const RARE_FROM_BASE = 500;

/** A killed boss, for server/index.ts to drop its parts around (x, z) within r. */
export type BossKill = { kind: BossKind; x: number; z: number; r: number; by: number };

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const r2 = (v: number) => Math.round(v * 100) / 100;

export class BossServer {
  bosses: Boss[] = [];
  private nextId = 1;
  private rareAt: number;

  constructor(now: number) {
    this.rareAt = now + rand(RARE_GAP[0], RARE_GAP[1]) / 2;
  }

  /** Debug menu: a boss of `kind` near player `p` (one of a kind: an earlier one of it goes). */
  summon(kind: unknown, p: BossPlayer, now: number) {
    if (!BOSS_KINDS.includes(kind as BossKind)) return;
    this.bosses = this.bosses.filter((b) => b.kind !== kind);
    this.spawn(kind as BossKind, p.x, p.z, true, now, now + SUMMON_STAY);
  }

  private spawn(kind: BossKind, x: number, z: number, summoned: boolean, now: number, until: number) {
    const b: Boss = { id: this.nextId++, kind, x, y: 0, z, yaw: 0, broken: 0, deadAt: -1, until, leaving: false, angry: -1, angryUntil: 0, st: null };
    BRAINS[kind].spawn(b, x, z, summoned, now);
    this.bosses.push(b);
  }

  tick(dt: number, now: number, players: BossPlayer[]): BossOut {
    const out: BossOut = { kills: [], craters: [], events: [] };
    // Hurt nobody indoors or safe: the brains get them flagged.
    const ps = players.map((p) => (p.safe || indoors(p.x, p.y, p.z) ? { ...p, safe: true } : p));
    this.bosses = this.bosses.filter((b) => {
      if (b.deadAt >= 0) return now - b.deadAt < BOSSES[b.kind].wreckS * 1000;
      if (!b.leaving && now > b.until) b.leaving = true;
      return !BRAINS[b.kind].tick(b, dt, now, ps, out);
    });
    if (now >= this.rareAt) {
      this.rareAt = now + rand(RARE_GAP[0], RARE_GAP[1]);
      const open = ps.filter((p) => !p.safe && Math.hypot(p.x - BASE.x, p.z - BASE.z) > RARE_FROM_BASE);
      const p = open[Math.floor(Math.random() * open.length)];
      if (p && !this.bosses.some((b) => b.deadAt < 0)) {
        this.spawn(BOSS_KINDS[Math.floor(Math.random() * BOSS_KINDS.length)], p.x, p.z, false, now, now + rand(RARE_STAY[0], RARE_STAY[1]));
      }
    }
    return out;
  }

  /** Player `by` shot from (x, y, z) to (ex, ey, ez) and says it broke weak point `i` of boss `id`. Plausible (alive,
   *  that point whole, in range, the shot ending near it): broken, and it's angry with the shooter. The last point
   *  kills it. */
  shoot(by: BossPlayer, x: number, y: number, z: number, ex: number, ey: number, ez: number, id: unknown, i: unknown, now: number, out: BossOut): { hit: boolean; kill: BossKill | null } {
    const miss = { hit: false, kill: null };
    const b = this.bosses.find((o) => o.id === id);
    if (!b || b.deadAt >= 0 || !Number.isInteger(i) || (i as number) < 0 || (i as number) >= BOSSES[b.kind].points) return miss;
    if (b.broken & (1 << (i as number))) return miss;
    if (Math.hypot(ex - x, ey - y, ez - z) > RANGE + 5 || !BRAINS[b.kind].near(b, ex, ey, ez)) return miss;
    b.broken |= 1 << (i as number);
    if (!by.safe) {
      b.angry = by.id;
      b.angryUntil = now + 30_000;
    }
    if (!bossDown(b.kind, b.broken)) return { hit: true, kill: null };
    b.deadAt = now;
    BRAINS[b.kind].die?.(b, now, out);
    return { hit: true, kill: { kind: b.kind, x: b.x, z: b.z, r: 12, by: by.id } };
  }

  /** The bosses near (x, z), for one player. */
  msg(now: number, x: number, z: number): ServerMsg {
    const b: BossSnap[] = [];
    for (const o of this.bosses) {
      if (Math.hypot(o.x - x, o.z - z) > BOSS_SEND_R) continue;
      b.push({
        id: o.id, k: o.kind, x: r2(o.x), y: r2(o.y), z: r2(o.z), yaw: Math.round(o.yaw * 1e4) / 1e4, br: o.broken,
        dead: o.deadAt < 0 ? 0 : Math.round((now - o.deadAt) / 10) / 100 + 0.01, s: BRAINS[o.kind].snap(o),
      });
    }
    return { t: 'bosses', time: Math.round(now), b };
  }
}
