// What a laser rifle shot looks like (shared/rifle.ts, src/rifle.ts): the beam from the muzzle to where it stopped,
// a flash of light at the muzzle, sparks where it struck, the red glass of a shot-out weak point flying, and the
// smoke that keeps pouring out of broken weak points and dead walkers (src/world/guardians.ts). Purely visual.
//
// Pools, one draw call each: sparks and smoke are instanced sprites (like src/tyreDust.ts), the glass is an
// instanced mesh. Beams are few and short-lived (a mesh each).
import * as THREE from 'three/webgpu';
import { abs, dot, float, instancedBufferAttribute, length, min, mx_noise_float, normalView, positionGeometry, positionViewDirection, pow, smoothstep, uniform, uv, vec2, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { heightAt } from '../../shared/terrain.ts';
import { hazeColor, sunColor } from './env.ts';
import { uAt, ustarFrom10, wind } from './wind.ts';

/**
 * The beam: a white-hot core in a cyan glow (HDR, bloom spreads it), gone in BEAM_S. Radii (m) grow from a thread at the
 * muzzle (the first-person gun is a few tens of cm from the eye: a full-width tube there fills the view) by SLOPE per
 * metre, to the full width that still reads at a hundred metres.
 */
const BEAM_S = 0.14;
const CORE_R = 0.012, GLOW_R = 0.07;
const CORE_R0 = 0.002, GLOW_R0 = 0.005;
const CORE_SLOPE = 0.01, GLOW_SLOPE = 0.03;
const CORE = new THREE.Color(5, 9, 10);
const GLOW = new THREE.Color(0.25, 1.4, 2.2);
/** The muzzle flash: a light thrown ahead of the gun (so it lights the sand, not just the hands) and a soft glow at the
 *  tip, about FLASH_ANGLE rad across as seen from the camera (capped at FLASH_MAX m). */
const FLASH_S = 0.07;
const FLASH_AHEAD = 0.6;
const FLASH_ANGLE = 0.1, FLASH_MAX = 0.3;
const SPARKS = 384, SHARDS = 128, SMOKE = 768;
const GRAVITY = 9.8;

const c3 = (u: unknown) => u as Node<'vec3'>;
const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2); // +Z, 0..1
const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _m = new THREE.Matrix4(), _e = new THREE.Euler();
const FWD = new THREE.Vector3(0, 0, 1);

type Beam = {
  group: THREE.Group; fade: { value: number }; len: { value: number }; age: number; mats: THREE.Material[];
  /** Where it ends, and (your own shot) where the drawn muzzle is now: the start follows the gun as it kicks. */
  end: THREE.Vector3; from?: (out: THREE.Vector3) => THREE.Vector3 | null; flash: boolean;
};

/** The tube along +Z from 0 to `len` m, `r0` m across at the start, widening by `slope` per metre up to `r`. */
function taper(len: Node<'float'>, r0: number, slope: number, r: number) {
  const d = positionGeometry.z.mul(len);
  return vec3(positionGeometry.xy.mul(min(float(r), d.mul(slope).add(r0))), d);
}

/** Instanced sprite pool: position, (alpha, size) per sprite. */
class SpritePool {
  readonly sprite: THREE.Sprite;
  pos: Float32Array;
  data: Float32Array;
  posAttr: THREE.InstancedBufferAttribute;
  dataAttr: THREE.InstancedBufferAttribute;
  vel: Float32Array;
  age: Float32Array;
  life: Float32Array;
  size: Float32Array;
  next = 0;
  live = 0;

  constructor(n: number, make: (m: THREE.SpriteNodeMaterial, data: Node<'vec2'>) => void, additive: boolean) {
    this.pos = new Float32Array(n * 3);
    this.data = new Float32Array(n * 2);
    this.posAttr = new THREE.InstancedBufferAttribute(this.pos, 3);
    this.dataAttr = new THREE.InstancedBufferAttribute(this.data, 2);
    this.vel = new Float32Array(n * 3);
    this.age = new Float32Array(n).fill(1);
    this.life = new Float32Array(n).fill(1);
    this.size = new Float32Array(n);
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    m.positionNode = instancedBufferAttribute(this.posAttr);
    make(m, instancedBufferAttribute(this.dataAttr, 'vec2') as unknown as Node<'vec2'>);
    this.sprite = new THREE.Sprite(m);
    this.sprite.count = 0;
    this.sprite.frustumCulled = false;
  }

  add(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number) {
    const i = this.next;
    this.next = (i + 1) % this.age.length;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.age[i] = 0;
    this.life[i] = life;
    this.size[i] = size;
    this.live = Math.max(this.live, i + 1);
  }

  /** Age everything; `step` moves sprite i (t = 0..1 of its life) and returns its (alpha, size). */
  update(dt: number, step: (i: number, t: number) => void) {
    if (this.live === 0) return;
    let last = 0;
    for (let i = 0; i < this.live; i++) {
      const t = (this.age[i] += dt / this.life[i]);
      if (t >= 1) {
        this.data[i * 2] = 0;
        continue;
      }
      last = i + 1;
      step(i, t);
    }
    this.live = last;
    this.sprite.count = last;
    this.posAttr.needsUpdate = true;
    this.dataAttr.needsUpdate = true;
  }
}

class Zaps {
  readonly root = new THREE.Group();
  private beams: Beam[] = [];
  private flash = new THREE.PointLight(0x7fe8ff, 0, 30, 2);
  private flashAge = 1;
  private flashGlow: THREE.Sprite;
  private flashFade = uniform(0);
  private flashAt = new THREE.Vector3();
  /** The glow is drawn: off when the shot starts where no gun is drawn (looking through the scope). */
  private flashDrawn = false;
  private camera: THREE.Camera | null = null;
  private sparks: SpritePool;
  private smoke: SpritePool;
  private shards: THREE.InstancedMesh;
  private shardPos = new Float32Array(SHARDS * 3);
  private shardVel = new Float32Array(SHARDS * 3);
  private shardRot = new Float32Array(SHARDS * 3);
  private shardSpin = new Float32Array(SHARDS * 3);
  private shardAge = new Float32Array(SHARDS).fill(1);
  private shardSize = new Float32Array(SHARDS);
  private shardNext = 0;

  constructor() {
    this.root.name = 'Zaps';
    this.root.add(this.flash);
    // Sparks: hot points, white-orange to dull red as they cool, stretched a little.
    this.sparks = new SpritePool(SPARKS, (m, d) => {
      const r = length(uv().sub(0.5)).mul(2);
      const heat = d.x;
      m.colorNode = vec3(3.2, 1.3, 0.35).mul(heat.mul(heat)).add(vec3(1.4, 0.25, 0.05).mul(heat));
      m.opacityNode = float(1).sub(smoothstep(0.2, 1, r));
      m.scaleNode = vec2(d.y, d.y);
    }, true);
    // Smoke: dark, oily, lit by the sun and the haze; lumpy and billowing as it rises.
    this.smoke = new SpritePool(SMOKE, (m, d) => {
      m.colorNode = c3(sunColor).mul(0.035).add(c3(hazeColor).mul(0.07));
      const c = uv().sub(0.5);
      const lump = mx_noise_float(vec3(c.mul(3), d.y.mul(2.3))).mul(0.45).add(0.7);
      const soft = float(1).sub(smoothstep(0.0, 0.5, length(c)));
      m.opacityNode = soft.mul(soft).mul(lump).mul(d.x);
      m.scaleNode = vec2(d.y, d.y.mul(0.85));
    }, false);
    this.smoke.sprite.renderOrder = 1;
    // Glass: little chips of the red lens, still glowing faintly as they fall.
    const shardMat = new THREE.MeshStandardNodeMaterial({ color: 0x5a0a06, roughness: 0.15, metalness: 0.1, emissive: 0xff2010, emissiveIntensity: 0.6 });
    this.shards = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(1), shardMat, SHARDS);
    this.shards.count = 0;
    this.shards.frustumCulled = false;
    this.root.add(this.sparks.sprite, this.smoke.sprite, this.shards);
    // The flash at the tip: a soft round glow, white in the middle (no polygon edge to it).
    const fm = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const fr = length(uv().sub(0.5)).mul(2);
    const soft = float(1).sub(smoothstep(0, 1, fr));
    fm.colorNode = vec3(GLOW.r, GLOW.g, GLOW.b).mul(soft.mul(soft)).add(vec3(CORE.r, CORE.g, CORE.b).mul(pow(soft, float(6)).mul(0.3)));
    fm.opacityNode = this.flashFade;
    this.flashGlow = new THREE.Sprite(fm);
    this.flashGlow.visible = false;
    this.flashGlow.frustumCulled = false;
    this.root.add(this.flashGlow);
  }

  /** The camera the flash glow is sized for (its size follows the distance, so it looks the same near and far). */
  setCamera(camera: THREE.Camera) {
    this.camera = camera;
  }

  /**
   * A shot from (ax, ay, az) to (bx, by, bz); `flash`: light the muzzle (your own or a nearby player's shot). `from`:
   * where the start is each frame while it lasts (your own drawn gun, kicking back), null to leave it.
   */
  beam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, flash = true, from?: (out: THREE.Vector3) => THREE.Vector3 | null) {
    const fade = uniform(1), len = uniform(1);
    const group = new THREE.Group();
    const core = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    core.positionNode = taper(len, CORE_R0, CORE_SLOPE, CORE_R);
    core.colorNode = vec3(CORE.r, CORE.g, CORE.b).mul(fade);
    const glow = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    glow.positionNode = taper(len, GLOW_R0, GLOW_SLOPE, GLOW_R);
    glow.colorNode = vec3(GLOW.r, GLOW.g, GLOW.b);
    glow.opacityNode = pow(abs(dot(normalView, positionViewDirection)), float(1.5)).mul(fade).mul(0.9);
    for (const m of [core, glow]) {
      const mesh = new THREE.Mesh(beamGeo, m);
      mesh.frustumCulled = false; // the shader sets its length
      group.add(mesh);
    }
    const b: Beam = { group, fade, len, age: 0, mats: [core, glow], end: new THREE.Vector3(bx, by, bz), from, flash };
    this.place(b, _v.set(ax, ay, az));
    this.root.add(group);
    this.beams.push(b);
    if (flash) {
      this.flashAge = 0;
      this.flashDrawn = !from || from(_s) !== null;
      for (const o of this.beams) o.flash = o === b;
    }
  }

  /** Start beam `b` at `a`, pointed at its end; its flash goes there too. */
  private place(b: Beam, a: THREE.Vector3) {
    const dir = _s.copy(b.end).sub(a);
    b.len.value = Math.max(1e-3, dir.length());
    dir.divideScalar(b.len.value);
    b.group.position.copy(a);
    b.group.quaternion.setFromUnitVectors(FWD, dir);
    if (!b.flash) return;
    this.flashAt.copy(a);
    this.flash.position.copy(a).addScaledVector(dir, Math.min(FLASH_AHEAD, b.len.value));
  }

  /** Sparks thrown from (x, y, z) off a surface facing (nx, ny, nz); `scale`: bigger for big things. */
  burst(x: number, y: number, z: number, nx: number, ny: number, nz: number, n: number, scale = 1) {
    for (let i = 0; i < n; i++) {
      const s = (2 + Math.random() * 7) * Math.sqrt(scale);
      const rx = Math.random() - 0.5, ry = Math.random() - 0.5, rz = Math.random() - 0.5;
      this.sparks.add(x, y, z, (nx + rx * 1.6) * s, (ny + ry * 1.6 + 0.4) * s, (nz + rz * 1.6) * s,
        (0.03 + Math.random() * 0.05) * Math.min(4, scale), 0.25 + Math.random() * 0.6);
    }
  }

  /** The red lens at (x, y, z), `r` m across, shattered outward along (nx, ny, nz). */
  shatter(x: number, y: number, z: number, nx: number, ny: number, nz: number, r: number) {
    const n = 14;
    for (let k = 0; k < n; k++) {
      const i = this.shardNext;
      this.shardNext = (i + 1) % SHARDS;
      const s = 2 + Math.random() * 4 * Math.sqrt(r);
      this.shardPos.set([x + (Math.random() - 0.5) * r, y + (Math.random() - 0.5) * r, z + (Math.random() - 0.5) * r], i * 3);
      this.shardVel.set([(nx + Math.random() - 0.5) * s, (ny + Math.random() * 0.8) * s, (nz + Math.random() - 0.5) * s], i * 3);
      this.shardRot.set([Math.random() * 6, Math.random() * 6, Math.random() * 6], i * 3);
      this.shardSpin.set([(Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20], i * 3);
      this.shardAge[i] = 0;
      this.shardSize[i] = r * (0.05 + Math.random() * 0.12);
    }
    this.burst(x, y, z, nx, ny, nz, 26, r * 2.5);
  }

  /** A puff of smoke at (x, y, z), `size` m across, rising at `rise` m/s. */
  puff(x: number, y: number, z: number, size: number, rise = 2.5) {
    this.smoke.add(x, y, z, (Math.random() - 0.5) * 0.4 * size, rise * (0.7 + Math.random() * 0.6), (Math.random() - 0.5) * 0.4 * size,
      size, 2.5 + Math.random() * 2.5 + size * 0.5);
  }

  /** After the camera and the first-person gun are placed for the frame (beams follow the drawn muzzle). */
  update(dt: number) {
    this.beams = this.beams.filter((b) => {
      b.age += dt;
      const t = b.age / BEAM_S;
      if (t >= 1) {
        b.group.removeFromParent();
        for (const m of b.mats) m.dispose();
        return false;
      }
      b.fade.value = (1 - t) * (1 - t);
      const a = b.from?.(_v);
      if (a) this.place(b, a);
      return true;
    });
    this.flashAge += dt;
    const f = this.flashAge < FLASH_S ? 1 - this.flashAge / FLASH_S : 0;
    this.flash.intensity = 60 * f;
    this.flashGlow.visible = f > 0 && this.flashDrawn;
    if (f > 0) {
      this.flashFade.value = f;
      const far = this.camera ? this.camera.getWorldPosition(_s).distanceTo(this.flashAt) : 1;
      this.flashGlow.position.copy(this.flashAt);
      this.flashGlow.scale.setScalar(Math.min(FLASH_MAX, far * FLASH_ANGLE));
    }
    const sp = this.sparks;
    sp.update(dt, (i, t) => {
      const v = i * 3;
      sp.vel[v + 1] -= GRAVITY * dt;
      const k = Math.exp(-dt * 1.5);
      sp.vel[v] *= k;
      sp.vel[v + 2] *= k;
      sp.pos[v] += sp.vel[v] * dt;
      sp.pos[v + 1] += sp.vel[v + 1] * dt;
      sp.pos[v + 2] += sp.vel[v + 2] * dt;
      const g = heightAt(sp.pos[v], sp.pos[v + 2]);
      if (sp.pos[v + 1] < g) {
        sp.pos[v + 1] = g;
        sp.vel[v + 1] *= -0.3;
        sp.vel[v] *= 0.5;
        sp.vel[v + 2] *= 0.5;
      }
      sp.data[i * 2] = 1 - t;
      sp.data[i * 2 + 1] = sp.size[i] * (1 - 0.5 * t);
    });
    const carry = uAt(ustarFrom10(wind.u10), 8);
    const sm = this.smoke;
    sm.update(dt, (i, t) => {
      const v = i * 3, k = 1 - Math.exp(-dt * 0.8);
      sm.vel[v] += (carry * wind.dx - sm.vel[v]) * k;
      sm.vel[v + 2] += (carry * wind.dz - sm.vel[v + 2]) * k;
      sm.vel[v + 1] *= Math.exp(-dt * 0.3);
      sm.pos[v] += sm.vel[v] * dt;
      sm.pos[v + 1] += sm.vel[v + 1] * dt;
      sm.pos[v + 2] += sm.vel[v + 2] * dt;
      sm.data[i * 2] = 0.95 * Math.min(1, t * 8) * (1 - t) * Math.sqrt(1 - t);
      sm.data[i * 2 + 1] = sm.size[i] * (1 + 4 * Math.sqrt(t));
    });
    let n = 0;
    for (let i = 0; i < SHARDS; i++) {
      if (this.shardAge[i] >= 1) continue;
      this.shardAge[i] += dt / 2.5;
      const v = i * 3;
      const p = this.shardPos, vel = this.shardVel, rot = this.shardRot;
      const g = heightAt(p[v], p[v + 2]);
      if (p[v + 1] > g + 0.01) {
        vel[v + 1] -= GRAVITY * dt;
        for (let a = 0; a < 3; a++) rot[v + a] += this.shardSpin[v + a] * dt;
      } else {
        // Landed: lies in the sand.
        vel[v] = vel[v + 1] = vel[v + 2] = 0;
        p[v + 1] = g + 0.005;
      }
      p[v] += vel[v] * dt;
      p[v + 1] = Math.max(g, p[v + 1] + vel[v + 1] * dt);
      p[v + 2] += vel[v + 2] * dt;
      const s = this.shardSize[i] * Math.min(1, (1 - this.shardAge[i]) * 4);
      _q.setFromEuler(_e.set(rot[v], rot[v + 1], rot[v + 2]));
      this.shards.setMatrixAt(n++, _m.compose(_v.set(p[v], p[v + 1], p[v + 2]), _q, _s.set(s, s * 0.4, s)));
    }
    this.shards.count = n;
    if (n) this.shards.instanceMatrix.needsUpdate = true;
  }
}

export const zaps = new Zaps();
