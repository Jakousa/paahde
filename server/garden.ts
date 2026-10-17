// Server side of the plant beds (shared/garden.ts): each placed bed's stage and growth in SQLite (`beds`),
// planting and harvesting on request, growing sprouts while a UV lamp stands over them, broadcasting stages.
import type { ServerMsg } from '../shared/protocol.ts';
import { EMPTY, GROW_MS, GROWN, SPROUTS, TEND_REACH, type BedState } from '../shared/garden.ts';
import { bedLit, placed, placedReach } from '../shared/placed.ts';
import type { openDb } from './db.ts';

type Db = ReturnType<typeof openDb>;

/** Slack on top of TEND_REACH for the server's view of the player lagging the client's. */
const REACH_SLACK = 1.5;
/** Minimum time between one player's plantings/harvests. */
const TEND_COOLDOWN_MS = 300;

export class GardenServer {
  private db: Db;
  /** Placed bed id → stage and ms grown under a lamp. Beds without a row are empty. */
  private beds = new Map<number, { stage: number; growth: number }>();
  private changed = false;
  private lastGrow = Date.now();

  /** Call after the placed list is loaded (server/placed.ts). Rows for beds that are gone are dropped. */
  constructor(db: Db) {
    this.db = db;
    const ids = new Set(placed.filter((p) => p.kind === 'plant_bed').map((p) => p.id));
    for (const r of db.loadBeds()) {
      if (ids.has(r.id)) this.beds.set(r.id, { stage: r.stage, growth: r.growth });
      else db.deleteBed(r.id);
    }
  }

  private bed(id: number) {
    return this.beds.get(id) ?? { stage: EMPTY, growth: 0 };
  }

  /**
   * A player tends bed `id`: plants an empty bed, harvests a grown one. Returns what happened, or null if
   * refused (no such bed, out of reach, too soon, still growing).
   */
  tend(feet: { x: number; y: number; z: number }, id: unknown, last: { at: number }): 'planted' | 'harvested' | null {
    const now = Date.now();
    const p = placed.find((q) => q.id === id && q.kind === 'plant_bed');
    if (!p || now - last.at < TEND_COOLDOWN_MS || placedReach(feet, p) > TEND_REACH + REACH_SLACK) return null;
    const { stage } = this.bed(p.id);
    if (stage === SPROUTS) return null;
    last.at = now;
    this.set(p.id, stage === EMPTY ? SPROUTS : EMPTY, 0);
    return stage === EMPTY ? 'planted' : 'harvested';
  }

  /** Sprouts under a lamp grow by the time since the last call; GROW_MS of it and they're grown. */
  grow() {
    const now = Date.now();
    const dt = now - this.lastGrow;
    this.lastGrow = now;
    for (const p of placed) {
      if (p.kind !== 'plant_bed') continue;
      const b = this.bed(p.id);
      if (b.stage !== SPROUTS || !bedLit(p)) continue;
      const growth = b.growth + dt;
      this.set(p.id, growth >= GROW_MS ? GROWN : SPROUTS, growth >= GROW_MS ? 0 : growth);
    }
  }

  /** A bed was picked up: forget it. */
  remove(id: number) {
    if (!this.beds.delete(id)) return;
    this.db.deleteBed(id);
    this.changed = true;
  }

  private set(id: number, stage: number, growth: number) {
    this.beds.set(id, { stage, growth });
    this.db.saveBed(id, stage, growth);
    this.changed = true;
  }

  /** Every bed's stage, for a joining client. */
  joinMessage(): ServerMsg {
    const beds: BedState[] = [...this.beds].map(([id, b]) => ({ id, stage: b.stage, grow: Math.round((b.growth / GROW_MS) * 100) / 100 }));
    return { t: 'garden', beds };
  }

  /** Every bed's stage if any changed since the last flush, or null. */
  flush(): ServerMsg | null {
    if (!this.changed) return null;
    this.changed = false;
    return this.joinMessage();
  }
}
