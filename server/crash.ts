// Server side of the machine sites (shared/crash.ts) at the crashed spacecraft.
//  - When every part of a crash site's large machine has been taken, the crash site is spent (persisted with a
//    timestamp, broadcast as 'crashSpent'): it stops smoking and its machine stays a husk, permanently.
//  - The first time anyone picks something up at a crash site (a part off its large machine, a small machine, a debris
//    piece, a find lying there: visit) it is visited (persisted, broadcast as 'crashVisited'): it stops smoking for good,
//    for everyone, so the world shows someone has been there.
//  - Small machines are carried home: crashTake validates reach and puts the machine in the player's bag (an item
//    of the component's kind); the site stays empty for good, except at a scrap field (STARTER_RESPAWN_MS). Salvage wrecks (shared/wrecks.ts, ids "w:...") are
//    carried the same way, and lie out there again WRECK_RESPAWN_MS later. crashUse takes one out of the bag when it
//    is put on the workbench.
//  - Large machines are worked on by everyone near them through a session per site: which steps are done and
//    which parts are taken (kept in SQLite, `machine_progress`, and never reset by itself: a stripped machine
//    stays stripped). Every step can be done by one player alone. Every player is told about every step and
//    take ('sites' on join, then siteDone / siteTake), so a machine looks the same to everyone, worked on or not.
//  - Every dismantling table (shared/crash.ts tables: each one put up with the wrench, 'bench<placed id>') is the same kind of session, with the table's id: crashUse puts a carried machine on it with
//    a seed picked here, and the job (kind, seed in `bench_jobs`, progress like a site's) is kept until it is scrapped
//    (scrapBench); then the table is free. A table with a job can't be taken down (busyTable).
// A part index is checked against the machine's own part list (shared/machine.ts, from the site's or job's
// seed): whoever takes part i first gets that part's item in their bag. Every mutation also validates current
// reach and the shared step/part prerequisites (shared/machineSteps.ts).
import { machineChanged, machineShove, maxShove, pushedMachine, setMachineProgress, setMachineShove } from '../shared/machineBoxes.ts';
import { CROUCH, BACK, DT, FORWARD, LEFT, PLAYER_RADIUS, RIGHT, STEP_UP } from '../shared/sim.ts';
import { CARRY_KINDS, crashSiteById, isTableId, tableById, crashSpent, crashTaken, crashVisited, CRASH_REACH, SITE_RANGE, TEARDOWN_LAYOUT } from '../shared/crash.ts';
import { CRASH_KINDS } from '../shared/crashKinds.ts';
import { crashSite, crashSitesNear, CRASH_CELL, debrisById, debrisReach, DEBRIS_REACH } from '../shared/crashsites.ts';
import { debrisItem } from '../shared/items.ts';
import { machineParts, partItem, type MachinePart } from '../shared/machine.ts';
import { frameScrap, stepList, stepAllowed, partAllowed } from '../shared/machineSteps.ts';
import { SCRAP_REWARD } from '../shared/tables.ts';
import type { BenchJob, ServerMsg } from '../shared/protocol.ts';
import { junkSpec, type JunkKind } from '../shared/salvage.ts';
import { LAB, labSites } from '../shared/lab.ts';
import { spendPickup, type PickupLimit } from './pickupLimit.ts';
import { wreckById } from '../shared/wrecks.ts';
import type { openDb } from './db.ts';
import { heightAt } from '../shared/terrain.ts';

type Db = ReturnType<typeof openDb>;
type Feet = { x: number; y: number; z: number };

const REACH_SLACK = 1.5;
const BENCH_REACH = 6;
const MAX_INDEX = 255;
/** How fast (m/s) a machine is shoved by someone walking into it crouched: a slow walk, a ton and a half of engine. */
const SHOVE_SPEED = 0.4;
/** About what a lying machine's radius is: it rolls as it goes (rolling without slipping: speed / radius). */
const ROLL_RADIUS = 0.45; // (half of what it is: it turns twice as fast as it would rolling without slipping)

interface Session {
  done: Set<number>;
  /** Part index → public id of the player who took it. */
  taken: Map<number, number>;
  /** Public ids in the session. */
  players: Set<number>;
}

/** Carried-off salvage wrecks (shared/wrecks.ts) are back after this long. */
const WRECK_RESPAWN_MS = 45 * 60 * 1000;
/** Picked-up crash debris (ids "d:...") lies there again after this long, like scrap (server/scrap.ts). */
const DEBRIS_RESPAWN_MS = 30 * 60 * 1000;

/** A small crash-site machine, a salvage wreck (shared/wrecks.ts, ids "w:...") or a crash debris piece (shared/crashsites.ts,
 *  ids "d:..."): something carried off whole. `kind` is the item it becomes; `dist` how far the player is from its reach. */
function carrySite(id: unknown): { id: string; kind: string; dist: (feet: Feet) => number; wreck: number | null } | null {
  const flat = (s: { x: number; z: number }) => (f: Feet) => Math.hypot(s.x - f.x, s.z - f.z) - CRASH_REACH;
  const w = wreckById(id);
  if (w) return { id: w.id, kind: w.kind, dist: flat(w), wreck: null };
  const d = debrisById(id);
  if (d) return { id: d.id!, kind: debrisItem(CRASH_KINDS[d.kind].node), dist: (f) => debrisReach(f, d) - DEBRIS_REACH, wreck: d.site };
  const s = crashSiteById(id);
  return s && !s.lab && junkSpec(s.kind).carry ? { id: s.id, kind: s.kind, dist: flat(s), wreck: s.wreck } : null;
}
/** How far (m) past a crash site's pieces a find may lie and still count as taken from it. */
const VISIT_SLACK = 6;
/** A scrap field's small machines (site level 0, the starter machines every new player needs) are back after this long;
 *  other small machines stay gone. */
const STARTER_RESPAWN_MS = 20 * 60 * 1000;
const respawnMs = (id: string) => id.startsWith('w:') ? WRECK_RESPAWN_MS : id.startsWith('d:') ? DEBRIS_RESPAWN_MS
  : crashSiteById(id)?.level === 0 ? STARTER_RESPAWN_MS : Infinity;

export class CrashServer {
  private db: Db;
  private taken = new Map<string, number>();
  private newlyTaken: string[] = [];
  private newlyBack: string[] = [];
  private newlySpent: number[] = [];
  private newlyVisited: number[] = [];
  private sessions = new Map<string, Session>();
  private broadcast: (msg: ServerMsg) => void;
  /** The machine on each dismantling table that has one, by the table's session id. */
  private benches = new Map<string, { kind: JunkKind; seed: number }>();

  constructor(db: Db, broadcast: (msg: ServerMsg) => void) {
    this.db = db;
    this.broadcast = broadcast;
    for (const job of db.loadBenches()) {
      if (!isTableId(job.id) || !(CARRY_KINDS as string[]).includes(job.kind)) continue;
      this.benches.set(job.id, { kind: job.kind as JunkKind, seed: job.seed });
      console.log(`crash: ${job.kind} on dismantling table ${job.id}`);
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
    for (const id of this.benches.keys()) if (!this.sessions.has(id)) this.sessions.set(id, this.newSession([], []));
    console.log(`crash: ${this.sessions.size} machines worked on`);
    for (const r of db.loadCrashTaken()) {
      const s = carrySite(r.id);
      if (!s) continue; // the layout changed since: forget it
      this.taken.set(r.id, r.taken_at);
      crashTaken.add(r.id);
    }
    for (const r of db.loadCrashSpent()) if (crashSite(r.site)) crashSpent.add(r.site);
    for (const site of db.loadCrashVisited()) if (crashSite(site)) crashVisited.add(site);
    console.log(`crash: ${this.taken.size} machines carried off, ${crashSpent.size} sites spent, ${crashVisited.size} visited`);
  }

  // -- carrying -----------------------------------------------------------------------------------------------

  /** A player carries off the machine at small site `id`. `give(kind)` puts it in their bag (false: no room).
   *  Returns the item kind, or null if refused (unknown or taken site, out of reach, too many at once, bag full). */
  carry(feet: Feet, id: unknown, limit: PickupLimit, give: (kind: string) => boolean): string | null {
    const site = carrySite(id);
    const now = Date.now();
    if (!site || crashTaken.has(site.id)) return null;
    if (site.dist(feet) > REACH_SLACK || !spendPickup(limit, now)) return null;
    const ok = this.db.tx(() => {
      if (!give(site.kind)) return false;
      this.db.takeCrash(site.id, now);
      return true;
    });
    if (!ok) return null;
    this.taken.set(site.id, now);
    crashTaken.add(site.id);
    this.newlyTaken.push(site.id);
    if (site.wreck !== null) this.visit(site.wreck);
    return site.kind;
  }

  /** Put one carried machine of item `kind` on dismantling table `at` (if it stands and is free); `take()` uses it up
   *  from the bag. Everyone is told about the new job. */
  use(feet: Feet, at: unknown, kind: unknown, take: () => boolean): boolean {
    const table = tableById(at);
    if (!table || typeof kind !== 'string' || !(CARRY_KINDS as string[]).includes(kind) || this.benches.has(table.id)) return false;
    if (Math.hypot(table.x - feet.x, table.z - feet.z) > BENCH_REACH) return false;
    const seed = (Math.random() * 4294967296) >>> 0;
    const ok = this.db.tx(() => {
      if (!take()) return false;
      this.db.saveBench(table.id, kind, seed);
      this.db.saveProgress(table.id, [], [], TEARDOWN_LAYOUT);
      return true;
    });
    if (!ok) return false;
    this.benches.set(table.id, { kind: kind as JunkKind, seed });
    this.sessions.set(table.id, this.newSession([], []));
    this.broadcast(this.benchMessage(table.id));
    return true;
  }

  /** Table `id`'s job as it stands, after every change of job. */
  benchMessage(id: string): ServerMsg {
    const s = this.sessions.get(id), job = this.benches.get(id);
    const out: BenchJob | null = job && s ? { ...job, done: [...s.done], taken: [...s.taken.keys()] } : null;
    return { t: 'bench', id, job: out };
  }

  /** Every table's job, for a joining player. */
  benchMessages(): ServerMsg[] {
    return [...this.benches.keys()].map((id) => this.benchMessage(id));
  }

  /** Does table `id` hold a machine? (It can't be taken down then.) */
  busyTable(id: string): boolean {
    return this.benches.has(id);
  }

  /** Steps done and parts taken at every machine worked on (not the tables: 'bench' carries those), for joining players. */
  progressMessage(): ServerMsg {
    const sites = [...this.sessions].filter(([id, s]) => !isTableId(id) && (s.done.size || s.taken.size))
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
    if (isTableId(id) || !this.sessions.has(id)) return;
    this.sessions.delete(id);
    machineChanged(id);
    this.db.clearProgress(id);
    this.broadcast({ t: 'siteReset', id });
    if (this.rolls.delete(id)) {
      setMachineShove(id, 0, 0);
      this.broadcast({ t: 'siteRolls', rolls: [{ id, a: 0, x: 0, z: 0 }] }); // (set back as it was)
    }
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
    const { site, into } = hit;
    // It goes the way they walk, and rolls as it goes (rolling without slipping: the top moves with the push, the part of the push
    // across its length turns it; along its length it just slides). It cannot be shoved far from where it lay.
    const v = SHOVE_SPEED * into * DT;
    const o = machineShove(site.id);
    let x = o.x + wx * v, z = o.z + wz * v;
    const far = Math.hypot(x, z);
    const most = maxShove(site);
    if (far > most) {
      x *= most / far;
      z *= most / far;
    }
    const ax = Math.sin(site.yaw), az = Math.cos(site.yaw);
    const across = -az * wx + ax * wz; // the push across the axis (+: the way the positive roll carries the top)
    setMachineShove(site.id, x, z);
    this.rolls.set(site.id, (this.rolls.get(site.id) ?? 0) + (across * v) / ROLL_RADIUS);
    this.rolled.add(site.id);
  }

  /** The machines that rolled since last time (each at most once per broadcast). */
  flushRolls(): ServerMsg | null {
    if (!this.rolled.size) return null;
    const rolls = [...this.rolled].map((id) => this.rollOf(id));
    this.rolled.clear();
    return { t: 'siteRolls', rolls };
  }

  private rollOf(id: string) {
    const o = machineShove(id);
    const r = (n: number) => Math.round(n * 1000) / 1000;
    return { id, a: r(this.rolls.get(id) ?? 0), x: r(o.x), z: r(o.z) };
  }

  rollsMessage(): ServerMsg {
    return { t: 'siteRolls', rolls: [...this.rolls.keys()].map((id) => this.rollOf(id)), reset: true };
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

  visitedMessage(): ServerMsg {
    return { t: 'crashVisited', visited: [...crashVisited], reset: true };
  }

  flushVisited(): ServerMsg | null {
    if (!this.newlyVisited.length) return null;
    const msg: ServerMsg = { t: 'crashVisited', visited: this.newlyVisited };
    this.newlyVisited = [];
    return msg;
  }

  /** Someone picked something up at crash site `wreck`: visited for good (its smoke stops). */
  visit(wreck: number) {
    if (crashVisited.has(wreck) || !crashSite(wreck)) return;
    crashVisited.add(wreck);
    this.db.visitCrash(wreck, Date.now());
    this.newlyVisited.push(wreck);
  }

  /** Something lying at (x, z) was picked up (a find, server/loot.ts): the crash site it lay at, if any, is visited. */
  visitAt(x: number, z: number) {
    const s = crashSitesNear(x, z, CRASH_CELL / 2)[0];
    if (s && Math.hypot(s.x - x, s.z - z) <= s.radius + VISIT_SLACK) this.visit(s.id);
  }

  /** The large machine of crash site `wreck` has no parts left: spent for good. */
  private spend(wreck: number) {
    if (crashSpent.has(wreck)) return;
    crashSpent.add(wreck);
    machineChanged(); // (its frame is gone: nothing to bump into)
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
  private large(id: unknown): { id: string; x: number; y: number; z: number; range: number; kind: JunkKind; seed: number; level: number; parts: MachinePart[]; wreck: number | null } | null {
    if (isTableId(id)) {
      const table = tableById(id), job = this.benches.get(id as string);
      return table && job ? { id: table.id, x: table.x, y: table.floor, z: table.z, range: BENCH_REACH, ...job, level: 1, parts: machineParts(job.kind, job.seed), wreck: null } : null;
    }
    const site = crashSiteById(id);
    // (A lab machine is worked in place whatever its size, and is never spent.)
    const o = site ? machineShove(site.id) : { x: 0, z: 0 };
    return site && (site.lab || !junkSpec(site.kind).carry) ? { id: site.id, x: site.x + o.x, y: heightAt(site.x + o.x, site.z + o.z), z: site.z + o.z, range: SITE_RANGE + REACH_SLACK, kind: site.kind, seed: site.seed, level: site.level, parts: machineParts(site.kind, site.seed, site.level), wreck: site.lab ? null : site.wreck } : null;
  }
  private newSession(done: number[], taken: number[]): Session {
    return { done: new Set(done), taken: new Map(taken.map((i) => [i, -1])), players: new Set() };
  }

  private index(i: unknown): i is number {
    return typeof i === 'number' && Number.isInteger(i) && i >= 0 && i <= MAX_INDEX;
  }

  /** `pid` (public id) joins the session of large site `id`; returns the state to send them. */
  join(pid: number, feet: Feet, id: unknown): ServerMsg | null {
    const site = this.large(id);
    if (!site || (site.wreck !== null && crashSpent.has(site.wreck)) || Math.hypot(site.x - feet.x, site.y - feet.y, site.z - feet.z) > site.range) return null;
    let s = this.sessions.get(site.id);
    if (!s) this.sessions.set(site.id, (s = this.newSession([], [])));
    s.players.add(pid);
    return { t: 'siteState', id: site.id, done: [...s.done], taken: [...s.taken.keys()] };
  }

  leave(pid: number, id: unknown) {
    const site = this.large(id);
    const s = site && this.sessions.get(site.id);
    if (site && s) s.players.delete(pid);
  }

  /** The player disconnected: leave every session. */
  leaveAll(pid: number) {
    for (const id of this.sessions.keys()) this.leave(pid, id);
  }

  /** Scrap for step `i` just done (and for what it finished) at a machine: see SCRAP_REWARD. */
  private scrapFor(site: { kind: JunkKind; seed: number; level: number }, s: Session, i: number): number {
    let n = SCRAP_REWARD.step;
    const steps = stepList(site.kind, site.seed, site.level);
    if (!steps) return n; // (a machine built in code: only the steps are paid)
    const { list } = steps;
    const me = list[i];
    if (me?.module) {
      let all = true;
      for (let k = 0; k < list.length && all; k++) if (list[k].module === me.module && list[k].inner === me.inner && !s.done.has(k)) all = false;
      if (all) n += me.inner ? SCRAP_REWARD.piece : SCRAP_REWARD.module;
    }
    return n;
  }

  /** Every step done and every part taken: only the frame is left. */
  private stripped(site: { kind: JunkKind; seed: number; level: number; parts: MachinePart[] }, s: Session): boolean {
    const steps = stepList(site.kind, site.seed, site.level);
    return s.taken.size >= site.parts.length && (!steps || steps.list.every((_, k) => s.done.has(k)));
  }

  done(pid: number, feet: Feet, id: unknown, i: unknown, reward?: (n: number, x: number, z: number) => void) {
    const site = this.large(id);
    const s = site && this.sessions.get(site.id);
    if (!site || !s || !s.players.has(pid) || !this.index(i) || s.done.has(i)) return;
    if (Math.hypot(site.x - feet.x, site.y - feet.y, site.z - feet.z) > site.range || !stepAllowed(stepList(site.kind, site.seed, site.level), s.done, i)) return;
    s.done.add(i);
    machineChanged(site.id);
    this.save(site.id, s);
    this.broadcast({ t: 'siteDone', id: site.id, i });
    const m = crashSiteById(site.id);
    if (reward && m && !isTableId(site.id)) reward(this.scrapFor({ kind: m.kind, seed: m.seed, level: m.level }, s, i), site.x, site.z);
  }

  /** First to take part `i` gets it: `give(kind)` puts its item in their bag (false: the bag is full, and the part
   *  stays on the machine for someone else). Later askers are told who did. Returns the answer for the taker, or
   *  null when there is nothing to say (bad message, or they already have it). */
  takePart(pid: number, feet: Feet, id: unknown, i: unknown, give: (kind: string) => boolean): ServerMsg | null {
    const site = this.large(id);
    const s = site && this.sessions.get(site.id);
    if (!site || !s || !s.players.has(pid) || !this.index(i) || i >= site.parts.length) return null;
    if (Math.hypot(site.x - feet.x, site.y - feet.y, site.z - feet.z) > site.range || !partAllowed(stepList(site.kind, site.seed, site.level), s.done, i)) return null;
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
    if (site.wreck !== null) this.visit(site.wreck);
    return { t: 'siteTook', id: site.id, i, ok: true, kind };
  }

  /** The frame of a machine in the field, with nothing left on it, was mashed to scrap: paid, and the site is spent for good (its frame
   *  is gone). Only a stripped machine can be (the table's: scrapBench). A lab machine is made whole again. */
  scrapFrame(pid: number, feet: Feet, id: unknown, reward: (n: number, x: number, z: number) => void) {
    const site = this.large(id);
    const s = site && this.sessions.get(site.id);
    if (!site || !s || isTableId(site.id) || !s.players.has(pid) || (site.wreck !== null && crashSpent.has(site.wreck))) return;
    if (Math.hypot(site.x - feet.x, site.y - feet.y, site.z - feet.z) > site.range) return;
    const m = crashSiteById(site.id);
    if (!m || !this.stripped({ kind: m.kind, seed: m.seed, level: m.level, parts: site.parts }, s)) return;
    reward(frameScrap(m.kind, m.seed, m.level, 0), site.x, site.z);
    if (site.wreck !== null) this.spend(site.wreck);
    else this.resetSite(site.id);
  }

  /** Scrap the machine on the table, finished or not (what is still on it is destroyed, and pays more: frameScrap): `give(n)` puts the scrap
   *  in the bag (false: no room, and the machine stays). The table is free again. */
  scrapBench(feet: Feet, at: unknown, give: (n: number) => boolean): boolean {
    const table = tableById(at);
    const job = table && this.benches.get(table.id), s = table && this.sessions.get(table.id);
    if (!table || !job || !s || Math.hypot(table.x - feet.x, table.z - feet.z) > BENCH_REACH) return false;
    const n = frameScrap(job.kind, job.seed, 1, Math.max(0, machineParts(job.kind, job.seed).length - s.taken.size));
    return this.db.tx(() => {
      if (!give(n)) return false;
      this.freeBench(table.id);
      return true;
    });
  }

  private freeBench(id: string) {
    this.benches.delete(id);
    this.sessions.delete(id);
    this.db.tx(() => {
      this.db.clearBench(id);
      this.db.clearProgress(id);
    });
    this.broadcast(this.benchMessage(id));
  }
}
