// Server side of the fixed-wing drones (shared/jets.ts): now and then one flies past a random player, in a straight
// pass or a big circle around them, and the list goes out to everyone whenever it changes. Shot (shoot) JET_HP times,
// one glides down to the sand. In memory only.
import { GLIDE, GLIDE_SPEED, SPIN_GLIDE, SPIN_SPEED, JET_ALT_MAX, JET_ALT_MIN, JET_HIT, JET_HP, JET_SPEED_MAX, JET_SPEED_MIN, LEAD, WRECK_MS, jetAt, jetLength, jetPose, type Jet } from '../shared/jets.ts';
import { baseHeight } from '../shared/terrain.ts';
import type { ServerMsg } from '../shared/protocol.ts';

/** Time between one flight's start and the next (ms). */
const GAP_MIN_MS = 150_000;
const GAP_MAX_MS = 6 * 60_000;
const MAX_JETS = 2;
/** The pass lands within this far (m) of the player it was picked for; a circle's ring passes about as near. */
const OFFSET = 350;
/** Share of flights that circle; circle radius (m) and how far round they go (rad). */
const CIRCLE = 0.4;
const R_MIN = 700;
const R_MAX = 1400;
const TURN_MIN = 0.75 * Math.PI;
const TURN_MAX = 2.5 * Math.PI;

/** The shooter sees the jet at its guess of the server clock: test the shot against where it was this far back (ms). */
const LAG_MS = [0, 100, 200, 300];

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const _p = jetPose();

export class JetServer {
  jets: Jet[] = [];
  private nextId = 1;
  private nextAt: number;
  private changed = false;

  constructor(now: number) {
    this.nextAt = now + rand(GAP_MIN_MS, GAP_MAX_MS) / 2;
  }

  /** Server time `now` (ms) and where the players are. Returns a 'jets' message when the list changed. */
  tick(now: number, players: { x: number; z: number }[]): ServerMsg | null {
    const live = this.jets.filter((j) => j.end > now);
    if (live.length !== this.jets.length) {
      this.jets = live;
      this.changed = true;
    }
    if (now >= this.nextAt) {
      this.nextAt = now + rand(GAP_MIN_MS, GAP_MAX_MS);
      const p = players[Math.floor(Math.random() * players.length)];
      if (p && this.jets.length < MAX_JETS) this.spawn(p.x, p.z, OFFSET, now);
    }
    if (!this.changed) return null;
    this.changed = false;
    return this.msg();
  }

  /** A flight past (x, z), within `offset` m of it, entering at `now` (debug: `soon`: a straight pass, 1200 m out). */
  spawn(x: number, z: number, offset: number, now: number, soon = false) {
    const a = Math.random() * Math.PI * 2, circle = !soon && Math.random() < CIRCLE, r = circle ? rand(R_MIN, R_MAX) : 1;
    // A pass: through (px, pz). A circle: centred there, so its ring runs within about `offset` of (x, z).
    const d = circle ? r + offset * (Math.random() * 2 - 1) : offset * Math.sqrt(Math.random());
    const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
    const speed = rand(JET_SPEED_MIN, JET_SPEED_MAX), yaw = rand(-Math.PI, Math.PI);
    let ax = px, az = pz, turn = 0;
    if (circle) {
      // The arc starts where heading `yaw` is tangent to the circle.
      turn = rand(TURN_MIN, TURN_MAX) * (Math.random() < 0.5 ? -1 : 1);
      const k = Math.sign(turn) / r;
      ax = px - Math.cos(yaw) / k;
      az = pz + Math.sin(yaw) / k;
    }
    // A straight pass is "turn 0" at (px, pz): run in LEAD to it, out LEAD past it.
    const lead = soon ? 1200 : LEAD;
    const jet = {
      id: this.nextId++,
      x: Math.round(ax - Math.sin(yaw) * lead),
      z: Math.round(az - Math.cos(yaw) * lead),
      yaw: Math.round(yaw * 1e4) / 1e4,
      y: Math.round(baseHeight(x, z) + rand(JET_ALT_MIN, JET_ALT_MAX)),
      speed: Math.round(speed),
      run: lead,
      turn: Math.round(turn * 1e4) / 1e4,
      r: Math.round(r),
      out: LEAD,
      start: Math.round(now),
      end: 0,
      hurt: 0,
    };
    jet.end = Math.round(now + (jetLength(jet) / jet.speed) * 1000);
    this.jets.push(jet);
    this.changed = true;
  }

  /** A rifle shot from (x, y, z) to (ex, ey, ez) at server time `now` that the client says hit jet `id`: true if it
   *  passed near where that jet was lately (the last hit brings it down). */
  shoot(x: number, y: number, z: number, ex: number, ey: number, ez: number, id: unknown, now: number): boolean {
    const j = this.jets.find((o) => o.id === id);
    if (!j || j.down) return false;
    const dx = ex - x, dy = ey - y, dz = ez - z, len2 = dx * dx + dy * dy + dz * dz;
    if (len2 < 0.01) return false;
    const near = LAG_MS.some((lag) => {
      if (!jetAt(j, now - lag, _p)) return false;
      const t = Math.max(0, Math.min(1, ((_p.x - x) * dx + (_p.y - y) * dy + (_p.z - z) * dz) / len2));
      return Math.hypot(x + dx * t - _p.x, y + dy * t - _p.y, z + dz * t - _p.z) < JET_HIT && Math.hypot(ex - _p.x, ey - _p.y, ez - _p.z) < JET_HIT * 1.5;
    });
    if (!near) return false;
    this.changed = true;
    if (++j.hurt >= JET_HP) this.bringDown(j, now);
    return true;
  }

  /** Where flying jet `id` was `ago` ms back (the jammer's client sees it on its guess of the server clock), or null. */
  where(id: number, now: number, ago = 150): { x: number; y: number; z: number } | null {
    const j = this.jets.find((o) => o.id === id);
    if (!j || j.down || !jetAt(j, now - ago, _p)) return null;
    return { x: _p.x, y: _p.y, z: _p.z };
  }

  /** Jammed (shared/jammer.ts): it falls in a flat spin and lands whole on its belly. */
  jam(id: number, now: number) {
    const j = this.jets.find((o) => o.id === id);
    if (!j || j.down) return;
    this.changed = true;
    this.bringDown(j, now, true);
  }

  /** Engine dead (or jammed: `soft`): it glides on along its heading until that line meets the sand (marched, then
   *  halved down to 1 m). */
  private bringDown(j: Jet, now: number, soft = false) {
    jetAt(j, now, _p);
    const glide = soft ? SPIN_GLIDE : GLIDE;
    const sx = Math.sin(_p.yaw), sz = Math.cos(_p.yaw), above = (f: number) => _p.y - f / glide - baseHeight(_p.x + sx * f, _p.z + sz * f);
    let lo = 0, hi = 20;
    while (above(hi) > 0 && hi < 5000) [lo, hi] = [hi, hi + 20];
    while (hi - lo > 1) {
      const mid = (lo + hi) / 2;
      if (above(mid) > 0) lo = mid;
      else hi = mid;
    }
    const land = Math.round(now + (hi / (j.speed * (soft ? SPIN_SPEED : GLIDE_SPEED))) * 1000);
    const lx = _p.x + sx * hi, lz = _p.z + sz * hi;
    const r = (v: number) => Math.round(v * 100) / 100;
    j.down = { at: Math.round(now), x: r(_p.x), y: r(_p.y), z: r(_p.z), yaw: r(_p.yaw), land, lx: r(lx), ly: r(baseHeight(lx, lz)), lz: r(lz), ...(soft ? { soft: true as const } : {}) };
    j.end = land + WRECK_MS;
  }

  msg(): ServerMsg {
    return { t: 'jets', jets: this.jets };
  }
}
