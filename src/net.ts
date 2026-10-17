// Client netcode:
// - Local player: client-side prediction. Every fixed tick we simulate our own input immediately,
//   send it with a sequence number and keep it as "pending". When a snapshot arrives we take the
//   server's state for us, drop the inputs it has acknowledged and replay the rest (reconciliation).
// - Remote players: entity interpolation. We render them INTERP_MS in the past, between the two
//   snapshots that surround that time, so their motion is smooth despite 20 Hz updates.
// - Terrain: the server owns the edit layer and sends absolute values. Our own dig strokes are predicted
//   immediately; the server's value for each predicted vertex is held back until a snapshot acks the
//   input that dug it (terrainEdit always arrives before that snapshot), then applied.
// - Scrap: picked-up pieces are hidden (and lose their hitbox) as soon as we ask; the server sends the
//   piece back to us if it refuses, and our new inventory if it agrees.
import { DIG, PILE, spawnState, step, type PlayerState } from '../shared/sim.ts';
import type { ClientMsg, PlayerSnap, ServerMsg } from '../shared/protocol.ts';
import { cellKey, cellX, cellZ, DIG_COOLDOWN_TICKS, pitchFromQ, stroke, type Point } from '../shared/dig.ts';
import { scrapChanged, scrapKey, scrapPiece, scrapTaken, type ScrapPiece } from '../shared/scrap.ts';
import { EDIT_CHUNK, edits, TerrainEdits } from '../shared/terrain.ts';

const INTERP_MS = 100;

export type RemotePlayer = {
  id: number; color: number; x: number; y: number; z: number; facing: number; speed: number; grounded: boolean;
  vx: number; vz: number;
  sliding: boolean; // intentional (Ctrl) slide
  pitch: number; // camera pitch in radians (negative = looking down)
};

type Snapshot = { time: number; players: Map<number, PlayerSnap> };

export class Net {
  status = 'connecting';
  id = 0;
  color = 0xffffff;
  /** Predicted local state (authoritative for physics on this client). */
  me: PlayerState = spawnState();
  /** Visual offset after a correction, decays to zero so corrections don't look like teleports. */
  errorX = 0;
  errorY = 0;
  errorZ = 0;

  private ws?: WebSocket;
  private seq = 0;
  private pending: { seq: number; input: number; yaw: number }[] = [];
  private snapshots: Snapshot[] = [];
  private clockOffset?: number; // serverTime - localTime
  private retryMs = 500;
  private browserId: string;
  private digCooldown = 0;
  /** Predicted terrain vertices: the server's latest value, and the input seq that last dug there. */
  private predicted = new Map<number, { server: number; seq: number }>();
  /** Chunks we held before a (re)join; whatever the server doesn't resend is dropped. */
  private staleChunks = new Set<string>();

  /** Scrap count per SCRAP_KINDS index, from the server. */
  inventory: number[] = [];
  /** The server sent a new inventory. */
  onInventory?: (items: number[]) => void;

  /** A dig/pile stroke landed: ours (predicted) or another player's. For effects only. */
  onDig?: (at: Point, pile: boolean, mine: boolean, id: number) => void;

  constructor(browserId: string) {
    this.browserId = browserId;
    this.connect();
  }

  get connected() {
    return this.id !== 0;
  }

  /** Called once per fixed tick with the sampled input and quantized camera yaw and pitch. */
  tick(input: number, yaw: number, pitch: number) {
    if (!this.connected) return;
    this.seq++;
    this.me = step(this.me, input, yaw);
    this.pending.push({ seq: this.seq, input, yaw });
    this.send({ t: 'input', seq: this.seq, input, yaw, pitch });
    this.predictDig(input, yaw, pitch);
  }

  /** Pick up a scrap piece: hidden now, confirmed (inventory) or put back by the server. */
  pickup(pc: ScrapPiece) {
    if (!this.connected || scrapTaken.has(pc.key)) return;
    this.send({ t: 'pickup', ix: pc.ix, iz: pc.iz, i: pc.i });
    scrapTaken.add(pc.key);
    scrapChanged();
  }

  private applyScrap(msg: Extract<ServerMsg, { t: 'scrap' }>) {
    if (msg.reset) scrapTaken.clear();
    for (let i = 0; i + 2 < msg.taken.length; i += 3) {
      const pc = scrapPiece(msg.taken[i], msg.taken[i + 1], msg.taken[i + 2]);
      if (pc) scrapTaken.add(pc.key);
    }
    for (let i = 0; i + 2 < msg.back.length; i += 3) scrapTaken.delete(scrapKey(msg.back[i], msg.back[i + 1], msg.back[i + 2]));
    scrapChanged();
  }

  // Same countdown and stroke as the server's dig() in server/index.ts.
  private predictDig(input: number, yaw: number, pitch: number) {
    if (this.digCooldown > 0) this.digCooldown--;
    if (!(input & (DIG | PILE)) || this.digCooldown > 0) return;
    const pile = (input & DIG) === 0;
    const seq = this.seq;
    const at = stroke(edits, this.me, yaw, pitch, pile, (ix, iz, prev) => {
      const k = cellKey(ix, iz);
      const p = this.predicted.get(k);
      if (p) p.seq = seq;
      else this.predicted.set(k, { server: prev, seq });
    });
    if (!at) return;
    this.digCooldown = DIG_COOLDOWN_TICKS;
    this.onDig?.(at, pile, true, this.id);
  }

  private applyTerrainEdit(cells: number[]) {
    for (let i = 0; i + 2 < cells.length; i += 3) {
      const ix = cells[i], iz = cells[i + 1], mm = cells[i + 2];
      const p = this.predicted.get(cellKey(ix, iz));
      if (p) p.server = mm; // held until the dig that predicted it is acked
      else edits.setMm(ix, iz, mm);
    }
  }

  private applyTerrainChunks(msg: Extract<ServerMsg, { t: 'terrainChunks' }>) {
    if (msg.reset) {
      this.staleChunks.clear();
      for (const [cx, cz] of edits.entries()) this.staleChunks.add(TerrainEdits.key(cx, cz));
    }
    for (const c of msg.chunks) {
      if (c.mm.length !== EDIT_CHUNK * EDIT_CHUNK) continue;
      this.staleChunks.delete(TerrainEdits.key(c.cx, c.cz));
      edits.setChunk(c.cx, c.cz, Int32Array.from(c.mm));
    }
    if (msg.done) {
      for (const k of this.staleChunks) {
        const [cx, cz] = k.split(',').map(Number);
        edits.deleteChunk(cx, cz);
      }
      this.staleChunks.clear();
    }
  }

  /** The server has processed inputs up to `ack`: its terrain values now include our predicted digs. */
  private resolvePredictions(ack: number) {
    for (const [k, p] of this.predicted) {
      if (p.seq > ack) continue;
      edits.setMm(cellX(k), cellZ(k), p.server);
      this.predicted.delete(k);
    }
  }

  /** Server clock in ms (local clock until the first snapshot), for effects all players should share. */
  serverTime(): number {
    return performance.now() + (this.clockOffset ?? 0);
  }

  /** Decay the visual error and interpolate remote players for this render frame. */
  frame(dtSeconds: number): RemotePlayer[] {
    const k = Math.exp(-dtSeconds * 15);
    this.errorX *= k;
    this.errorY *= k;
    this.errorZ *= k;
    return this.interpolate(performance.now() + (this.clockOffset ?? 0) - INTERP_MS);
  }

  private connect() {
    const ws = new WebSocket(new URL('ws', location.href.replace(/^http/, 'ws')));
    this.ws = ws;
    ws.onopen = () => {
      this.status = 'joining';
      this.send({ t: 'hello', browserId: this.browserId });
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data) as ServerMsg);
    ws.onclose = () => {
      this.id = 0;
      this.pending = [];
      this.snapshots = [];
      // Predicted vertices go back to the last server value; the rejoin resends all chunks anyway.
      for (const [k, p] of this.predicted) edits.setMm(cellX(k), cellZ(k), p.server);
      this.predicted.clear();
      this.digCooldown = 0;
      this.status = 'reconnecting';
      // Reconnect with backoff; deploys restart the server, so this is expected to happen.
      // Jitter spreads everyone's reconnects out after a restart.
      setTimeout(() => this.connect(), this.retryMs * (0.5 + Math.random()));
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    };
  }

  private onMessage(msg: ServerMsg) {
    if (msg.t === 'version') return reloadIfStale(msg.build);
    if (msg.t === 'terrainChunks') return this.applyTerrainChunks(msg);
    if (msg.t === 'terrainEdit') return this.applyTerrainEdit(msg.cells);
    if (msg.t === 'scrap') return this.applyScrap(msg);
    if (msg.t === 'inventory') {
      this.inventory = msg.items;
      return this.onInventory?.(msg.items);
    }
    if (msg.t === 'dug') {
      if (msg.id !== this.id) this.onDig?.({ x: msg.x, y: msg.y, z: msg.z }, msg.pile, false, msg.id);
      return;
    }
    if (msg.t === 'welcome') {
      this.id = msg.id;
      this.color = msg.color;
      this.me = msg.state;
      this.seq = 0;
      this.retryMs = 500;
      this.status = 'online';
      return;
    }
    if (msg.t === 'snap') {
      const offset = msg.time - performance.now();
      // Smooth the clock offset; the first sample sets it directly.
      this.clockOffset = this.clockOffset === undefined ? offset : this.clockOffset + (offset - this.clockOffset) * 0.1;

      const players = new Map(msg.players.map((p) => [p.id, p]));
      this.snapshots.push({ time: msg.time, players });
      while (this.snapshots.length > 30) this.snapshots.shift();

      this.resolvePredictions(msg.ack);
      const server = players.get(this.id);
      if (server) this.reconcile(server, msg.ack);
    }
  }

  private reconcile(server: PlayerState, ack: number) {
    this.pending = this.pending.filter((p) => p.seq > ack);
    let s: PlayerState = {
      x: server.x, y: server.y, z: server.z, vx: server.vx, vy: server.vy, vz: server.vz, facing: server.facing,
      grounded: server.grounded, airJumps: server.airJumps, jumpHeld: server.jumpHeld, landTicks: server.landTicks,
      sliding: server.sliding, slideCool: server.slideCool,
    };
    for (const p of this.pending) s = step(s, p.input, p.yaw);
    this.errorX += this.me.x - s.x;
    this.errorY += this.me.y - s.y;
    this.errorZ += this.me.z - s.z;
    // Big jumps (respawn, long lag) should snap, not glide.
    if (Math.hypot(this.errorX, this.errorY, this.errorZ) > 3) this.errorX = this.errorY = this.errorZ = 0;
    this.me = s;
  }

  private interpolate(renderTime: number): RemotePlayer[] {
    const snaps = this.snapshots;
    if (snaps.length === 0) return [];
    let i = snaps.length - 1;
    while (i > 0 && snaps[i - 1].time > renderTime) i--;
    const b = snaps[i];
    const a = snaps[i - 1] ?? b;
    const t = b.time === a.time ? 1 : Math.min(1, Math.max(0, (renderTime - a.time) / (b.time - a.time)));
    const out: RemotePlayer[] = [];
    for (const pb of b.players.values()) {
      if (pb.id === this.id) continue;
      const pa = a.players.get(pb.id) ?? pb;
      const pick = t < 0.5 ? pa : pb; // discrete fields come from the nearer snapshot
      out.push({
        id: pb.id, color: pb.color,
        x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t, z: pa.z + (pb.z - pa.z) * t,
        facing: lerpAngle(pa.facing, pb.facing, t), speed: Math.hypot(pick.vx, pick.vz), vx: pick.vx, vz: pick.vz, grounded: pick.grounded, sliding: pick.sliding ?? false,
        pitch: pitchFromQ(pa.pitch ?? 32768) * (1 - t) + pitchFromQ(pb.pitch ?? 32768) * t,
      });
    }
    return out;
  }

  private send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

export function getBrowserId(): string {
  try {
    let id = localStorage.getItem('dadajam.browserId');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('dadajam.browserId', id);
    }
    return id;
  } catch {
    return crypto.randomUUID(); // storage blocked: play as a fresh guest
  }
}

// A deploy restarts the server, so every client reconnects and hears the new build here. Reload to
// pick it up (position is kept server-side by browserId). Dev builds never reload, and we try each
// build only once per tab in case a cache still hands us the old page.
function reloadIfStale(build: string) {
  if (build === __BUILD_SHA__ || build === 'dev' || __BUILD_SHA__ === 'dev') return;
  try {
    if (sessionStorage.getItem('reloadedFor') === build) return;
    sessionStorage.setItem('reloadedFor', build);
  } catch {
    return;
  }
  location.reload();
}
