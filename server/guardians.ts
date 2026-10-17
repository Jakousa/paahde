// Server side of the walkers (guardians, crawlers) and night drones (shared/guardians.ts): where they walk and fly,
// who they see, who gets burned, bitten, shot or crushed. In memory only: a restart puts every guardian back at its
// post. Ticked at TICK_HZ; every player gets the ones near them ('bots').
//
// Guardians are few and roam the whole desert from site to site. Crawlers and drones belong to a crash site: they
// turn up there when someone comes near (crawlers any time, drones at night) and go when everyone has left.
import { BASE, inBase } from '../shared/base.ts';
import { allCrashSites, type CrashSite } from '../shared/crashsites.ts';
import {
  ALERT_R, beamDir, BITE_HEAT, BITE_MS, BLAST_R, BODY_H, BOLT_R, BOLT_RANGE, BOLT_SPEED, BURN, CHARGE_MS, CHASE_BACK, CHASE_SPEED,
  CRAWLER, CRAWLER_CALM_MS, CRAWLER_CHASE_MS, DRONE_ALT, DRONE_SPEED, FIRE_MS, FIRE_R, GUARDIAN, gunPivot, inBeam, KINDS, type Kind, lineOfSight, LOSE_MS, MUZZLE,
  NIGHT_SUN, sweepAt,
} from '../shared/guardians.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { sunElevation } from '../shared/sun.ts';
import { heightAt, WORLD_HALF } from '../shared/terrain.ts';

export const TICK_HZ = 10;
/** Players get guardians and drones within this distance (m), crawlers within CRAWLER_SEND_R. */
export const SEND_R = 1200;
const CRAWLER_SEND_R = 300;
/** How many guardians roam the desert, starting at crash sites this many places apart in the list nearest the base,
 *  from the GUARDIAN_FIRST'th (the closest ones are the first a new player visits: leave those to the crawlers). */
const GUARDIANS = 3;
const GUARDIAN_SPREAD = 5;
const GUARDIAN_FIRST = 3;
/** Walkers never come this close (m) to the base: it's safe ground. */
const BASE_KEEP_OUT = 200;
/** Patrol waypoints lie this far (m) from the site's centre, by kind. */
const PATROL: Record<Kind, [number, number]> = { [GUARDIAN]: [30, 80], [CRAWLER]: [6, 34] };
/** At a waypoint: the chance to stand guard for a while (GUARD_MIN..MAX ms), and (guardians) to move on to another site. */
const GUARD_CHANCE: Record<Kind, number> = { [GUARDIAN]: 0.3, [CRAWLER]: 0.45 };
const GUARD_MIN = 4_000, GUARD_MAX = 20_000;
const WANDER_CHANCE = 0.4;
/** The next site is at most this far (m). */
const WANDER_R = 1500;
/** A hunt ends this long (ms) after the walker last knew where you are, or once you're this far (m) from it (crawlers:
 *  from their site). */
const HUNT_FORGET = 15_000;
const HUNT_GIVE_UP_R: Record<Kind, number> = { [GUARDIAN]: 200, [CRAWLER]: 70 };
/** After crushing someone, a guardian ignores everyone for this long (ms). */
const CALM_MS = 20_000;
/** Crawlers come to a site when someone is this close (m) and leave when nobody is within SITE_LEAVE_R. */
const SITE_NEAR_R = 300;
const SITE_LEAVE_R = 450;
const CRAWLERS_MIN = 3, CRAWLERS_MAX = 6;
/** Drones over a site at night, all drones at most; they come in from DRONE_FROM (m) and patrol within DRONE_AREA. */
const DRONES_PER_SITE = 2;
const MAX_DRONES = 16;
const DRONE_FROM = 220;
const DRONE_AREA = 110;
/** A drone with nobody within this distance (m) leaves. */
const DRONE_LONELY = 600;
/** Drones keep this far (m) from the base. */
const DRONE_BASE_KEEP_OUT = 60;

/** What the bots need to know about a player (feet position; `safe` = just respawned, can't be hurt). */
export type BotPlayer = { id: number; x: number; y: number; z: number; safe: boolean };

type Guardian = {
  id: number; kind: Kind; legs: 3 | 4; x: number; z: number; yaw: number; speed: number;
  home: CrashSite; tx: number; tz: number; guardUntil: number;
  /** Hunting this player id (-1 none) since when, last known where, when; calm until; last bite. */
  prey: number; huntAt: number; px: number; pz: number; knownAt: number; calmUntil: number; bitAt: number;
  /** The cannon: aimed at (ax, ay, az) while it sees its prey; charging since (-1 not), last fired. */
  aiming: boolean; ax: number; ay: number; az: number; chargeAt: number; firedAt: number;
};

type Bolt = { id: number; x: number; y: number; z: number; dx: number; dy: number; dz: number; flown: number; by: number };

/** A bolt fired or burst (shared/protocol.ts 'shot' / 'boom'), where. */
export type BoltEvent = { msg: ServerMsg; x: number; z: number };

type Drone = {
  id: number; x: number; y: number; z: number; yaw: number;
  /** Patrol area centre, current waypoint; the crash site it guards (-1: summoned). */
  hx: number; hz: number; tx: number; tz: number; site: number;
  /** Locked on to this player (-1 none), last lit when. Leaving: flying off before dawn. */
  lock: number; litAt: number; leaving: boolean;
  /** Summoned from the debug menu: stays out until then (server ms), day or not. */
  until: number;
  /** Beam direction (unit), sent to clients. */
  dx: number; dy: number; dz: number;
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export class GuardianServer {
  guardians: Guardian[] = [];
  drones: Drone[] = [];
  bolts: Bolt[] = [];
  private nextBolt = 1;
  private sites = allCrashSites();
  private nextDrone = 1;
  private nextWalker = 1;
  /** Crash sites (ids) with crawlers out right now. */
  private swarmed = new Set<number>();

  constructor() {
    const near = [...this.sites].sort((a, b) => Math.hypot(a.x - BASE.x, a.z - BASE.z) - Math.hypot(b.x - BASE.x, b.z - BASE.z));
    for (let i = 0; i < GUARDIANS && GUARDIAN_FIRST + i * GUARDIAN_SPREAD < near.length; i++) {
      const home = near[GUARDIAN_FIRST + i * GUARDIAN_SPREAD];
      this.guardians.push(this.walker(GUARDIAN, i % 3 === 2 ? 3 : 4, home, home.x + 50, home.z));
    }
  }

  private walker(kind: Kind, legs: 3 | 4, home: CrashSite, x: number, z: number): Guardian {
    const g: Guardian = {
      id: this.nextWalker++, kind, legs, x, z, yaw: rand(-Math.PI, Math.PI), speed: 0, home,
      tx: home.x, tz: home.z, guardUntil: 0, prey: -1, huntAt: 0, px: 0, pz: 0, knownAt: 0, calmUntil: 0, bitAt: 0,
      aiming: false, ax: 0, ay: 0, az: 0, chargeAt: -1, firedAt: 0,
    };
    this.patrolPoint(g);
    return g;
  }

  /** Crawlers out at the sites someone is near, gone from the ones everyone has left. */
  private swarm(players: BotPlayer[]) {
    const near = (s: CrashSite, r: number) => players.some((p) => Math.hypot(p.x - s.x, p.z - s.z) < r);
    for (const id of this.swarmed) {
      const s = this.sites.find((o) => o.id === id)!;
      if (near(s, SITE_LEAVE_R)) continue;
      this.swarmed.delete(id);
      this.guardians = this.guardians.filter((g) => g.kind !== CRAWLER || g.home !== s);
    }
    for (const s of this.sites) {
      if (this.swarmed.has(s.id) || !near(s, SITE_NEAR_R)) continue;
      this.swarmed.add(s.id);
      const n = CRAWLERS_MIN + Math.floor(Math.random() * (CRAWLERS_MAX - CRAWLERS_MIN + 1));
      for (let i = 0; i < n; i++) {
        const a = rand(-Math.PI, Math.PI), r = rand(...PATROL[CRAWLER]);
        this.guardians.push(this.walker(CRAWLER, 4, s, s.x + Math.sin(a) * r, s.z + Math.cos(a) * r));
      }
    }
  }

  /**
   * Advance by dt seconds at server time `now` (ms), wall-clock time of day `tod`. Returns who the drone beams are
   * burning (player id → heat per second), who was crushed, who was shot, and the bolts fired and burst.
   */
  tick(dt: number, now: number, tod: number, players: BotPlayer[]): {
    burn: Map<number, number>; bitten: Map<number, number>; crushed: number[]; shot: number[]; events: BoltEvent[];
  } {
    const burn = new Map<number, number>(), bitten = new Map<number, number>();
    const crushed: number[] = [], shot: number[] = [], events: BoltEvent[] = [];
    const byId = new Map(players.map((p) => [p.id, p]));
    const exposed = players.filter((p) => !p.safe && !inBase(p.x, p.y, p.z));
    this.swarm(players);
    this.tickDrones(dt, now, tod, players, exposed, byId, burn);
    for (const g of this.guardians) {
      this.tickGuardian(g, dt, now, exposed, byId, crushed, bitten);
      if (KINDS[g.kind].gun) this.tickGun(g, now, byId, events);
    }
    this.tickBolts(dt, exposed, shot, events);
    return { burn, bitten, crushed, shot, events };
  }

  /** The cannon: follows the prey it can see, charges, fires. */
  private tickGun(g: Guardian, now: number, byId: Map<number, BotPlayer>, events: BoltEvent[]) {
    const p = g.prey >= 0 ? byId.get(g.prey) : undefined;
    const sc = KINDS[g.kind].scale;
    const pv = gunPivot(g.x, heightAt(g.x, g.z) + BODY_H * sc, g.z, g.yaw, sc, { x: 0, y: 0, z: 0 });
    const cy = p ? p.y + 1.1 : 0;
    g.aiming = !!p && !p.safe && !inBase(p.x, p.y, p.z) && Math.hypot(p.x - pv.x, cy - pv.y, p.z - pv.z) < FIRE_R
      && lineOfSight(pv.x, pv.y, pv.z, p.x, cy, p.z);
    if (!g.aiming || !p) {
      g.chargeAt = -1;
      return;
    }
    g.ax = p.x;
    g.ay = cy;
    g.az = p.z;
    // It sees them: keeps after them.
    g.px = p.x;
    g.pz = p.z;
    g.knownAt = now;
    if (g.chargeAt < 0) {
      if (now - g.firedAt >= FIRE_MS) g.chargeAt = now;
      return;
    }
    if (now - g.chargeAt < CHARGE_MS) return;
    g.chargeAt = -1;
    g.firedAt = now;
    const dx = p.x - pv.x, dy = cy - pv.y, dz = p.z - pv.z, l = Math.hypot(dx, dy, dz);
    const b: Bolt = {
      id: this.nextBolt++, x: pv.x + (dx / l) * MUZZLE * sc, y: pv.y + (dy / l) * MUZZLE * sc, z: pv.z + (dz / l) * MUZZLE * sc,
      dx: dx / l, dy: dy / l, dz: dz / l, flown: 0, by: g.id,
    };
    this.bolts.push(b);
    events.push({ x: b.x, z: b.z, msg: { t: 'shot', id: b.id, g: g.id, time: now, x: r2(b.x), y: r2(b.y), z: r2(b.z), dx: r3(b.dx), dy: r3(b.dy), dz: r3(b.dz) } });
  }

  /** Bolts fly on; one that meets a player or the ground bursts there and kills whoever is within BLAST_R. */
  private tickBolts(dt: number, exposed: BotPlayer[], shot: number[], events: BoltEvent[]) {
    const step = BOLT_SPEED * dt;
    this.bolts = this.bolts.filter((b) => {
      // Along this tick's segment in short steps: the first player or sand it touches.
      const n = Math.ceil(step / 1.5);
      for (let i = 1; i <= n; i++) {
        const t = (step * i) / n;
        const x = b.x + b.dx * t, y = b.y + b.dy * t, z = b.z + b.dz * t;
        const hit = exposed.find((p) => Math.hypot(p.x - x, p.z - z) < BOLT_R + 0.35 && y > p.y - BOLT_R && y < p.y + 1.8 + BOLT_R);
        const ground = y < heightAt(x, z);
        if (hit || ground || b.flown + t >= BOLT_RANGE) {
          for (const p of exposed) {
            if (p === hit || Math.hypot(p.x - x, p.y + 0.9 - y, p.z - z) < BLAST_R) if (!shot.includes(p.id)) shot.push(p.id);
          }
          events.push({ x, z, msg: { t: 'boom', id: b.id, x: r2(x), y: r2(ground ? heightAt(x, z) : y), z: r2(z), ground } });
          return false;
        }
      }
      b.x += b.dx * step;
      b.y += b.dy * step;
      b.z += b.dz * step;
      b.flown += step;
      return true;
    });
  }

  private tickGuardian(g: Guardian, dt: number, now: number, exposed: BotPlayer[], byId: Map<number, BotPlayer>, crushed: number[], bitten: Map<number, number>) {
    const k = KINDS[g.kind];
    // Notice anyone close by.
    if (now >= g.calmUntil) {
      for (const p of exposed) {
        if (Math.hypot(p.x - g.x, p.z - g.z) > k.sight) continue;
        if (g.prey < 0 || g.prey === p.id) this.hunt(g, p, now);
      }
    }
    if (g.prey >= 0) {
      const p = byId.get(g.prey);
      // Crawlers keep to their site; guardians give up once you've got far from them.
      const far = g.kind === CRAWLER ? Math.hypot(g.px - g.home.x, g.pz - g.home.z) : Math.hypot(g.px - g.x, g.pz - g.z);
      const tired = g.kind === CRAWLER && now - g.huntAt > CRAWLER_CHASE_MS;
      const gone = !p || p.safe || inBase(p.x, p.y, p.z) || now - g.knownAt > HUNT_FORGET || far > HUNT_GIVE_UP_R[g.kind] || tired;
      if (tired) g.calmUntil = now + CRAWLER_CALM_MS;
      if (gone) {
        g.prey = -1;
        this.patrolPoint(g);
      } else {
        g.tx = g.px;
        g.tz = g.pz;
        if (Math.hypot(p.x - g.x, p.z - g.z) < k.reach) {
          if (g.kind === GUARDIAN) {
            crushed.push(p.id);
            g.prey = -1;
            g.calmUntil = now + CALM_MS;
            g.guardUntil = now + GUARD_MIN;
          } else if (now - g.bitAt >= BITE_MS) {
            // Bites, and backs off.
            g.bitAt = now;
            bitten.set(p.id, (bitten.get(p.id) ?? 0) + BITE_HEAT);
            g.prey = -1;
            g.calmUntil = now + CRAWLER_CALM_MS;
            this.patrolPoint(g);
          }
        }
      }
    }
    const hunting = g.prey >= 0;
    const dx = g.tx - g.x, dz = g.tz - g.z, dist = Math.hypot(dx, dz);
    let want = 0;
    const near = g.kind === CRAWLER ? 0.6 : 6, ease = g.kind === CRAWLER ? 0.25 : 1.5;
    if (now < g.guardUntil && !hunting) {
      // Standing guard: slowly looking around.
      g.yaw = wrap(g.yaw + Math.sin(now / 4000 + g.id) * 0.08 * k.turn * 4 * dt);
    } else if (dist < (hunting ? Math.min(1, k.reach * 0.5) : near)) {
      if (!hunting) this.arrive(g, now);
    } else {
      const turn = wrap(Math.atan2(dx, dz) - g.yaw);
      const rate = (hunting ? k.huntTurn : k.turn) * dt;
      g.yaw = wrap(g.yaw + Math.max(-rate, Math.min(rate, turn)));
      // Walks on while roughly facing the way; turns on the spot when it isn't. Slows down to arrive.
      want = (hunting ? k.hunt : k.patrol) * Math.max(0, Math.cos(turn)) ** 2 * Math.min(1, dist / (near + 2));
    }
    g.speed += (want - g.speed) * (1 - Math.exp(-dt / ease));
    let nx = g.x + Math.sin(g.yaw) * g.speed * dt, nz = g.z + Math.cos(g.yaw) * g.speed * dt;
    // The base is out of bounds: stopped at the edge (and it gives up the hunt there).
    const bd = Math.hypot(nx - BASE.x, nz - BASE.z);
    if (bd < BASE_KEEP_OUT) {
      nx = BASE.x + ((nx - BASE.x) / bd) * BASE_KEEP_OUT;
      nz = BASE.z + ((nz - BASE.z) / bd) * BASE_KEEP_OUT;
      if (!hunting) this.patrolPoint(g);
    }
    g.x = nx;
    g.z = nz;
  }

  private hunt(g: Guardian, p: BotPlayer, now: number) {
    if (g.prey !== p.id) g.huntAt = now;
    g.prey = p.id;
    g.px = p.x;
    g.pz = p.z;
    g.knownAt = now;
    g.guardUntil = 0;
  }

  /** Reached a waypoint: stand guard, wander off to another site, or on to the next point around this one. */
  private arrive(g: Guardian, now: number) {
    if (Math.random() < GUARD_CHANCE[g.kind]) g.guardUntil = now + rand(GUARD_MIN, GUARD_MAX) * (g.kind === CRAWLER ? 0.4 : 1);
    if (g.kind === GUARDIAN && Math.random() < WANDER_CHANCE) {
      const next = this.sites.filter((s) => s !== g.home && Math.hypot(s.x - g.home.x, s.z - g.home.z) < WANDER_R
        && Math.hypot(s.x - BASE.x, s.z - BASE.z) > BASE_KEEP_OUT + PATROL[GUARDIAN][1]
        && !this.guardians.some((o) => o !== g && o.kind === GUARDIAN && o.home === s));
      if (next.length) g.home = next[Math.floor(Math.random() * next.length)];
    }
    this.patrolPoint(g);
  }

  private patrolPoint(g: Guardian) {
    for (let i = 0; i < 10; i++) {
      const a = rand(-Math.PI, Math.PI), r = rand(...PATROL[g.kind]);
      g.tx = g.home.x + Math.sin(a) * r;
      g.tz = g.home.z + Math.cos(a) * r;
      if (Math.hypot(g.tx - BASE.x, g.tz - BASE.z) > BASE_KEEP_OUT + 10) return;
    }
  }

  private tickDrones(dt: number, now: number, tod: number, players: BotPlayer[], exposed: BotPlayer[], byId: Map<number, BotPlayer>, burn: Map<number, number>) {
    const night = sunElevation(tod) < NIGHT_SUN;
    // At night, every crash site someone is near has its drones over it.
    if (night) {
      for (const s of this.sites) {
        if (this.drones.length >= MAX_DRONES) break;
        if (!exposed.some((p) => Math.hypot(p.x - s.x, p.z - s.z) < SITE_NEAR_R)) continue;
        let have = this.drones.filter((d) => !d.leaving && d.site === s.id).length;
        for (; have < DRONES_PER_SITE && this.drones.length < MAX_DRONES; have++) this.spawnDrone(s.x, s.z, s.id, 0, DRONE_FROM);
      }
    }
    const v = { x: 0, y: 0, z: 0 };
    for (const d of this.drones) {
      if ((!night && now > d.until) || !players.some((p) => Math.hypot(p.x - d.hx, p.z - d.hz) < DRONE_LONELY)) d.leaving = true;
      let speed = DRONE_SPEED, tx = d.tx, tz = d.tz, alt = DRONE_ALT;
      const prey = d.lock >= 0 ? byId.get(d.lock) : undefined;
      if (d.leaving) {
        d.lock = -1;
        alt = DRONE_ALT * 5;
        speed = CHASE_SPEED;
        tx = d.x + Math.sin(d.yaw) * 100;
        tz = d.z + Math.cos(d.yaw) * 100;
      } else if (prey) {
        // Hang back from them, beam on them.
        const hx = d.x - prey.x, hz = d.z - prey.z, h = Math.hypot(hx, hz) || 1;
        tx = prey.x + (hx / h) * CHASE_BACK;
        tz = prey.z + (hz / h) * CHASE_BACK;
        speed = CHASE_SPEED;
      } else if (Math.hypot(tx - d.x, tz - d.z) < 5) {
        this.dronePoint(d);
      }
      // Fly: turn towards the target, ease the height over the ground ahead.
      const dx = tx - d.x, dz = tz - d.z, dist = Math.hypot(dx, dz);
      if (dist > 0.5) {
        const step = Math.min(dist, speed * dt);
        d.x += (dx / dist) * step;
        d.z += (dz / dist) * step;
        if (!prey) d.yaw = wrap(d.yaw + wrap(Math.atan2(dx, dz) - d.yaw) * (1 - Math.exp(-dt * 1.5)));
      }
      const bd = Math.hypot(d.x - BASE.x, d.z - BASE.z);
      if (bd < DRONE_BASE_KEEP_OUT && !d.leaving) {
        d.x = BASE.x + ((d.x - BASE.x) / bd) * DRONE_BASE_KEEP_OUT;
        d.z = BASE.z + ((d.z - BASE.z) / bd) * DRONE_BASE_KEEP_OUT;
        this.dronePoint(d);
      }
      const ground = Math.max(heightAt(d.x, d.z), heightAt(d.x + Math.sin(d.yaw) * 15, d.z + Math.cos(d.yaw) * 15));
      d.y += (ground + alt - d.y) * (1 - Math.exp(-dt * (d.leaving ? 0.3 : 1.2)));
      // Aim the beam: at the prey, or sweeping ahead.
      if (prey) {
        const ax = prey.x - d.x, ay = prey.y + 1.1 - d.y, az = prey.z - d.z, l = Math.hypot(ax, ay, az) || 1;
        d.dx = ax / l;
        d.dy = ay / l;
        d.dz = az / l;
        d.yaw = wrap(d.yaw + wrap(Math.atan2(ax, az) - d.yaw) * (1 - Math.exp(-dt * 3)));
      } else {
        beamDir(d.yaw, sweepAt(d.id, now), v);
        d.dx = v.x;
        d.dy = v.y;
        d.dz = v.z;
      }
      if (d.leaving) continue;
      // Who's in the beam.
      if (prey && inBeam(d.x, d.y, d.z, d.dx, d.dy, d.dz, prey.x, prey.y, prey.z) && !prey.safe) d.litAt = now;
      else if (d.lock >= 0 && now - d.litAt > LOSE_MS) d.lock = -1;
      if (d.lock < 0) {
        for (const p of exposed) {
          if (!inBeam(d.x, d.y, d.z, d.dx, d.dy, d.dz, p.x, p.y, p.z)) continue;
          d.lock = p.id;
          d.litAt = now;
          break;
        }
      }
      // Burning whoever it has right now, and calling the guardians.
      if (d.lock >= 0 && d.litAt === now) {
        const p = byId.get(d.lock)!;
        burn.set(p.id, Math.max(burn.get(p.id) ?? 0, BURN));
        for (const g of this.guardians) {
          if (now < g.calmUntil || (g.prey >= 0 && g.prey !== p.id) || g.kind !== GUARDIAN) continue;
          if (Math.hypot(g.x - p.x, g.z - p.z) < ALERT_R) this.hunt(g, p, now);
        }
      }
    }
    this.drones = this.drones.filter((d) => !d.leaving || d.y < heightAt(d.x, d.z) + DRONE_ALT * 4.5);
  }

  /** Debug menu: the nearest guardian walks in from 90 m away, or a drone comes for a minute. */
  summon(what: unknown, p: BotPlayer, now: number) {
    if (what === 'drone') return this.spawnDrone(p.x, p.z, -1, now + 60_000, 70);
    const big = this.guardians.filter((g) => g.kind === GUARDIAN);
    if (what !== 'guardian' || !big.length) return;
    const g = big.reduce((a, b) => (Math.hypot(a.x - p.x, a.z - p.z) < Math.hypot(b.x - p.x, b.z - p.z) ? a : b));
    const a = rand(-Math.PI, Math.PI);
    g.x = p.x + Math.sin(a) * 90;
    g.z = p.z + Math.cos(a) * 90;
    g.yaw = Math.atan2(p.x - g.x, p.z - g.z);
    g.tx = p.x;
    g.tz = p.z;
    g.prey = -1;
    g.guardUntil = 0;
    g.calmUntil = 0;
  }

  /** A drone coming in from `from` m away to patrol around (hx, hz), over crash site `site` (-1: summoned). */
  private spawnDrone(hx: number, hz: number, site: number, until: number, from: number) {
    const a = rand(-Math.PI, Math.PI);
    const x = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, hx + Math.sin(a) * from));
    const z = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, hz + Math.cos(a) * from));
    const d: Drone = {
      id: this.nextDrone++, x, z, y: heightAt(x, z) + DRONE_ALT, yaw: Math.atan2(hx - x, hz - z),
      hx, hz, tx: hx, tz: hz, site, lock: -1, litAt: 0, leaving: false, dx: 0, dy: -1, dz: 0, until,
    };
    // First pass: across the site from where it came in.
    d.tx = hx + rand(-30, 30);
    d.tz = hz + rand(-30, 30);
    this.drones.push(d);
  }

  private dronePoint(d: Drone) {
    const a = rand(-Math.PI, Math.PI), r = rand(20, DRONE_AREA);
    d.tx = d.hx + Math.sin(a) * r;
    d.tz = d.hz + Math.cos(a) * r;
  }

  /** The 'bots' message for a player at (x, z): guardians and drones within SEND_R, flagged when after them. */
  msg(time: number, id: number, x: number, z: number): ServerMsg {
    const g: number[] = [], d: number[] = [];
    for (const o of this.guardians) {
      if (Math.hypot(o.x - x, o.z - z) > (o.kind === CRAWLER ? CRAWLER_SEND_R : SEND_R)) continue;
      g.push(o.id, o.kind, o.legs, r2(o.x), r2(o.z), r3(o.yaw), o.prey < 0 ? 0 : o.prey === id ? 2 : 1,
        o.aiming ? r2(o.ax) : 0, o.aiming ? r2(o.ay) : 0, o.aiming ? r2(o.az) : 0, o.chargeAt >= 0 ? 1 : o.aiming ? 0 : -1);
    }
    for (const o of this.drones) {
      if (Math.hypot(o.x - x, o.z - z) > SEND_R) continue;
      d.push(o.id, r2(o.x), r2(o.y), r2(o.z), r3(o.yaw), r3(o.dx), r3(o.dy), r3(o.dz), o.lock < 0 ? 0 : o.lock === id ? 2 : 1);
    }
    return { t: 'bots', time, g, d };
  }
}
