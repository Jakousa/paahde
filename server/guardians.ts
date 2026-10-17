// Server side of the walkers (guardians, crawlers) and night drones (shared/guardians.ts): where they walk and fly,
// who they see, who gets burned, bitten, shot or crushed. In memory only: a restart puts every guardian back at its
// post. Ticked at TICK_HZ; every player gets the ones near them ('bots').
//
// Guardians are few and roam guardian ground (crash sites of level 2, shared/crashsites.ts SiteLevel) from site to
// site. Crawlers and drones belong to a crash site: they turn up there when someone comes near (crawlers any time at
// crawler and guardian ground, drones at night there too) and go when everyone has left. The scrap fields
// (level 0) near the base have none. A few more drones roam the open desert day and night (ROAMERS), drifting in
// near someone now and then on long legs, and flying off again after a few minutes.
import { BASE, inBase } from '../shared/base.ts';
import { allCrashSites, type CrashSite } from '../shared/crashsites.ts';
import {
  ALERT_R, beamDir, BITE_HEAT, BITE_MS, BLAST_R, BODY_H, BOLT_R, BOLT_RANGE, BOLT_SPEED, CHARGE_MS, CHASE_BACK, CHASE_SPEED,
  CRAWLER, CRAWLER_CALM_MS, CRAWLER_CHASE_MS, DRONE_ALT, DRONE_SPEED, FIRE_MS, FIRE_R, GUARDIAN, gunPivot, IGNORE_MS, inBeam, KINDS, type Kind, lineOfSight, LOSE_MS, MUZZLE,
  NIGHT_SUN, NOTICE_R, REST_R, SEEK_GIVE_UP, SEEK_RATE, sweepAt, TRACK_RATE,
} from '../shared/guardians.ts';
import {
  BLAST_R as MISSILE_BLAST_R, FIRST_MS, flightTime, LEAD, MISSILE_MIN_R, MISSILE_MS, MISSILE_R, type MissilePath, SCATTER, SHOOTERS,
} from '../shared/missiles.ts';
import { nearStorm, type Storm } from '../shared/storm.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { allBroken, DRONE_HIT, DRONE_HP, DRONE_WRECK_S, RANGE, weakPoints, WRECK_S } from '../shared/rifle.ts';
import { sunElevation } from '../shared/sun.ts';
import { heightAt, WORLD_HALF } from '../shared/terrain.ts';

export const TICK_HZ = 10;
/** Players get guardians and drones within this distance (m), crawlers within CRAWLER_SEND_R. */
export const SEND_R = 1200;
const CRAWLER_SEND_R = 300;
/** How many guardians roam guardian ground, starting spread evenly over its sites from nearest the base to farthest. */
const GUARDIANS = 4;
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
const CRAWLERS_MIN = 1, CRAWLERS_MAX = 4;
/** Drones over a site at night, all drones at most; they come in from DRONE_FROM (m) and patrol within DRONE_AREA. */
const DRONES_PER_SITE = 2;
const MAX_DRONES = 16;
const DRONE_FROM = 220;
const DRONE_AREA = 110;
/** A drone with nobody within this distance (m) leaves. */
const DRONE_LONELY = 600;
/** Drones keep this far (m) from the base. */
const DRONE_BASE_KEEP_OUT = 60;
/** Roaming drones (site ROAM): at most ROAMERS out at once. Someone out in the open with fewer than ROAM_EACH within
 *  ROAM_NEAR (m) gets one about every ROAM_EVERY_S seconds, coming in from ROAM_FROM (m); it stays ROAM_MIN..MAX ms, flying legs of
 *  ROAM_LEG (m), and keeps ROAM_BASE_KEEP_OUT (m) from the base. */
const ROAM = -2;
const ROAMERS = 6;
const ROAM_NEAR = 800;
const ROAM_EACH = 2;
const ROAM_EVERY_S = 60;
const ROAM_FROM: [number, number] = [300, 420];
const ROAM_MIN = 3 * 60_000, ROAM_MAX = 6 * 60_000;
const ROAM_LEG: [number, number] = [120, 350];
const ROAM_BASE_KEEP_OUT = 250;
/** A dead walker's wreck lies where it fell this long (ms), by kind; a dead guardian is replaced after GUARDIAN_BACK_MS
 *  by a new one at a site far from where it died. */
const WRECK_MS: Record<Kind, number> = { [GUARDIAN]: WRECK_S[GUARDIAN] * 1000, [CRAWLER]: WRECK_S[CRAWLER] * 1000 };
const GUARDIAN_BACK_MS = 8 * 60_000;
const GUARDIAN_BACK_FAR = 900;
/** A rifle shot counts against a walker if it passes and ends within this far (m, × scale) of the body's centre. */
const SHOT_SLACK = REST_R + 6;

/** What the bots need to know about a player (feet position; `safe` = just respawned, can't be hurt). */
export type BotPlayer = { id: number; x: number; y: number; z: number; safe: boolean };

type Guardian = {
  id: number; kind: Kind; legs: 3 | 4; x: number; z: number; yaw: number; speed: number;
  home: CrashSite; tx: number; tz: number; guardUntil: number;
  /** Hunting this player id (-1 none) since when, last known where, when; calm until; last bite. */
  prey: number; huntAt: number; px: number; pz: number; knownAt: number; calmUntil: number; bitAt: number;
  /** The cannon: aimed at (ax, ay, az) while it sees its prey; charging since (-1 not), last fired. */
  aiming: boolean; ax: number; ay: number; az: number; chargeAt: number; firedAt: number;
  /** Last missile launched when. */
  missileAt: number;
  /** Weak points (shared/rifle.ts): how many, which are shot (bit mask); died when (-1 alive). */
  points: number; broken: number; deadAt: number;
};

/** A walker killed by a rifle (`by` the shooter's id), for the server to drop its parts. */
export type Kill = { kind: Kind | 'drone'; x: number; z: number; by: number };

type Missile = { id: number; path: MissilePath; launched: number };

type Bolt = { id: number; x: number; y: number; z: number; dx: number; dy: number; dz: number; flown: number; by: number };

/** A bolt fired or burst (shared/protocol.ts 'shot' / 'boom'), where. */
export type BoltEvent = { msg: ServerMsg; x: number; z: number };

type Drone = {
  id: number; x: number; y: number; z: number; yaw: number;
  /** Patrol area centre, current waypoint; the crash site it guards (-1: summoned, ROAM: roaming). */
  hx: number; hz: number; tx: number; tz: number; site: number;
  /** Locked on to this player (-1 none), last lit when. Leaving: flying off before dawn. */
  lock: number; litAt: number; leaving: boolean;
  /** Lost this player (-1 none): won't lock on to them again until then. */
  lost: number; lostUntil: number;
  /** Noticed this player (-1 none) and searching them out with the beam, last saw them when. */
  seek: number; seenAt: number;
  /** Summoned from the debug menu or roaming: stays out until then (server ms), day or not (roaming: no longer). */
  until: number;
  /** Beam direction (unit), sent to clients. */
  dx: number; dy: number; dz: number;
  /** Rifle hits taken; shot down when (-1 flying), falling with velocity (vx, vy, vz), on the sand (crashed). */
  hurt: number; downAt: number; vx: number; vy: number; vz: number; crashed: boolean;
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export class GuardianServer {
  guardians: Guardian[] = [];
  drones: Drone[] = [];
  /** Sandstorms right now (set by the server before each tick), shared/storm.ts. */
  storms: readonly Storm[] = [];
  bolts: Bolt[] = [];
  missiles: Missile[] = [];
  private nextBolt = 1;
  private nextMissile = 1;
  /** Player id → when a drone's beam last caught them after a spell out of it (the salvo starts FIRST_MS later). */
  private spottedAt = new Map<number, number>();
  /** Player positions last tick, for leading the missiles. */
  private lastPos = new Map<number, { x: number; z: number }>();
  private sites = allCrashSites();
  /** Guardian ground: the sites guardians roam. */
  private ground = this.sites.filter((s) => s.level === 2);
  private nextDrone = 1;
  private nextWalker = 1;
  /** Shot-down drones that have hit the sand, for crashes(). */
  private downed: Kill[] = [];
  /** Crash sites (ids) with crawlers out right now. */
  private swarmed = new Set<number>();
  /** Killed guardians come back (server ms), away from (x, z). */
  private comeback: { at: number; x: number; z: number }[] = [];

  constructor() {
    const near = [...this.ground].sort((a, b) => Math.hypot(a.x - BASE.x, a.z - BASE.z) - Math.hypot(b.x - BASE.x, b.z - BASE.z));
    for (let i = 0; i < GUARDIANS && i < near.length; i++) {
      const home = near[Math.floor((i * near.length) / GUARDIANS)];
      this.guardians.push(this.walker(GUARDIAN, i % 3 === 2 ? 3 : 4, home, home.x + 50, home.z));
    }
  }

  private walker(kind: Kind, legs: 3 | 4, home: CrashSite, x: number, z: number): Guardian {
    const g: Guardian = {
      id: this.nextWalker++, kind, legs, x, z, yaw: rand(-Math.PI, Math.PI), speed: 0, home,
      tx: home.x, tz: home.z, guardUntil: 0, prey: -1, huntAt: 0, px: 0, pz: 0, knownAt: 0, calmUntil: 0, bitAt: 0,
      aiming: false, ax: 0, ay: 0, az: 0, chargeAt: -1, firedAt: 0, missileAt: 0,
      points: weakPoints(kind, legs).length, broken: 0, deadAt: -1,
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
      if (s.level === 0 || this.swarmed.has(s.id) || !near(s, SITE_NEAR_R)) continue;
      this.swarmed.add(s.id);
      const n = CRAWLERS_MIN + Math.floor(Math.random() * (CRAWLERS_MAX - CRAWLERS_MIN + 1));
      for (let i = 0; i < n; i++) {
        const a = rand(-Math.PI, Math.PI), r = rand(...PATROL[CRAWLER]);
        this.guardians.push(this.walker(CRAWLER, 4, s, s.x + Math.sin(a) * r, s.z + Math.cos(a) * r));
      }
    }
  }

  /**
   * Advance by dt seconds at server time `now` (ms), wall-clock time of day `tod`. Returns who was bitten (player id
   * → heat), crushed, shot by a bolt or blown up by a missile, and the bolts and missiles fired and burst.
   */
  tick(dt: number, now: number, tod: number, players: BotPlayer[]): {
    bitten: Map<number, number>; crushed: number[]; shot: number[]; blasted: number[]; events: BoltEvent[];
  } {
    const bitten = new Map<number, number>();
    const crushed: number[] = [], shot: number[] = [], blasted: number[] = [], events: BoltEvent[] = [];
    const byId = new Map(players.map((p) => [p.id, p]));
    const exposed = players.filter((p) => !p.safe && !inBase(p.x, p.y, p.z));
    this.swarm(players);
    this.wrecks(now);
    const lit = this.tickDrones(dt, now, tod, players, exposed, byId);
    this.tickMissiles(dt, now, lit, players, exposed, blasted, events);
    for (const g of this.guardians) {
      if (g.deadAt >= 0) continue;
      this.tickGuardian(g, dt, now, exposed, byId, crushed, bitten);
      if (KINDS[g.kind].gun) this.tickGun(g, now, byId, events);
    }
    this.tickBolts(dt, exposed, shot, events);
    return { bitten, crushed, shot, blasted, events };
  }

  /** Missiles: guardians shell their prey, and the nearest ones whoever a drone's beam is on; ones that have landed burst. */
  private tickMissiles(dt: number, now: number, lit: Set<number>, players: BotPlayer[], exposed: BotPlayer[], blasted: number[], events: BoltEvent[]) {
    for (const id of this.spottedAt.keys()) if (!lit.has(id)) this.spottedAt.delete(id);
    for (const p of exposed) {
      if (lit.has(p.id) && !this.spottedAt.has(p.id)) this.spottedAt.set(p.id, now);
      const spotted = lit.has(p.id) && now - this.spottedAt.get(p.id)! >= FIRST_MS;
      const alive = this.guardians.filter((g) => g.kind === GUARDIAN && g.deadAt < 0);
      const shooters = new Set(alive.filter((g) => g.prey === p.id && now - g.huntAt >= FIRST_MS));
      if (spotted) {
        for (const g of alive.filter((g) => Math.hypot(g.x - p.x, g.z - p.z) < MISSILE_R)
          .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z)).slice(0, SHOOTERS)) shooters.add(g);
      }
      if (!shooters.size) continue;
      const prev = this.lastPos.get(p.id);
      const vx = prev ? (p.x - prev.x) / dt : 0, vz = prev ? (p.z - prev.z) / dt : 0;
      for (const g of shooters) {
        if (now - g.missileAt < MISSILE_MS || Math.hypot(g.x - p.x, g.z - p.z) < MISSILE_MIN_R) continue;
        g.missileAt = now;
        const sc = KINDS[g.kind].scale;
        const pv = gunPivot(g.x, heightAt(g.x, g.z) + BODY_H * sc, g.z, g.yaw, sc, { x: 0, y: 0, z: 0 });
        const flight = flightTime(Math.hypot(p.x - pv.x, p.z - pv.z));
        const a = rand(-Math.PI, Math.PI), r = Math.sqrt(Math.random()) * SCATTER;
        const x1 = p.x + vx * flight * LEAD + Math.sin(a) * r, z1 = p.z + vz * flight * LEAD + Math.cos(a) * r;
        const m: Missile = { id: this.nextMissile++, launched: now, path: { x0: r2(pv.x), y0: r2(pv.y), z0: r2(pv.z), x1: r2(x1), y1: r2(heightAt(x1, z1)), z1: r2(z1), flight: r3(flight) } };
        this.missiles.push(m);
        events.push({ x: x1, z: z1, msg: { t: 'missile', id: m.id, g: g.id, time: now, ...m.path } });
      }
    }
    for (const p of players) this.lastPos.set(p.id, { x: p.x, z: p.z });
    if (this.lastPos.size > players.length) for (const id of this.lastPos.keys()) if (!players.some((p) => p.id === id)) this.lastPos.delete(id);
    this.missiles = this.missiles.filter((m) => {
      if (now - m.launched < m.path.flight * 1000) return true;
      const { x1: x, y1: y, z1: z } = m.path;
      for (const p of exposed) if (Math.hypot(p.x - x, p.y + 0.9 - y, p.z - z) < MISSILE_BLAST_R && !blasted.includes(p.id)) blasted.push(p.id);
      events.push({ x, z, msg: { t: 'blast', id: m.id, x, y, z } });
      return false;
    });
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
        if (g.prey === p.id) this.hunt(g, p, now);
        else if (g.prey < 0) {
          this.hunt(g, p, now);
          // One crawler sees you, the whole site's pack comes (bar any backing off after a bite).
          if (g.kind === CRAWLER) {
            for (const o of this.guardians) if (o !== g && o.kind === CRAWLER && o.home === g.home && o.prey < 0 && now >= o.calmUntil && o.deadAt < 0) this.hunt(o, p, now);
          }
        }
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
      const next = this.ground.filter((s) => s !== g.home && Math.hypot(s.x - g.home.x, s.z - g.home.z) < WANDER_R
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

  /** Flies the drones; returns who their beams hold right now. */
  private tickDrones(dt: number, now: number, tod: number, players: BotPlayer[], exposed: BotPlayer[], byId: Map<number, BotPlayer>): Set<number> {
    const lit = new Set<number>();
    const night = sunElevation(tod) < NIGHT_SUN;
    // At night, every crawler- or guardian-ground site someone is near has its drones over it (not the scrap fields).
    if (night) {
      for (const s of this.sites) {
        if (s.level === 0) continue;
        if (this.drones.length >= MAX_DRONES) break;
        if (!exposed.some((p) => Math.hypot(p.x - s.x, p.z - s.z) < SITE_NEAR_R)) continue;
        let have = this.drones.filter((d) => !d.leaving && d.site === s.id).length;
        for (; have < DRONES_PER_SITE && this.drones.length < MAX_DRONES; have++) this.spawnDrone(s.x, s.z, s.id, 0, DRONE_FROM);
      }
    }
    this.roam(dt, now, exposed);
    const v = { x: 0, y: 0, z: 0 };
    for (const d of this.drones) {
      if (d.downAt >= 0) {
        this.fall(d, dt);
        continue;
      }
      if (d.site === ROAM) {
        d.hx = d.x;
        d.hz = d.z;
      }
      if ((now > d.until && (!night || d.site === ROAM)) || !players.some((p) => Math.hypot(p.x - d.hx, p.z - d.hz) < DRONE_LONELY)) d.leaving = true;
      // Near a storm the light is off and it notices nobody (the client darkens it by the same rule).
      const dark = nearStorm(this.storms, d.x, d.z, now);
      if (dark) d.lock = d.seek = -1;
      let speed = DRONE_SPEED, tx = d.tx, tz = d.tz, alt = DRONE_ALT;
      const prey = d.lock >= 0 ? byId.get(d.lock) : undefined;
      if (prey || d.leaving) d.seek = -1;
      if (!prey && !d.leaving && !dark) this.notice(d, now, exposed);
      const sought = d.seek >= 0 ? byId.get(d.seek) : undefined;
      const target = prey ?? sought;
      if (d.leaving) {
        d.lock = -1;
        alt = DRONE_ALT * 5;
        speed = CHASE_SPEED;
        tx = d.x + Math.sin(d.yaw) * 100;
        tz = d.z + Math.cos(d.yaw) * 100;
      } else if (target) {
        // Hang back from them, beam on them (searching them out: at patrol speed).
        const hx = d.x - target.x, hz = d.z - target.z, h = Math.hypot(hx, hz) || 1;
        tx = target.x + (hx / h) * CHASE_BACK;
        tz = target.z + (hz / h) * CHASE_BACK;
        if (prey) speed = CHASE_SPEED;
      } else if (Math.hypot(tx - d.x, tz - d.z) < 5) {
        this.dronePoint(d);
      }
      // Fly: turn towards the target, ease the height over the ground ahead.
      const dx = tx - d.x, dz = tz - d.z, dist = Math.hypot(dx, dz);
      if (dist > 0.5) {
        const step = Math.min(dist, speed * dt);
        d.x += (dx / dist) * step;
        d.z += (dz / dist) * step;
        if (!target) d.yaw = wrap(d.yaw + wrap(Math.atan2(dx, dz) - d.yaw) * (1 - Math.exp(-dt * 1.5)));
      }
      const bd = Math.hypot(d.x - BASE.x, d.z - BASE.z), keep = d.site === ROAM && !prey ? ROAM_BASE_KEEP_OUT : DRONE_BASE_KEEP_OUT;
      if (bd < keep && !d.leaving) {
        d.x = BASE.x + ((d.x - BASE.x) / bd) * keep;
        d.z = BASE.z + ((d.z - BASE.z) / bd) * keep;
        this.dronePoint(d);
      }
      const ground = Math.max(heightAt(d.x, d.z), heightAt(d.x + Math.sin(d.yaw) * 15, d.z + Math.cos(d.yaw) * 15));
      d.y += (ground + alt - d.y) * (1 - Math.exp(-dt * (d.leaving ? 0.3 : 1.2)));
      // Aim the beam: turning after the prey no faster than TRACK_RATE (SEEK_RATE onto someone noticed), or sweeping ahead.
      if (target) {
        const ax = target.x - d.x, ay = target.y + 1.1 - d.y, az = target.z - d.z, l = Math.hypot(ax, ay, az) || 1;
        const cos = Math.max(-1, Math.min(1, (d.dx * ax + d.dy * ay + d.dz * az) / l)), ang = Math.acos(cos);
        const t = ang > 1e-4 ? Math.min(1, ((prey ? TRACK_RATE : SEEK_RATE) * dt) / ang) : 1;
        // Between the two directions by fraction t of the angle (slerp).
        const s0 = ang > 1e-4 ? Math.sin((1 - t) * ang) / Math.sin(ang) : 1 - t, s1 = ang > 1e-4 ? Math.sin(t * ang) / Math.sin(ang) : t;
        const nx = d.dx * s0 + (ax / l) * s1, ny = d.dy * s0 + (ay / l) * s1, nz = d.dz * s0 + (az / l) * s1, nl = Math.hypot(nx, ny, nz) || 1;
        d.dx = nx / nl;
        d.dy = ny / nl;
        d.dz = nz / nl;
        d.yaw = wrap(d.yaw + wrap(Math.atan2(d.dx, d.dz) - d.yaw) * (1 - Math.exp(-dt * 3)));
      } else {
        beamDir(d.yaw, sweepAt(d.id, now), v);
        d.dx = v.x;
        d.dy = v.y;
        d.dz = v.z;
      }
      if (d.leaving || dark) continue;
      // Who's in the beam.
      if (prey && inBeam(d.x, d.y, d.z, d.dx, d.dy, d.dz, prey.x, prey.y, prey.z) && !prey.safe) d.litAt = now;
      else if (d.lock >= 0 && now - d.litAt > LOSE_MS) {
        d.lost = d.lock;
        d.lostUntil = now + IGNORE_MS;
        d.lock = -1;
      }
      if (d.lock < 0) {
        for (const p of exposed) {
          if (p.id === d.lost && now < d.lostUntil) continue;
          if (!inBeam(d.x, d.y, d.z, d.dx, d.dy, d.dz, p.x, p.y, p.z)) continue;
          d.lock = p.id;
          d.litAt = now;
          d.seek = -1;
          break;
        }
      }
      // Whoever it has right now: the missiles come for them (tickMissiles), and the guardians near them.
      if (d.lock >= 0 && d.litAt === now) {
        const p = byId.get(d.lock)!;
        lit.add(p.id);
        for (const g of this.guardians) {
          if (now < g.calmUntil || (g.prey >= 0 && g.prey !== p.id) || g.kind !== GUARDIAN || g.deadAt >= 0) continue;
          if (Math.hypot(g.x - p.x, g.z - p.z) < ALERT_R) this.hunt(g, p, now);
        }
      }
    }
    this.drones = this.drones.filter((d) => d.downAt >= 0 ? now - d.downAt < DRONE_WRECK_S * 1000 : !d.leaving || d.y < heightAt(d.x, d.z) + DRONE_ALT * 4.5);
    return lit;
  }

  /** Searching someone out (d.seek): keeps at it while they're in sight and near, else notices whoever is. */
  private notice(d: Drone, now: number, exposed: BotPlayer[]) {
    const sees = (p: BotPlayer, r: number) => Math.hypot(p.x - d.x, p.z - d.z) < r && lineOfSight(d.x, d.y, d.z, p.x, p.y + 1.1, p.z);
    if (d.seek >= 0) {
      const p = exposed.find((o) => o.id === d.seek);
      if (p && sees(p, NOTICE_R * SEEK_GIVE_UP)) d.seenAt = now;
      else if (!p || now - d.seenAt > LOSE_MS) d.seek = -1;
      if (d.seek >= 0) return;
    }
    let best = NOTICE_R;
    for (const p of exposed) {
      if (p.id === d.lost && now < d.lostUntil) continue;
      const h = Math.hypot(p.x - d.x, p.z - d.z);
      if (h >= best || !sees(p, NOTICE_R)) continue;
      best = h;
      d.seek = p.id;
      d.seenAt = now;
    }
  }

  /** A shot-down drone: drops, carried on by its speed, until it hits the sand (and lies there). */
  private fall(d: Drone, dt: number) {
    if (d.crashed) return;
    d.vy -= 9.8 * dt;
    const drag = Math.exp(-dt * 0.4);
    d.vx *= drag;
    d.vz *= drag;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.z += d.vz * dt;
    const g = heightAt(d.x, d.z) + 0.4;
    if (d.y <= g) {
      d.y = g;
      d.crashed = true;
      this.downed.push({ kind: 'drone', x: d.x, z: d.z, by: -1 });
    }
  }

  /** Drones that hit the sand since the last call (their parts are dropped there). */
  crashes(): Kill[] {
    return this.downed.splice(0);
  }

  /**
   * Player `by` shot from (x, y, z) to (ex, ey, ez) and says it hit drone `id`: plausible (flying, in range, the shot
   * passing and ending near it), it takes the hit; the last one brings it down. Returns whether it counted.
   */
  shootDrone(x: number, y: number, z: number, ex: number, ey: number, ez: number, id: unknown, now: number): boolean {
    const d = this.drones.find((o) => o.id === id);
    if (!d || d.downAt >= 0) return false;
    const dx = ex - x, dy = ey - y, dz = ez - z, len = Math.hypot(dx, dy, dz);
    if (len > RANGE + 5 || len < 0.1) return false;
    const t = Math.max(0, Math.min(1, ((d.x - x) * dx + (d.y - y) * dy + (d.z - z) * dz) / (len * len)));
    // The client draws it 250 ms in the past, and it moves up to CHASE_SPEED: slack for that.
    const slack = DRONE_HIT + 2;
    if (Math.hypot(x + dx * t - d.x, y + dy * t - d.y, z + dz * t - d.z) > slack || Math.hypot(ex - d.x, ey - d.y, ez - d.z) > slack * 1.5) return false;
    if (++d.hurt < DRONE_HP) return true;
    // Down: it drops, still drifting the way it was going, its light out.
    d.downAt = now;
    d.lock = -1;
    const sp = d.leaving ? CHASE_SPEED : DRONE_SPEED * 0.8;
    d.vx = Math.sin(d.yaw) * sp + dx / len * 3;
    d.vz = Math.cos(d.yaw) * sp + dz / len * 3;
    d.vy = 1.5;
    return true;
  }

  /** Debug menu: the nearest guardian walks in from 90 m away, or a drone comes for a minute. */
  summon(what: unknown, p: BotPlayer, now: number) {
    if (what === 'drone') return this.spawnDrone(p.x, p.z, -1, now + 60_000, 70);
    const big = this.guardians.filter((g) => g.kind === GUARDIAN && g.deadAt < 0);
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

  /**
   * Player `by` (feet position) shot from (x, y, z) to (ex, ey, ez) and says it broke weak point `i` of walker `gid`
   * (-1: hit its body). Plausible (alive, the point whole, in range, the shot passing and ending at that walker): broken,
   * and the walker (crawlers: the whole pack) comes for the shooter; a body hit does no harm but angers it the same.
   * Returns whether it broke a point, and the kill if that was the last one.
   */
  shoot(by: BotPlayer, x: number, y: number, z: number, ex: number, ey: number, ez: number, gid: unknown, i: unknown, now: number): { hit: boolean; kill: Kill | null } {
    const miss = { hit: false, kill: null };
    const g = this.guardians.find((o) => o.id === gid);
    const body = i === -1;
    if (!g || g.deadAt >= 0 || (!body && (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= g.points || g.broken & (1 << (i as number))))) return miss;
    const sc = KINDS[g.kind].scale;
    const cx = g.x, cy = heightAt(g.x, g.z) + BODY_H * sc, cz = g.z;
    const dx = ex - x, dy = ey - y, dz = ez - z, len = Math.hypot(dx, dy, dz);
    if (len > RANGE + 5 || len < 0.1) return miss;
    // Closest approach of the shot to the body's centre, and where it ended.
    const t = Math.max(0, Math.min(1, ((cx - x) * dx + (cy - y) * dy + (cz - z) * dz) / (len * len)));
    const near = Math.hypot(x + dx * t - cx, y + dy * t - cy, z + dz * t - cz);
    const slack = SHOT_SLACK * sc + 2;
    if (near > slack || Math.hypot(ex - cx, ey - cy, ez - cz) > slack * 1.5) return miss;
    if (!body) g.broken |= 1 << (i as number);
    if (!body && allBroken(g.broken, g.points)) {
      g.deadAt = now;
      g.prey = -1;
      g.aiming = false;
      g.chargeAt = -1;
      g.speed = 0;
      return { hit: true, kill: { kind: g.kind, x: g.x, z: g.z, by: by.id } };
    }
    // Hurt (or just hit), it turns on whoever did it; a crawler's pack with it.
    if (!by.safe && !inBase(by.x, by.y, by.z)) {
      g.calmUntil = 0;
      this.hunt(g, by, now);
      if (g.kind === CRAWLER) for (const o of this.guardians) if (o.kind === CRAWLER && o.home === g.home && o.deadAt < 0 && o.prey < 0) this.hunt(o, by, now);
    }
    return { hit: !body, kill: null };
  }

  /** Wrecks cleared away after a while; killed guardians replaced, at a site far from where they fell. */
  private wrecks(now: number) {
    this.guardians = this.guardians.filter((g) => {
      if (g.deadAt < 0 || now - g.deadAt < WRECK_MS[g.kind]) return true;
      if (g.kind === GUARDIAN) this.comeback.push({ at: g.deadAt + GUARDIAN_BACK_MS, x: g.x, z: g.z });
      return false;
    });
    this.comeback = this.comeback.filter((c) => {
      if (now < c.at) return true;
      const far = this.ground.filter((s) => Math.hypot(s.x - c.x, s.z - c.z) > GUARDIAN_BACK_FAR
        && Math.hypot(s.x - BASE.x, s.z - BASE.z) > BASE_KEEP_OUT + PATROL[GUARDIAN][1]
        && !this.guardians.some((o) => o.kind === GUARDIAN && o.home === s));
      const pool = far.length ? far : this.ground.length ? this.ground : this.sites;
      const home = pool[Math.floor(Math.random() * pool.length)];
      this.guardians.push(this.walker(GUARDIAN, Math.random() < 0.34 ? 3 : 4, home, home.x + 50, home.z));
      return false;
    });
  }

  /** A drone coming in from `from` m away to patrol around (hx, hz), over crash site `site` (-1: summoned). */
  private spawnDrone(hx: number, hz: number, site: number, until: number, from: number) {
    const a = rand(-Math.PI, Math.PI);
    const x = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, hx + Math.sin(a) * from));
    const z = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, hz + Math.cos(a) * from));
    const d: Drone = {
      id: this.nextDrone++, x, z, y: heightAt(x, z) + DRONE_ALT, yaw: Math.atan2(hx - x, hz - z),
      hx, hz, tx: hx, tz: hz, site, lock: -1, hurt: 0, downAt: -1, vx: 0, vy: 0, vz: 0, crashed: false, litAt: 0, leaving: false, lost: -1, lostUntil: 0, seek: -1, seenAt: 0, dx: 0, dy: -1, dz: 0, until,
    };
    // First pass: across the site from where it came in.
    d.tx = hx + rand(-30, 30);
    d.tz = hz + rand(-30, 30);
    this.drones.push(d);
  }

  private dronePoint(d: Drone) {
    if (d.site === ROAM) {
      // A long leg somewhere ahead-ish, inside the world and clear of the base.
      for (let i = 0; i < 8; i++) {
        const a = d.yaw + rand(-1.6, 1.6), r = rand(...ROAM_LEG);
        d.tx = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, d.x + Math.sin(a) * r));
        d.tz = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, d.z + Math.cos(a) * r));
        if (Math.hypot(d.tx - BASE.x, d.tz - BASE.z) > ROAM_BASE_KEEP_OUT + 20) return;
      }
      return;
    }
    const a = rand(-Math.PI, Math.PI), r = rand(20, DRONE_AREA);
    d.tx = d.hx + Math.sin(a) * r;
    d.tz = d.hz + Math.cos(a) * r;
  }

  /** Now and then a roaming drone drifts in near someone out in the open with few around. */
  private roam(dt: number, now: number, exposed: BotPlayer[]) {
    let out = this.drones.filter((d) => d.site === ROAM && !d.leaving).length;
    for (const p of exposed) {
      if (out >= ROAMERS || this.drones.length >= MAX_DRONES) return;
      if (Math.random() > dt / ROAM_EVERY_S) continue;
      if (this.drones.filter((d) => d.site === ROAM && Math.hypot(d.x - p.x, d.z - p.z) < ROAM_NEAR).length >= ROAM_EACH) continue;
      // Passing by: it heads for somewhere near them, then wanders on.
      const a = rand(-Math.PI, Math.PI), r = rand(40, 120);
      const hx = p.x + Math.sin(a) * r, hz = p.z + Math.cos(a) * r;
      if (Math.hypot(hx - BASE.x, hz - BASE.z) < ROAM_BASE_KEEP_OUT) continue;
      this.spawnDrone(hx, hz, ROAM, now + rand(ROAM_MIN, ROAM_MAX), rand(...ROAM_FROM));
      out++;
    }
  }

  /** The 'bots' message for a player at (x, z): guardians and drones within SEND_R, flagged when after them. */
  msg(time: number, id: number, x: number, z: number): ServerMsg {
    const g: number[] = [], d: number[] = [];
    for (const o of this.guardians) {
      if (Math.hypot(o.x - x, o.z - z) > (o.kind === CRAWLER ? CRAWLER_SEND_R : SEND_R)) continue;
      g.push(o.id, o.kind, o.legs, r2(o.x), r2(o.z), r3(o.yaw), o.prey < 0 ? 0 : o.prey === id ? 2 : 1,
        o.aiming ? r2(o.ax) : 0, o.aiming ? r2(o.ay) : 0, o.aiming ? r2(o.az) : 0, o.chargeAt >= 0 ? 1 : o.aiming ? 0 : -1,
        o.broken, o.deadAt < 0 ? 0 : Math.round((time - o.deadAt) / 100) / 10 + 0.01);
    }
    for (const o of this.drones) {
      if (Math.hypot(o.x - x, o.z - z) > SEND_R) continue;
      d.push(o.id, r2(o.x), r2(o.y), r2(o.z), r3(o.yaw), r3(o.dx), r3(o.dy), r3(o.dz), o.lock < 0 ? 0 : o.lock === id ? 2 : 1,
        o.hurt, o.downAt < 0 ? 0 : Math.round((time - o.downAt) / 100) / 10 + 0.01);
    }
    return { t: 'bots', time, g, d };
  }
}
