// Server side of the crash sites (shared/crash.ts).
//  - Small machines are carried home: crashTake validates reach and puts the machine in the player's bag (an item
//    of the component's kind); the site stays empty until it refills. crashUse takes one out of the bag when it
//    is put on the workbench.
//  - Large machines are worked on by everyone near them through an in-memory session per site: which steps are
//    done, which parts are taken, and who is holding which lifting eye right now. A step that needs several
//    players (a lift) is only accepted while that many are holding. Sessions forget their state after
//    SESSION_TTL_MS with nobody in them, so the wreck is whole again later.
// What a step or part index means is up to the client (they are indexes into the machine the site's seed
// builds), so the server only checks them for range.
import { BENCH, CARRY_KINDS, crashSiteById, crashTaken, CRASH_REACH, SITE_RANGE } from '../shared/crash.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { COMPONENTS } from '../shared/salvage.ts';
import type { openDb } from './db.ts';

type Db = ReturnType<typeof openDb>;
type Feet = { x: number; z: number };

/** Carried-off machines are back after this long. */
const RESPAWN_MS = 45 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
/** A lifting eye counts as held this long after the last hold message. */
const HOLD_TTL_MS = 3000;
const REACH_SLACK = 1.5;
const BENCH_REACH = 6;
const MAX_INDEX = 255;
const COOLDOWN_MS = 200;

interface Session {
  done: Set<number>;
  /** Part index → public id of the player who took it. */
  taken: Map<number, number>;
  /** Public ids in the session. */
  players: Set<number>;
  /** Lifting eye → (player → time of last hold message). */
  holders: Map<number, Map<number, number>>;
  need: Map<number, number>;
  lastActive: number;
}

export class CrashServer {
  private db: Db;
  private notify: (ids: Iterable<number>, msg: ServerMsg) => void;
  private taken = new Map<string, number>();
  private newlyTaken: string[] = [];
  private newlyBack: string[] = [];
  private sessions = new Map<string, Session>();

  constructor(db: Db, notify: (ids: Iterable<number>, msg: ServerMsg) => void) {
    this.db = db;
    this.notify = notify;
    for (const r of db.loadCrashTaken()) {
      const s = crashSiteById(r.id);
      if (!s || !COMPONENTS[s.kind].carry) continue; // the layout changed since: forget it
      this.taken.set(r.id, r.taken_at);
      crashTaken.add(r.id);
    }
    console.log(`crash: ${this.taken.size} sites carried off`);
  }

  // -- carrying -----------------------------------------------------------------------------------------------

  /** A player carries off the machine at small site `id`. `give(kind)` puts it in their bag (false: no room).
   *  Returns the item kind, or null if refused (unknown or taken site, out of reach, too soon, bag full). */
  carry(feet: Feet, id: unknown, last: { at: number }, give: (kind: string) => boolean): string | null {
    const site = crashSiteById(id);
    const now = Date.now();
    if (!site || !COMPONENTS[site.kind].carry || crashTaken.has(site.id) || now - last.at < COOLDOWN_MS) return null;
    if (Math.hypot(site.x - feet.x, site.z - feet.z) > CRASH_REACH + REACH_SLACK) return null;
    last.at = now;
    const ok = this.db.tx(() => {
      if (!give(site.kind)) return false;
      this.db.takeCrash(site.id, now);
      return true;
    });
    if (!ok) return null;
    this.taken.set(site.id, now);
    crashTaken.add(site.id);
    this.newlyTaken.push(site.id);
    return site.kind;
  }

  /** Put one carried machine of item `kind` on the workbench; `take()` uses it up from the bag. */
  use(feet: Feet, kind: unknown, take: () => boolean): boolean {
    if (typeof kind !== 'string' || !(CARRY_KINDS as string[]).includes(kind)) return false;
    if (Math.hypot(BENCH.x - feet.x, BENCH.z - feet.z) > BENCH_REACH) return false;
    return take();
  }

  /** Bring back sites carried off more than RESPAWN_MS ago, and forget abandoned sessions. */
  maintain() {
    const now = Date.now();
    for (const [id, at] of this.taken) {
      if (now - at < RESPAWN_MS) continue;
      this.taken.delete(id);
      crashTaken.delete(id);
      this.db.respawnCrash(id);
      this.newlyBack.push(id);
    }
    for (const [id, s] of this.sessions) if (s.players.size === 0 && now - s.lastActive > SESSION_TTL_MS) this.sessions.delete(id);
  }

  joinMessage(): ServerMsg {
    return { t: 'crash', taken: [...this.taken.keys()], back: [], reset: true };
  }

  flush(): ServerMsg | null {
    if (!this.newlyTaken.length && !this.newlyBack.length) return null;
    const msg: ServerMsg = { t: 'crash', taken: this.newlyTaken, back: this.newlyBack };
    this.newlyTaken = [];
    this.newlyBack = [];
    return msg;
  }

  // -- shared sessions ----------------------------------------------------------------------------------------

  private large(id: unknown) {
    const site = crashSiteById(id);
    return site && !COMPONENTS[site.kind].carry ? site : null;
  }
  private index(i: unknown): i is number {
    return typeof i === 'number' && Number.isInteger(i) && i >= 0 && i <= MAX_INDEX;
  }
  private live(s: Session, i: number): number {
    const h = s.holders.get(i);
    if (!h) return 0;
    const now = Date.now();
    for (const [p, at] of h) if (now - at > HOLD_TTL_MS || !s.players.has(p)) h.delete(p);
    return h.size;
  }

  /** `pid` (public id) joins the session of large site `id`; returns the state to send them. */
  join(pid: number, feet: Feet, id: unknown): ServerMsg | null {
    const site = this.large(id);
    if (!site || Math.hypot(site.x - feet.x, site.z - feet.z) > SITE_RANGE + REACH_SLACK) return null;
    let s = this.sessions.get(site.id);
    if (!s) this.sessions.set(site.id, (s = { done: new Set(), taken: new Map(), players: new Set(), holders: new Map(), need: new Map(), lastActive: Date.now() }));
    s.players.add(pid);
    s.lastActive = Date.now();
    return { t: 'siteState', id: site.id, done: [...s.done], taken: [...s.taken.keys()] };
  }

  leave(pid: number, id: unknown) {
    const site = this.large(id);
    const s = site && this.sessions.get(site.id);
    if (!site || !s || !s.players.delete(pid)) return;
    s.lastActive = Date.now();
    for (const [i, h] of s.holders) {
      if (h.delete(pid)) this.notify(s.players, { t: 'siteHolders', id: site.id, i, n: this.live(s, i) });
    }
  }

  /** The player disconnected: leave every session. */
  leaveAll(pid: number) {
    for (const id of this.sessions.keys()) this.leave(pid, id);
  }

  hold(pid: number, id: unknown, i: unknown, players: unknown, on: unknown) {
    const site = this.large(id);
    const s = site && this.sessions.get(site.id);
    if (!site || !s || !s.players.has(pid) || !this.index(i)) return;
    if (typeof players !== 'number' || !Number.isInteger(players) || players < 1 || players > 8) return;
    s.lastActive = Date.now();
    s.need.set(i, players);
    let h = s.holders.get(i);
    if (!h) s.holders.set(i, (h = new Map()));
    const before = this.live(s, i);
    if (on) h.set(pid, Date.now());
    else h.delete(pid);
    const n = this.live(s, i);
    // The 1 s refreshes change nothing; only tell people when the count moves.
    if (n !== before) this.notify(s.players, { t: 'siteHolders', id: site.id, i, n });
  }

  done(pid: number, id: unknown, i: unknown) {
    const site = this.large(id);
    const s = site && this.sessions.get(site.id);
    if (!site || !s || !s.players.has(pid) || !this.index(i) || s.done.has(i)) return;
    const need = s.need.get(i) ?? 1;
    if (need > 1 && (this.live(s, i) < need || !s.holders.get(i)?.has(pid))) return; // not enough hands
    s.done.add(i);
    s.holders.delete(i);
    s.lastActive = Date.now();
    this.notify(s.players, { t: 'siteDone', id: site.id, i });
  }

  /** First to take part `i` gets it; later askers are told who did. */
  takePart(pid: number, id: unknown, i: unknown) {
    const site = this.large(id);
    const s = site && this.sessions.get(site.id);
    if (!site || !s || !s.players.has(pid) || !this.index(i)) return;
    const owner = s.taken.get(i);
    if (owner !== undefined && owner !== pid) {
      this.notify([pid], { t: 'siteTake', id: site.id, i, by: owner }); // too late
      return;
    }
    if (owner === undefined) {
      s.taken.set(i, pid);
      s.lastActive = Date.now();
      this.notify(s.players, { t: 'siteTake', id: site.id, i, by: pid });
    }
  }
}
