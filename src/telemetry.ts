// Stall tracing (docs/netcode.md "Telemetry"): src/net.ts tells it when inputs go out and snapshots come in,
// src/main.ts when each frame starts. From that it tells apart where a stall was:
// - down: snapshots stopped coming though their server times stayed 50 ms apart (the network, server → us)
// - up: snapshots on time, but the input after the acked one has waited long (the network, us → server)
// - server: the snapshots' own server times far apart (the world's loop was late)
// - frame: a frame of ours took long (our main thread was busy; snapshots queued behind it aren't counted as 'down')
// - reconnect: the socket was closed, and for how long
// Stalls go to the server in small batches, with a summary a minute (server/telemetry.ts writes them down). Cheap:
// a few numbers per message and frame, a sort a minute.
import type { ClientMsg, NetSummary, StallEvent } from '../shared/protocol.ts';

/** A gap this long (ms) between snapshots, frames or an input and its ack counts as a stall. */
const STALL_MS = 250;
/** Snapshots stamped this far apart (ms) by the server: its loop was late (they go out every 50 ms). */
const SERVER_LATE_MS = 150;
/** Snapshots this close together (ms) after a stall came in its burst. */
const BURST_MS = 20;
/** Stalls are sent this often at most (ms), and a summary every SUMMARY_MS; never closer than MIN_GAP_MS (the
 *  server takes one a TRACE_GAP_MS, server/world.ts). */
const SEND_MS = 5000;
const MIN_GAP_MS = 2500;
const SUMMARY_MS = 60_000;
/** Stalls kept for sending (oldest dropped), and sent in one message (the server takes 1 KB at most). */
const KEEP = 48;
const PER_MSG = 12;
/** Inputs remembered by seq for the round trip (60 a second: about 8 s). */
const RING = 512;
/** The stats line shows the last stall this long (ms). */
const SHOW_MS = 30_000;

type Stall = StallEvent & { at: number };

export class Telemetry {
  /** Sends if connected; false if not (kept for later). */
  private send: (msg: ClientMsg) => boolean;
  private stalls: Stall[] = [];
  /** 'down' stalls waiting for the next frame to say whether our own frame was what held them. */
  private unsure: Stall[] = [];
  private burst: Stall | null = null;
  private sentAt = new Float64Array(RING);
  private seq = 0;
  private lastAck = 0;
  private snapAt?: number;
  private snapStamp = 0;
  /** The longest wait so far of an input for its ack while snapshots kept coming (an uplink stall going on). */
  private upPeak = 0;
  private frameAt?: number;
  /** The last long frame: when it ended and how long it took (performance.now() ms). */
  private block = { end: -Infinity, ms: 0 };
  private offlineAt?: number;
  private closeCode = 0;
  private sentAtMs = 0;
  // This minute's summary.
  private since = performance.now();
  private rtts: number[] = [];
  private gapMax = 0;
  private frameMax = 0;
  private frames = 0;
  private shownMs = 0;
  private hidden = false;
  /** Smoothed round trip (ms) for the stats line. */
  private rtt = 0;

  constructor(send: (msg: ClientMsg) => boolean) {
    this.send = send;
    document.addEventListener('visibilitychange', () => {
      // A hidden tab draws no frames: the gap when it comes back isn't a stall.
      this.frameAt = undefined;
      this.hidden ||= document.hidden;
    });
  }

  /** Input `seq` went out now. */
  sent(seq: number) {
    this.seq = seq;
    this.sentAt[seq % RING] = performance.now();
  }

  /** A snapshot stamped `time` (server ms) came in, acknowledging input `ack`. */
  snap(time: number, ack: number) {
    const now = performance.now();
    const gap = this.snapAt === undefined ? 0 : now - this.snapAt, stamped = time - this.snapStamp;
    if (this.burst && gap < BURST_MS) this.burst.n!++;
    else this.burst = null;
    if (this.snapAt !== undefined) {
      this.gapMax = Math.max(this.gapMax, gap);
      if (stamped > SERVER_LATE_MS) this.add({ k: 'server', ms: Math.round(stamped), ago: 0, at: now });
      else if (gap > STALL_MS) {
        const s: Stall = { k: 'down', ms: Math.round(gap), n: 1, ago: 0, at: now };
        this.unsure.push(s);
        this.burst = s;
      }
    }
    this.snapAt = now;
    this.snapStamp = time;
    if (ack > this.lastAck && this.seq - ack < RING) {
      const rtt = now - this.sentAt[ack % RING];
      this.rtts.push(rtt);
      this.rtt = this.rtt ? this.rtt + (rtt - this.rtt) * 0.1 : rtt;
    }
    this.lastAck = Math.max(this.lastAck, ack);
    // The first input the server hasn't acked: how long it has been on its way, while snapshots come on time.
    const waiting = this.seq > ack && this.seq - ack < RING ? now - this.sentAt[(ack + 1) % RING] : 0;
    if (waiting > STALL_MS && gap < SERVER_LATE_MS) this.upPeak = Math.max(this.upPeak, waiting);
    else if (this.upPeak && waiting < STALL_MS) {
      this.add({ k: 'up', ms: Math.round(this.upPeak), ago: 0, at: now });
      this.upPeak = 0;
    }
  }

  /** The socket closed with `code`. */
  closed(code: number) {
    this.offlineAt ??= performance.now();
    this.closeCode = code;
    this.snapAt = undefined; // a restarted server has a new clock
    this.burst = null;
    this.upPeak = 0;
  }

  /** Joined (again): the server counts inputs from 1. */
  opened() {
    const now = performance.now();
    if (this.offlineAt !== undefined) this.add({ k: 'reconnect', ms: Math.round(now - this.offlineAt), code: this.closeCode, ago: 0, at: now });
    this.offlineAt = undefined;
    this.seq = this.lastAck = 0;
  }

  /** Every frame, at its start (performance.now() ms). */
  frame(now: number) {
    if (this.frameAt !== undefined && !document.hidden) {
      const ms = now - this.frameAt;
      this.frames++;
      this.shownMs += ms;
      this.frameMax = Math.max(this.frameMax, ms);
      if (ms > STALL_MS) {
        this.block = { end: now, ms };
        this.add({ k: 'frame', ms: Math.round(ms), ago: 0, at: now });
      }
    }
    this.frameAt = now;
    // A snapshot gap mostly spent in one long frame of ours was our own stall, already counted.
    for (const s of this.unsure) {
      if (!(this.block.ms > s.ms * 0.6 && Math.abs(this.block.end - s.at) < STALL_MS)) this.add(s);
    }
    this.unsure.length = 0;
    if (now - this.sentAtMs < MIN_GAP_MS) return;
    if (now - this.since >= SUMMARY_MS) this.report(now, this.summary(now));
    else if (this.stalls.length && now - this.sentAtMs >= SEND_MS) this.report(now);
  }

  /** For the stats line: the round trip, and the last stall for a while after it. */
  text(): string {
    const last = this.stalls[this.stalls.length - 1] ?? this.lastSent;
    const recent = last && performance.now() - last.at < SHOW_MS ? ` · ${last.k} ${(last.ms / 1000).toFixed(1)} s` : '';
    return `rtt ${Math.round(this.rtt)} ms${recent}`;
  }

  private lastSent?: Stall;

  private add(s: Stall) {
    this.stalls.push(s);
    if (this.stalls.length > KEEP) this.stalls.shift();
  }

  private summary(now: number): NetSummary {
    const r = this.rtts.sort((a, b) => a - b), q = (p: number) => Math.round(r[Math.min(r.length - 1, Math.floor(r.length * p))] ?? 0);
    const sum: NetSummary = {
      rtt50: q(0.5), rtt95: q(0.95), rttMax: q(1), gapMax: Math.round(this.gapMax), frameMax: Math.round(this.frameMax),
      fps: this.shownMs ? Math.round((this.frames * 1000) / this.shownMs) : 0, ...(this.hidden ? { hidden: true } : {}),
    };
    this.since = now;
    this.rtts = [];
    this.gapMax = this.frameMax = this.frames = this.shownMs = 0;
    this.hidden = document.hidden;
    return sum;
  }

  private report(now: number, sum?: NetSummary) {
    this.sentAtMs = now;
    const batch = this.stalls.slice(0, PER_MSG);
    const ev = batch.map(({ k, ms, n, code, at }) => ({ k, ms, ago: Math.round(now - at), ...(n !== undefined ? { n } : {}), ...(code !== undefined ? { code } : {}) }));
    if (!this.send({ t: 'telemetry', ev, ...(sum ? { sum } : {}) })) return;
    this.stalls.splice(0, batch.length);
    if (batch.length) this.lastSent = batch[batch.length - 1];
  }
}
