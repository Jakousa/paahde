// Thrown scrap in flight (shared/throw.ts): launched from a player's hand, flown on its arc every server tick, struck
// against the flying drones (server/guardians.ts) and the sand. A drone it hits takes a hit and the junk bounces off;
// where it comes down it becomes dropped loot (server/loot.ts), or, over the base where nothing can lie, goes back
// into the thrower's bag.
import { canDropAt } from '../shared/loot.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { heightAt } from '../shared/terrain.ts';
import { BOUNCE, FLIGHT_MAX, THROW_G, THROW_HIT, THROW_SPEED, tossAt, type TossPath } from '../shared/throw.ts';
import type { GuardianServer } from './guardians.ts';

/** Stepped no coarser than this (s): 0.5 m at full speed, well inside THROW_HIT. */
const STEP = 1 / 60;

/** `t`: seconds into the current leg (`path`), `flown` in all; `spent`: it has hit a drone (once is all). */
type Flying = { id: number; by: number; owner: string; n: number; kind: string; path: TossPath; t: number; flown: number; spent: boolean };

/** A toss launched, bounced or ended (shared/protocol.ts), and where, for whoever is near. */
export type TossEvent = { msg: ServerMsg; x: number; z: number };
/** Where a toss came down: loot at (x, z), or back to `owner` (browser id) if it can't lie there. */
export type Landing = { kind: string; x: number; z: number; owner: string; ok: boolean };

const r2 = (n: number) => Math.round(n * 100) / 100;
const _p = { x: 0, y: 0, z: 0 };

export class ThrowServer {
  private flying: Flying[] = [];
  private nextId = 1;
  private guardians: GuardianServer;

  constructor(guardians: GuardianServer) {
    this.guardians = guardians;
  }

  /** Player `by` (public id; `owner` their browser id) throws a `kind` from (x, y, z) along unit (dx, dy, dz). */
  launch(by: number, owner: string, n: number, kind: string, x: number, y: number, z: number, dx: number, dy: number, dz: number, now: number): TossEvent {
    const path = { time: now, x, y, z, vx: dx * THROW_SPEED, vy: dy * THROW_SPEED, vz: dz * THROW_SPEED };
    const f: Flying = { id: this.nextId++, by, owner, n, kind, path, t: 0, flown: 0, spent: false };
    this.flying.push(f);
    return this.event(f);
  }

  /** Every server tick: fly everything `dt` seconds on; what happened, and what landed. */
  tick(dt: number, now: number): { events: TossEvent[]; landed: Landing[] } {
    const events: TossEvent[] = [], landed: Landing[] = [];
    this.flying = this.flying.filter((f) => {
      for (let left = dt; left > 1e-6; left -= STEP) {
        const h = Math.min(STEP, left);
        f.t += h;
        f.flown += h;
        tossAt(f.path, f.t, _p);
        const ground = heightAt(_p.x, _p.z);
        if (_p.y <= ground || f.flown > FLIGHT_MAX) {
          const y = Math.max(_p.y, ground);
          events.push({ msg: { t: 'tossEnd', id: f.id, x: r2(_p.x), y: r2(y), z: r2(_p.z) }, x: _p.x, z: _p.z });
          landed.push({ kind: f.kind, x: _p.x, z: _p.z, owner: f.owner, ok: canDropAt(_p.x, _p.z) });
          return false;
        }
        if (f.spent) continue;
        const d = this.guardians.droneNear(_p.x, _p.y, _p.z, THROW_HIT);
        if (d < 0) continue;
        // A hit: the drone takes it, and the junk glances off back the way it came, falling; it hits nothing more.
        const vx = f.path.vx, vz = f.path.vz, vy = f.path.vy - f.t * THROW_G, sp = Math.hypot(vx, vz) || 1;
        this.guardians.strikeDrone(d, vx / sp, vz / sp, now, f.by);
        f.path = { time: now, x: _p.x, y: _p.y, z: _p.z, vx: -vx * BOUNCE, vy: Math.min(0, vy) * BOUNCE, vz: -vz * BOUNCE };
        f.t = 0;
        f.spent = true;
        events.push(this.event(f, true));
      }
      return true;
    });
    return { events, landed };
  }

  private event(f: Flying, hit = false): TossEvent {
    const p = f.path;
    const msg: ServerMsg = { t: 'toss', id: f.id, by: f.by, n: f.n, kind: f.kind, time: p.time, x: r2(p.x), y: r2(p.y), z: r2(p.z), vx: r2(p.vx), vy: r2(p.vy), vz: r2(p.vz), ...(hit ? { hit: true as const } : {}) };
    return { msg, x: p.x, z: p.z };
  }
}
