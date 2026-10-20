// The crash sites of downed jets (shared/jetcrash.ts): made once the pieces of the broken plane (shared/jetbreak.ts) have come to rest, kept in the
// world's database. The pieces lie where the simulation left them; the right engine's is where it lies as a machine to take apart.
import { JET_CRASH_MAX, jetCrashList, setJetCrashes, type JetCrash } from '../shared/jetcrash.ts';
import { PIECES_OF, type Fate, type JetKind } from '../shared/jetbreak.ts';
import type { openDb } from './db.ts';

type Db = ReturnType<typeof openDb>;

const r2 = (v: number) => Math.round(v * 100) / 100;

export class JetCrashes {
  private db: Db;
  private nextId: number;

  constructor(db: Db) {
    this.db = db;
    const list = (db.loadJetCrashes() as JetCrash[])
      .map((c) => ({ ...c, kind: c.kind ?? 'wing' }))
      .filter((c) => PIECES_OF[c.kind] && Array.isArray(c.pieces) && c.pieces.length === PIECES_OF[c.kind].length && Array.isArray(c.fates));
    setJetCrashes(list);
    this.nextId = list.reduce((m, c) => Math.max(m, c.id), 0) + 1;
    console.log(`jets: ${list.length} crash sites`);
  }

  /** The pieces of jet `jet` lie at `final` (shared/jetbreak.ts): its crash site, the oldest ones dropped past JET_CRASH_MAX (`gone`). */
  add(jet: number, kind: JetKind, final: number[][], fates: Fate[]): { crash: JetCrash; gone: number[] } {
    const body = final[PIECES_OF[kind].findIndex((p) => p.id === 'front')];
    const crash: JetCrash = {
      id: this.nextId++, jet, kind, x: r2(body[0]), z: r2(body[2]), pieces: final, fates, seed: (Math.random() * 4294967296) >>> 0,
    };
    this.db.saveJetCrash(crash.id, crash);
    const all = [...jetCrashList(), crash];
    const gone = all.slice(0, Math.max(0, all.length - JET_CRASH_MAX)).map((c) => c.id);
    for (const id of gone) this.db.deleteJetCrash(id);
    setJetCrashes(all.filter((c) => !gone.includes(c.id)));
    return { crash, gone };
  }
}
