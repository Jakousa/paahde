// Server side of the walkers (guardians, crawlers; shared/guardians.ts): where they walk, who they see, who gets
// burned, bitten, shot or crushed, and the guardians' bolts and missiles. The night drones are server/drones.ts, ticked
// from here. In memory only: a restart puts every guardian back at its post. Ticked at TICK_HZ; every player gets the
// ones near them ('bots').
//
// Guardians are few and roam guardian ground (crash sites of level 2, shared/crashsites.ts SiteLevel) from site to
// site. Crawlers belong to a crash site: they turn up there when someone comes near (any time, at crawler and guardian
// ground) and go when everyone has left. The scrap fields (level 0) near the start have none.
import { ORIGIN } from '../shared/origin.ts';
import type { Vortex } from '../shared/vortex.ts';
import { PACK_BACK_S } from '../shared/enemies.ts';
import { coreCrashSites, crashSite, type CrashSite, LEVEL_R } from '../shared/crashsites.ts';
import {
  ALERT_R, BITE_DAMAGE, BITE_MS, BLAST_R, BODY_H, BOLT_R, BOLT_RANGE, BOLT_SPEED, CHARGE_MS, CRAWLER, CRAWLER_CALM_MS,
  CRAWLER_CHASE_MS, CRUSH_SLACK, LUNGE_DASH, LUNGE_HIT_R, LUNGE_NONE, LUNGE_OVER, LUNGE_REST, LUNGE_REST_MS, LUNGE_SPEED,
  LUNGE_WIND, LUNGE_WIND_MS, FIRE_MS, FIRE_R, footTop, GUARDIAN, GUN_DEPRESS, gunPivot, KINDS, type Kind, lineOfSight,
  MUZZLE, REST_R, restSpot, SETTLE, STEP_DIST, STEP_MAX, STEP_MIN,
} from '../shared/guardians.ts';
import {
  BLAST_R as MISSILE_BLAST_R, FIRST_MS, flightTime, LEAD, MISSILE_MIN_R, MISSILE_MS, MISSILE_R, type MissilePath, SCATTER, SHOOTERS,
  missileAt,
} from '../shared/missiles.ts';
import { nearStorm, seized, type Storm } from '../shared/storm.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { allBroken, RANGE, shotPasses, weakPoints, WRECK_S } from '../shared/rifle.ts';
import { heightAt } from '../shared/terrain.ts';
import { type BotPlayer, type Kill, open, r2, r3, rand, SEND_R, SITE_LEAVE_R, SITE_NEAR_R, sitesNear, wrap } from './bots.ts';
import { DroneServer } from './drones.ts';
import { flank, keepOut, skirt, type Skirt } from './pack.ts';
import { Tracks } from './tracks.ts';

export { SEND_R, type BotPlayer, type Kill } from './bots.ts';

export const TICK_HZ = 10;
const CRAWLER_SEND_R = 300;
/** How many guardians roam guardian ground, starting spread evenly over its sites from nearest the origin to farthest. */
const GUARDIANS = 6;
/** Walkers never come this close (m) to the start (the origin, where the pod lies): it's safe ground. */
const START_KEEP_OUT = 200;
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
/** Shot from any distance, a walker keeps tracking the shooter this long (ms), however far, renewed by every hit. */
const SHOT_TRACK_MS = 20_000;
const HUNT_GIVE_UP_R: Record<Kind, number> = { [GUARDIAN]: 200, [CRAWLER]: 70 };
/** After crushing someone, a guardian ignores everyone for this long (ms). */
const CALM_MS = 20_000;
const CRAWLERS_MIN = 1, CRAWLERS_MAX = 4;
/** Most crawlers at an outpost (a crawler site among the scrap fields, inside LEVEL_R[0]: shared/crashsites.ts). */
const OUTPOST_CRAWLERS_MAX = 2;
/** A crawler's body, for keeping it out of wrecks and scrap (m). */
const CRAWLER_R = 0.8;
/** A crawler after you keeps track of you this close (m); this close it stops flanking and comes straight in. */
const CHASE_SIGHT = 45, CLOSE_IN = 6;
/** A dead walker's wreck lies where it fell this long (ms), by kind; a dead guardian is replaced after GUARDIAN_BACK_MS
 *  by a new one at a site far from where it died. */
const WRECK_MS: Record<Kind, number> = { [GUARDIAN]: WRECK_S[GUARDIAN] * 1000, [CRAWLER]: WRECK_S[CRAWLER] * 1000 };
const GUARDIAN_BACK_MS = 6 * 60_000;
const GUARDIAN_BACK_FAR = 900;
/** A rifle shot counts against a walker if it passes and ends within this far (m, × scale) of the body's centre. */
const SHOT_SLACK = REST_R + 6;
/** Walkers of a kind keep this far apart (m, × scale: their legs would tangle closer), steering away from each other
 *  with weight SEP_W (SEP_HUNT_W while hunting, so two after the same prey still close in, side by side). One
 *  standing about with another this close (fraction of SEP_R, summed) walks off. */
const SEP_R = 2 * REST_R + STEP_DIST;
const SEP_W = 1.6, SEP_HUNT_W = 0.8;
const SEP_CROWDED = 0.35;

type Guardian = {
  id: number; kind: Kind; legs: 3 | 4; x: number; z: number; yaw: number; speed: number;
  home: CrashSite; tx: number; tz: number; guardUntil: number;
  /** Hunting this player id (-1 none) since when, last known where, when; calm until; last bite. */
  prey: number; huntAt: number; px: number; pz: number; knownAt: number; calmUntil: number; shotUntil: number; bitAt: number;
  /** The cannon: aimed at (ax, ay, az) while it sees its prey; charging since (-1 not), last fired. */
  aiming: boolean; ax: number; ay: number; az: number; chargeAt: number; firedAt: number;
  /** Last missile launched when. */
  missileAt: number;
  /** Weak points (shared/rifle.ts): how many, which are shot (bit mask); died when (-1 alive). */
  points: number; broken: number; deadAt: number;
  /** Guardians' feet (crawlers' are only drawn, src/world/guardians.ts); yaw last tick; standing still for (s). */
  feet: Foot[] | null; lastYaw: number; still: number;
  /** Crawlers: which way round what's in its way (server/pack.ts); the lunge (LUNGE_*) since when, springing along
   *  unit (lx, lz) with `left` m to go. */
  skirt: Skirt;
  lunge: number; lungeAt: number; lx: number; lz: number; left: number;
};

/** A guardian's foot: planted at (x, y, z), or swinging there with `left` s to go of `dur`. */
type Foot = { x: number; y: number; z: number; left: number };

type Missile = { id: number; path: MissilePath; launched: number };

type Bolt = { id: number; x: number; y: number; z: number; dx: number; dy: number; dz: number; flown: number; by: number };

/** A bolt fired or burst (shared/protocol.ts 'shot' / 'boom'), where. */
export type BoltEvent = { msg: ServerMsg; x: number; z: number };

export class GuardianServer {
  guardians: Guardian[] = [];
  /** The night drones (server/drones.ts): ticked first, their beams calling the guardians and the missiles. */
  readonly drones = new DroneServer();
  /** Sandstorms right now (set by the server before each tick), shared/storm.ts. */
  storms: readonly Storm[] = [];
  /** Sand vortices right now (set with the storms), shared/vortex.ts: they drag the drones in. */
  vortices: readonly Vortex[] = [];
  bolts: Bolt[] = [];
  missiles: Missile[] = [];
  private nextBolt = 1;
  private nextMissile = 1;
  /** Player id → when a drone's beam last caught them after a spell out of it (the salvo starts FIRST_MS later). */
  private spottedAt = new Map<number, number>();
  /** Player positions last tick, for leading the missiles. */
  private lastPos = new Map<number, { x: number; z: number }>();
  /** Player velocities (smoothed), for the crawler packs heading them off. */
  private vel = new Tracks({ k: (dt) => 1 - Math.exp(-dt * 6), jump: 25, onJump: 'keep' });
  /** The sites in the core square (terrain.ts CORE_HALF); crawlers and night drones go by the sites near players. */
  private sites = coreCrashSites();
  /** Guardian ground: the sites guardians roam. */
  private ground = this.sites.filter((s) => s.level === 2);
  private nextWalker = 1;
  /** Crash sites (ids) with crawlers out right now. */
  private swarmed = new Set<number>();
  /** Crash site id → when everyone left it and how many of its crawlers were alive then (swarm). */
  private left = new Map<number, { at: number; crawlers: number }>();
  /** Debug menu packs: their made-up home (where they were summoned), gone like a site's once everyone has left it. */
  private summoned: CrashSite[] = [];
  private nextSummon = 1;
  /** Killed guardians come back (server ms), away from (x, z). */
  private comeback: { at: number; x: number; z: number }[] = [];

  constructor() {
    const near = [...this.ground].sort((a, b) => Math.hypot(a.x - ORIGIN.x, a.z - ORIGIN.z) - Math.hypot(b.x - ORIGIN.x, b.z - ORIGIN.z));
    for (let i = 0; i < GUARDIANS && i < near.length; i++) {
      const home = near[Math.floor((i * near.length) / GUARDIANS)];
      this.guardians.push(this.walker(GUARDIAN, i % 3 === 2 ? 3 : 4, home, home.x + 50, home.z));
    }
  }

  private walker(kind: Kind, legs: 3 | 4, home: CrashSite, x: number, z: number): Guardian {
    const g: Guardian = {
      id: this.nextWalker++, kind, legs, x, z, yaw: rand(-Math.PI, Math.PI), speed: 0, home,
      tx: home.x, tz: home.z, guardUntil: 0, prey: -1, huntAt: 0, px: 0, pz: 0, knownAt: 0, calmUntil: 0, shotUntil: 0, bitAt: 0,
      aiming: false, ax: 0, ay: 0, az: 0, chargeAt: -1, firedAt: 0, missileAt: 0,
      points: weakPoints(kind, legs).length, broken: 0, deadAt: -1, feet: null, lastYaw: 0, still: 0, skirt: { side: 0, until: 0 },
      lunge: LUNGE_NONE, lungeAt: 0, lx: 0, lz: 0, left: 0,
    };
    g.lastYaw = g.yaw;
    if (kind === GUARDIAN) this.plantFeet(g);
    this.patrolPoint(g);
    return g;
  }

  /** Every foot on its rest spot (a new or teleported guardian). */
  private plantFeet(g: Guardian) {
    const sc = KINDS[g.kind].scale;
    g.feet = [];
    for (let i = 0; i < g.legs; i++) {
      const f = restSpot(g.x, g.z, g.yaw, g.legs, i, sc, 0, 0, 0, { x: 0, y: 0, z: 0, left: 0 });
      f.y = footTop(f.x, f.z, sc);
      g.feet.push(f);
    }
  }

  /**
   * A guardian's gait (the client swings its legs to these feet): a planted foot stays put until its rest spot is
   * STEP_DIST away (or, standing, SETTLE), then it steps to where its rest spot will be when it lands, led on by
   * half a swing (the feet lead the body). Four legs step one at a time, diagonal pairs when hurrying; three one at
   * a time. Swings are timed to keep up. It lands on whatever is there: sand, rock, wreck or scrap (footTop).
   */
  private stepFeet(g: Guardian, dt: number) {
    const feet = g.feet;
    if (!feet) return;
    const sc = KINDS[g.kind].scale, T = Math.sqrt(sc), n = feet.length;
    const vx = Math.sin(g.yaw) * g.speed, vz = Math.cos(g.yaw) * g.speed;
    const turn = wrap(g.yaw - g.lastYaw) / dt;
    g.lastYaw = g.yaw;
    const footSpeed = g.speed + Math.abs(turn) * REST_R * sc;
    g.still = footSpeed < 0.25 * T ? g.still + dt : 0;
    const settling = g.still > 0.6 * T;
    const together = n === 4 && footSpeed / T > 3.2 ? 2 : 1;
    const dur = Math.min(STEP_MAX * T, Math.max(STEP_MIN * T, (0.8 * STEP_DIST * sc * together) / (Math.max(0.5 * T, footSpeed) * n)));
    const group = (i: number) => (n === 4 ? i % 2 : i);
    let swinging = 0, swingGroup = -1;
    feet.forEach((f, i) => {
      if (f.left > 0) f.left = Math.max(0, f.left - dt);
      if (f.left > 0) {
        swinging++;
        swingGroup = group(i);
      }
    });
    const p = { x: 0, z: 0 };
    while (swinging < together) {
      let best = -1, bestErr = (settling ? SETTLE : STEP_DIST) * sc;
      feet.forEach((f, i) => {
        if (f.left > 0 || (swingGroup >= 0 && group(i) !== swingGroup)) return;
        restSpot(g.x, g.z, g.yaw, g.legs, i, sc, 0, 0, 0, p);
        const err = Math.hypot(p.x - f.x, p.z - f.z);
        if (err > bestErr) {
          best = i;
          bestErr = err;
        }
      });
      if (best < 0) break;
      const d = settling ? 1.1 * T : dur;
      // Where the rest spot will be as it lands (turning with the body), and half a swing on.
      const f = feet[best];
      restSpot(g.x, g.z, g.yaw + turn * d, g.legs, best, sc, vx, vz, d * 1.5, f);
      f.y = footTop(f.x, f.z, sc);
      f.left = d;
      swingGroup = group(best);
      swinging++;
    }
  }

  /** Planted guardian feet as posts players can't walk through (shared/sim.ts collideLegs): (x, sole y, z) each. */
  posts: number[] = [];
  private updatePosts() {
    this.posts.length = 0;
    for (const g of this.guardians) {
      if (!g.feet || g.deadAt >= 0) continue;
      for (const f of g.feet) if (f.left === 0) this.posts.push(f.x, f.y, f.z);
    }
  }

  /** Crawlers out at the sites someone is near, gone from the ones everyone has left. A site left comes back with the
   *  crawlers it had then until PACK_BACK_S is up (no fresh pack for stepping out and back in), whole after. */
  private swarm(players: BotPlayer[], now: number) {
    const near = (s: CrashSite, r: number) => players.some((p) => Math.hypot(p.x - s.x, p.z - s.z) < r);
    for (const id of this.swarmed) {
      const s = crashSite(id)!;
      if (near(s, SITE_LEAVE_R)) continue;
      this.swarmed.delete(id);
      const left = this.guardians.filter((g) => g.kind === CRAWLER && g.home === s && g.deadAt < 0).length;
      this.left.set(id, { at: now, crawlers: left });
      this.guardians = this.guardians.filter((g) => g.kind !== CRAWLER || g.home !== s);
    }
    for (const [id, l] of this.left) if (now - l.at >= PACK_BACK_S * 1000) this.left.delete(id);
    this.summoned = this.summoned.filter((s) => {
      if (near(s, SITE_LEAVE_R)) return true;
      this.guardians = this.guardians.filter((g) => g.home !== s);
      return false;
    });
    for (const s of sitesNear(players, SITE_NEAR_R)) {
      if (s.level === 0 || this.swarmed.has(s.id)) continue;
      this.swarmed.add(s.id);
      const max = Math.hypot(s.x - ORIGIN.x, s.z - ORIGIN.z) < LEVEL_R[0] ? OUTPOST_CRAWLERS_MAX : CRAWLERS_MAX;
      const n = this.left.get(s.id)?.crawlers ?? CRAWLERS_MIN + Math.floor(Math.random() * (max - CRAWLERS_MIN + 1));
      this.left.delete(s.id);
      for (let i = 0; i < n; i++) {
        const a = rand(-Math.PI, Math.PI), r = rand(...PATROL[CRAWLER]);
        this.guardians.push(this.walker(CRAWLER, 4, s, s.x + Math.sin(a) * r, s.z + Math.cos(a) * r));
      }
    }
  }

  /**
   * Advance by dt seconds at server time `now` (ms), wall-clock time of day `tod`. Returns who was bitten (player id
   * → damage), shot by a bolt or blown up by a missile, and the bolts and missiles fired and burst.
   */
  tick(dt: number, now: number, tod: number, players: BotPlayer[]): {
    bitten: Map<number, number>; shot: number[]; blasted: number[]; events: BoltEvent[];
  } {
    const bitten = new Map<number, number>();
    const shot: number[] = [], blasted: number[] = [], events: BoltEvent[] = [];
    const byId = new Map(players.map((p) => [p.id, p]));
    const exposed = players.filter(open);
    this.vel.update(now, dt, players);
    this.swarm(players, now);
    this.wrecks(now);
    const lit = this.drones.tick(dt, now, tod, players, exposed, byId, this.storms, (p) => this.alert(p, now), this.vortices);
    this.tickMissiles(dt, now, lit, players, exposed, blasted, events);
    for (const g of this.guardians) {
      if (g.deadAt >= 0) continue;
      // Seized up by a storm front's static: stands where it is, no bites, no cannon, till it has passed.
      const stuck = seized(this.storms, g.x, g.z, now);
      if (stuck) {
        g.speed = 0;
        g.aiming = false;
        g.chargeAt = -1;
        g.lunge = LUNGE_NONE;
      } else this.tickGuardian(g, dt, now, exposed, byId, bitten);
      this.stepFeet(g, dt);
      if (KINDS[g.kind].gun && !stuck) this.tickGun(g, now, byId, events);
    }
    this.tickBolts(dt, exposed, shot, events);
    this.updatePosts();
    return { bitten, shot, blasted, events };
  }


  /** Missiles: guardians shell their prey, and the nearest ones whoever a drone's beam is on; ones that have landed burst. */
  private tickMissiles(dt: number, now: number, lit: Set<number>, players: BotPlayer[], exposed: BotPlayer[], blasted: number[], events: BoltEvent[]) {
    for (const id of this.spottedAt.keys()) if (!lit.has(id)) this.spottedAt.delete(id);
    for (const p of exposed) {
      if (lit.has(p.id) && !this.spottedAt.has(p.id)) this.spottedAt.set(p.id, now);
      const spotted = lit.has(p.id) && now - this.spottedAt.get(p.id)! >= FIRST_MS;
      const alive = this.guardians.filter((g) => g.kind === GUARDIAN && g.deadAt < 0 && !seized(this.storms, g.x, g.z, now));
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
        // No firing from inside a storm, or at someone in one (it would burst on the way in).
        if (nearStorm(this.storms, g.x, g.z, now, 1) || nearStorm(this.storms, p.x, p.z, now, 1)) continue;
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
    const pos = { x: 0, y: 0, z: 0 };
    this.missiles = this.missiles.filter((m) => {
      if (now - m.launched < m.path.flight * 1000) {
        // Flying into a storm: it bursts in the air, harmlessly.
        missileAt(m.path, (now - m.launched) / 1000, pos);
        if (!nearStorm(this.storms, pos.x, pos.z, now, 1)) return true;
        events.push({ x: pos.x, z: pos.z, msg: { t: 'blast', id: m.id, x: r2(pos.x), y: r2(pos.y), z: r2(pos.z) } });
        return false;
      }
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
    g.aiming = !!p && open(p) && Math.hypot(p.x - pv.x, cy - pv.y, p.z - pv.z) < FIRE_R
      && Math.atan2(pv.y - cy, Math.hypot(p.x - pv.x, p.z - pv.z)) < GUN_DEPRESS
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

  private tickGuardian(g: Guardian, dt: number, now: number, exposed: BotPlayer[], byId: Map<number, BotPlayer>, bitten: Map<number, number>) {
    const k = KINDS[g.kind];
    // Notice anyone close by.
    if (now >= g.calmUntil) {
      for (const p of exposed) {
        if (Math.hypot(p.x - g.x, p.z - g.z) > k.sight) continue;
        if (g.prey === p.id) this.hunt(g, p, now);
        else if (g.prey < 0) {
          this.hunt(g, p, now);
          this.rouse(g, p, now);
        }
      }
    }
    // A crawler of a pack that's after someone joins in as soon as it's free (backed off, or calmed down).
    if (g.kind === CRAWLER && g.prey < 0 && now >= g.calmUntil) {
      const o = this.guardians.find((o) => o !== g && o.kind === CRAWLER && o.home === g.home && o.deadAt < 0 && o.prey >= 0 && now - o.knownAt < 1000);
      const p = o && exposed.find((q) => q.id === o.prey);
      if (o && p) {
        this.hunt(g, p, now);
        g.px = o.px;
        g.pz = o.pz;
      }
    }
    if (g.prey >= 0) {
      const p = byId.get(g.prey);
      const shot = now < g.shotUntil;
      if (shot && p && open(p)) this.hunt(g, p, now);
      // Crawlers keep to their site; guardians give up once you've got far from them, unless they were told where
      // you are this tick (a drone's beam holds you: the drones tick first, and alert() calls them from up to ALERT_R).
      const far = g.kind === CRAWLER ? Math.hypot(g.px - g.home.x, g.pz - g.home.z)
        : g.knownAt === now ? 0 : Math.hypot(g.px - g.x, g.pz - g.z);
      // Once after you, a crawler keeps track of you within CHASE_SIGHT (not just its sight).
      if (g.kind === CRAWLER && p && open(p) && Math.hypot(p.x - g.x, p.z - g.z) < CHASE_SIGHT) this.hunt(g, p, now);
      // Tires after a chase (each a little sooner or later, so the pack doesn't all stop at once).
      const tired = g.kind === CRAWLER && now - g.huntAt > CRAWLER_CHASE_MS * (0.75 + ((g.id * 0.618) % 1) * 0.5);
      const gone = !p || !open(p) || now - g.knownAt > HUNT_FORGET || (far > HUNT_GIVE_UP_R[g.kind] && !shot) || tired;
      if (tired) g.calmUntil = now + CRAWLER_CALM_MS;
      if (gone) {
        g.prey = -1;
        this.patrolPoint(g);
      } else {
        if (g.kind === CRAWLER) {
          // The pack on the same prey fans out round them, heading them off (server/pack.ts).
          const pack = this.guardians.filter((o) => o.kind === CRAWLER && o.deadAt < 0 && o.prey === g.prey).sort((a, b) => a.id - b.id);
          const v = this.vel.get(g.prey);
          // Right on them: straight in, just ahead of them; further off, heading them off from its own side.
          if (Math.hypot(g.px - g.x, g.pz - g.z) < CLOSE_IN) (g.tx = g.px + (v?.vx ?? 0) * 0.2), (g.tz = g.pz + (v?.vz ?? 0) * 0.2);
          else [g.tx, g.tz] = flank(g.x, g.z, g.px, g.pz, v?.vx ?? 0, v?.vz ?? 0, k.hunt, pack.indexOf(g), pack.length, 8, 1);
        } else {
          g.tx = g.px;
          g.tz = g.pz;
        }
        // A guardian over you only crushes you if a foot comes down on you (stomp); a crawler close by lunges.
        if (g.kind === CRAWLER && g.lunge === LUNGE_NONE && Math.hypot(p.x - g.x, p.z - g.z) < k.reach && now - g.bitAt >= BITE_MS) {
          g.lunge = LUNGE_WIND;
          g.lungeAt = now;
        }
      }
    }
    if (g.lunge !== LUNGE_NONE) return this.lunge(g, dt, now, byId, exposed, bitten);
    const hunting = g.prey >= 0;
    // Others of its kind close by: it steers away from them (their legs would tangle).
    const sep = SEP_R * k.scale;
    let ax = 0, az = 0, crowd = 0;
    for (const o of this.guardians) {
      if (o === g || o.kind !== g.kind || o.deadAt >= 0) continue;
      const ox = g.x - o.x, oz = g.z - o.z, d = Math.hypot(ox, oz);
      if (d >= sep) continue;
      const w = 1 - d / sep;
      // Right on top of each other: apart by id.
      ax += d > 1e-3 ? (ox / d) * w : Math.sin(g.id) * w;
      az += d > 1e-3 ? (oz / d) * w : Math.cos(g.id) * w;
      crowd += w;
    }
    if (crowd > SEP_CROWDED && !hunting && (now < g.guardUntil || Math.hypot(g.tx - g.x, g.tz - g.z) < sep)) {
      // Standing about (or about to) with another too close: off somewhere clear of it.
      const a = Math.hypot(ax, az) || 1;
      g.guardUntil = 0;
      g.tx = g.x + (ax / a) * sep;
      g.tz = g.z + (az / a) * sep;
    }
    const dx = g.tx - g.x, dz = g.tz - g.z, dist = Math.hypot(dx, dz);
    let want = 0;
    const near = g.kind === CRAWLER ? 0.6 : 6, ease = g.kind === CRAWLER ? 0.25 : 1.5;
    if (now < g.guardUntil && !hunting) {
      // Standing guard: slowly looking around.
      g.yaw = wrap(g.yaw + Math.sin(now / 4000 + g.id) * 0.08 * k.turn * 4 * dt);
    } else if (hunting ? g.kind !== CRAWLER && dist < Math.min(1, k.reach * 0.5) : dist < near) {
      if (!hunting) this.arrive(g, now);
    } else {
      const sw = hunting ? SEP_HUNT_W : SEP_W;
      let head = Math.atan2(dx / dist + ax * sw, dz / dist + az * sw);
      // Crawlers go round wrecks and scrap, not over them.
      if (g.kind === CRAWLER) head = skirt(g.x, g.z, head, CRAWLER_R, g.skirt, now);
      const turn = wrap(head - g.yaw);
      const rate = (hunting ? k.huntTurn : k.turn) * dt;
      g.yaw = wrap(g.yaw + Math.max(-rate, Math.min(rate, turn)));
      // Walks on while roughly facing the way; turns on the spot when it isn't. Slows down to arrive. A hunting
      // crawler runs on through its turns, and right through to you.
      want = hunting && g.kind === CRAWLER
        ? k.hunt * Math.max(0.4, Math.cos(turn))
        : (hunting ? k.hunt : k.patrol) * Math.max(0, Math.cos(turn)) ** 2 * Math.min(1, dist / (near + 2));
    }
    g.speed += (want - g.speed) * (1 - Math.exp(-dt / ease));
    this.moveTo(g, g.x + Math.sin(g.yaw) * g.speed * dt, g.z + Math.cos(g.yaw) * g.speed * dt, hunting);
  }

  /** A crawler's lunge (shared/guardians.ts LUNGE_*): crouched, it turns to face its prey; then it springs straight
   *  at where they are, biting whoever it passes close by and backing off; after a miss it stands a moment. */
  private lunge(g: Guardian, dt: number, now: number, byId: Map<number, BotPlayer>, exposed: BotPlayer[], bitten: Map<number, number>) {
    const k = KINDS[g.kind];
    if (g.lunge === LUNGE_WIND) {
      const p = byId.get(g.prey);
      if (!p || !open(p)) {
        g.lunge = LUNGE_NONE;
        return;
      }
      const dx = p.x - g.x, dz = p.z - g.z, d = Math.hypot(dx, dz) || 1;
      if (now - g.lungeAt < LUNGE_WIND_MS) {
        const rate = k.huntTurn * dt;
        g.yaw = wrap(g.yaw + Math.max(-rate, Math.min(rate, wrap(Math.atan2(dx, dz) - g.yaw))));
        g.speed = 0;
        return;
      }
      g.lunge = LUNGE_DASH;
      g.lungeAt = g.bitAt = now;
      g.lx = dx / d;
      g.lz = dz / d;
      g.left = d + LUNGE_OVER;
      g.yaw = Math.atan2(dx, dz);
      g.speed = LUNGE_SPEED;
    }
    if (g.lunge === LUNGE_DASH) {
      const x0 = g.x, z0 = g.z, step = Math.min(g.left, LUNGE_SPEED * dt);
      this.moveTo(g, x0 + g.lx * step, z0 + g.lz * step, true);
      g.left -= step;
      const hit = exposed.find((p) => segDist(p.x, p.z, x0, z0, g.x, g.z) < LUNGE_HIT_R);
      if (hit) {
        // Bites, and backs off.
        bitten.set(hit.id, (bitten.get(hit.id) ?? 0) + BITE_DAMAGE);
        g.lunge = LUNGE_NONE;
        g.speed = 0;
        g.prey = -1;
        g.calmUntil = now + CRAWLER_CALM_MS;
        this.patrolPoint(g);
      } else if (g.left <= 0 || Math.hypot(g.x - x0, g.z - z0) < step * 0.5) {
        // Missed (or ran into a wreck, or the start's edge).
        g.lunge = LUNGE_REST;
        g.lungeAt = now;
        g.speed = 0;
      }
      return;
    }
    g.speed = 0;
    if (now - g.lungeAt >= LUNGE_REST_MS) g.lunge = LUNGE_NONE;
  }

  /** Steps to (nx, nz), kept off the start (and out of wrecks and scrap: crawlers). */
  private moveTo(g: Guardian, nx: number, nz: number, hunting: boolean) {
    // The start (round the origin, where the pod lies) is out of bounds: stopped at the edge (and it gives up the hunt there). Not for a debug menu pack
    // (made-up home, id < 0), so it can be tried out near the start.
    const bd = Math.hypot(nx - ORIGIN.x, nz - ORIGIN.z);
    if (bd < START_KEEP_OUT && g.home.id >= 0) {
      nx = ORIGIN.x + ((nx - ORIGIN.x) / bd) * START_KEEP_OUT;
      nz = ORIGIN.z + ((nz - ORIGIN.z) / bd) * START_KEEP_OUT;
      if (!hunting) this.patrolPoint(g);
    }
    if (g.kind === CRAWLER) [nx, nz] = keepOut(nx, nz, CRAWLER_R);
    g.x = nx;
    g.z = nz;
  }

  /** One crawler angered (seen you, shot at): the whole site's pack comes for you, whatever they were doing. */
  private rouse(g: Guardian, p: BotPlayer, now: number) {
    if (g.kind !== CRAWLER) return;
    for (const o of this.guardians) {
      if (o === g || o.kind !== CRAWLER || o.home !== g.home || o.deadAt >= 0 || o.prey >= 0) continue;
      o.calmUntil = 0;
      this.hunt(o, p, now);
    }
  }

  private hunt(g: Guardian, p: BotPlayer, now: number) {
    if (g.prey !== p.id) g.huntAt = now;
    g.prey = p.id;
    g.px = p.x;
    g.pz = p.z;
    g.knownAt = now;
    g.guardUntil = 0;
  }

  /** A drone's beam holds `p` (server/drones.ts): the guardians within ALERT_R of them, free to, come for them. */
  private alert(p: BotPlayer, now: number) {
    for (const g of this.guardians) {
      if (now < g.calmUntil || (g.prey >= 0 && g.prey !== p.id) || g.kind !== GUARDIAN || g.deadAt >= 0) continue;
      if (Math.hypot(g.x - p.x, g.z - p.z) < ALERT_R) this.hunt(g, p, now);
    }
  }

  /** Reached a waypoint: stand guard, wander off to another site, or on to the next point around this one. */
  private arrive(g: Guardian, now: number) {
    if (Math.random() < GUARD_CHANCE[g.kind]) g.guardUntil = now + rand(GUARD_MIN, GUARD_MAX) * (g.kind === CRAWLER ? 0.4 : 1);
    if (g.kind === GUARDIAN && Math.random() < WANDER_CHANCE) {
      const next = this.ground.filter((s) => s !== g.home && Math.hypot(s.x - g.home.x, s.z - g.home.z) < WANDER_R
        && Math.hypot(s.x - ORIGIN.x, s.z - ORIGIN.z) > START_KEEP_OUT + PATROL[GUARDIAN][1]
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
      // Not inside a wreck (a crawler would walk round it for ever).
      if (g.kind === CRAWLER) [g.tx, g.tz] = keepOut(g.tx, g.tz, CRAWLER_R + 0.5);
      if (g.home.id >= 0 && Math.hypot(g.tx - ORIGIN.x, g.tz - ORIGIN.z) <= START_KEEP_OUT + 10) continue;
      // Not where another of its kind stands or is heading (guardians: crawlers swarm).
      const sep = SEP_R * KINDS[g.kind].scale;
      if (i < 9 && g.kind === GUARDIAN && this.guardians.some((o) => o !== g && o.kind === g.kind && o.deadAt < 0
        && (Math.hypot(o.x - g.tx, o.z - g.tz) < sep || Math.hypot(o.tx - g.tx, o.tz - g.tz) < sep))) continue;
      return;
    }
  }

  /** Player `p`'s client says guardian `id`'s foot came down on them: crushed, if it's alive and a foot could reach
   *  them. The one hunting them calms down after. */
  stomp(id: unknown, p: BotPlayer, now: number): boolean {
    const g = this.guardians.find((o) => o.id === id);
    if (!g || g.kind !== GUARDIAN || g.deadAt >= 0 || !open(p)) return false;
    if (Math.hypot(p.x - g.x, p.z - g.z) > (REST_R + STEP_DIST) * KINDS[GUARDIAN].scale + CRUSH_SLACK) return false;
    if (g.prey === p.id) {
      g.prey = -1;
      g.calmUntil = now + CALM_MS;
      g.guardUntil = now + GUARD_MIN;
    }
    return true;
  }

  /** Debug menu: the nearest guardian walks in from 90 m away, a drone comes for a minute, or a pack of crawlers turns
   *  up 30 m off and comes for you (they keep to where they were summoned, like a site's). */
  summon(what: unknown, p: BotPlayer, now: number) {
    if (what === 'drone') return this.drones.summon(p, now);
    if (what === 'crawlers') {
      const home: CrashSite = { ...this.sites[0], id: -this.nextSummon++, x: p.x, z: p.z };
      this.summoned.push(home);
      const a0 = rand(-Math.PI, Math.PI);
      let first: Guardian | null = null;
      for (let i = 0; i < 6; i++) {
        const a = a0 + rand(-0.9, 0.9);
        const [x, z] = keepOut(p.x + Math.sin(a) * rand(26, 34), p.z + Math.cos(a) * rand(26, 34), CRAWLER_R);
        const g = this.walker(CRAWLER, 4, home, x, z);
        g.yaw = g.lastYaw = Math.atan2(p.x - x, p.z - z);
        this.guardians.push(g);
        first ??= g;
      }
      if (first && open(p)) {
        this.hunt(first, p, now);
        this.rouse(first, p, now);
      }
      return;
    }
    const big = this.guardians.filter((g) => g.kind === GUARDIAN && g.deadAt < 0);
    if (what !== 'guardian' || !big.length) return;
    const g = big.reduce((a, b) => (Math.hypot(a.x - p.x, a.z - p.z) < Math.hypot(b.x - p.x, b.z - p.z) ? a : b));
    const a = rand(-Math.PI, Math.PI);
    g.x = p.x + Math.sin(a) * 90;
    g.z = p.z + Math.cos(a) * 90;
    g.yaw = Math.atan2(p.x - g.x, p.z - g.z);
    g.lastYaw = g.yaw;
    this.plantFeet(g);
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
    // Passing and ending near the body's centre.
    if (Math.hypot(ex - x, ey - y, ez - z) > RANGE + 5
      || !shotPasses(x, y, z, ex, ey, ez, g.x, heightAt(g.x, g.z) + BODY_H * sc, g.z, SHOT_SLACK * sc + 2)) return miss;
    if (!body) g.broken |= 1 << (i as number);
    if (!body && allBroken(g.broken, g.points)) {
      // Killing one sets the rest of the pack on you too.
      if (open(by)) this.rouse(g, by, now);
      g.deadAt = now;
      g.prey = -1;
      g.aiming = false;
      g.chargeAt = -1;
      g.speed = 0;
      return { hit: true, kill: { kind: g.kind, x: g.x, z: g.z, by: by.id } };
    }
    // Hurt (or just hit), it turns on whoever did it; a crawler's pack with it.
    if (open(by)) {
      g.calmUntil = 0;
      g.shotUntil = now + SHOT_TRACK_MS;
      this.hunt(g, by, now);
      this.rouse(g, by, now);
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
        && Math.hypot(s.x - ORIGIN.x, s.z - ORIGIN.z) > START_KEEP_OUT + PATROL[GUARDIAN][1]
        && !this.guardians.some((o) => o.kind === GUARDIAN && o.home === s));
      const pool = far.length ? far : this.ground.length ? this.ground : this.sites;
      const home = pool[Math.floor(Math.random() * pool.length)];
      this.guardians.push(this.walker(GUARDIAN, Math.random() < 0.34 ? 3 : 4, home, home.x + 50, home.z));
      return false;
    });
  }

  /** The 'bots' message for a player at (x, z): guardians and drones within SEND_R, flagged when after them. */
  msg(time: number, id: number, x: number, z: number): ServerMsg {
    const g: number[] = [], f: number[] = [];
    for (const o of this.guardians) {
      if (Math.hypot(o.x - x, o.z - z) > (o.kind === CRAWLER ? CRAWLER_SEND_R : SEND_R)) continue;
      if (o.feet && o.deadAt < 0) o.feet.forEach((e, i) => f.push(o.id, i, r2(e.x), r2(e.y), r2(e.z), r2(e.left)));
      g.push(o.id, o.kind, o.legs, r2(o.x), r2(o.z), r3(o.yaw), o.prey < 0 ? 0 : o.prey === id ? 2 : 1,
        o.aiming ? r2(o.ax) : 0, o.aiming ? r2(o.ay) : 0, o.aiming ? r2(o.az) : 0,
        o.kind === CRAWLER ? o.lunge : o.chargeAt >= 0 ? 1 : o.aiming ? 0 : -1,
        o.broken, o.deadAt < 0 ? 0 : Math.round((time - o.deadAt) / 100) / 10 + 0.01);
    }
    return { t: 'bots', time, g, d: this.drones.msg(time, id, x, z), f };
  }

  // The drones, for server/world.ts.
  shootDrone(x: number, y: number, z: number, ex: number, ey: number, ez: number, id: unknown, now: number, by = -1): boolean {
    return this.drones.shoot(x, y, z, ex, ey, ez, id, now, by);
  }
  droneAt(id: number) {
    return this.drones.at(id);
  }
  jamDrone(id: number, now: number) {
    this.drones.jam(id, now);
  }
  crashes(): Kill[] {
    return this.drones.crashes();
  }
}

/** How far (m) (px, pz) is from the segment (ax, az)–(bx, bz). */
function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}
