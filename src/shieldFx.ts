// A shield plate (shared/gear.ts) taking a killing blow ('shieldBreak', server/world.ts shielded): the emitter throws
// its field round the wearer in a flash and a glassy ring; on its last blow (not `held`) the cracked hull plate sheds
// shards with a crack too. Then the field
// hangs on faintly, flickering out, for as long as it still keeps them safe (`ms`). Coloured like the emitter's lens
// by the plate's tier (src/tierLook.ts). Whoever it saved also gets a jolt and a flash over the screen.
import * as THREE from 'three/webgpu';
import { abs, dot, float, normalView, positionLocal, positionViewDirection, pow, sin, uniform, vec3 } from 'three/tsl';
import type { ServerMsg } from '../shared/protocol.ts';
import { heightAt } from '../shared/terrain.ts';
import { audio } from './audio';

type Msg = Extract<ServerMsg, { t: 'shieldBreak' }>;
type At = (id: number) => { x: number; y: number; z: number } | null;

/** The field's colour by tier: the lens's (src/tierLook.ts LAMP; Basic: the lens as made). */
const COLORS = [0xd08840, 0xffb04a, 0xff9a3c, 0x3ff0ff];
/** The field: radius (m) round the body's middle (this high above the feet), the flash (s), its fade at the end (s). */
const R = 1.05;
const MID = 0.95;
const FLASH_S = 0.35;
const FADE_S = 0.6;
/** Shards: how many, how fast (m/s), how long they lie (s). */
const SHARDS = 9;
const SHARD_V = 5;
const SHARD_LIFE = 4;
/** Seen and heard within this distance (m). */
const NEAR = 120;
const GRAVITY = 9.8;
/** Levels at full slider volume, at the wearer: together −24.7 LUFS over the event, true peak −1.3 dBTP (measured
 *  offline at Space-grade, ffmpeg ebur128). */
const CRACK_GAIN = 0.36;
const RING_GAIN = 0.13;
const THUMP_GAIN = 0.32;

const SHARD_MAT = new THREE.MeshStandardNodeMaterial({ color: 0x8e8b7f, roughness: 0.6, metalness: 0.55 });
const SHARD_GEO = new THREE.BoxGeometry(1, 0.08, 0.7);

type Field = { id: number; mesh: THREE.Mesh; mat: THREE.MeshBasicNodeMaterial; glow: ReturnType<typeof uniform>; t: number; life: number };
type Shard = { mesh: THREE.Mesh; v: THREE.Vector3; spin: THREE.Vector3; t: number; resting: boolean };

export class ShieldFx {
  private fields: Field[] = [];
  private shards: Shard[] = [];
  private flash = document.createElement('div');
  private flashT = 1;
  private time = uniform(0);
  private scene: THREE.Scene;
  private ear: () => THREE.Vector3;
  private myId: () => number;
  private jolt: (m: number) => void;

  constructor(scene: THREE.Scene, ear: () => THREE.Vector3, myId: () => number, jolt: (m: number) => void) {
    this.scene = scene;
    this.ear = ear;
    this.myId = myId;
    this.jolt = jolt;
    this.flash.style.cssText = 'position:fixed;inset:0;pointer-events:none;opacity:0;mix-blend-mode:screen;z-index:5';
    document.body.append(this.flash);
  }

  /** A break, from the server. */
  play(m: Msg) {
    const ear = this.ear();
    const d = Math.hypot(m.x - ear.x, m.z - ear.z);
    if (d > NEAR) return;
    const col = new THREE.Color(COLORS[m.tier] ?? COLORS[1]);
    this.fields = this.fields.filter((f) => f.id !== m.id || (this.drop(f), false));
    const glow = uniform(1);
    // Both sides: the wearer, inside it, sees it round them too.
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      side: THREE.DoubleSide });
    // Bright at the rim, a faint skin over the middle, bands of it running up.
    const rim = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 2.5);
    const bands = sin(positionLocal.y.mul(26).sub(this.time.mul(7))).mul(0.5).add(0.5);
    mat.colorNode = vec3(col.r, col.g, col.b).mul(2.2);
    mat.opacityNode = rim.mul(0.85).add(bands.mul(bands).mul(0.12)).add(0.04).mul(glow);
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(R, 3), mat);
    mesh.position.set(m.x, m.y + MID, m.z);
    mesh.renderOrder = 3;
    this.scene.add(mesh);
    this.fields.push({ id: m.id, mesh, mat, glow, t: 0, life: Math.max(FLASH_S + FADE_S, m.ms / 1000) });
    // The plate cracks: shards off the chest, thrown on with the blow.
    const [px, py, pz] = m.push;
    const ph = Math.hypot(px, pz) || 1;
    for (let i = 0; i < (m.held ? 0 : SHARDS); i++) {
      const s = new THREE.Mesh(SHARD_GEO, SHARD_MAT);
      s.scale.setScalar(0.05 + Math.random() * 0.05);
      s.position.set(m.x, m.y + 1.3, m.z);
      s.castShadow = true;
      const a = Math.random() * Math.PI * 2, up = 1.5 + Math.random() * 3;
      const v = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(SHARD_V * (0.4 + Math.random() * 0.6));
      v.x += (px / ph) * Math.min(4, ph * 0.2);
      v.z += (pz / ph) * Math.min(4, ph * 0.2);
      v.y = up + Math.max(0, py) * 0.1;
      this.scene.add(s);
      this.shards.push({ mesh: s, v, spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(24), t: 0, resting: false });
    }
    const mine = m.id === this.myId();
    if (mine) {
      this.jolt(0.35);
      this.flash.style.background = `radial-gradient(circle, transparent 35%, #${col.getHexString()} 130%)`;
      this.flashT = 0;
    }
    sound(mine ? 1 : 1 / (1 + d / 10), m.tier, !m.held);
  }

  /** Every frame; `at` is where a player is drawn now (the field follows them). */
  update(dt: number, at: At) {
    this.time.value += dt;
    for (const f of this.fields) {
      f.t += dt;
      const p = at(f.id);
      if (p) f.mesh.position.set(p.x, p.y + MID, p.z);
      // The flash swells out and dies down to a faint field; near its end it stutters, then it's gone.
      const flash = f.t < FLASH_S ? 1 - f.t / FLASH_S : 0;
      f.mesh.scale.setScalar(0.85 + 0.25 * Math.min(1, f.t / FLASH_S) + 0.1 * flash);
      const left = f.life - f.t;
      const stutter = left < FADE_S * 2 ? (Math.sin(f.t * 60) > 0.2 ? 1 : 0.3) : 1;
      f.glow.value = (0.35 + 2.5 * flash * flash) * stutter * Math.min(1, left / FADE_S);
    }
    this.fields = this.fields.filter((f) => f.t < f.life || (this.drop(f), false));
    for (const s of this.shards) {
      s.t += dt;
      if (!s.resting) {
        s.v.y -= GRAVITY * dt;
        s.mesh.position.addScaledVector(s.v, dt);
        s.mesh.rotation.x += s.spin.x * dt;
        s.mesh.rotation.y += s.spin.y * dt;
        s.mesh.rotation.z += s.spin.z * dt;
        const g = heightAt(s.mesh.position.x, s.mesh.position.z);
        if (s.mesh.position.y < g + 0.01 && s.v.y < 0) {
          s.mesh.position.y = g + 0.01;
          s.resting = true;
          s.mesh.rotation.x = s.mesh.rotation.z = 0; // flat on the sand
        }
      }
      if (s.t > SHARD_LIFE) s.mesh.position.y -= dt * 0.15; // the sand takes them
    }
    this.shards = this.shards.filter((s) => s.t < SHARD_LIFE + 1 || (s.mesh.removeFromParent(), false));
    if (this.flashT < 1) {
      this.flashT = Math.min(1, this.flashT + dt / 0.5);
      this.flash.style.opacity = String((1 - this.flashT) ** 2 * 0.8);
    }
  }

  private drop(f: Field) {
    f.mesh.removeFromParent();
    f.mesh.geometry.dispose();
    f.mat.dispose();
  }
}

/** The blow: a crack (noise, high and short; only when it `breaks`), a glassy ring (inharmonic partials, pitched by
 *  tier) and a low thump. */
function sound(level: number, tier: number, breaks: boolean) {
  const ctx = audio.ctx, out = audio.out;
  if (!ctx || !out || !audio.running || level < 0.02) return;
  const t0 = ctx.currentTime + 0.01;
  const bus = ctx.createGain();
  bus.gain.value = level;
  bus.connect(out);
  if (breaks) crack(ctx, bus, t0);
  // Ring: higher and cleaner the better the plate.
  const base = 900 + tier * 160;
  for (const [k, a, len] of [[1, 1, 1.4], [2.76, 0.5, 0.9], [5.4, 0.3, 0.5], [8.93, 0.15, 0.3]] as const) {
    const o = ctx.createOscillator();
    o.frequency.value = base * k;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setTargetAtTime(RING_GAIN * a, t0, 0.002);
    g.gain.setTargetAtTime(0, t0 + 0.01, len / 4);
    o.connect(g).connect(bus);
    o.start(t0);
    o.stop(t0 + len + 0.2);
  }
  // Thump.
  const th = ctx.createOscillator();
  th.frequency.setValueAtTime(110, t0);
  th.frequency.exponentialRampToValueAtTime(42, t0 + 0.25);
  const tg = ctx.createGain();
  tg.gain.value = 0;
  tg.gain.setTargetAtTime(THUMP_GAIN, t0, 0.003);
  tg.gain.setTargetAtTime(0, t0 + 0.03, 0.08);
  th.connect(tg).connect(bus);
  th.start(t0);
  th.stop(t0 + 0.6);
  setTimeout(() => bus.disconnect(), 2500);
}

/** The plate cracking: noise, high and short. */
function crack(ctx: AudioContext, bus: AudioNode, t0: number) {
  const n = Math.round(ctx.sampleRate * 0.12);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.018));
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1800;
  const cg = ctx.createGain();
  cg.gain.value = CRACK_GAIN;
  noise.connect(hp).connect(cg).connect(bus);
  noise.start(t0);
}
