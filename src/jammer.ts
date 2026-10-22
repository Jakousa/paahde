// The jammer in your hand (shared/jammer.ts). Hold the use button: of the jets and drones in the cone it takes the
// one nearest the aim (keeping it while it stays in), builds the lock locally as a guess of the server's, and tells
// the server every JAM_SEND_MS. Nothing on the HUD: the hands point it (JammerAim, src/viewmodel.ts), its lamp blinks
// faster as the lock builds, the target twitches (src/world/jets.ts, drones.ts), and you hear it: a warbling static
// that climbs as the lock builds, a falling chirp when the target drops out.
//
// Others see a jammer raised in someone's hand (their 'hands' aim flag, already sent for the guns) blink its lamp
// (src/models/scavenger.ts) and hear its searching static from where they stand (`others`): the same voice at the
// searching level, panned, 1/d from REMOTE_REF.
//
// Sound through the shared output (src/audio.ts), head-locked (it's in your hand). Measured (OfflineAudioContext,
// K-weighted, gated): searching −38 LUFS; locked on −32 rising to −27 as the band climbs (the gain eases off as it
// goes, the K-weighting favours the highs); the chirp −26 momentary.
import * as THREE from 'three/webgpu';
import { inCone, JAM_BLEED, JAM_CONE, JAM_MS, JAM_SEND_MS, JAMMER } from '../shared/jammer.ts';
import { EYE_HEIGHT } from '../shared/dig.ts';
import { audio } from './audio';
import type { FirstPersonCamera } from './camera';
import { tools, useHeld } from './input';
import { jamMs, quality } from '../shared/gear.ts';
import type { Net } from './net';
import * as kills from './kills';
import { playerHands } from './water';
import type { Drones } from './world/drones';
import type { Jets } from './world/jets';

/** How fast the hand comes up to point it (s, full raise). */
const RAISE_S = 0.25;
/** Static level: trigger held with nothing in the cone, and locked on (eased by LOCK_EASE at a full lock); the chirp. */
const HISS_GAIN = 0.12;
const LOCK_GAIN = 0.34;
const LOCK_EASE = 0.4;
const CHIRP_GAIN = 0.12;
/** Someone else's jammer: heard at the searching level (−38 LUFS) at REMOTE_REF m, 1/d past it, not past REMOTE_MAX. */
const REMOTE_REF = 2;
const REMOTE_MAX = 60;

type Target = { kind: 'jet' | 'drone'; id: number };
type Voice = { src: AudioBufferSourceNode; band: BiquadFilterNode; gain: GainNode; lfo: OscillatorNode; depth: GainNode };

const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _q = new THREE.Quaternion();

export class Jammer {
  private view: FirstPersonCamera;
  private net: Net;
  private jets: Jets;
  private drones: Drones;
  private target: Target | null = null;
  /** The lock built on `target`, 0..1 (our guess of the server's). */
  private level = 0;
  private sentAt = 0;
  private blink = 0;
  private voice: Voice | null = null;
  /** Others' jammers being heard, by player id. */
  private heard = new Map<number, { voice: Voice; pan: PannerNode }>();
  /** Debug (?debug, `dbg.jammer`): hold the use button without the mouse captured. */
  forceUse = false;

  constructor(view: FirstPersonCamera, net: Net, jets: Jets, drones: Drones) {
    this.view = view;
    this.net = net;
    this.jets = jets;
    this.drones = drones;
  }

  /** Every frame, after the camera is placed and the jets and drones drawn. `can`: free to use it. */
  update(dt: number, can: boolean) {
    const holding = playerHands.held === 'jammer' && can;
    const using = holding && ((useHeld() && !!document.pointerLockElement) || this.forceUse);
    if (playerHands.held === 'jammer') playerHands.aim = Math.max(0, Math.min(1, playerHands.aim + (using ? dt : -dt) / RAISE_S));
    _o.copy(this.view.eye);
    this.view.camera.getWorldQuaternion(_q);
    _d.set(0, 0, -1).applyQuaternion(_q);

    // The target: the current one while it's still flying and in the cone, else the nearest to the aim.
    let next = null as Target | null;
    if (using) {
      let best = Math.cos(JAM_CONE), keep = false;
      const look = (kind: Target['kind'], list: Iterable<{ id: number; x: number; y: number; z: number }>) => {
        for (const t of list) {
          if (!inCone(_o.x, _o.y, _o.z, _d.x, _d.y, _d.z, t.x, t.y, t.z)) continue;
          if (this.target?.kind === kind && this.target.id === t.id) keep = true;
          const dot = ((t.x - _o.x) * _d.x + (t.y - _o.y) * _d.y + (t.z - _o.z) * _d.z) / Math.hypot(t.x - _o.x, t.y - _o.y, t.z - _o.z);
          if (dot >= best) {
            best = dot;
            next = { kind, id: t.id };
          }
        }
      };
      look('jet', this.jets.flying());
      look('drone', this.drones.flying());
      if (keep) next = this.target;
    }
    const gone = this.target && !this.alive(this.target);
    if (gone && this.level > 0.8) this.chirp();
    if (gone) {
      this.target = null;
      this.level = 0;
    }
    if (next && (!this.target || next.kind !== this.target.kind || next.id !== this.target.id)) {
      this.target = next;
      this.level = 0;
    }
    const on = !!next;
    // The lock time this jammer's parts give (shared/gear.ts jamMs), as the server counts it.
    const lockMs = jamMs(JAM_MS, Math.max(0, quality(this.net.boxes.bag?.[tools.slot])));
    if (on) this.level = Math.min(1, this.level + (dt * 1000) / lockMs);
    else if (this.target) this.level = Math.max(0, this.level - (dt * 1000 * JAM_BLEED) / lockMs);
    if (on && performance.now() - this.sentAt >= JAM_SEND_MS) {
      this.sentAt = performance.now();
      kills.hit(`${this.target!.kind === 'jet' ? 'j' : 'd'}${this.target!.id}`);
      this.net.jam(this.target!.kind, this.target!.id, _o.x, _o.y, _o.z, _d.x, _d.y, _d.z);
    }
    const shown = on ? { id: this.target!.id, level: this.level } : null;
    this.jets.jamming = this.target?.kind === 'jet' ? shown : null;
    this.drones.jamming = this.target?.kind === 'drone' ? shown : null;

    // The lamp: dark at rest, a steady glow searching, blinking faster as the lock builds.
    this.blink += dt * (2 + 14 * this.level);
    playerHands.jamLamp = !using ? 0 : !on ? 0.35 : this.blink % 1 < 0.5 ? 1 : 0.1;
    this.sound(using, on);
  }

  private alive(t: Target) {
    for (const o of t.kind === 'jet' ? this.jets.flying() : this.drones.flying()) if (o.id === t.id) return true;
    return false;
  }

  /** The static: faint while searching; locked on, louder, higher and warbling faster as the lock builds. */
  private sound(using: boolean, on: boolean) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const now = ctx.currentTime;
    if (!using) {
      if (this.voice) {
        const v = this.voice;
        v.gain.gain.setTargetAtTime(0, now, 0.03);
        v.src.stop(now + 0.3);
        v.lfo.stop(now + 0.3);
        this.voice = null;
      }
      return;
    }
    const v = (this.voice ??= this.makeVoice(ctx, out));
    const l = on ? this.level : 0;
    v.gain.gain.setTargetAtTime(on ? LOCK_GAIN * (1 - LOCK_EASE * l) : HISS_GAIN, now, 0.05);
    v.band.frequency.setTargetAtTime(on ? 700 * Math.pow(5, l) : 1400, now, 0.05);
    v.lfo.frequency.setTargetAtTime(on ? 6 + 18 * l : 3, now, 0.05);
    v.depth.gain.setTargetAtTime(on ? 0.6 : 0.2, now, 0.05);
  }

  private makeVoice(ctx: AudioContext, out: AudioNode): Voice {
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 4;
    band.frequency.value = 1400;
    // The warble: the level swung by an LFO (unity gain plus ±depth).
    const wob = ctx.createGain();
    wob.gain.value = 1;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 3;
    const depth = ctx.createGain();
    depth.gain.value = 0.2;
    lfo.connect(depth).connect(wob.gain);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(band).connect(wob).connect(gain).connect(out);
    src.start();
    lfo.start();
    return { src, band, gain, lfo, depth };
  }

  /** Every frame with the other players (interpolated) and where we hear from: the static of each one jamming. */
  others(players: readonly { id: number; x: number; y: number; z: number; item: string | null; aiming: boolean; down: unknown }[],
    ear: { x: number; y: number; z: number }) {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const now = ctx.currentTime;
    const on = new Set<number>();
    for (const p of players) {
      if (p.item !== JAMMER || !p.aiming || p.down || Math.hypot(p.x - ear.x, p.y - ear.y, p.z - ear.z) > REMOTE_MAX) continue;
      on.add(p.id);
      let h = this.heard.get(p.id);
      if (!h) {
        const pan = ctx.createPanner();
        pan.panningModel = 'equalpower';
        pan.distanceModel = 'inverse';
        pan.refDistance = REMOTE_REF;
        pan.rolloffFactor = 1;
        pan.positionX.value = p.x;
        pan.positionY.value = p.y + EYE_HEIGHT - 0.3;
        pan.positionZ.value = p.z;
        pan.connect(out);
        h = { voice: this.makeVoice(ctx, pan), pan };
        h.voice.gain.gain.setTargetAtTime(HISS_GAIN, now, 0.05);
        this.heard.set(p.id, h);
      }
      h.pan.positionX.setTargetAtTime(p.x, now, 0.05);
      h.pan.positionY.setTargetAtTime(p.y + EYE_HEIGHT - 0.3, now, 0.05);
      h.pan.positionZ.setTargetAtTime(p.z, now, 0.05);
    }
    for (const [id, h] of this.heard) {
      if (on.has(id)) continue;
      h.voice.gain.gain.setTargetAtTime(0, now, 0.03);
      h.voice.src.stop(now + 0.3);
      h.voice.lfo.stop(now + 0.3);
      h.voice.src.onended = () => h.pan.disconnect();
      this.heard.delete(id);
    }
  }

  /** The target dropped out: a falling chirp. */
  private chirp() {
    const ctx = audio.ctx, out = audio.out;
    if (!ctx || !out || !audio.running) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(2200, t);
    o.frequency.exponentialRampToValueAtTime(260, t + 0.45);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(CHIRP_GAIN, t + 0.01);
    g.gain.setTargetAtTime(0, t + 0.3, 0.06);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.8);
  }
}
