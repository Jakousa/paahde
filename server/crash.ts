// Server side of the machine sites (shared/crash.ts) at the crashed spacecraft.
//  - When every part of a crash site's large machine has been taken, the crash site is spent (persisted with a
//    timestamp, broadcast as 'crashSpent'): it stops smoking and its machine stays a husk, permanently.
//  - Small machines are carried home: crashTake validates reach and puts the machine in the player's bag (an item
//    of the component's kind); the site stays empty for good, except at a scrap field (STARTER_RESPAWN_MS). Salvage wrecks (shared/wrecks.ts, ids "w:...") are
//    carried the same way, and lie out there again WRECK_RESPAWN_MS later. crashUse takes one out of the bag when it
//    is put on the workbench.
//  - Large machines are worked on by everyone near them through a session per site: which steps are done and
//    which parts are taken (kept in SQLite, `machine_progress`, and never reset by itself: a stripped machine
//    stays stripped), and who is holding which lifting eye right now (memory only). A step that needs several
//    players (a lift) is only accepted while that many are holding. Every player is told about every step and
//    take ('sites' on join, then siteDone / siteTake), so a machine looks the same to everyone, worked on or not.
//  - The base's disassembly table is the same kind of session, with id BENCH_ID: crashUse puts a carried machine
//    on it with a seed picked here, and the job (kind, seed in `bench_job`, progress like a site's) is kept until
//    its last part is taken (or it is scrapped, scrapBench); then the table is free.
// A part index is checked against the machine's own part list (shared/machine.ts, from the site's or job's
// seed): whoever takes part i first gets that part's item in their bag. Step indexes are only checked for range
// (what they mean is up to the client's build of the machine, src/teardown/junk.ts).
import { machineChanged, pushedMachine, setMachineProgress } from '../shared/machineBoxes.ts';
import { CROUCH, BACK, DT, FORWARD, LEFT, PLAYER_RADIUS, RIGHT, STEP_UP } from '../shared/sim.ts';
import { BENCH, CARRY_KINDS, crashSiteById, crashSpent, crashTaken, CRASH_REACH, SITE_RANGE, TEARDOWN_LAYOUT } from '../shared/crash.ts';
import { CRASH_KINDS } from '../shared/crashKinds.ts';
import { crashSite, debrisById, debrisReach, DEBRIS_REACH } from '../shared/crashsites.ts';
import { debrisItem } from '../shared/items.ts';
import { machineParts, partItem, type MachinePart } from '../shared/machine.ts';
import type { BenchJob, ServerMsg } from '../shared/protocol.ts';
import { junkSpec, type JunkKind } from '../shared/salvage.ts';
import { LAB, labSites } from '../shared/lab.ts';
import { wreckById } from '../shared/wrecks.ts';
import type { openDb } from './db.ts';

type Db = ReturnType<typeof openDb>;
type Feet = { x: number; y: number; z: number };

/** A lifting eye counts as held this long after the last hold message. */
const HOLD_TTL_MS = 3000;
const REACH_SLACK = 1.5;
const BENCH_REACH = 6;
const MAX_INDEX = 255;
const COOLDOWN_MS = 200;
/** How fast (rad/s) a machine rolls when pushed at a walk: a quarter turn in about five seconds. */
const ROLL_RATE = 0.3;
/** Session id of the base's disassembly table. */
export const BENCH_ID = 'bench';

interface Session {
  done: Set<number>;
  /** Part index → public id of the player who took it. */
  taken: Map<number, number>;
  /** Public ids in the session. */
  players: Set<number>;
  /** Lifting eye → (player → time of last hold message). */
  holders: Map<number, Map<number, number>>;
  need: Map<number, number>;
}

/** Carried-off salvage wrecks (shared/wrecks.ts) are back after this long. */
const WRECK_RESPAWN_MS = 45 * 60 * 1000;
/** Picked-up crash debris (ids "d:...") lies there again after this long, like scrap (server/scrap.ts). */
const DEBRIS_RESPAWN_MS = 30 * 60 * 1000;

/** A small crash-site machine, a salvage wreck (shared/wrecks.ts, ids "w:...") or a crash debris piece (shared/crashsites.ts,
 *  ids "d:..."): something carried off whole. `kind` is the item it becomes; `dist` how far the player is from its reach. */
function carrySite(id: unknown): { id: string; kind: string; dist: (feet: Feet) => number } | null {
  const flat = (s: { x: number; z: number }) => (f: Feet) => Math.hypot(s.x - f.x, s.z - f.z) - CRASH_REACH;
  const w = wreckById(id);
  if (w) return { id: w.id, kind: w.kind, dist: flat(w) };
  const d = debrisById(id);
  if (d) return { id: d.id!, kind: debrisItem(CRASH_KINDS[d.kind].node), dist: (f) => debrisReach(f, d) - DEBRIS_REACH };
  const s = crashSiteById(id);
  return s && !s.lab && junkSpec(s.kind).carry ? { id: s.id, kind: s.kind, dist: flat(s) } : null;
}
/** A scrap field's small machines (site level 0, the starter machines every new player needs) are back after this long;
 *  other small machines stay gone. */
const STARTER_RESPAWN_MS = 20 * 60 * 1000;
const respawnMs = (id: string) => id.startsWith('w:') ? WRECK_RESPAWN_MS : id.startsWith('d:') ? DEBRIS_RESPAWN_MS
  : crashSiteById(id)?.level === 0 ? STARTER_RESPAWN_MS : Infinity;

export class CrashServer {
  private db: Db;
  private notify: (ids: Iterable<number>, msg: ServerMsg) => void;
  private taken = new Map<string, number>();
  private newlyTaken: string[] = [];
  private newlyBack: string[] = [];
  private newlySpent: number[] = [];
  private sessions = new Map<string, Session>();
  private broadcast: (msg: ServerMsg) => void;
  /** The machine on the disassembly table, or null when it is free. */
  private bench: { kind: JunkKind; seed: number } | null = null;

  constructor(db: Db, notify: (ids: Iterable<number>, msg: ServerMsg) => void, broadcast: (msg: ServerMsg) => void) {
    this.db = db;
    this.notify = notify;
    this.broadcast = broadcast;
    const job = db.loadBench();
    if (job && (CARRY_KINDS as string[]).includes(job.kind)) {
      this.bench = { kind: job.kind as JunkKind, seed: job.seed };
      console.log(`crash: ${job.kind} on the disassembly table`);
    }
    for (const r of db.loadProgress()) {
      const m = this.large(r.id);
      if (!m) continue; // the layout changed since (or the table is free): forget it
      const ok = (i: number) => Number.isInteger(i) && i >= 0 && i <= MAX_INDEX;
      // Steps saved under another layout point at different hardware now: redo them (the parts taken stay taken).
      const done = r.layout === TEARDOWN_LAYOUT ? r.done.filter(ok) : [];
      this.sessions.set(m.id, this.newSession(done, r.taken.filter((i) => ok(i) && i < m.parts.length)));
    }
    setMachineProgress((id) => this.sessions.get(id)?.done);
    if (this.bench && !this.sessions.has(BENCH_ID)) this.sessions.set(BENCH_ID, this.newSession([], []));
    console.log(`crash: ${this.sessions.size} machines worked on`);
    for (const r of db.loadCrashTaken()) {
      const s = carrySite(r.id);
      if (!s) continue; // the layout changed since: forget it
      this.taken.set(r.id, r.taken_at);
      crashTaken.add(r.id);
    }
    for (const r of db.loadCrashSpent()) if (crashSite(r.site)) crashSpent.add(r.site);
    console.log(`crash: ${this.taken.size} machines carried off, ${crashSpent.size} sites spent`);
  }

  // -- carrying -----------------------------------------------------------------------------------------------

  /** A player carries off the machine at small site `id`. `give(kind)` puts it in their bag (false: no room).
   *  Returns the item kind, or null if refused (unknown or taken site, out of reach, too soon, bag full). */
  carry(feet: Feet, id: unknown, last: { at: number }, give: (kind: string) => boolean): string | null {
    const site = carrySite(id);
    const now = Date.now();
    if (!site || crashTaken.has(site.id) || now - last.at < COOLDOWN_MS) return null;
    if (site.dist(feet) > REACH_SLACK) return null;
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

  /** Put one carried machine of item `kind` on the disassembly table (if it is free); `take()` uses it up from
   *  the bag. Everyone is told about the new job. */
  use(feet: Feet, kind: unknown, take: () => boolean): boolean {
    if (typeof kind !== 'string' || !(CARRY_KINDS as string[]).includes(kind) || this.bench) return false;
    if (Math.hypot(BENCH.x - feet.x, BENCH.z - feet.z) > BENCH_REACH) return false;
    const seed = (Math.random() * 4294967296) >>> 0;
    const ok = this.db.tx(() => {
      if (!take()) return false;
      this.db.saveBench(kind, seed);
      this.db.saveProgress(BENCH_ID, [], [], TEARDOWN_LAYOUT);
      return true;
    });
    if (!ok) return false;
    this.bench = { kind: kind as JunkKind, seed };
    this.sessions.set(BENCH_ID, this.newSession([], []));
    this.broadcast(this.benchMessage());
    return true;
  }

  /** The table's job as it stands, for joining players and after every change of job. */
  benchMessage(): ServerMsg {
    const s = this.sessions.get(BENCH_ID);
    const job: BenchJob | null = this.bench && s ? { ...this.bench, done: [...s.done], taken: [...s.taken.keys()] } : null;
    return { t: 'bench', job };
  }

  /** Steps done and parts taken at every machine worked on (not the table: 'bench' carries that), for joining players. */
  progressMessage(): ServerMsg {
    const sites = [...this.sessions].filter(([id, s]) => id !== BENCH_ID && (s.done.size || s.taken.size))
      .map(([id, s]) => ({ id, done: [...s.done], taken: [...s.taken.keys()] }));
    return { t: 'sites', sites };
  }

  private save(id: string, s: Session) {
    this.db.saveProgress(id, [...s.done], [...s.taken.keys()], TEARDOWN_LAYOUT);
  }

  /** The dev test lab's reset (labReset): `id` one lab machine, or every one of them. */
  labReset(id: unknown) {
    if (!LAB) return;
    for (const s of labSites()) if (id === undefined || id === s.id) this.resetSite(s.id);
  }

  /** Make a site's machine whole again: forget its progress (dev/admin helper; nothing calls it on its own). */
  resetSite(id: string) {
    if (id === BENCH_ID || !this.sessions.has(id)) return;
    this.sessions.delete(id);
    machineChanged(id);
    this.db.clearProgress(id);
    this.broadcast({ t: 'siteReset', id });
    if (this.rolls.delete(id)) this.broadcast({ t: 'siteRolls', rolls: [{ id, a: 0 }] }); // (set back as it was)
  }

  /** How far each machine that has been pushed round has rolled about its axis (rad), and which changed since the last message. */
  private rolls = new Map<string, number>();
  private rolled = new Set<string>();

  /** A player at `s` this tick with these keys (`input`) and facing (`yaw`): crouched and leaning on a machine, walking into it, they
   *  roll it, slowly, away from them: pushing from one side brings the other round. (Crouching so that brushing past never does.) */
  push(s: { x: number; y: number; z: number }, input: number, yaw: number) {
    if (!(input & CROUCH)) return;
    const fwd = (input & FORWARD ? 1 : 0) - (input & BACK ? 1 : 0);
    const strafe = (input & RIGHT ? 1 : 0) - (input & LEFT ? 1 : 0);
    let wx = -Math.sin(yaw) * fwd + Math.cos(yaw) * strafe;
    let wz = -Math.cos(yaw) * fwd - Math.sin(yaw) * strafe;
    const len = Math.hypot(wx, wz);
    if (!len) return;
    wx /= len;
    wz /= len;
    const hit = pushedMachine(s, s.y, PLAYER_RADIUS, STEP_UP, wx, wz);
    if (!hit) return;
    const { site, nx, nz, into } = hit;
    // which way round: the top moves away from the player (the axis' horizontal direction crossed with up, against the push)
    const ax = Math.sin(site.yaw), az = Math.cos(site.yaw);
    const side = az * nx - ax * nz;
    if (Math.abs(side) < 0.05) return; // pushing along the axis: it does not roll
    const rate = ROLL_RATE * into * Math.sign(side);
    this.rolls.set(site.id, (this.rolls.get(site.id) ?? 0) + rate * DT);
    this.rolled.add(site.id);
  }

  /** The machines that rolled since last time (each at most once per broadcast). */
  flushRolls(): ServerMsg | null {
    if (!this.rolled.size) return null;
    const rolls = [...this.rolled].map((id) => ({ id, a: Math.round((this.rolls.get(id) ?? 0) * 1000) / 1000 }));
    this.rolled.clear();
    return { t: 'siteRolls', rolls };
  }

  rollsMessage(): ServerMsg {
    return { t: 'siteRolls', rolls: [...this.rolls].map(([id, a]) => ({ id, a: Math.round(a * 1000) / 1000 })), reset: true };
  }

  joinMessage(): ServerMsg {
    return { t: 'crash', taken: [...this.taken.keys()], back: [], reset: true };
  }

  spentMessage(): ServerMsg {
    return { t: 'crashSpent', spent: [...crashSpent], reset: true };
  }

  flushSpent(): ServerMsg | null {
    if (!this.newlySpent.length) return null;
    const msg: ServerMsg = { t: 'crashSpent', spent: this.newlySpent };
    this.newlySpent = [];
    return msg;
  }

  /** The large machine of crash site `wreck` has no parts left: spent for good. */
  private spend(wreck: number) {
    if (crashSpent.has(wreck)) return;
    crashSpent.add(wreck);
    this.db.spendCrash(wreck, Date.now());
    this.newlySpent.push(wreck);
  }

  flush(): ServerMsg | null {
    // Salvage wrecks, crash debris and the scrap fields' machines lie out there again a while after being carried off
    // (other small machines stay gone).
    const now = Date.now();
    for (const [id, at] of this.taken) {
      if (now - at < respawnMs(id)) continue;
      this.taken.delete(id);
      crashTaken.delete(id);
      this.db.respawnCrash(id);
      this.newlyBack.push(id);
    }
    if (!this.newlyTaken.length && !this.newlyBack.length) return null;
    const msg: ServerMsg = { t: 'crash', taken: this.newlyTaken, back: this.newlyBack };
    this.newlyTaken = [];
    this.newlyBack = [];
    return msg;
  }

  // -- shared sessions ----------------------------------------------------------------------------------------

  /** A machine that can be worked on together: a large site, or the table while it holds a job. */
  /** A large site's or the table's machine; `wreck` is the crash site a field machine lies at (null: the table). */
  private large(id: unknown): { id: string; x: number; z: number; range: number; parts: MachinePart[]; wreck: number | null } | null {
    if (id === BENCH_ID) {
      return this.bench ? { id: BENCH_ID, x: BENCH.x, z: BENCH.z, range: BENCH_REACH, parts: machineParts(this.bench.kind, this.bench.seed), wreck: null } : null;
    }
    const site = crashSiteById(id);
    // (A lab machine is worked in place whatever its size, and is never spent.)
    return site && (site.lab || !junkSpec(site.kind).carry) ? { id: site.id, x: site.x, z: site.z, range: SITE_RANGE + REACH_SLACK, parts: machineParts(site.kind, site.seed, site.level), wreck: site.lab ? null : site.wreck } : null;
  }
  private newSession(done: number[], taken: number[]): Session {
    return { done: new Set(done), taken: new Map(taken.map((i) => [i, -1])), players: new Set(), holders: new Map(), need: new Map() };
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
    if (!site || (site.wreck !== null && crashSpent.has(site.wreck)) || Math.hypot(site.x - feet.x, site.z - feet.z) > site.range) return null;
    let s = this.sessions.get(site.id);
    if (!s) this.sessions.set(site.id, (s = this.newSession([], [])));
    s.players.add(pid);
    return { t: 'siteState', id: site.id, done: [...s.done], taken: [...s.taken.keys()] };
  }

  leave(pid: number, id: unknown) {
    const site = this.large(id);
    const s = site && this.sessions.get(site.id);
    if (!site || !s || !s.players.delete(pid)) return;
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
    machineChanged(site.id);
    s.holders.delete(i);
    this.save(site.id, s);
    this.broadcast({ t: 'siteDone', id: site.id, i });
  }

  /** First to take part `i` gets it: `give(kind)` puts its item in their bag (false: the bag is full, and the part
   *  stays on the machine for someone else). Later askers are told who did. Returns the answer for the taker, or
   *  null when there is nothing to say (bad message, or they already have it). */
  takePart(pid: number, id: unknown, i: unknown, give: (kind: string) => boolean): ServerMsg | null {
    const site = this.large(id);
    const s = site && this.sessions.get(site.id);
    if (!site || !s || !s.players.has(pid) || !this.index(i) || i >= site.parts.length) return null;
    const owner = s.taken.get(i);
    if (owner === pid) return null;
    if (owner !== undefined) return { t: 'siteTake', id: site.id, i, by: owner }; // too late
    const { part, tier } = site.parts[i];
    const kind = partItem(part, tier);
    const ok = this.db.tx(() => {
      if (!give(kind)) return false;
      s.taken.set(i, pid);
      this.save(site.id, s);
      return true;
    });
    if (!ok) return { t: 'siteTook', id: site.id, i, ok: false, reason: 'full' };
    this.broadcast({ t: 'siteTake', id: site.id, i, by: pid });
    if (site.wreck !== null && s.taken.size >= site.parts.length) this.spend(site.wreck);
    if (site.id === BENCH_ID && s.taken.size >= site.parts.length) this.freeBench(); // every part is out
    return { t: 'siteTook', id: site.id, i, ok: true, kind };
  }

  /** Scrap the machine on the table: `give(n)` puts one scrap per part still on it (at least one) in the bag
   *  (false: no room, and the machine stays). The table is free again. */
  scrapBench(feet: Feet, give: (n: number) => boolean): boolean {
    const s = this.sessions.get(BENCH_ID);
    if (!this.bench || !s || Math.hypot(BENCH.x - feet.x, BENCH.z - feet.z) > BENCH_REACH) return false;
    const n = Math.max(1, machineParts(this.bench.kind, this.bench.seed).length - s.taken.size);
    return this.db.tx(() => {
      if (!give(n)) return false;
      this.freeBench();
      return true;
    });
  }

  private freeBench() {
    this.bench = null;
    this.sessions.delete(BENCH_ID);
    this.db.tx(() => {
      this.db.clearBench();
      this.db.clearProgress(BENCH_ID);
    });
    this.broadcast(this.benchMessage());
  }
}
