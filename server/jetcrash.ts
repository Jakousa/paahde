// The crash sites of downed jets (shared/jetcrash.ts): made when a jet's nose meets the sand, kept in the world's database.
// The plane stays where it came down; its right engine is thrown on ahead and lies there as a machine to take apart; the sand
// is dug up round both (the craters, in `craters`).
import { JET_CRASH_MAX, jetCrashList, setJetCrashes, type JetCrash } from '../shared/jetcrash.ts';
import type { openDb } from './db.ts';

type Db = ReturnType<typeof openDb>;

export interface JetWreck {
  jet: number;
  /** The plane's pose as it lay down. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  bank: number;
  /** Where its nose went in. */
  lx: number;
  lz: number;
  soft: boolean;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export class JetCrashes {
  private db: Db;
  private nextId: number;

  constructor(db: Db) {
    this.db = db;
    const list = db.loadJetCrashes() as JetCrash[];
    setJetCrashes(list);
    this.nextId = list.reduce((m, c) => Math.max(m, c.id), 0) + 1;
    console.log(`jets: ${list.length} crash sites`);
  }

  /** A jet came down: its crash site, the oldest ones dropped past JET_CRASH_MAX (`gone`). */
  add(w: JetWreck): { crash: JetCrash; gone: number[]; craters: { x: number; z: number; r: number; mm: number }[] } {
    const sx = Math.sin(w.yaw), sz = Math.cos(w.yaw), cx = Math.cos(w.yaw), cz = -Math.sin(w.yaw);
    // The right engine tore off and skidded on ahead and to the side.
    const ahead = 18 + Math.random() * 8, side = 10 + Math.random() * 6;
    const ex = w.x + sx * ahead + cx * side, ez = w.z + sz * ahead + cz * side;
    const crash: JetCrash = {
      id: this.nextId++, jet: w.jet, x: r2(w.x), y: r2(w.y), z: r2(w.z), yaw: r2(w.yaw), pitch: r2(w.pitch), bank: r2(w.bank),
      ex: r2(ex), ez: r2(ez), eyaw: r2(w.yaw + Math.PI + (Math.random() - 0.5) * 1.2), seed: (Math.random() * 4294967296) >>> 0,
    };
    this.db.saveJetCrash(crash.id, crash);
    const all = [...jetCrashList(), crash];
    const gone = all.slice(0, Math.max(0, all.length - JET_CRASH_MAX)).map((c) => c.id);
    for (const id of gone) this.db.deleteJetCrash(id);
    setJetCrashes(all.filter((c) => !gone.includes(c.id)));
    // The sand: the nose in a deep bowl, then the trench it slid along to where it lies (shallower and wider as it slowed, the sand
    // thrown up each side), and the engine's skid to where it lies, with a bowl where it stopped.
    const craters = [{ x: w.lx, z: w.lz, r: 7.5, mm: 2800 }];
    const len = Math.hypot(w.x - w.lx, w.z - w.lz), n = Math.max(2, Math.round(len / 3));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      craters.push({ x: w.lx + (w.x - w.lx) * t, z: w.lz + (w.z - w.lz) * t, r: 3.6 - 0.8 * t, mm: 1500 - 600 * t });
    }
    const m = 6;
    for (let i = 1; i <= m; i++) {
      const t = i / m;
      craters.push({ x: w.x + (ex - w.x) * t, z: w.z + (ez - w.z) * t, r: 1.6 + 1.4 * t, mm: 500 + 600 * t });
    }
    craters.push({ x: ex, z: ez, r: 3.8, mm: 1500 });
    return { crash, gone, craters };
  }
}
