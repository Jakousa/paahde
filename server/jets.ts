// Server side of the fixed-wing drones (shared/jets.ts): now and then one flies past a random player, in a straight
// pass or a big circle around them, and the list goes out to everyone whenever it changes. In memory only.
import { JET_ALT_MAX, JET_ALT_MIN, JET_SPEED_MAX, JET_SPEED_MIN, LEAD, jetLength, type Jet } from '../shared/jets.ts';
import { baseHeight } from '../shared/terrain.ts';
import type { ServerMsg } from '../shared/protocol.ts';

/** Time between one flight's start and the next (ms). */
const GAP_MIN_MS = 90_000;
const GAP_MAX_MS = 4 * 60_000;
const MAX_JETS = 2;
/** The pass lands within this far (m) of the player it was picked for; a circle's ring passes about as near. */
const OFFSET = 350;
/** Share of flights that circle; circle radius (m) and how far round they go (rad). */
const CIRCLE = 0.4;
const R_MIN = 700;
const R_MAX = 1400;
const TURN_MIN = 0.75 * Math.PI;
const TURN_MAX = 2.5 * Math.PI;

const rand = (a: number, b: number) => a + Math.random() * (b - a);

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
    };
    jet.end = Math.round(now + (jetLength(jet) / jet.speed) * 1000);
    this.jets.push(jet);
    this.changed = true;
  }

  msg(): ServerMsg {
    return { t: 'jets', jets: this.jets };
  }
}
