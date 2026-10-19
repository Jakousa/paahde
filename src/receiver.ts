// The receiver in your hand (shared/bosses.ts RECEIVERS). Repaired, the use button sends its signal: the server spends
// the cell and calls the boss, some way off (server/world.ts onCall), with a rising sweep. Repaired or not, while its
// boss is about the needle on top points to it (src/models/receiver.ts, turned by src/viewmodel.ts), less steadily
// the worse its parts (shared/gear.ts receiverWobble), and it ticks, faster and higher the more nearly you face it;
// the lamp blinks with the ticks. Nothing on the HUD.
//
// Sound through the shared output (src/audio.ts), head-locked:
// short sine ticks; the sweep −26 LUFS momentary like the jammer's chirp.
import { receiverBoss } from '../shared/bosses.ts';
import { quality, receiverWobble, repaired } from '../shared/gear.ts';
import type { Item } from '../shared/items.ts';
import { audio } from './audio';
import type { FirstPersonCamera } from './camera';
import { useHeld } from './input';
import type { Net } from './net';
import { playerHands } from './water';

/** Tick interval (s) facing away and straight at it; pitch (Hz) the same; length (s), level. */
const SLOW = 1.3;
const FAST = 0.12;
const LOW_HZ = 520;
const HIGH_HZ = 1500;
const TICK = 0.05;
const TICK_GAIN = 0.13;
const SWEEP_GAIN = 0.12;
/** Needle spring (1/s): how fast it swings round to the bearing. */
const SWING = 6;

export class Receiver {
  private view: FirstPersonCamera;
  private net: Net;
  private t = 0;
  private next = 0;
  private wasDown = false;
  /** Signal sent at (performance.now()): the lamp stays lit and no second call goes out for a while. */
  private sentAt = -Infinity;
  /** Last tick (s, our clock): the lamp blinks with it. */
  private blinkAt = -Infinity;

  constructor(view: FirstPersonCamera, net: Net) {
    this.view = view;
    this.net = net;
  }

  /** Every frame, after the camera is placed. `held`: the item in hand; `can`: free to use it; `dead`: a storm's static
   *  has it dead (src/storm.ts toolsDown): no call, and the needle hangs as if nothing answered. */
  update(dt: number, held: Item | null | undefined, can: boolean, dead = false) {
    const kind = playerHands.held === 'receiver' ? receiverBoss(held?.kind) : null;
    const r = playerHands.receiver;
    r.kind = kind;
    if (!kind) {
      this.next = 0;
      this.wasDown = false;
      return;
    }
    this.t += dt;
    const down = can && !dead && useHeld() && !!document.pointerLockElement;
    const boss = dead ? undefined : this.net.called.find((b) => b.k === kind);
    if (down && !this.wasDown && !boss && repaired(held) && performance.now() - this.sentAt > 3000) {
      this.sentAt = performance.now();
      this.net.call();
      sweep();
    }
    this.wasDown = down;
    const lit = Math.max(0, 1 - (performance.now() - this.sentAt) / 1500);
    if (!boss) {
      // Nothing answers: the needle hangs and drifts.
      r.needle += (Math.sin(this.t * 0.7) * 0.6 - r.needle) * Math.min(1, dt * 1.5);
      r.lamp = lit;
      this.next = 0;
      return;
    }
    const me = this.net.me;
    const yaw = this.view.yaw + this.view.freeYaw; // the hand turns with the view
    const bearing = Math.atan2(-(boss.x - me.x), -(boss.z - me.z)); // the view's yaw that would face it
    let rel = bearing - yaw;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    const wob = receiverWobble(Math.max(0, quality(held)));
    const want = rel + wob * (Math.sin(this.t * 2.3) + 0.5 * Math.sin(this.t * 5.1));
    let d = want - r.needle;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    r.needle += d * Math.min(1, dt * SWING);
    const facing = (1 + Math.cos(rel)) / 2; // 0 away .. 1 straight at it
    this.next -= dt;
    if (this.next <= 0) {
      const f = facing ** 3;
      this.next = SLOW + (FAST - SLOW) * f;
      tick(LOW_HZ + (HIGH_HZ - LOW_HZ) * f);
      this.blinkAt = this.t;
    }
    r.lamp = Math.max(lit, Math.max(0, 1 - (this.t - this.blinkAt) / 0.08));
  }
}

/** One short sine tick (src/detector.ts tick). */
function tick(hz: number) {
  const ctx = audio.ctx, out = audio.out;
  if (!ctx || !out || !audio.running) return;
  const t0 = ctx.currentTime + 0.01;
  const osc = ctx.createOscillator();
  osc.frequency.value = hz;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  osc.connect(gain).connect(out);
  gain.gain.setTargetAtTime(TICK_GAIN, t0, 0.003);
  gain.gain.setTargetAtTime(0, t0 + TICK, 0.006);
  osc.start(t0);
  osc.stop(t0 + TICK + 0.06);
  osc.onended = () => gain.disconnect();
}

/** The signal goes out: a rising sweep with a warble. */
function sweep() {
  const ctx = audio.ctx, out = audio.out;
  if (!ctx || !out || !audio.running) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(300, t);
  o.frequency.exponentialRampToValueAtTime(2400, t + 0.9);
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 14;
  const depth = ctx.createGain();
  depth.gain.value = 60;
  lfo.connect(depth).connect(o.frequency);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(SWEEP_GAIN, t + 0.05);
  g.gain.setTargetAtTime(0, t + 0.85, 0.08);
  o.connect(g).connect(out);
  o.start(t);
  lfo.start(t);
  o.stop(t + 1.4);
  lfo.stop(t + 1.4);
  o.onended = () => {
    g.disconnect();
    depth.disconnect();
  };
}
