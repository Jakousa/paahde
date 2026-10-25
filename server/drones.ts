// Server side of the searchlight drones (shared/guardians.ts): where they fly, who their beams find and hold, how
// they come down. In memory only. Ticked by server/guardians.ts, which sends the guardians after whoever a beam holds
// and the missiles at them.
//
// Drones belong to a crash site: at night they turn up over the crawler and guardian ground someone is near, and go
// when everyone has left. The scrap fields (level 0) near the base have none. A few more drones roam the open desert
// day and night (ROAMERS), drifting in near someone now and then on long legs, and flying off again after a few
// minutes.
import { ORIGIN } from '../shared/origin.ts';
import { crashSite } from '../shared/crashsites.ts';
import {
  beamDir, CHASE_BACK, CHASE_SPEED, DRONE_ALT, DRONE_SPEED, IGNORE_MS, inBeam, lineOfSight, LOSE_MS, NIGHT_SUN, NOTICE_R,
  SEEK_GIVE_UP, SEEK_RATE, sweepAt, TRACK_RATE,
} from '../shared/guardians.ts';
import { frontOut, nearStorm, type Storm } from '../shared/storm.ts';
import { DRONE_HIT, DRONE_HP, DRONE_WRECK_S, RANGE, shotPasses } from '../shared/rifle.ts';
import { sunElevation } from '../shared/sun.ts';
import { heightAt } from '../shared/terrain.ts';
import { type BotPlayer, type Kill, r2, r3, rand, SEND_R, SITE_LEAVE_R, SITE_NEAR_R, sitesNear, wrap } from './bots.ts';

/** Drones over a site at night, all drones at most; they come in from DRONE_FROM (m) and patrol within DRONE_AREA.
 *  One shot down (or gone) is replaced, one at a time, REFILL_MS later. */
const DRONES_PER_SITE = 2;
const MAX_DRONES = 16;
const DRONE_FROM = 220;
const DRONE_AREA = 110;
const REFILL_MS = 60_000;
/** A drone hit from any distance heads for the shooter this long (ms), renewed by every hit. */
const HUNT_MS = 45_000;
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
const ROAM_EVERY_S = 90;
const ROAM_FROM: [number, number] = [300, 420];
const ROAM_MIN = 3 * 60_000, ROAM_MAX = 6 * 60_000;
const ROAM_LEG: [number, number] = [120, 350];
const ROAM_BASE_KEEP_OUT = 250;

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
  /** Shot by this player (-1 none) from wherever: flies to where they are now until then (server ms). */
  hunt: number; huntUntil: number;
  /** Summoned from the debug menu or roaming: stays out until then (server ms), day or not (roaming: no longer). */
  until: number;
  /** Beam direction (unit), sent to clients. */
  dx: number; dy: number; dz: number;
  /** Rifle hits taken; shot down when (-1 flying), falling with velocity (vx, vy, vz), on the sand (crashed).
   *  Jammed (shared/jammer.ts): brought down gently instead, settling on the sand whole. */
  hurt: number; downAt: number; vx: number; vy: number; vz: number; crashed: boolean; jammed: boolean;
  /** Fleeing a storm front: climbing straight for the sky (leaving too), gone once FLEE_TOP up. */
  fled: boolean;
};

/** Drones fleeing a storm front climb this fast (m/s), drifting on at this, and are gone this high (m) over the sand. */
const FLEE_CLIMB = 14;
const FLEE_DRIFT = 6;
const FLEE_TOP = 260;

/** A jammed drone sinks this fast (m/s). */
const JAM_SINK = 2.5;

export class DroneServer {
  drones: Drone[] = [];
  private nextDrone = 1;
  /** Shot-down drones that have hit the sand, for crashes(). */
  private downed: Kill[] = [];
  /** Crash site id → when its next replacement drone comes (server ms; 0 none due); a site not in it gets all its drones
   *  at once. Forgotten once everyone has left the site (SITE_LEAVE_R) or the night is over. */
  private refill = new Map<number, number>();

  /**
   * Flies the drones by dt s at server time `now` (ms), time of day `tod`, through `storms`; `exposed` are the players
   * out in the open, `byId` all of them. Each time a beam holds someone this tick, `alert(p)` is called right then (the
   * guardians near them come for them). Returns who the beams hold right now.
   */
  tick(dt: number, now: number, tod: number, players: BotPlayer[], exposed: BotPlayer[], byId: Map<number, BotPlayer>,
    storms: readonly Storm[], alert: (p: BotPlayer) => void): Set<number> {
    const lit = new Set<number>();
    const night = sunElevation(tod) < NIGHT_SUN;
    // A storm front coming: every drone flies up out of it, and none come until it has died down.
    const front = frontOut(storms, now);
    // At night, every crawler- or guardian-ground site someone is near has its drones over it (not the scrap fields).
    if (night && !front) {
      for (const id of this.refill.keys()) {
        const s = crashSite(id)!;
        if (!players.some((p) => Math.hypot(p.x - s.x, p.z - s.z) < SITE_LEAVE_R)) this.refill.delete(id);
      }
      for (const s of sitesNear(exposed, SITE_NEAR_R)) {
        if (s.level === 0) continue;
        if (this.drones.length >= MAX_DRONES) break;
        let have = this.drones.filter((d) => !d.leaving && d.downAt < 0 && d.site === s.id).length;
        const at = this.refill.get(s.id);
        if (at === undefined) {
          for (; have < DRONES_PER_SITE && this.drones.length < MAX_DRONES; have++) this.spawn(s.x, s.z, s.id, 0, DRONE_FROM);
          this.refill.set(s.id, 0);
        } else if (have >= DRONES_PER_SITE) this.refill.set(s.id, 0);
        else if (at === 0) this.refill.set(s.id, now + REFILL_MS);
        else if (now >= at) {
          this.spawn(s.x, s.z, s.id, 0, DRONE_FROM);
          this.refill.set(s.id, have + 1 < DRONES_PER_SITE ? now + REFILL_MS : 0);
        }
      }
    } else this.refill.clear();
    if (!front) this.roam(dt, now, exposed);
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
      if (front) d.fled = d.leaving = true;
      // Near a storm the light is off and it notices nobody (the client darkens it by the same rule).
      const dark = nearStorm(storms, d.x, d.z, now);
      if (dark) d.lock = d.seek = -1;
      if (dark || d.leaving || now > d.huntUntil) d.hunt = -1;
      let speed = DRONE_SPEED, tx = d.tx, tz = d.tz, alt = DRONE_ALT;
      const prey = d.lock >= 0 ? byId.get(d.lock) : undefined;
      if (prey || d.leaving) d.seek = -1;
      if (prey) d.hunt = -1;
      if (!prey && !d.leaving && !dark) this.notice(d, now, exposed);
      const hunted = d.hunt >= 0 ? exposed.find((o) => o.id === d.hunt) : undefined;
      if (d.hunt >= 0 && !hunted) d.hunt = -1;
      const sought = d.seek >= 0 ? byId.get(d.seek) : hunted;
      const target = prey ?? sought;
      if (d.leaving) {
        d.lock = -1;
        alt = DRONE_ALT * 5;
        speed = d.fled ? FLEE_DRIFT : CHASE_SPEED;
        tx = d.x + Math.sin(d.yaw) * 100;
        tz = d.z + Math.cos(d.yaw) * 100;
      } else if (target) {
        // Hang back from them, beam on them (searching them out: at patrol speed).
        const hx = d.x - target.x, hz = d.z - target.z, h = Math.hypot(hx, hz) || 1;
        tx = target.x + (hx / h) * CHASE_BACK;
        tz = target.z + (hz / h) * CHASE_BACK;
        if (prey || (hunted && d.seek < 0)) speed = CHASE_SPEED;
      } else if (Math.hypot(tx - d.x, tz - d.z) < 5) {
        this.point(d);
      }
      // Fly: turn towards the target, ease the height over the ground ahead.
      const dx = tx - d.x, dz = tz - d.z, dist = Math.hypot(dx, dz);
      if (dist > 0.5) {
        const step = Math.min(dist, speed * dt);
        d.x += (dx / dist) * step;
        d.z += (dz / dist) * step;
        if (!target) d.yaw = wrap(d.yaw + wrap(Math.atan2(dx, dz) - d.yaw) * (1 - Math.exp(-dt * 1.5)));
      }
      const bd = Math.hypot(d.x - ORIGIN.x, d.z - ORIGIN.z), keep = d.site === ROAM && !prey ? ROAM_BASE_KEEP_OUT : DRONE_BASE_KEEP_OUT;
      if (bd < keep && !d.leaving) {
        d.x = ORIGIN.x + ((d.x - ORIGIN.x) / bd) * keep;
        d.z = ORIGIN.z + ((d.z - ORIGIN.z) / bd) * keep;
        this.point(d);
      }
      // (Looking well ahead: a canyon's wall (shared/canyons.ts) rises hundreds of metres in a few steps.)
      const fx = Math.sin(d.yaw), fz = Math.cos(d.yaw), here = heightAt(d.x, d.z);
      const ground = Math.max(here, heightAt(d.x + fx * 15, d.z + fz * 15), heightAt(d.x + fx * 40, d.z + fz * 40) - 10);
      if (d.fled) d.y += FLEE_CLIMB * dt;
      else d.y += (ground + alt - d.y) * (1 - Math.exp(-dt * (d.leaving ? 0.3 : 1.2)));
      if (d.y < here + 4) d.y = here + 4; // never through the ground
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
      // Whoever it has right now: the missiles come for them, and the guardians near them (server/guardians.ts).
      if (d.lock >= 0 && d.litAt === now) {
        const p = byId.get(d.lock)!;
        lit.add(p.id);
        alert(p);
      }
    }
    this.drones = this.drones.filter((d) => d.downAt >= 0 ? now - d.downAt < DRONE_WRECK_S * 1000 : !d.leaving || d.y < heightAt(d.x, d.z) + (d.fled ? FLEE_TOP : DRONE_ALT * 4.5));
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
    // Jammed: sinking at a steady JAM_SINK while it drifts to a stop.
    if (d.jammed) d.vy = -JAM_SINK;
    else d.vy -= 9.8 * dt;
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
  shoot(x: number, y: number, z: number, ex: number, ey: number, ez: number, id: unknown, now: number, by = -1): boolean {
    const d = this.drones.find((o) => o.id === id);
    if (!d || d.downAt >= 0) return false;
    const dx = ex - x, dz = ez - z, len = Math.hypot(dx, ey - y, dz);
    // The client draws it 250 ms in the past, and it moves up to CHASE_SPEED: slack for that.
    if (len > RANGE + 5 || !shotPasses(x, y, z, ex, ey, ez, d.x, d.y, d.z, DRONE_HIT + 2)) return false;
    this.hurt(d, dx / len, dz / len, now, by);
    return true;
  }

  /** The first flying drone within `r` m of (x, y, z), or -1 (thrown scrap, server/throws.ts). */
  near(x: number, y: number, z: number, r: number): number {
    return this.drones.find((d) => d.downAt < 0 && Math.hypot(d.x - x, d.y - y, d.z - z) < r)?.id ?? -1;
  }

  /** Something thrown by player `by` struck drone `id` going along (dx, dz) (unit): a hit, as from a rifle. */
  strike(id: number, dx: number, dz: number, now: number, by: number) {
    const d = this.drones.find((o) => o.id === id);
    if (d && d.downAt < 0) this.hurt(d, dx, dz, now, by);
  }

  /** Where flying drone `id` is (the jammer's check), or null. */
  at(id: number): { x: number; y: number; z: number } | null {
    const d = this.drones.find((o) => o.id === id);
    return d && d.downAt < 0 ? d : null;
  }

  /** Jammed (shared/jammer.ts): light out and rotors winding down, it sinks to the sand whole. */
  jam(id: number, now: number) {
    const d = this.drones.find((o) => o.id === id);
    if (!d || d.downAt >= 0) return;
    d.downAt = now;
    d.jammed = true;
    d.lock = -1;
    d.vx = Math.sin(d.yaw) * DRONE_SPEED * 0.6;
    d.vz = Math.cos(d.yaw) * DRONE_SPEED * 0.6;
    d.vy = -JAM_SINK;
  }

  /** Drone `d` takes a hit along unit (dx, dz) from player `by`; the last one brings it down. */
  private hurt(d: Drone, dx: number, dz: number, now: number, by: number) {
    if (++d.hurt < DRONE_HP) {
      // Hit from anywhere: it comes for where the shooter is now.
      if (by >= 0 && !d.leaving) {
        d.hunt = by;
        d.huntUntil = now + HUNT_MS;
      }
      return;
    }
    // Down: it drops, still drifting the way it was going, its light out.
    d.downAt = now;
    d.lock = -1;
    const sp = d.leaving ? CHASE_SPEED : DRONE_SPEED * 0.8;
    d.vx = Math.sin(d.yaw) * sp + dx * 3;
    d.vz = Math.cos(d.yaw) * sp + dz * 3;
    d.vy = 1.5;
  }

  /** Debug menu: a drone comes for a minute. */
  summon(p: BotPlayer, now: number) {
    this.spawn(p.x, p.z, -1, now + 60_000, 70);
  }

  /** A drone coming in from `from` m away to patrol around (hx, hz), over crash site `site` (-1: summoned). */
  private spawn(hx: number, hz: number, site: number, until: number, from: number) {
    const a = rand(-Math.PI, Math.PI);
    const x = hx + Math.sin(a) * from;
    const z = hz + Math.cos(a) * from;
    const d: Drone = {
      id: this.nextDrone++, x, z, y: heightAt(x, z) + DRONE_ALT, yaw: Math.atan2(hx - x, hz - z),
      hx, hz, tx: hx, tz: hz, site, lock: -1, hurt: 0, downAt: -1, vx: 0, vy: 0, vz: 0, crashed: false, jammed: false, fled: false, litAt: 0, leaving: false, lost: -1, lostUntil: 0, seek: -1, seenAt: 0, hunt: -1, huntUntil: 0, dx: 0, dy: -1, dz: 0, until,
    };
    // First pass: across the site from where it came in.
    d.tx = hx + rand(-30, 30);
    d.tz = hz + rand(-30, 30);
    this.drones.push(d);
  }

  private point(d: Drone) {
    if (d.site === ROAM) {
      // A long leg somewhere ahead-ish, clear of the base.
      for (let i = 0; i < 8; i++) {
        const a = d.yaw + rand(-1.6, 1.6), r = rand(...ROAM_LEG);
        d.tx = d.x + Math.sin(a) * r;
        d.tz = d.z + Math.cos(a) * r;
        if (Math.hypot(d.tx - ORIGIN.x, d.tz - ORIGIN.z) > ROAM_BASE_KEEP_OUT + 20) return;
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
      if (Math.hypot(hx - ORIGIN.x, hz - ORIGIN.z) < ROAM_BASE_KEEP_OUT) continue;
      this.spawn(hx, hz, ROAM, now + rand(ROAM_MIN, ROAM_MAX), rand(...ROAM_FROM));
      out++;
    }
  }

  /** The drones in the 'bots' message for a player `id` at (x, z): within SEND_R, flagged when locked on to them. */
  msg(time: number, id: number, x: number, z: number): number[] {
    const d: number[] = [];
    for (const o of this.drones) {
      if (Math.hypot(o.x - x, o.z - z) > SEND_R) continue;
      d.push(o.id, r2(o.x), r2(o.y), r2(o.z), r3(o.yaw), r3(o.dx), r3(o.dy), r3(o.dz), o.lock < 0 ? 0 : o.lock === id ? 2 : 1,
        o.hurt, o.downAt < 0 ? 0 : Math.round((time - o.downAt) / 100) / 10 + 0.01, o.jammed ? 1 : 0);
    }
    return d;
  }
}
