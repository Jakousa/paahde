// Server side of the harvester (shared/harvester.ts): the mud flats (shared/biomes.ts) are its ground. Now and then,
// when a player is out near one, a harvester rises out of the mud of a flat some way from them and crawls a route that
// keeps to the flat (steering round rock, the base, shelters and crash sites too), sinking back where it runs out. Its list goes out to
// everyone whenever it changes (a new one, a change of pace, a core shot out, its death). Ticked with the bots: it
// runs over whoever is under it, charges whoever it sees ahead (inSight: a new stretch of pace up to CHARGE, back down
// to SPEED once it has seen no one for CALM_MS), steering at the nearest of them as it does (the route ahead of its
// front axle swapped for one curving towards them, then wandering on), and ploughs furrows behind its tracks. In
// memory only.
import {
  BOW, CALM_MS, CHARGE, CORE_HALF, CORE_HP, CORES, HALF_W, harvesterAt, harvesterPose, HULL_TOP, inSight, paceAt,
  routeCut, routeLength, SLOW_DOWN, SPEED, SPEED_UP, STEP, STERN, toLocal, toWorld, TRACK, TRACK_LEN, WHEELBASE, WRECK_MS,
  type Harvester, type HarvesterPose,
} from '../shared/harvester.ts';
import { baseHeight } from '../shared/terrain.ts';
import { rocksNear } from '../shared/rocks.ts';
import { overBase } from '../shared/base.ts';
import { nearShelter, indoors } from '../shared/shelters.ts';
import { crashSitesNear } from '../shared/crashsites.ts';
import { biome } from '../shared/biomes.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { seized, type Storm } from '../shared/storm.ts';

/** Time between one harvester setting off and the next being sent (ms); the first comes sooner. With no one out near
 *  a mud flat, it looks again after RETRY_MS. */
const GAP_MIN_MS = 4 * 60_000;
const GAP_MAX_MS = 10 * 60_000;
const RETRY_MS = 30_000;
const MAX_OUT = 2;
/** It rises out of the mud this far (m) from the player it was sent for (debug: as near as it can, out to DEBUG_R),
 *  on a route up to ROUTE_LEN m long, at least ROUTE_MIN. */
const RISE_MIN = 150;
const RISE_MAX = 900;
const DEBUG_R = 3000;
const ROUTE_LEN = 3000;
const ROUTE_MIN = 300;
/** How much mud flat (shared/biomes.ts mudflat) its ground needs: where it rises, and along its way. */
const MUD_RISE = 0.9;
const MUD_ROAM = 0.6;
/** The route's heading changes by at most this much per STEP (rad); it looks this far ahead (m) for trouble. */
const TURN = 0.09;
const LOOK = 70;
/** Steepest sand it'll take on (rise over 8 m). */
const SLOPE = 3.6;
/** Furrows: a shallow trough under each track every FURROW m come, while someone is within FURROW_R. */
const FURROW = 3;
const FURROW_R = 700;
const FURROW_MM = 160;
const FURROW_R_M = 2.4;
/** A shot ending this near a core (m, beyond its size) counts for it, fired from at least this far forward along its
 *  length (local z: from in front of the maw, give or take). */
const CORE_SLACK = 0.9;
const SHOT_FROM_Z = 12;
/** Steering at whoever it charges: the route ahead is redrawn every STEER_MS, in STEER_STEP m steps turning on a
 *  radius of at least TURN_R m, for up to STEER_LEN m (straight on once it's within REACHED m of them), then wandering
 *  on for STEER_ON m; the new route has to be at least STEER_MIN m long, or it keeps the old one. */
const STEER_MS = 800;
const STEER_STEP = 5;
const TURN_R = 70;
const STEER_LEN = 260;
const REACHED = 25;
const STEER_ON = 1500;
const STEER_MIN = 200;
/** Seized up by a storm front (shared/storm.ts seized): it brakes to a stop at this (m/s²). */
const SEIZE_BRAKE = 3;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Clear ground for its footprint at (x, z): out on a mud flat, not too steep, away from what it mustn't crush. */
function clear(x: number, z: number): boolean {
  if (biome('mudflat', x, z) < MUD_ROAM || overBase(x, z, 140) || nearShelter(x, z, 45) || rocksNear(x, z, 16)) return false;
  for (const s of crashSitesNear(x, z, 260)) if (Math.hypot(s.x - x, s.z - z) < s.radius + 30) return false;
  const dx = baseHeight(x + 4, z) - baseHeight(x - 4, z), dz = baseHeight(x, z + 4) - baseHeight(x, z - 4);
  return Math.hypot(dx, dz) < SLOPE;
}

/** Clear for LOOK m along heading `yaw` from (x, z). */
function clearAhead(x: number, z: number, yaw: number) {
  for (let d = STEP; d <= LOOK; d += STEP) if (!clear(x + Math.sin(yaw) * d, z + Math.cos(yaw) * d)) return false;
  return true;
}

/** A route from (x, z) heading `yaw`, `len` m long (shorter if it gets boxed in), wandering and steering round
 *  trouble: x, z pairs. */
function wander(x: number, z: number, yaw: number, len: number): number[] {
  const pts = [x, z];
  let bend = 0;
  for (let d = 0; d < len; d += STEP) {
    bend = Math.max(-TURN, Math.min(TURN, bend + rand(-0.03, 0.03)));
    // The way it would go, else the nearest turn either side that's clear.
    let pick: number | null = null;
    for (const k of [0, 1, -1, 2, -2, 3, -3, 5, -5, 8, -8, 12, -12]) {
      const a = yaw + bend + k * TURN;
      if (clearAhead(x, z, a)) {
        pick = a;
        break;
      }
    }
    if (pick === null) break;
    if (pick !== yaw + bend) bend = 0;
    yaw = pick;
    x += Math.sin(yaw) * STEP;
    z += Math.cos(yaw) * STEP;
    pts.push(r1(x), r1(z));
  }
  return pts;
}


type Brain = {
  /** Last saw someone in its lane (server ms). */
  aheadAt: number;
  /** Where the furrows were last stamped (distance come, m). */
  furrowS: number;
  /** Seized up by a storm front: stopped till it has passed. */
  stuck: boolean;
  /** Last redrew its route to steer at someone (server ms). */
  steerAt: number;
};

export type HarvesterPlayer = { id: number; x: number; y: number; z: number; safe: boolean };
export type HarvesterKill = { x: number; z: number; yaw: number };
/** Run over: who, and the shove their body takes (shared/ragdoll.ts). */
export type Crushed = { id: number; push: [number, number, number] };
/** A trough to dig (server/terrain.ts crater, unsettled). */
export type Furrow = { x: number; z: number; r: number; mm: number };

const _p: HarvesterPose = harvesterPose();
const _w = { x: 0, y: 0, z: 0 }, _l = { x: 0, z: 0 };

export class HarvesterServer {
  harvesters: Harvester[] = [];
  private brains = new Map<number, Brain>();
  private nextId = 1;
  private nextAt: number;
  private changed = false;

  constructor(now: number) {
    this.nextAt = now + rand(60_000, 4 * 60_000);
  }

  /** Raise one out of a mud flat RISE_MIN..RISE_MAX m from (x, z) at server time `now` (false: no flat there, or no
   *  way across it). `soon` (debug): the nearest spot it can, out to DEBUG_R. */
  spawn(x: number, z: number, now: number, soon = false): boolean {
    const tries = soon ? 120 : 60;
    for (let i = 0; i < tries; i++) {
      const a = rand(-Math.PI, Math.PI), d = soon ? 60 + (i / tries) * DEBUG_R : rand(RISE_MIN, RISE_MAX);
      const px = x + Math.sin(a) * d, pz = z + Math.cos(a) * d;
      if (biome('mudflat', px, pz) < MUD_RISE || !clear(px, pz)) continue;
      const pts = wander(px, pz, rand(-Math.PI, Math.PI), ROUTE_LEN);
      if (routeLength(pts) < ROUTE_MIN) continue;
      const id = this.nextId++, start = Math.round(now);
      this.harvesters.push({ id, pts, pace: [{ t: start, s: 0, v: SPEED, a: 0, to: SPEED }], start, end: 0, cores: CORES.map(() => 0), charging: false });
      this.brains.set(id, { aheadAt: 0, furrowS: 0, stuck: false, steerAt: 0 });
      this.changed = true;
      return true;
    }
    return false;
  }

  /** Advance to server time `now` under `storms`. Who it ran over; furrows to stamp go into `furrows`. */
  tick(now: number, players: HarvesterPlayer[], furrows: Furrow[], storms: readonly Storm[] = []): Crushed[] {
    const crushed: Crushed[] = [];
    // Gone: a wreck burnt out, or past the route's end.
    const live = this.harvesters.filter((h) => (h.end ? h.end > now : harvesterAt(h, now, _p)));
    if (live.length !== this.harvesters.length) {
      for (const h of this.harvesters) if (!live.includes(h)) this.brains.delete(h.id);
      this.harvesters = live;
      this.changed = true;
    }
    const exposed = players.filter((p) => !p.safe && !indoors(p.x, p.y, p.z));
    if (now >= this.nextAt && this.harvesters.length < MAX_OUT) {
      const p = exposed[Math.floor(Math.random() * exposed.length)];
      this.nextAt = now + (p && this.spawn(p.x, p.z, now) ? rand(GAP_MIN_MS, GAP_MAX_MS) : RETRY_MS);
    }
    for (const h of this.harvesters) {
      const b = this.brains.get(h.id)!;
      if (h.down || !harvesterAt(h, now, _p)) continue;
      let ahead = false, target: HarvesterPlayer | null = null, near = Infinity;
      for (const p of exposed) {
        toLocal(_p, p.x, p.z, _l);
        const level = p.y < _p.y + HULL_TOP && p.y > _p.y - 4;
        // Under it: ground into the sand.
        if (Math.abs(_l.x) < HALF_W && _l.z > STERN && _l.z < BOW && level) {
          crushed.push({ id: p.id, push: [Math.sin(_p.yaw) * 6, 3, Math.cos(_p.yaw) * 6] });
        }
        if (level && inSight(_l.x, _l.z)) {
          ahead = true;
          const d = Math.hypot(_l.x, _l.z);
          if (d < near) (near = d), (target = p);
        }
      }
      // A storm front's static seizes it: it brakes to a stop and sits there till it has passed, then sets off again.
      const stuck = seized(storms, _p.x, _p.z, now);
      if (stuck !== b.stuck) {
        b.stuck = stuck;
        this.pace(h, now, stuck ? 0 : SPEED);
      }
      if (stuck) continue;
      if (ahead) b.aheadAt = now;
      if (ahead && !h.charging) this.pace(h, now, CHARGE);
      else if (!ahead && h.charging && now - b.aheadAt > CALM_MS) this.pace(h, now, SPEED);
      if (target) this.steer(h, b, target.x, target.z, now);
      this.furrows(b, players, furrows);
    }
    return crushed;
  }

  /** A new stretch of pace from now, towards speed `to`: up to CHARGE, back down to SPEED, or stopping (0, seized). */
  private pace(h: Harvester, now: number, to: number) {
    const { s, v } = paceAt(h.pace, now);
    h.pace.push({ t: Math.round(now), s: r2(s), v: r3(v), a: to > v ? SPEED_UP : to === 0 ? -SEIZE_BRAKE : -SLOW_DOWN, to });
    // Only the last few matter (the one before covers anyone whose clock is a little behind).
    if (h.pace.length > 3) h.pace.splice(0, h.pace.length - 3);
    h.charging = to === CHARGE;
    this.changed = true;
  }

  /** Redraw the route ahead of its front axle to curve towards (tx, tz) (at most every STEER_MS), steering round
   *  nothing: where the way there isn't clear (rock, the base, a shelter...) it stops turning there and wanders on. */
  private steer(h: Harvester, b: Brain, tx: number, tz: number, now: number) {
    if (now - b.steerAt < STEER_MS) return;
    b.steerAt = now;
    const keep = routeCut(h.pts, _p.s + WHEELBASE / 2 + STEER_STEP);
    const n = keep.length;
    if (n < 4) return;
    let x = keep[n - 2], z = keep[n - 1], yaw = Math.atan2(x - keep[n - 4], z - keep[n - 3]);
    const tail: number[] = [];
    for (let d = 0; d < STEER_LEN; d += STEER_STEP) {
      if (Math.hypot(tx - x, tz - z) > REACHED) {
        const turn = Math.atan2(Math.sin(Math.atan2(tx - x, tz - z) - yaw), Math.cos(Math.atan2(tx - x, tz - z) - yaw));
        yaw += Math.max(-STEER_STEP / TURN_R, Math.min(STEER_STEP / TURN_R, turn));
      }
      const nx = x + Math.sin(yaw) * STEER_STEP, nz = z + Math.cos(yaw) * STEER_STEP;
      if (!clear(nx, nz)) break;
      x = nx;
      z = nz;
      tail.push(r1(x), r1(z));
    }
    if (tail.length < 8) return;
    const on = wander(x, z, yaw, STEER_ON).slice(2);
    if (routeLength([keep[n - 2], keep[n - 1], ...tail, ...on]) < STEER_MIN) return;
    h.pts = keep.concat(tail, on);
    this.changed = true;
  }

  /** Furrows behind the tracks, when someone is about to see them. */
  private furrows(b: Brain, players: HarvesterPlayer[], out: Furrow[]) {
    if (_p.s - b.furrowS < FURROW) return;
    b.furrowS = _p.s;
    if (!players.some((p) => Math.hypot(p.x - _p.x, p.z - _p.z) < FURROW_R)) return;
    for (const side of [1, -1]) for (const z of [-(WHEELBASE / 2 + TRACK_LEN / 2 - 1), WHEELBASE / 2 - TRACK_LEN / 2 + 1]) {
      toWorld(_p, (side * TRACK) / 2, 0, z, _w);
      out.push({ x: _w.x, z: _w.z, r: FURROW_R_M, mm: FURROW_MM });
    }
  }

  /** A rifle shot from (x, z) ending at (ex, ey, ez) that the client says hit core `ci` of harvester `id`: it counts if
   *  it was fired from in front and ended at that core. True if it hit a live core; `kill` once the last one goes. */
  shoot(x: number, z: number, ex: number, ey: number, ez: number, id: unknown, ci: unknown, now: number): { hit: boolean; kill: HarvesterKill | null } {
    const h = this.harvesters.find((o) => o.id === id);
    if (!h || h.down || !harvesterAt(h, now, _p)) return { hit: false, kill: null };
    if (!Number.isInteger(ci) || (ci as number) < 0 || (ci as number) >= CORES.length) return { hit: false, kill: null };
    const i = ci as number, c = CORES[i];
    if (h.cores[i] >= CORE_HP || toLocal(_p, x, z, _l).z < SHOT_FROM_Z) return { hit: false, kill: null };
    toWorld(_p, c.x, c.y, c.z, _w);
    if (Math.hypot(ex - _w.x, ey - _w.y, ez - _w.z) > CORE_HALF * 1.8 + CORE_SLACK) return { hit: false, kill: null };
    h.cores[i]++;
    this.changed = true;
    if (h.cores.some((n) => n < CORE_HP)) return { hit: true, kill: null };
    h.down = { at: Math.round(now) };
    h.end = Math.round(now + WRECK_MS);
    h.charging = false;
    return { hit: true, kill: { x: _p.x, z: _p.z, yaw: _p.yaw } };
  }

  /** Returns a 'harvesters' message when the list changed since the last call. */
  flush(): ServerMsg | null {
    if (!this.changed) return null;
    this.changed = false;
    return this.msg();
  }

  msg(): ServerMsg {
    return { t: 'harvesters', harvesters: this.harvesters };
  }
}
