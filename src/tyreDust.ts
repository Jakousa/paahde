// Sand thrown up by the sand bike's tyres: soft puffs off the back wheel that grow, drift downwind and fade.
// More with speed and when the back steps out sideways, plus a burst on landing (Bike.update emits them).
// One instanced sprite pool shared by every bike; purely visual. Lit like the storm dust (world/dust.ts).
import * as THREE from 'three/webgpu';
import { float, instancedBufferAttribute, length, mx_noise_float, smoothstep, uv, vec2, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { dustLight } from './world/dust.ts';
import { uAt, ustarFrom10, wind } from './world/wind.ts';

const MAX = 512;
const DRAG = 2.2; // per second: thrown sand slows quickly and is then carried by the wind
const RISE = 0.9; // m/s the warm, light dust keeps slowly lifting

class TyreDust {
  readonly mesh: THREE.Sprite;
  private pos = new Float32Array(MAX * 3);
  private data = new Float32Array(MAX * 2); // alpha, size
  private posAttr = new THREE.InstancedBufferAttribute(this.pos, 3);
  private dataAttr = new THREE.InstancedBufferAttribute(this.data, 2);
  private vel = new Float32Array(MAX * 3);
  private age = new Float32Array(MAX).fill(1);
  private life = new Float32Array(MAX).fill(1);
  private size = new Float32Array(MAX);
  private next = 0;
  private live = 0;

  constructor() {
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    m.positionNode = instancedBufferAttribute(this.posAttr);
    const d = instancedBufferAttribute(this.dataAttr, 'vec2') as unknown as Node<'vec2'>;
    m.colorNode = dustLight(0.8);
    // Soft, lumpy disc, as the storm puffs; seeded by the size, so it churns as it grows.
    const c = uv().sub(0.5);
    const lump = mx_noise_float(vec3(c.mul(3), d.y.mul(1.7))).mul(0.4).add(0.75);
    const soft = float(1).sub(smoothstep(0.0, 0.5, length(c)));
    m.opacityNode = soft.mul(soft).mul(lump).mul(d.x);
    m.scaleNode = vec2(d.y, d.y.mul(0.8));
    this.mesh = new THREE.Sprite(m);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  /** One puff at (x, y, z) thrown with velocity (vx, vy, vz), `size` metres across to start with. */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number) {
    const i = this.next;
    this.next = (i + 1) % MAX;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.age[i] = 0;
    this.life[i] = 2.2 + Math.random() * 2.0;
    this.size[i] = size;
    this.live = Math.max(this.live, i + 1);
  }

  /** Per render frame: move, grow and fade the puffs. */
  update(dt: number) {
    if (this.live === 0) return;
    const carry = uAt(ustarFrom10(wind.u10), 1);
    const k = 1 - Math.exp(-DRAG * dt);
    let last = 0;
    for (let i = 0; i < this.live; i++) {
      const t = (this.age[i] += dt / this.life[i]);
      if (t >= 1) {
        this.data[i * 2] = 0;
        continue;
      }
      last = i + 1;
      const v = i * 3;
      this.vel[v] += (carry * wind.dx - this.vel[v]) * k;
      this.vel[v + 1] += (RISE - this.vel[v + 1]) * k;
      this.vel[v + 2] += (carry * wind.dz - this.vel[v + 2]) * k;
      this.pos[v] += this.vel[v] * dt;
      this.pos[v + 1] += this.vel[v + 1] * dt;
      this.pos[v + 2] += this.vel[v + 2] * dt;
      // Quick to appear, slow to thin out, billowing out to several times its size.
      this.data[i * 2] = 0.6 * Math.min(1, t * 10) * (1 - t) * Math.sqrt(1 - t);
      this.data[i * 2 + 1] = this.size[i] * (1 + 6 * Math.sqrt(t));
    }
    this.live = last;
    this.mesh.count = last;
    this.posAttr.needsUpdate = true;
    this.dataAttr.needsUpdate = true;
  }
}

export const tyreDust = new TyreDust();
