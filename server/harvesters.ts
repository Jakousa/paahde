// Server side of the harvester (shared/harvester.ts): now and then one sets off on a long route over the dunes that
// passes some way from a random player, steering round rock, the base, shelters and crash sites. Its list goes out to
// everyone whenever it changes (a new one, its prey, a vent shot out, its death). Ticked with the bots: it runs over
// whoever is under it, turns on whoever comes close or shoots it and fires salvos of the walkers' bolts at them
// (GuardianServer.bolt), and ploughs furrows behind its tracks. In memory only.
import {
  ANGER_MS, BARREL, BOW, HALF_W, harvesterAt, harvesterPose, HULL_TOP, LOSE_MS, LOSE_R, NOTICE_R, routeLength, SALVO,
  SALVO_GAP, SALVO_MS, SPEED, STEP, STERN, toLocal, toWorld, TOWER_TOP, TRACK, TRACK_LEN, TURRET, VENT_HALF, VENT_HP,
  VENTS, WAKE_MS, WRECK_MS, EYE, type Harvester, type HarvesterPose,
} from '../shared/harvester.ts';
import { baseHeight } from '../shared/terrain.ts';
import { rocksNear } from '../shared/rocks.ts';
import { overBase } from '../shared/base.ts';
import { nearShelter, indoors } from '../shared/shelters.ts';
import { crashSitesNear } from '../shared/crashsites.ts';
import { BOLT_RANGE, lineOfSight } from '../shared/guardians.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import type { BoltEvent, GuardianServer } from './guardians.ts';

/** Time between one harvester setting off and the next being sent (ms); the first comes sooner. */
const GAP_MIN_MS = 7 * 60_000;
const GAP_MAX_MS = 18 * 60_000;
const MAX_OUT = 1;
/** Its route passes this near (m) the player it was picked for, after this much route (m) to get there, and goes on
 *  for AFTER m. */
const PASS_MIN = 160;
const PASS_MAX = 420;
const BEFORE = 1500;
const AFTER = 2600;
/** The route's heading changes by at most this much per STEP (rad); it looks this far ahead (m) for trouble. */
const TURN = 0.09;
const LOOK = 70;
/** Steepest sand it'll take on (rise over 8 m). */
const SLOPE = 3.6;
/** Furrows: a shallow trough under each track every FURROW m come, while someone is within FURROW_R. */
const FURROW = 3;
const FURROW_R = 700;
const FURROW_MM = 160;
const FURROW_R_M = 1.7;
/** A shot ending this near a vent's grille (m, beyond its half size) counts for it. */
const VENT_SLACK = 0.9;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Clear ground for its footprint at (x, z): sand, not too steep, away from what it mustn't crush. */
function clear(x: number, z: number): boolean {
  if (overBase(x, z, 140) || nearShelter(x, z, 45) || rocksNear(x, z, 10)) return false;
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

/** A route through (x, z) heading `yaw`: `before` m leading up to it, `after` m on. Null if it can't get far enough. */
function route(x: number, z: number, yaw: number, before: number, after: number): number[] | null {
  if (!clear(x, z)) return null;
  const on = wander(x, z, yaw, after), back = wander(x, z, yaw + Math.PI, before);
  if (routeLength(on) < after * 0.5 || routeLength(back) < before * 0.5) return null;
  const pts: number[] = [];
  for (let i = back.length - 2; i >= 2; i -= 2) pts.push(back[i], back[i + 1]);
  return pts.concat(on);
}

type Brain = {
  /** Turned on its prey at (ms); last saw them at; angry at them (shot by them) until. */
  wokeAt: number; seenAt: number; angryUntil: number;
  /** The salvo: bolts left to fire in it, when the next goes; when the next salvo may start. */
  left: number; nextBolt: number; nextSalvo: number;
  /** Where the furrows were last stamped (distance come, m). */
  furrowS: number;
  /** Prey's last position, for leading the shots. */
  px: number; pz: number; vx: number; vz: number;
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
    this.nextAt = now + rand(3 * 60_000, 8 * 60_000);
  }

  /** Set one off past (x, z) at server time `now`. `soon` (debug): it passes 50 m away (more if that's no good), with
   *  only 160 m to go. */
  spawn(x: number, z: number, now: number, soon = false): boolean {
    for (let i = 0; i < 40; i++) {
      // Debug: as near as it can, further out each try (not over the base).
      const a = rand(-Math.PI, Math.PI), d = soon ? 50 + i * 8 : rand(PASS_MIN, PASS_MAX);
      const px = x + Math.sin(a) * d, pz = z + Math.cos(a) * d;
      // Heading across the line to the player, either way, give or take.
      const yaw = a + (Math.random() < 0.5 ? 1 : -1) * Math.PI / 2 + rand(-0.5, 0.5);
      const pts = route(px, pz, yaw, soon ? 160 : BEFORE, AFTER);
      if (!pts) continue;
      const h: Harvester = { id: this.nextId++, pts, speed: SPEED, start: Math.round(now), end: 0, vents: VENTS.map(() => 0), prey: 0 };
      h.end = Math.round(now + (routeLength(pts) / SPEED) * 1000);
      this.harvesters.push(h);
      this.brains.set(h.id, { wokeAt: 0, seenAt: 0, angryUntil: 0, left: 0, nextBolt: 0, nextSalvo: 0, furrowS: 0, px: 0, pz: 0, vx: 0, vz: 0 });
      this.changed = true;
      return true;
    }
    return false;
  }

  /** Advance to server time `now` (dt s since the last tick). Who it ran over; bolts go into `guns` (their 'shot'
   *  events into `events`); furrows to stamp into `furrows`. */
  tick(dt: number, now: number, players: HarvesterPlayer[], guns: GuardianServer, events: BoltEvent[], furrows: Furrow[]): Crushed[] {
    const crushed: Crushed[] = [];
    const live = this.harvesters.filter((h) => h.end > now);
    if (live.length !== this.harvesters.length) {
      for (const h of this.harvesters) if (h.end <= now) this.brains.delete(h.id);
      this.harvesters = live;
      this.changed = true;
    }
    if (now >= this.nextAt) {
      this.nextAt = now + rand(GAP_MIN_MS, GAP_MAX_MS);
      const out = players.filter((p) => !p.safe && !indoors(p.x, p.y, p.z));
      const p = out[Math.floor(Math.random() * out.length)];
      if (p && this.harvesters.length < MAX_OUT) this.spawn(p.x, p.z, now);
    }
    const exposed = players.filter((p) => !p.safe && !indoors(p.x, p.y, p.z));
    for (const h of this.harvesters) {
      const b = this.brains.get(h.id)!;
      if (!harvesterAt(h, now, _p) || h.down) continue;
      // Under it: ground into the sand.
      for (const p of exposed) {
        toLocal(_p, p.x, p.z, _l);
        if (Math.abs(_l.x) < HALF_W && _l.z > STERN && _l.z < BOW && p.y < _p.y + HULL_TOP && p.y > _p.y - 4) {
          crushed.push({ id: p.id, push: [Math.sin(_p.yaw) * 5, 2.5, Math.cos(_p.yaw) * 5] });
        }
      }
      this.furrows(h, b, players, furrows);
      this.think(h, b, now, dt, exposed);
      this.fire(h, b, now, exposed, guns, events);
    }
    return crushed;
  }

  /** Furrows behind the tracks, when someone is about to see them. */
  private furrows(_h: Harvester, b: Brain, players: HarvesterPlayer[], out: Furrow[]) {
    if (_p.s - b.furrowS < FURROW) return;
    b.furrowS = _p.s;
    if (!players.some((p) => Math.hypot(p.x - _p.x, p.z - _p.z) < FURROW_R)) return;
    for (const side of [1, -1]) for (const z of [-(9 + TRACK_LEN / 2 - 1), 9 - TRACK_LEN / 2 + 1]) {
      toWorld(_p, (side * TRACK) / 2, 0, z, _w);
      out.push({ x: _w.x, z: _w.z, r: FURROW_R_M, mm: FURROW_MM });
    }
  }

  /** Who it's after: whoever shot it while it's still angry, else whoever came close where its eye can see them. */
  private think(h: Harvester, b: Brain, now: number, dt: number, exposed: HarvesterPlayer[]) {
    toWorld(_p, EYE.x, EYE.y, EYE.z, _w);
    const eye = { ..._w };
    const sees = (p: HarvesterPlayer) => lineOfSight(eye.x, eye.y, eye.z, p.x, p.y + 1.2, p.z);
    let prey = h.prey ? exposed.find((p) => p.id === h.prey) : undefined;
    if (prey) {
      const d = Math.hypot(prey.x - _p.x, prey.z - _p.z);
      if (sees(prey)) b.seenAt = now;
      if (d > LOSE_R || (now > b.angryUntil && now - b.seenAt > LOSE_MS)) prey = undefined;
    }
    if (!prey) {
      prey = exposed.filter((p) => Math.hypot(p.x - _p.x, p.z - _p.z) < NOTICE_R && sees(p))
        .sort((a, c) => Math.hypot(a.x - _p.x, a.z - _p.z) - Math.hypot(c.x - _p.x, c.z - _p.z))[0];
      if (prey) this.wake(h, b, prey, now);
    }
    if (!prey && h.prey) {
      h.prey = 0;
      b.left = 0;
      this.changed = true;
    }
    if (prey) {
      const k = 1 - Math.exp(-dt * 3);
      b.vx += ((prey.x - b.px) / Math.max(dt, 0.01) - b.vx) * k;
      b.vz += ((prey.z - b.pz) / Math.max(dt, 0.01) - b.vz) * k;
      if (Math.hypot(prey.x - b.px, prey.z - b.pz) > 20) b.vx = b.vz = 0; // a respawn isn't a velocity
      b.px = prey.x;
      b.pz = prey.z;
    }
  }

  private wake(h: Harvester, b: Brain, p: HarvesterPlayer, now: number) {
    if (h.prey === p.id) return;
    h.prey = p.id;
    b.wokeAt = b.seenAt = now;
    b.nextSalvo = Math.max(b.nextSalvo, now + WAKE_MS);
    b.left = 0;
    b.px = p.x;
    b.pz = p.z;
    b.vx = b.vz = 0;
    this.changed = true;
  }

  /** Salvos at its prey from the turret, led a little, while it can see them and they're in reach. */
  private fire(h: Harvester, b: Brain, now: number, exposed: HarvesterPlayer[], guns: GuardianServer, events: BoltEvent[]) {
    const p = h.prey ? exposed.find((o) => o.id === h.prey) : undefined;
    if (!p) return;
    toWorld(_p, TURRET.x, TURRET.y, TURRET.z, _w);
    const pv = { ..._w }, cy = p.y + 1.1;
    const d = Math.hypot(p.x - pv.x, cy - pv.y, p.z - pv.z);
    if (d > BOLT_RANGE - 10 || !lineOfSight(pv.x, pv.y, pv.z, p.x, cy, p.z)) return;
    if (b.left === 0) {
      if (now < b.nextSalvo) return;
      b.left = SALVO;
      b.nextBolt = now;
      b.nextSalvo = now + SALVO_MS;
    }
    if (now < b.nextBolt) return;
    b.left--;
    b.nextBolt = now + SALVO_GAP;
    // Lead them by half their way over the bolt's flight, and scatter the salvo a little.
    const flight = d / 38;
    const tx = p.x + b.vx * flight * 0.5 + rand(-1.2, 1.2), tz = p.z + b.vz * flight * 0.5 + rand(-1.2, 1.2);
    const dx = tx - pv.x, dy = cy - pv.y, dz = tz - pv.z, l = Math.hypot(dx, dy, dz);
    events.push(guns.bolt(pv.x + (dx / l) * BARREL, pv.y + (dy / l) * BARREL, pv.z + (dz / l) * BARREL, dx / l, dy / l, dz / l, -h.id, now));
  }

  /** A rifle shot from (x, y, z) ending at (ex, ey, ez) that the client says hit harvester `id`'s vent `vi` (-1: its
   *  armour). It turns on the shooter either way; a vent hit counts if the shot ended at that vent. True if it hit a
   *  live vent; `kill` once the last one goes. */
  shoot(by: HarvesterPlayer, x: number, y: number, z: number, ex: number, ey: number, ez: number, id: unknown, vi: unknown, now: number): { hit: boolean; kill: HarvesterKill | null } {
    const h = this.harvesters.find((o) => o.id === id);
    if (!h || h.down || !harvesterAt(h, now, _p)) return { hit: false, kill: null };
    toLocal(_p, ex, ez, _l);
    // The shot has to have ended on it somewhere.
    if (Math.abs(_l.x) > HALF_W + 2 || _l.z < STERN - 2 || _l.z > BOW + 2 || ey < _p.y - 3 || ey > _p.y + TOWER_TOP + 4) return { hit: false, kill: null };
    const b = this.brains.get(h.id)!;
    if (!by.safe) {
      this.wake(h, b, by, now);
      b.angryUntil = now + ANGER_MS;
    }
    if (!Number.isInteger(vi) || (vi as number) < 0 || (vi as number) >= VENTS.length) return { hit: false, kill: null };
    const i = vi as number, v = VENTS[i];
    if (h.vents[i] >= VENT_HP) return { hit: false, kill: null };
    toWorld(_p, v.x, v.y, v.z, _w);
    const near = Math.hypot(ex - _w.x, ez - _w.z) < VENT_HALF.z + VENT_SLACK && Math.abs(ey - _w.y) < VENT_HALF.y + VENT_SLACK + 1.5;
    if (!near) return { hit: false, kill: null };
    h.vents[i]++;
    this.changed = true;
    if (h.vents.some((n) => n < VENT_HP)) return { hit: true, kill: null };
    h.down = { at: Math.round(now) };
    h.end = Math.round(now + WRECK_MS);
    h.prey = 0;
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
