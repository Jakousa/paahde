// The brood queen's spiderlings as drawn (server/queen.ts simulates them, shared/queen.ts SP_*; their numbers ride
// at the end of the queen's BossSnap.s): small dark machine spiders, a body and a glowing slit along the back, on
// eight two-part legs. Instanced: one draw call each for the bodies, their glow and all the legs.
//
// - Positions come at the boss rate (10 a second): each one eases towards the newest, which makes them run in
//   little scuttling bursts. The legs step in an alternating tetrapod, the phase driven by the distance run.
// - Dropping (SP_DROP): out from under the sac (the view hands us that point), legs flailing, tumbling onto the sand.
// - Crouched (SP_CROUCH): low, legs spread, glowing hot, a sharp rattle: about to spring. Leaping: in an arc, legs
//   tucked. Landed: a thud and dust, getting up.
// - Dying (SP_DIE): flips onto its back, legs curling up, a puff of smoke, and sinks into the sand.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BROOD_CAP, BROOD_N, CROUCH_MS, DIE_MS, DROP_MS, LEAP_MS, REST_MS, S_BROOD, SP_BODY_Y, SP_CROUCH, SP_DIE, SP_DROP, SP_LEAP, SP_REST, SP_RUN,
} from '../../shared/queen.ts';
import { heightAt } from '../../shared/terrain.ts';
import { queenSound } from '../queenSound';
import type { BossCtx } from './bossParts';
import { zaps } from './zaps';

/** Legs per spiderling, segments per leg. */
const LEGS = 8;
/** Hips and rest feet (body frame, +X side; mirrored), per leg front to back. */
const HIP_Z = [0.42, 0.18, -0.06, -0.28];
const FOOT_Z = [1.0, 0.4, -0.25, -0.85];
const HIP_X = 0.22, FOOT_X = 1.0;
/** Gait: radians of step per metre run, stride swing (m), lift (m). */
const STEP_PER_M = 6.5, SWING = 0.3, LIFT = 0.25;
/** A shot this close (m) to its body's centre hits it. */
const HIT_R = 0.9;
/** Leap arc height (m). */
const ARC = 1.1;
/** Running ones are heard this close (m); a tick every TICK_S (± a little). */
const HEAR = 70, TICK_S = 0.07;

type Ling = {
  x: number; y: number; z: number; yaw: number; pitch: number; roll: number;
  st: number; stAt: number; spd: number; phase: number; seen: number;
  /** Dropping: from where under the sac; played: the drop's landing, the leap's, the death. */
  from: THREE.Vector3 | null; landed: boolean; leapt: number; died: boolean; crouched: number;
};

const bodyMat = new THREE.MeshStandardNodeMaterial({ color: 0x241a14, roughness: 0.55, metalness: 0.55 });
const legMat = new THREE.MeshStandardNodeMaterial({ color: 0x2e231c, roughness: 0.6, metalness: 0.5 });
const glowMat = new THREE.MeshBasicNodeMaterial({ color: 0xffffff });
const GLOW = new THREE.Color(1.6, 0.36, 0.08);

function bodyGeo() {
  const s = (sx: number, sy: number, sz: number, x: number, y: number, z: number) => new THREE.SphereGeometry(1, 10, 7).scale(sx, sy, sz).translate(x, y, z);
  return mergeGeometries([s(0.5, 0.36, 0.62, 0, 0.08, -0.5), s(0.34, 0.22, 0.38, 0, 0, 0.22), s(0.17, 0.13, 0.16, 0, -0.02, 0.6)])!;
}
function glowGeo() {
  const e = (x: number) => new THREE.SphereGeometry(0.055, 6, 4).translate(x, 0.06, 0.72);
  return mergeGeometries([e(-0.08), e(0.08), e(-0.15).translate(0, -0.03, -0.06), e(0.15).translate(0, -0.03, -0.06),
    new THREE.BoxGeometry(0.07, 0.05, 0.62).translate(0, 0.43, -0.5)])!;
}

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const lerpAngle = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const _m = new THREE.Matrix4(), _mb = new THREE.Matrix4(), _c = new THREE.Color(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _hip = new THREE.Vector3(), _knee = new THREE.Vector3(), _foot = new THREE.Vector3(), _d = new THREE.Vector3(), _w = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class Brood {
  private scene: THREE.Scene;
  private bodies: THREE.InstancedMesh;
  private glows: THREE.InstancedMesh;
  private legs: THREE.InstancedMesh;
  private lings = new Map<number, Ling>();
  private frame = 0;
  private tick = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.bodies = new THREE.InstancedMesh(bodyGeo(), bodyMat, BROOD_CAP);
    this.glows = new THREE.InstancedMesh(glowGeo(), glowMat, BROOD_CAP);
    this.legs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), legMat, BROOD_CAP * LEGS * 2);
    for (const m of [this.bodies, this.glows, this.legs]) {
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
    }
    this.bodies.castShadow = this.legs.castShadow = true;
    for (let i = 0; i < BROOD_CAP; i++) this.glows.setColorAt(i, GLOW);
  }

  /** Where the shot from o along unit d first meets a live spiderling within max (m), and its id, or null. */
  ray(o: THREE.Vector3, d: THREE.Vector3, max: number): { index: number; dist: number } | null {
    let best: { index: number; dist: number } | null = null;
    for (const [id, l] of this.lings) {
      if (l.st === SP_DIE) continue;
      const cx = l.x - o.x, cy = l.y - o.y, cz = l.z - o.z;
      const along = cx * d.x + cy * d.y + cz * d.z, miss2 = cx * cx + cy * cy + cz * cz - along * along;
      if (along < 0 || miss2 > HIT_R * HIT_R) continue;
      const t = Math.max(0, along - Math.sqrt(HIT_R * HIT_R - miss2));
      if (t <= max && (!best || t < best.dist)) best = { index: id, dist: t };
    }
    return best;
  }

  /**
   * Every frame, with the queen's snapshot numbers `s`; `drop` gives the point under the sac they fall from (world).
   * Hidden: far away (nothing drawn, nothing heard).
   */
  update(s: number[], ctx: BossCtx, hidden: boolean, drop: (out: THREE.Vector3) => THREE.Vector3) {
    const dt = ctx.dt;
    this.frame++;
    let n = 0, near: Ling | null = null, nd = HEAR, running = 0;
    for (let o = S_BROOD + 2; o + BROOD_N <= s.length && n < BROOD_CAP; o += BROOD_N) {
      const id = s[o], tx = s[o + 1], tz = s[o + 2], tyaw = s[o + 3], st = s[o + 4], stAt = s[o + 5];
      let l = this.lings.get(id);
      if (!l) {
        l = {
          x: tx, y: heightAt(tx, tz) + SP_BODY_Y, z: tz, yaw: tyaw, pitch: 0, roll: 0, st, stAt, spd: 0, phase: Math.random() * 6, seen: 0,
          from: st === SP_DROP ? drop(new THREE.Vector3()) : null, landed: st !== SP_DROP, leapt: st === SP_REST ? stAt : 0, died: st === SP_DIE,
          crouched: st === SP_CROUCH ? stAt : 0,
        };
        this.lings.set(id, l);
      }
      l.seen = this.frame;
      l.st = st;
      l.stAt = stAt;
      const since = ctx.time - stAt;
      const ground = heightAt(l.x, l.z);
      let y = ground + SP_BODY_Y, pitch = 0, roll = 0, show = true;
      const ox = l.x, oz = l.z;
      if (st === SP_DROP && l.from && since < DROP_MS) {
        // Falling out from under the sac, tumbling.
        if (since < 0) show = false;
        const p = Math.max(0, since / DROP_MS);
        l.x = l.from.x + (tx - l.from.x) * p;
        l.z = l.from.z + (tz - l.from.z) * p;
        y = l.from.y + (heightAt(l.x, l.z) + SP_BODY_Y - l.from.y) * p * p;
        roll = (1 - p) * 5.5;
        pitch = (1 - p) * 1.5;
        l.yaw = lerpAngle(l.yaw, tyaw, Math.min(1, dt * 4));
      } else {
        if (!l.landed) {
          l.landed = true;
          this.land(l, ctx, hidden);
        }
        const k = 1 - Math.exp(-dt * (st === SP_LEAP ? 18 : 10));
        l.x += (tx - l.x) * k;
        l.z += (tz - l.z) * k;
        l.yaw = lerpAngle(l.yaw, tyaw, 1 - Math.exp(-dt * 12));
        y = heightAt(l.x, l.z) + SP_BODY_Y;
        if (st === SP_CROUCH) {
          y -= 0.22 * smooth(since / 120);
          if (l.crouched !== stAt) {
            l.crouched = stAt;
            if (!hidden && since < 300) queenSound.crouch(_w.set(l.x, y, l.z), ctx.ear);
          }
        } else if (st === SP_LEAP) {
          const p = Math.min(1, Math.max(0, since / LEAP_MS));
          y += Math.sin(Math.PI * p) * ARC;
          pitch = -0.5 + p;
        } else if (st === SP_REST) {
          y -= 0.18 * (1 - smooth(since / REST_MS));
          if (l.leapt !== stAt) {
            l.leapt = stAt;
            if (since < 300) this.land(l, ctx, hidden);
          }
        } else if (st === SP_DIE) {
          const p = smooth(since / 350);
          roll = p * Math.PI;
          y += p * 0.15 - Math.max(0, (since - 700) / (DIE_MS - 700)) * 0.9;
          if (!l.died) {
            l.died = true;
            if (!hidden && since < 400) {
              queenSound.pop(_w.set(l.x, y, l.z), ctx.ear);
              zaps.puff(l.x, y + 0.3, l.z, 0.9, 1.5);
            }
          }
        }
      }
      const moved = Math.hypot(l.x - ox, l.z - oz);
      l.spd += (moved / Math.max(dt, 1e-3) - l.spd) * (1 - Math.exp(-dt * 8));
      l.phase += moved * STEP_PER_M;
      l.y = y;
      l.pitch = pitch;
      l.roll = roll;
      if (show) this.pose(l, n, ctx.time, since);
      else this.hide(n);
      n++;
      if (st === SP_RUN && l.spd > 1) {
        running++;
        const d = Math.hypot(l.x - ctx.ear.x, l.y - ctx.ear.y, l.z - ctx.ear.z);
        if (d < nd) (nd = d), (near = l);
      }
    }
    for (const [id, l] of this.lings) if (l.seen !== this.frame) this.lings.delete(id);
    for (const m of [this.bodies, this.glows, this.legs]) m.visible = !hidden && n > 0;
    this.bodies.count = this.glows.count = n;
    this.legs.count = n * LEGS * 2;
    this.bodies.instanceMatrix.needsUpdate = this.glows.instanceMatrix.needsUpdate = this.legs.instanceMatrix.needsUpdate = true;
    if (this.glows.instanceColor) this.glows.instanceColor.needsUpdate = true;
    // Their claws on the sand: the nearest running one, livelier the more there are.
    this.tick -= dt;
    if (near && !hidden && this.tick <= 0) {
      const ln = near as Ling;
      queenSound.skitter(_w.set(ln.x, ln.y, ln.z), ctx.ear, running);
      this.tick = TICK_S + Math.random() * 0.04;
    }
  }

  /** Hitting the sand: a thud and a little dust. */
  private land(l: Ling, ctx: BossCtx, hidden: boolean) {
    if (hidden) return;
    const y = heightAt(l.x, l.z);
    queenSound.drop(_w.set(l.x, y, l.z), ctx.ear);
    ctx.thump(l.x, y, l.z, 0.03, 4, 1, 0.4);
  }

  private hide(i: number) {
    this.bodies.setMatrixAt(i, ZERO);
    this.glows.setMatrixAt(i, ZERO);
    for (let j = 0; j < LEGS * 2; j++) this.legs.setMatrixAt(i * LEGS * 2 + j, ZERO);
  }

  /** Instance i: the body where l is, the legs stepping (or flailing, tucked, curled by its state). */
  private pose(l: Ling, i: number, time: number, since: number) {
    _e.set(l.pitch, l.yaw, l.roll, 'YXZ');
    _q.setFromEuler(_e);
    _mb.compose(_p.set(l.x, l.y, l.z), _q, _s.set(1, 1, 1));
    this.bodies.setMatrixAt(i, _mb);
    this.glows.setMatrixAt(i, _mb);
    // Glow: hotter crouched and in the air, out as it dies.
    const hot = l.st === SP_CROUCH ? 1.8 + Math.sin(time * 0.06) * 0.5 : l.st === SP_LEAP ? 1.6 : l.st === SP_DIE ? Math.max(0, 1 - since / 500) : 1;
    this.glows.setColorAt(i, _c.copy(GLOW).multiplyScalar(hot));
    const groundY = -(l.y - heightAt(l.x, l.z));
    const act = Math.min(1, l.spd / 3);
    for (let k = 0; k < LEGS; k++) {
      const side = k < 4 ? 1 : -1, j = k % 4;
      _hip.set(side * HIP_X, 0, HIP_Z[j]);
      if (l.st === SP_DROP) {
        // Flailing.
        _foot.set(side * FOOT_X * 0.8, -0.3 + Math.sin(time * 0.03 + k * 1.3) * 0.2, FOOT_Z[j] * 0.8);
      } else if (l.st === SP_LEAP) {
        // Tucked: front legs reaching ahead, the rest folded back.
        _foot.set(side * 0.55, -0.35, j < 2 ? 0.9 + j * -0.3 : -0.6 - (j - 2) * 0.3);
      } else if (l.st === SP_DIE) {
        // Curling up (the body is on its back, so its belly side is up).
        const c = smooth(since / 600);
        _foot.set(side * (FOOT_X - 0.7 * c), groundY * (1 - c) + c * -0.15, FOOT_Z[j] * (1 - 0.6 * c));
      } else {
        const spread = l.st === SP_CROUCH ? 1.2 : 1;
        const g = (j + (side > 0 ? 0 : 1)) % 2, ph = l.phase + g * Math.PI;
        const twitch = act < 0.1 ? Math.sin(time * 0.004 + k * 2.1) * 0.03 : 0;
        _foot.set(side * FOOT_X * spread, groundY + Math.max(0, Math.cos(ph)) * LIFT * act, FOOT_Z[j] * spread + Math.sin(ph) * SWING * act + twitch);
      }
      // Knee: high over the middle and a little out, like a harvestman's.
      _knee.addVectors(_hip, _foot).multiplyScalar(0.5);
      _knee.y = Math.max(_hip.y, _foot.y) + 0.38;
      _knee.x += side * 0.12;
      _hip.applyMatrix4(_mb);
      _knee.applyMatrix4(_mb);
      _foot.applyMatrix4(_mb);
      this.segment(i * LEGS * 2 + k * 2, _hip, _knee, 0.07);
      this.segment(i * LEGS * 2 + k * 2 + 1, _knee, _foot, 0.05);
    }
  }

  /** Leg instance i as a bar from a to b, `th` thick. */
  private segment(i: number, a: THREE.Vector3, b: THREE.Vector3, th: number) {
    _d.subVectors(b, a);
    const len = _d.length();
    if (len < 1e-4) return this.legs.setMatrixAt(i, ZERO);
    _q.setFromUnitVectors(Y, _d.divideScalar(len));
    _m.compose(_p.addVectors(a, b).multiplyScalar(0.5), _q, _s.set(th, len, th));
    this.legs.setMatrixAt(i, _m);
  }

  dispose() {
    for (const m of [this.bodies, this.glows, this.legs]) {
      this.scene.remove(m);
      m.geometry.dispose();
      m.dispose();
    }
  }
}
