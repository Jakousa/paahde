// Server side of the weather: sandstorms (shared/storm.ts): now and then one blows up somewhere near a random player,
// and rarely a mega-storm front rolls in over everyone; and on some nights poison gas (shared/gas.ts) creeps in. The
// lists go out to everyone whenever they change. In memory only: a restart clears the weather.
//
// Balance: the big events (fronts, gas) never come within BIG_GAP_MS of each other's end, the gas waits for a night
// with enough of it left, and no sandstorm column blows up while a big one is out.
import { WIND } from '../shared/dunes.ts';
import { FRONT_LEAD_S, FRONT_PASS_S, FRONT_SPEED, MAX_LEN_MS, MIN_LEN_MS, WARN_MS, type Storm } from '../shared/storm.ts';
import { KEEP_OUT, NEVER, RAMP_MS as VORTEX_RAMP_MS, ROAMERS, vortexEnvelope, type Vortex } from '../shared/vortex.ts';
import { ORIGIN } from '../shared/origin.ts';
import { GAS_LEAD_S, GAS_PASS_S, GAS_SPEED, type Gas } from '../shared/gas.ts';
import { DAY_SECONDS, sunElevation } from '../shared/sun.ts';
import type { ServerMsg } from '../shared/protocol.ts';

/** Quiet time between one storm's announcement and the next (ms). */
const GAP_MIN_MS = 4 * 60_000;
const GAP_MAX_MS = 10 * 60_000;
/** The gap is this many times longer when the sun is down (storms are rarer at night). */
const NIGHT_GAP = 2.5;
/** A new storm's centre lands this far (m) from the player it was picked for, at most. */
const OFFSET = 220;
const R_MIN = 60;
const R_MAX = 130;
const MAX_STORMS = 3;
/** Time between mega-storm fronts (ms), and before the first one after the world starts. */
const FRONT_GAP_MIN_MS = 35 * 60_000;
const FRONT_GAP_MAX_MS = 70 * 60_000;
const FRONT_FIRST_MIN_MS = 15 * 60_000;
/** A front keeps blowing this long (ms) after its back has passed the furthest player (downwind) it was
 *  sent at, so riding away from it only works on a fast bike. */
const FRONT_LINGER_MS = 45_000;
/** A front held back by a boss being out tries again this long (ms) after. */
const FRONT_RETRY_MS = 3 * 60_000;
/** Time between poison gas clouds (ms), and before the first one after the world starts; due by day (or too late in
 *  the night), one waits for the next night with GAS_NIGHT_LEFT of dark ahead. A day is 30 min, half of it night, so
 *  that's one night in three or four. */
const GAS_GAP_MIN_MS = 60 * 60_000;
const GAS_GAP_MAX_MS = 110 * 60_000;
const GAS_FIRST_MIN_MS = 25 * 60_000;
/** Real ms of night it needs ahead of it, to creep in, lie and sink away before dawn. */
const GAS_NIGHT_LEFT_MS = 5 * 60_000;
/** It sinks away this long (ms) after its back has passed the furthest player it was sent at. */
const GAS_LINGER_MS = 20_000;
/** A sand vortex summoned from the debug menu (the world's own roam for ever, shared/vortex.ts) lasts this long (ms). */
const VORTEX_SUMMON_MS = 6 * 60_000;

/** A big event (front or gas) keeps the other kind away this long (ms) after it has ended. */
const BIG_GAP_MS = 20 * 60_000;

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class StormServer {
  storms: Storm[] = [];
  gas: Gas[] = [];
  vortices: Vortex[] = [];
  private nextId = 1;
  private nextAt: number;
  private nextFrontAt: number;
  private nextGasAt: number;
  private changed = false;
  /** Debug menu: no random storms (and any blowing now are cleared). */
  off = false;

  /** `roamers`: the world has its sand vortices (not the lab or the art bench). */
  constructor(now: number, roamers = true) {
    this.nextAt = now + rand(GAP_MIN_MS, GAP_MAX_MS) / 2;
    this.nextFrontAt = now + rand(FRONT_FIRST_MIN_MS, FRONT_GAP_MAX_MS);
    this.nextGasAt = now + rand(GAS_FIRST_MIN_MS, GAS_GAP_MAX_MS);
    // The world's sand vortices: out from the start, already spun up, spread round the base, roaming for ever.
    const turn = Math.random() * Math.PI * 2;
    for (let i = 0; roamers && i < ROAMERS; i++) {
      const seed = Math.round(((turn + (i / ROAMERS) * Math.PI * 2) % (Math.PI * 2)) * 1000) / 1000;
      this.vortices.push({ id: this.nextId++, x: Math.round(ORIGIN.x), z: Math.round(ORIGIN.z), start: Math.round(now - VORTEX_RAMP_MS), end: NEVER, seed, roam: true });
    }
  }

  /** Server time `now` (ms), where the players are and the time of day (shared/sun.ts). Returns a 'storms' message
   *  when a list changed. `boss`: a boss is alive somewhere, so no front or gas comes (it waits till after the fight). */
  tick(now: number, players: { x: number; z: number }[], tod: number, boss = false): ServerMsg | null {
    const night = sunElevation(tod) < 0;
    const live = this.off ? [] : this.storms.filter((s) => s.end > now);
    if (live.length !== this.storms.length) {
      this.storms = live;
      this.changed = true;
    }
    const gas = this.off ? [] : this.gas.filter((g) => g.end > now);
    if (gas.length !== this.gas.length) {
      this.gas = gas;
      this.changed = true;
    }
    // (The roamers are part of the world: weather off or not, they stay.)
    const vortices = this.vortices.filter((v) => v.roam || (!this.off && v.end > now));
    if (vortices.length !== this.vortices.length) {
      this.vortices = vortices;
      this.changed = true;
    }
    const big = this.gas.length > 0 || this.storms.some((s) => s.front);
    if (now >= this.nextAt) {
      this.nextAt = now + rand(GAP_MIN_MS, GAP_MAX_MS) * (night ? NIGHT_GAP : 1);
      const p = players[Math.floor(Math.random() * players.length)];
      if (p && !this.off && !big && this.storms.length < MAX_STORMS) this.spawn(p.x, p.z, OFFSET, now);
    }
    if (now >= this.nextFrontAt && (boss || big)) this.nextFrontAt = now + FRONT_RETRY_MS;
    else if (now >= this.nextFrontAt) {
      this.nextFrontAt = now + rand(FRONT_GAP_MIN_MS, FRONT_GAP_MAX_MS);
      if (players.length && !this.off) this.spawnFront(players, now);
    }
    if (now >= this.nextGasAt && (boss || big)) this.nextGasAt = now + FRONT_RETRY_MS;
    else if (now >= this.nextGasAt && nightLeftMs(tod) >= GAS_NIGHT_LEFT_MS) {
      this.nextGasAt = now + rand(GAS_GAP_MIN_MS, GAS_GAP_MAX_MS);
      if (players.length && !this.off) this.spawnGas(players, now);
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

  /** Debug menu: a sand vortex already spun up within sight of (x, z): `ahead` m upwind of it if its path from there stays
   *  clear of the base and the ship for a few minutes, else on the first clear spot round them (you start there). */
  summonVortex(x: number, z: number, ahead: number, now: number) {
    const tries: [number, number][] = [[x - WIND.x * ahead, z - WIND.z * ahead]];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2, r = KEEP_OUT + 350;
      tries.push([ORIGIN.x + Math.sin(a) * r, ORIGIN.z + Math.cos(a) * r]);
    }
    const start = Math.round(now - VORTEX_RAMP_MS);
    for (const [tx, tz] of tries) {
      const v: Vortex = { id: this.nextId, x: Math.round(tx), z: Math.round(tz), start, end: Math.round(now + VORTEX_SUMMON_MS), seed: Math.round(Math.random() * 6283) / 1000 };
      let clear = true;
      for (let t = now; t < now + 240_000 && clear; t += 5000) clear = vortexEnvelope(v, t) > 0.95;
      if (!clear) continue;
      this.nextId++;
      this.vortices.push(v);
      this.changed = true;
      return;
    }
  }

  /** A mega-storm front rolling in from upwind of everyone: it reaches the first of `players` FRONT_LEAD_S
   *  from `now`, and dies down once it has blown over the last. */
  spawnFront(players: { x: number; z: number }[], now: number) {
    let first = Infinity, last = -Infinity;
    for (const p of players) {
      const a = p.x * WIND.x + p.z * WIND.z;
      first = Math.min(first, a);
      last = Math.max(last, a);
    }
    const a0 = first - FRONT_SPEED * FRONT_LEAD_S;
    const depth = FRONT_SPEED * FRONT_PASS_S;
    this.storms.push({
      id: this.nextId++,
      x: Math.round(WIND.x * a0),
      z: Math.round(WIND.z * a0),
      r: depth,
      speed: FRONT_SPEED,
      start: Math.round(now),
      end: Math.round(now + ((last - a0 + depth) / FRONT_SPEED) * 1000 + FRONT_LINGER_MS),
      front: true,
    });
    this.apart(this.storms[this.storms.length - 1].end);
    this.changed = true;
  }

  /** Poison gas creeping in from a random side: it reaches the first of `players` GAS_LEAD_S from `now` and sinks
   *  away once it has passed the last. */
  spawnGas(players: { x: number; z: number }[], now: number) {
    const a = Math.random() * Math.PI * 2;
    const dx = Math.cos(a), dz = Math.sin(a);
    let first = Infinity, last = -Infinity;
    for (const p of players) {
      const along = p.x * dx + p.z * dz;
      first = Math.min(first, along);
      last = Math.max(last, along);
    }
    const a0 = first - GAS_SPEED * GAS_LEAD_S;
    const depth = GAS_SPEED * GAS_PASS_S;
    this.gas.push({
      id: this.nextId++,
      x: Math.round(dx * a0),
      z: Math.round(dz * a0),
      dx, dz,
      speed: GAS_SPEED,
      r: depth,
      start: Math.round(now),
      end: Math.round(now + ((last - a0 + depth) / GAS_SPEED) * 1000 + GAS_LINGER_MS),
    });
    this.apart(this.gas[this.gas.length - 1].end);
    this.changed = true;
  }

  /** A big event ending at `end`: neither kind comes again until BIG_GAP_MS after it. */
  private apart(end: number) {
    this.nextFrontAt = Math.max(this.nextFrontAt, end + BIG_GAP_MS);
    this.nextGasAt = Math.max(this.nextGasAt, end + BIG_GAP_MS);
  }

  msg(): ServerMsg {
    return { t: 'storms', storms: this.storms, gas: this.gas, vortices: this.vortices };
  }
}

/** Real ms from time of day `tod` until the sun is up again (0 by day). */
function nightLeftMs(tod: number): number {
  const step = 1 / 288; // 5 game minutes
  let n = 0;
  while (n < 160 && sunElevation(tod + n * step) < 0) n++;
  return n * step * DAY_SECONDS * 1000;
}
