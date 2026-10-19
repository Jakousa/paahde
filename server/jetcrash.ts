// The crash sites of downed jets (shared/jetcrash.ts): made once the pieces of the broken plane (shared/jetbreak.ts) have come to rest, kept in the
// world's database. The pieces lie where the simulation left them; the right engine's is where it lies as a machine to take apart.
import { JET_CRASH_MAX, jetCrashList, setJetCrashes, type JetCrash } from '../shared/jetcrash.ts';
import type { Fate } from '../shared/jetbreak.ts';
import { JET_PIECES } from '../shared/jetpieces.ts';
import type { openDb } from './db.ts';

type Db = ReturnType<typeof openDb>;

const r2 = (v: number) => Math.round(v * 100) / 100;
const BODY = JET_PIECES.findIndex((p) => p.id === 'front');

export class JetCrashes {
  private db: Db;
  private nextId: number;

  constructor(db: Db) {
    this.db = db;
    const list = (db.loadJetCrashes() as JetCrash[]).filter((c) => Array.isArray(c.pieces) && c.pieces.length === JET_PIECES.length && Array.isArray(c.fates));
    setJetCrashes(list);
    this.nextId = list.reduce((m, c) => Math.max(m, c.id), 0) + 1;
    console.log(`jets: ${list.length} crash sites`);
  }

  /** The pieces of jet `jet` lie at `final` (shared/jetbreak.ts): its crash site, the oldest ones dropped past JET_CRASH_MAX (`gone`). */
  add(jet: number, final: number[][], fates: Fate[]): { crash: JetCrash; gone: number[] } {
    const crash: JetCrash = {
      id: this.nextId++, jet, x: r2(final[BODY][0]), z: r2(final[BODY][2]), pieces: final, fates, seed: (Math.random() * 4294967296) >>> 0,
    };
    this.db.saveJetCrash(crash.id, crash);
    const all = [...jetCrashList(), crash];
    const gone = all.slice(0, Math.max(0, all.length - JET_CRASH_MAX)).map((c) => c.id);
    for (const id of gone) this.db.deleteJetCrash(id);
    setJetCrashes(all.filter((c) => !gone.includes(c.id)));
    return { crash, gone };
  }
}
