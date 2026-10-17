// Server side of the guardians and night drones (shared/guardians.ts): where they walk and fly, who they see, who
// gets burned or crushed. In memory only: a restart puts every guardian back at its post. Ticked at TICK_HZ;
// every player gets the ones within SEND_R of them ('bots').
import { BASE, inBase } from '../shared/base.ts';
import { allCrashSites, type CrashSite } from '../shared/crashsites.ts';
import {
  ALERT_R, beamDir, BURN, CHASE_BACK, CHASE_SPEED, CRUSH_R, DRONE_ALT, DRONE_SPEED, HUNT_SPEED, HUNT_TURN_RATE, inBeam,
  LOSE_MS, NIGHT_SUN, PATROL_SPEED, SIGHT, sweepAt, TURN_RATE,
} from '../shared/guardians.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { sunElevation } from '../shared/sun.ts';
import { heightAt, WORLD_HALF } from '../shared/terrain.ts';

export const TICK_HZ = 10;
/** Players get the machines within this distance (m). */
const SEND_R = 900;
/** How many guardians, posted at the crash sites nearest the base (one each). */
const GUARDIANS = 8;
/** Guardians never come this close (m) to the base: it's safe ground. */
const BASE_KEEP_OUT = 170;
/** Patrol waypoints lie this far (m) from the site's centre. */
const PATROL_MIN = 25, PATROL_MAX = 60;
/** At a waypoint: the chance to stand guard for a while (GUARD_MIN..MAX ms), and to wander off to the next site. */
const GUARD_CHANCE = 0.35;
const GUARD_MIN = 8_000, GUARD_MAX = 25_000;
const WANDER_CHANCE = 0.15;
/** The next site is at most this far (m). */
const WANDER_R = 1000;
/** A hunt ends this long (ms) after the guardian last knew where you are, or once you're this far (m). */
const HUNT_FORGET = 15_000;
const HUNT_GIVE_UP_R = 160;
/** After crushing someone, a guardian ignores everyone for this long (ms). */
const CALM_MS = 20_000;
/** Drones per player out in the desert at night, all drones at most, and how often (ms) one more may come. */
const DRONES_PER_PLAYER = 2;
const MAX_DRONES = 16;
const DRONE_EVERY = 15_000;
/** New drones come in from this far (m) and patrol within PATROL_AREA (m) of where their player was. */
const DRONE_FROM = 260;
const DRONE_AREA = 170;
/** A drone with nobody within this distance (m) leaves. */
const DRONE_LONELY = 600;
/** Drones keep this far (m) from the base. */
const DRONE_BASE_KEEP_OUT = 60;

/** What the bots need to know about a player (feet position; `safe` = just respawned, can't be hurt). */
export type BotPlayer = { id: number; x: number; y: number; z: number; safe: boolean };

type Guardian = {
  id: number; legs: 3 | 4; x: number; z: number; yaw: number; speed: number;
  home: CrashSite; tx: number; tz: number; guardUntil: number;
  /** Hunting this player id (-1 none), last known where, when; calm until. */
  prey: number; px: number; pz: number; knownAt: number; calmUntil: number;
};

type Drone = {
  id: number; x: number; y: number; z: number; yaw: number;
  /** Patrol area centre, current waypoint. */
  hx: number; hz: number; tx: number; tz: number;
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
  private sites = allCrashSites();
  private nextDrone = 1;
  private droneAt = new Map<number, number>(); // player id → when a drone last came for them

  constructor() {
    const near = [...this.sites].sort((a, b) => Math.hypot(a.x - BASE.x, a.z - BASE.z) - Math.hypot(b.x - BASE.x, b.z - BASE.z));
    for (let i = 0; i < Math.min(GUARDIANS, near.length); i++) {
      const home = near[i];
      const g: Guardian = {
        id: i + 1, legs: i % 3 === 2 ? 3 : 4, x: home.x + 40, z: home.z, yaw: rand(-Math.PI, Math.PI), speed: 0, home,
        tx: home.x, tz: home.z, guardUntil: 0, prey: -1, px: 0, pz: 0, knownAt: 0, calmUntil: 0,
      };
      this.patrolPoint(g);
      this.guardians.push(g);
    }
  }

  /**
   * Advance by dt seconds at server time `now` (ms), wall-clock time of day `tod`. Returns who the drone beams are
   * burning (player id → heat per second) and who was crushed.
   */
  tick(dt: number, now: number, tod: number, players: BotPlayer[]): { burn: Map<number, number>; crushed: number[] } {
    const burn = new Map<number, number>();
    const crushed: number[] = [];
    const byId = new Map(players.map((p) => [p.id, p]));
    const exposed = players.filter((p) => !p.safe && !inBase(p.x, p.y, p.z));
    this.tickDrones(dt, now, tod, players, exposed, byId, burn);
    for (const g of this.guardians) this.tickGuardian(g, dt, now, exposed, byId, crushed);
    return { burn, crushed };
  }

  private tickGuardian(g: Guardian, dt: number, now: number, exposed: BotPlayer[], byId: Map<number, BotPlayer>, crushed: number[]) {
    // Notice anyone close by.
    if (now >= g.calmUntil) {
      for (const p of exposed) {
        if (Math.hypot(p.x - g.x, p.z - g.z) > SIGHT) continue;
        if (g.prey < 0 || g.prey === p.id) this.hunt(g, p, now);
      }
    }
    if (g.prey >= 0) {
      const p = byId.get(g.prey);
      const gone = !p || p.safe || inBase(p.x, p.y, p.z) || now - g.knownAt > HUNT_FORGET || Math.hypot(g.px - g.x, g.pz - g.z) > HUNT_GIVE_UP_R;
      if (gone) {
        g.prey = -1;
        this.patrolPoint(g);
      } else {
        g.tx = g.px;
        g.tz = g.pz;
        if (Math.hypot(p.x - g.x, p.z - g.z) < CRUSH_R) {
          crushed.push(p.id);
          g.prey = -1;
          g.calmUntil = now + CALM_MS;
          g.guardUntil = now + GUARD_MIN;
        }
      }
    }
    const hunting = g.prey >= 0;
    const dx = g.tx - g.x, dz = g.tz - g.z, dist = Math.hypot(dx, dz);
    let want = 0;
    if (now < g.guardUntil && !hunting) {
      // Standing guard: slowly looking around.
      g.yaw = wrap(g.yaw + Math.sin(now / 4000 + g.id) * 0.08 * dt);
    } else if (dist < (hunting ? 1 : 6)) {
      if (!hunting) this.arrive(g, now);
    } else {
      const turn = wrap(Math.atan2(dx, dz) - g.yaw);
      const rate = (hunting ? HUNT_TURN_RATE : TURN_RATE) * dt;
      g.yaw = wrap(g.yaw + Math.max(-rate, Math.min(rate, turn)));
      // Walks on while roughly facing the way; turns on the spot when it isn't. Slows down to arrive.
      want = (hunting ? HUNT_SPEED : PATROL_SPEED) * Math.max(0, Math.cos(turn)) ** 2 * Math.min(1, dist / 8);
    }
    g.speed += (want - g.speed) * (1 - Math.exp(-dt / 1.5));
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
    g.prey = p.id;
    g.px = p.x;
    g.pz = p.z;
    g.knownAt = now;
    g.guardUntil = 0;
  }

  /** Reached a waypoint: stand guard, wander off to another site, or on to the next point around this one. */
  private arrive(g: Guardian, now: number) {
    if (Math.random() < GUARD_CHANCE) g.guardUntil = now + rand(GUARD_MIN, GUARD_MAX);
    if (Math.random() < WANDER_CHANCE) {
      const next = this.sites.filter((s) => s !== g.home && Math.hypot(s.x - g.home.x, s.z - g.home.z) < WANDER_R
        && Math.hypot(s.x - BASE.x, s.z - BASE.z) > BASE_KEEP_OUT + PATROL_MAX
        && !this.guardians.some((o) => o !== g && o.home === s));
      if (next.length) g.home = next[Math.floor(Math.random() * next.length)];
    }
    this.patrolPoint(g);
  }

  private patrolPoint(g: Guardian) {
    for (let i = 0; i < 10; i++) {
      const a = rand(-Math.PI, Math.PI), r = rand(PATROL_MIN, PATROL_MAX);
      g.tx = g.home.x + Math.sin(a) * r;
      g.tz = g.home.z + Math.cos(a) * r;
      if (Math.hypot(g.tx - BASE.x, g.tz - BASE.z) > BASE_KEEP_OUT + 10) return;
    }
  }

  private tickDrones(dt: number, now: number, tod: number, players: BotPlayer[], exposed: BotPlayer[], byId: Map<number, BotPlayer>, burn: Map<number, number>) {
    const night = sunElevation(tod) < NIGHT_SUN;
    // Bring drones to whoever is out in the dark without enough of them around.
    if (night) {
      for (const p of exposed) {
        if (this.drones.length >= MAX_DRONES) break;
        if (now - (this.droneAt.get(p.id) ?? -Infinity) < DRONE_EVERY) continue;
        const around = this.drones.filter((d) => !d.leaving && Math.hypot(d.x - p.x, d.z - p.z) < DRONE_AREA * 1.5).length;
        if (around >= DRONES_PER_PLAYER) continue;
        this.droneAt.set(p.id, now);
        this.spawnDrone(p, 0);
      }
    }
    const v = { x: 0, y: 0, z: 0 };
    for (const d of this.drones) {
      if ((!night && now > d.until) || !players.some((p) => Math.hypot(p.x - d.x, p.z - d.z) < DRONE_LONELY)) d.leaving = true;
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
          if (now < g.calmUntil || (g.prey >= 0 && g.prey !== p.id)) continue;
          if (Math.hypot(g.x - p.x, g.z - p.z) < ALERT_R) this.hunt(g, p, now);
        }
      }
    }
    this.drones = this.drones.filter((d) => !d.leaving || d.y < heightAt(d.x, d.z) + DRONE_ALT * 4.5);
  }

  /** Debug menu: the nearest guardian walks in from 90 m away, or a drone comes for a minute. */
  summon(what: unknown, p: BotPlayer, now: number) {
    if (what === 'drone') return this.spawnDrone(p, now + 60_000, 70);
    if (what !== 'guardian' || !this.guardians.length) return;
    const g = this.guardians.reduce((a, b) => (Math.hypot(a.x - p.x, a.z - p.z) < Math.hypot(b.x - p.x, b.z - p.z) ? a : b));
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

  private spawnDrone(p: BotPlayer, until: number, from = DRONE_FROM) {
    const a = rand(-Math.PI, Math.PI);
    const x = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, p.x + Math.sin(a) * from));
    const z = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, p.z + Math.cos(a) * from));
    const d: Drone = {
      id: this.nextDrone++, x, z, y: heightAt(x, z) + DRONE_ALT, yaw: Math.atan2(p.x - x, p.z - z),
      hx: p.x, hz: p.z, tx: p.x, tz: p.z, lock: -1, litAt: 0, leaving: false, dx: 0, dy: -1, dz: 0, until,
    };
    // First pass: through the player's area from where it came in.
    d.tx = p.x + rand(-40, 40);
    d.tz = p.z + rand(-40, 40);
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
      if (Math.hypot(o.x - x, o.z - z) > SEND_R) continue;
      g.push(o.id, o.legs, r2(o.x), r2(o.z), r3(o.yaw), o.prey < 0 ? 0 : o.prey === id ? 2 : 1);
    }
    for (const o of this.drones) {
      if (Math.hypot(o.x - x, o.z - z) > SEND_R) continue;
      d.push(o.id, r2(o.x), r2(o.y), r2(o.z), r3(o.yaw), r3(o.dx), r3(o.dy), r3(o.dz), o.lock < 0 ? 0 : o.lock === id ? 2 : 1);
    }
    return { t: 'bots', time, g, d };
  }
}
