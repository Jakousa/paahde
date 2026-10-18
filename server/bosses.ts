// Server side of the bosses (shared/bosses.ts): spawns them (called by a receiver, or from the debug menu), ticks each kind's brain (server/<kind>.ts), checks rifle hits, and hands the deaths, sand marks and one-off
// effects back to server/index.ts. In memory only: a restart sends them all away.
import { allPoints, BOSS_KINDS, BOSS_SEND_R, BOSSES, REGROW_MS, type BossKind, type BossSnap } from '../shared/bosses.ts';
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
  /** Weak points broken now (bit mask), each until regrow[i] (server ms); health left (hits); died when (-1 alive). */
  broken: number; regrow: number[]; hp: number; deadAt: number;
  /** Stays until then (server ms), then `leaving`: its brain takes it away and says when it's gone. */
  until: number; leaving: boolean;
  /** Called by a receiver: it stays until it's killed (server/world.ts keeps it in the settings across restarts). */
  called: boolean;
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
  /** Dead, while its wreck lies: anything still to come of the death (a fall's impact) (optional). */
  wreck?(b: Boss, dt: number, now: number, players: BossPlayer[], out: BossOut): void;
};

const BRAINS: Record<BossKind, Brain> = { worm, carrier, colossus, queen };

/** A summoned boss stays this long (ms). */
const SUMMON_STAY = 10 * 60_000;

/** A killed boss, for server/index.ts to drop its parts around (x, z) within r. */
export type BossKill = { kind: BossKind; x: number; z: number; r: number; by: number };

const r2 = (v: number) => Math.round(v * 100) / 100;

export class BossServer {
  bosses: Boss[] = [];
  private nextId = 1;

  /** Debug menu: a boss of `kind` near player `p` for a while (one of a kind: an earlier one of it goes). */
  summon(kind: unknown, p: BossPlayer, now: number) {
    if (!BOSS_KINDS.includes(kind as BossKind)) return;
    this.bosses = this.bosses.filter((b) => b.kind !== kind);
    this.spawn(kind as BossKind, p.x, p.z, true, now, now + SUMMON_STAY, false);
  }

  /** The kind alive now (not its wreck), or null. */
  alive(kind: BossKind): Boss | null {
    return this.bosses.find((b) => b.kind === kind && b.deadAt < 0) ?? null;
  }

  /** A receiver's call (or one from before a restart, with the hits it had taken): `kind` turns up some way off
   *  player `p` and stays until it's killed. False if one of it is already about. */
  call(kind: BossKind, p: BossPlayer, now: number, hurt = 0): boolean {
    if (this.alive(kind)) return false;
    this.spawn(kind, p.x, p.z, false, now, Infinity, true, Math.max(1, BOSSES[kind].hp - hurt));
    return true;
  }

  private spawn(kind: BossKind, x: number, z: number, summoned: boolean, now: number, until: number, called: boolean, hp = BOSSES[kind].hp) {
    const b: Boss = {
      id: this.nextId++, kind, x, y: 0, z, yaw: 0, broken: 0, regrow: [], hp, deadAt: -1, until, leaving: false, called, angry: -1, angryUntil: 0, st: null,
    };
    BRAINS[kind].spawn(b, x, z, summoned, now);
    this.bosses.push(b);
  }

  tick(dt: number, now: number, players: BossPlayer[]): BossOut {
    const out: BossOut = { kills: [], craters: [], events: [] };
    // Hurt nobody indoors or safe: the brains get them flagged.
    const ps = players.map((p) => (p.safe || indoors(p.x, p.y, p.z) ? { ...p, safe: true } : p));
    this.bosses = this.bosses.filter((b) => {
      if (b.deadAt >= 0) {
        BRAINS[b.kind].wreck?.(b, dt, now, ps, out);
        return now - b.deadAt < BOSSES[b.kind].wreckS * 1000;
      }
      if (!b.leaving && now > b.until) b.leaving = true;
      for (let i = 0; i < BOSSES[b.kind].points; i++) if (b.broken & (1 << i) && now >= b.regrow[i]) b.broken &= ~(1 << i);
      return !BRAINS[b.kind].tick(b, dt, now, ps, out);
    });
    return out;
  }

  /** Player `by` shot from (x, y, z) to (ex, ey, ez) and says it broke weak point `i` of boss `id`. Plausible (alive,
   *  that point whole, in range, the shot ending near it): broken until it regrows, a hit off its health, and it's
   *  angry with the shooter. The last hit kills it. */
  shoot(by: BossPlayer, x: number, y: number, z: number, ex: number, ey: number, ez: number, id: unknown, i: unknown, now: number, out: BossOut): { hit: boolean; kill: BossKill | null; boss?: Boss } {
    const miss = { hit: false, kill: null };
    const b = this.bosses.find((o) => o.id === id);
    if (!b || b.deadAt >= 0 || !Number.isInteger(i) || (i as number) < 0 || (i as number) >= BOSSES[b.kind].points) return miss;
    if (b.broken & (1 << (i as number))) return miss;
    if (Math.hypot(ex - x, ey - y, ez - z) > RANGE + 5 || !BRAINS[b.kind].near(b, ex, ey, ez)) return miss;
    b.broken |= 1 << (i as number);
    b.regrow[i as number] = now + REGROW_MS;
    b.hp--;
    if (!by.safe) {
      b.angry = by.id;
      b.angryUntil = now + 30_000;
    }
    if (b.hp > 0) return { hit: true, kill: null, boss: b };
    b.broken = allPoints(b.kind);
    b.deadAt = now;
    BRAINS[b.kind].die?.(b, now, out);
    return { hit: true, kill: { kind: b.kind, x: b.x, z: b.z, r: 12, by: by.id }, boss: b };
  }

  /** Where every live boss is, for everyone (the receivers' needles, src/receiver.ts). */
  whereMsg(): ServerMsg {
    return { t: 'called', b: this.bosses.filter((o) => o.deadAt < 0).map((o) => ({ k: o.kind, x: Math.round(o.x), z: Math.round(o.z) })) };
  }

  /** The bosses near (x, z), for one player. */
  msg(now: number, x: number, z: number): ServerMsg {
    const b: BossSnap[] = [];
    for (const o of this.bosses) {
      if (Math.hypot(o.x - x, o.z - z) > BOSS_SEND_R) continue;
      b.push({
        id: o.id, k: o.kind, x: r2(o.x), y: r2(o.y), z: r2(o.z), yaw: Math.round(o.yaw * 1e4) / 1e4, br: o.broken, hp: r2(o.hp / BOSSES[o.kind].hp),
        dead: o.deadAt < 0 ? 0 : Math.round((now - o.deadAt) / 10) / 100 + 0.01, s: BRAINS[o.kind].snap(o),
      });
    }
    return { t: 'bosses', time: Math.round(now), b };
  }
}
