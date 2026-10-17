// Client netcode:
// - Local player: client-side prediction. Every fixed tick we simulate our own input immediately,
//   send it with a sequence number and keep it as "pending". When a snapshot arrives we take the
//   server's state for us, drop the inputs it has acknowledged and replay the rest (reconciliation).
// - Remote players: entity interpolation. We render them INTERP_MS in the past, between the two
//   snapshots that surround that time, so their motion is smooth despite 20 Hz updates.
import { spawnState, step, type PlayerState } from '../shared/sim.ts';
import type { ClientMsg, PlayerSnap, ServerMsg } from '../shared/protocol.ts';

const INTERP_MS = 100;

export type RemotePlayer = { id: number; color: number; x: number; y: number; vx: number; grounded: boolean };

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

  private ws?: WebSocket;
  private seq = 0;
  private pending: { seq: number; input: number }[] = [];
  private snapshots: Snapshot[] = [];
  private clockOffset?: number; // serverTime - localTime
  private retryMs = 500;
  private browserId: string;

  constructor(browserId: string) {
    this.browserId = browserId;
    this.connect();
  }

  get connected() {
    return this.id !== 0;
  }

  /** Called once per fixed tick with the sampled input. */
  tick(input: number) {
    if (!this.connected) return;
    this.seq++;
    this.me = step(this.me, input);
    this.pending.push({ seq: this.seq, input });
    this.send({ t: 'input', seq: this.seq, input });
  }

  /** Decay the visual error and interpolate remote players for this render frame. */
  frame(dtSeconds: number): RemotePlayer[] {
    const k = Math.exp(-dtSeconds * 15);
    this.errorX *= k;
    this.errorY *= k;
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
      this.status = 'reconnecting';
      // Reconnect with backoff; deploys restart the server, so this is expected to happen.
      // Jitter spreads everyone's reconnects out after a restart.
      setTimeout(() => this.connect(), this.retryMs * (0.5 + Math.random()));
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    };
  }

  private onMessage(msg: ServerMsg) {
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

      const server = players.get(this.id);
      if (server) this.reconcile(server, msg.ack);
    }
  }

  private reconcile(server: PlayerState, ack: number) {
    this.pending = this.pending.filter((p) => p.seq > ack);
    let s: PlayerState = {
      x: server.x, y: server.y, vx: server.vx, vy: server.vy,
      grounded: server.grounded, airJumps: server.airJumps, jumpHeld: server.jumpHeld,
    };
    for (const p of this.pending) s = step(s, p.input);
    this.errorX += this.me.x - s.x;
    this.errorY += this.me.y - s.y;
    // Big jumps (respawn, long lag) should snap, not glide.
    if (Math.hypot(this.errorX, this.errorY) > 3) this.errorX = this.errorY = 0;
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
        x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t,
        vx: pick.vx, grounded: pick.grounded,
      });
    }
    return out;
  }

  private send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
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
