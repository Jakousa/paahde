// Server side of the greenhouse beds (shared/garden.ts): keeps each bed's stage and planting time in
// SQLite, plants and harvests on request, grows sprouts after GROW_MS and broadcasts the stages.
import type { ServerMsg } from '../shared/protocol.ts';
import { BEDS, bedReach, EMPTY, GROW_MS, GROWN, SPROUTS, TEND_REACH } from '../shared/garden.ts';
import type { openDb } from './db.ts';

type Db = ReturnType<typeof openDb>;

/** Slack on top of TEND_REACH for the server's view of the player lagging the client's. */
const REACH_SLACK = 1.5;
/** Minimum time between one player's plantings/harvests. */
const TEND_COOLDOWN_MS = 300;

export class GardenServer {
  private db: Db;
  private stages = BEDS.map((b) => b.initial);
  /** Beds sprouting in the layout count as planted when the server starts. */
  private plantedAt = BEDS.map((b) => (b.initial === SPROUTS ? Date.now() : 0));
  private changed = false;

  constructor(db: Db) {
    this.db = db;
    for (const r of db.loadBeds()) {
      if (r.bed < 0 || r.bed >= BEDS.length) continue; // the layout changed since: forget it
      this.stages[r.bed] = r.stage;
      this.plantedAt[r.bed] = r.planted_at;
    }
  }

  /**
   * A player tends bed i: plants an empty bed, harvests a grown one. Returns what happened, or null if
   * refused (unknown bed, out of reach, too soon, still growing).
   */
  tend(feet: { x: number; y: number; z: number }, i: unknown, last: { at: number }): 'planted' | 'harvested' | null {
    const now = Date.now();
    if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= BEDS.length) return null;
    const bed = i as number;
    if (now - last.at < TEND_COOLDOWN_MS || bedReach(feet, bed) > TEND_REACH + REACH_SLACK) return null;
    const stage = this.stages[bed];
    if (stage === SPROUTS) return null;
    last.at = now;
    this.set(bed, stage === EMPTY ? SPROUTS : EMPTY, stage === EMPTY ? now : 0);
    return stage === EMPTY ? 'planted' : 'harvested';
  }

  /** Grow sprouts planted more than GROW_MS ago. */
  grow() {
    const cutoff = Date.now() - GROW_MS;
    this.stages.forEach((s, bed) => {
      if (s === SPROUTS && this.plantedAt[bed] <= cutoff) this.set(bed, GROWN, this.plantedAt[bed]);
    });
  }

  private set(bed: number, stage: number, plantedAt: number) {
    this.stages[bed] = stage;
    this.plantedAt[bed] = plantedAt;
    this.db.saveBed(bed, stage, plantedAt);
    this.changed = true;
  }

  /** Every bed's stage, for a joining client. */
  joinMessage(): ServerMsg {
    return { t: 'garden', beds: this.stages.slice() };
  }

  /** Every bed's stage if any changed since the last flush, or null. */
  flush(): ServerMsg | null {
    if (!this.changed) return null;
    this.changed = false;
    return this.joinMessage();
  }
}
