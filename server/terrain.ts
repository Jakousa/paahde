// Server side of the terrain edit layer: stamps craters, runs sand relaxation, batches changed
// vertices for broadcast and persists dirty chunks to SQLite.
import { cellKey, cellX, cellZ, deposit, heal, Relaxer, strokeDig } from '../shared/dig.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { EDIT_CELL, EDIT_CHUNK, edits, TerrainEdits } from '../shared/terrain.ts';
import type { openDb } from './db.ts';

type Db = ReturnType<typeof openDb>;

/** Chunks per terrainChunks message on join (each chunk is ~1–6 KB of JSON). */
const CHUNKS_PER_MSG = 16;
/** Relaxation work cap per pass, so a huge avalanche can't stall the game loop. */
const RELAX_MAX_CELLS = 20_000;
/** Chunks only healed are saved a share at a time, all of them over this many saves (12 × 5 s: at worst a minute's
 *  healing lost on a crash). */
const HEAL_SAVE_EVERY = 12;

export class TerrainServer {
  private db: Db;
  private relaxer = new Relaxer();
  private changed = new Set<number>();
  private dirtyChunks = new Set<string>();
  private onCell = (ix: number, iz: number) => {
    const k = cellKey(ix, iz);
    this.changed.add(k);
    this.relaxer.active.add(k);
    this.dirtyChunks.add(TerrainEdits.key(Math.floor(ix / EDIT_CHUNK), Math.floor(iz / EDIT_CHUNK)));
  };

  // A stamped crater (a boss's footprint) is sent and saved but left as dug: no avalanche to work through.
  private onStamp = (ix: number, iz: number) => {
    this.changed.add(cellKey(ix, iz));
    this.dirtyChunks.add(TerrainEdits.key(Math.floor(ix / EDIT_CHUNK), Math.floor(iz / EDIT_CHUNK)));
  };

  // Healing flattens, so it never needs relaxing; nor sending: every client heals its own copy ('terrainHeal').
  // Nor saving every time: it touches every edited chunk, so each save takes a share of them, round robin (a chunk
  // healed again goes to the back of the set).
  private healed = new Set<string>();
  private onHeal = (cx: number, cz: number) => {
    this.healed.add(TerrainEdits.key(cx, cz));
  };

  constructor(db: Db) {
    this.db = db;
    for (const c of db.loadChunks()) {
      if (c.data.length === EDIT_CHUNK * EDIT_CHUNK) edits.setChunk(c.cx, c.cz, c.data);
    }
    console.log(`terrain: loaded ${edits.size} edited chunks`);
  }

  /** A blast crater at (x, z): a bowl `radius` wide and `mm` deep, the sand thrown out into a rim around it.
   *  `settle` false (the bosses' big ones): the walls stay as dug instead of slumping to the angle of repose. A
   *  boss's steep 10 m bowl would otherwise avalanche for seconds, sending ~10 000 vertices per footstep. */
  crater(x: number, z: number, radius: number, mm: number, settle = true) {
    const sink = settle ? this.onCell : this.onStamp;
    const removed = strokeDig(edits, x, z, sink, { mm, radius });
    const n = 10;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      deposit(edits, x + Math.cos(a) * radius * 1.15, z + Math.sin(a) * radius * 1.15, (removed * 0.6) / n, radius * 0.5, sink);
    }
  }

  /** One sand-relaxation pass over recently changed vertices. Cheap when nothing is moving. */
  relax() {
    if (!this.relaxer.idle) this.relaxer.step(edits, RELAX_MAX_CELLS, this.onCell);
  }

  /** Wind fills holes and flattens piles a little; call every few seconds, and tell every client ('terrainHeal')
   *  right away: they heal their copies the same way. */
  heal() {
    heal(edits, this.onHeal);
  }

  /** Changed vertices since the last call as a terrainEdit message, or null if none. */
  flush(): ServerMsg | null {
    if (this.changed.size === 0) return null;
    const cells: number[] = [];
    for (const k of this.changed) {
      const ix = cellX(k), iz = cellZ(k);
      cells.push(ix, iz, edits.getMm(ix, iz));
    }
    this.changed.clear();
    return { t: 'terrainEdit', cells };
  }

  /** All edited chunks as terrainChunks messages, nearest to (x, z) first. */
  joinMessages(x: number, z: number): ServerMsg[] {
    const size = EDIT_CHUNK * EDIT_CELL;
    const list = [...edits.entries()]
      .filter(([, , c]) => c.some((v) => v !== 0))
      .map(([cx, cz, c]) => ({ cx, cz, c, d: Math.hypot((cx + 0.5) * size - x, (cz + 0.5) * size - z) }))
      .sort((a, b) => a.d - b.d);
    const msgs: ServerMsg[] = [];
    for (let i = 0; i < list.length || i === 0; i += CHUNKS_PER_MSG) {
      const chunks = list.slice(i, i + CHUNKS_PER_MSG).map(({ cx, cz, c }) => ({ cx, cz, mm: Array.from(c) }));
      msgs.push({ t: 'terrainChunks', chunks, reset: i === 0, done: i + CHUNKS_PER_MSG >= list.length });
    }
    return msgs;
  }

  /** Persist chunks changed since the last save, and 1/HEAL_SAVE_EVERY of those only healed (`all`: all of them). */
  save(all = false) {
    let n = all ? this.healed.size : Math.ceil(this.healed.size / HEAL_SAVE_EVERY);
    for (const k of this.healed) {
      if (n-- <= 0) break;
      this.dirtyChunks.add(k);
      this.healed.delete(k);
    }
    if (this.dirtyChunks.size === 0) return;
    const out: { cx: number; cz: number; data: Int32Array }[] = [];
    for (const k of this.dirtyChunks) {
      const [cx, cz] = k.split(',').map(Number);
      const data = edits.chunk(cx, cz);
      if (data) out.push({ cx, cz, data });
    }
    this.db.saveChunks(out);
    this.dirtyChunks.clear();
  }
}
