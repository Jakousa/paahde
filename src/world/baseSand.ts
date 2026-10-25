// Sand getting into the base while a sandstorm blows over it (src/storm.ts: `outside`): a thin, wavering
// curtain of grains sifting down the skylight shaft onto the floor around the pump, and gusts of grit
// blown in through the entrance hut's door, skidding down onto the landing and the top of the stairs.
// Purely visual; the grains are motion-blurred streaks like blownSand.ts's, built in the vertex shader
// from per-instance position and velocity.
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { cameraPosition, cross, float, instancedBufferAttribute, length, max, normalize, saturate, uv, vec3 } from 'three/tsl';
import { FLOOR, HUT, ROOM_Z, SKY, stairY } from '../../shared/base.ts';
import { ORIGIN } from '../../shared/origin.ts';
import { hazeColor, nightLevel, sunColor } from './env.ts';
import { wind } from './wind.ts';

const MAX = 1500;
/** Grains a second at full storm: down the skylight, in at the door. */
const SKY_RATE = 520;
const DOOR_RATE = 260;
/** Falling grains' terminal speed (m/s) and the motion blur (s). */
const FALL = 3.2;
const SHUTTER = 0.035;
const WIDTH = 0.007;

const vec4Attr = (a: THREE.InstancedBufferAttribute) => instancedBufferAttribute(a, 'vec4') as unknown as Node<'vec4'>;

export class BaseSand {
  private pos = new Float32Array(MAX * 4); // x, y, z, opacity
  private vel = new Float32Array(MAX * 4); // vx, vy, vz, width
  private floor = new Float32Array(MAX); // world y where the grain lands
  private life = new Float32Array(MAX); // s left
  private posAttr = new THREE.InstancedBufferAttribute(this.pos, 4).setUsage(THREE.DynamicDrawUsage);
  private velAttr = new THREE.InstancedBufferAttribute(this.vel, 4).setUsage(THREE.DynamicDrawUsage);
  private geo = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1) as unknown as THREE.InstancedBufferGeometry);
  private mesh: THREE.Mesh;
  private n = 0;
  private owed = { sky: 0, door: 0 };
  private t = 0;

  constructor(scene: THREE.Scene) {
    this.geo.instanceCount = 0;
    const p = vec4Attr(this.posAttr), v = vec4Attr(this.velAttr);
    const center = p.xyz;
    const speed = max(length(v.xyz), 1e-3);
    const dir = v.xyz.div(speed);
    const side = normalize(cross(dir, normalize(cameraPosition.sub(center))).add(vec3(0, 1e-4, 0)));
    const width = max(v.w, length(cameraPosition.sub(center)).mul(0.0015));
    const len = speed.mul(SHUTTER).add(width);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    mat.positionNode = center.add(dir.mul(uv().x.sub(0.5).mul(len))).add(side.mul(uv().y.sub(0.5).mul(width)));
    const along = uv().x.mul(2).sub(1), across = uv().y.mul(2).sub(1);
    const shape = saturate(float(1).sub(along.mul(along))).mul(saturate(float(1).sub(across.mul(across))));
    mat.opacityNode = p.w.mul(v.w.div(width)).mul(shape);
    // Dust-lit sand: the storm has dimmed the sun, and down here it's mostly the light from the shaft.
    const sun = sunColor as unknown as Node<'vec3'>, haze = hazeColor as unknown as Node<'vec3'>;
    mat.colorNode = vec3(0.9, 0.62, 0.38).mul(sun.mul(0.16).add(haze.mul(0.25))).mul(float(1).sub(nightLevel.mul(0.8)));
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** Per render frame: `storm` is the storm strength over the base (eased, 0..1). */
  update(dt: number, storm: number) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    const k = Math.max(0, (storm - 0.05) / 0.95);
    // Gusty: the shaft pours in surges, the door in bursts.
    const surge = 0.55 + 0.45 * Math.sin(this.t * 0.9) * Math.sin(this.t * 0.37 + 1.3);
    const burst = Math.max(0, Math.sin(this.t * 1.7) * Math.sin(this.t * 0.61 + 2.1) + 0.3);
    this.owed.sky += SKY_RATE * k * surge * dt;
    this.owed.door += DOOR_RATE * k * burst * dt;
    while (this.owed.sky >= 1) {
      this.owed.sky--;
      this.spawnSky();
    }
    while (this.owed.door >= 1) {
      this.owed.door--;
      this.spawnDoor();
    }

    const pos = this.pos, vel = this.vel;
    for (let i = 0; i < this.n; i++) {
      const o = i * 4;
      this.life[i] -= dt;
      // Drag towards a slow fall (and the draught's push dying out), plus gravity.
      const drag = Math.min(1, dt * 2.5);
      vel[o] -= vel[o] * drag;
      vel[o + 2] -= vel[o + 2] * drag;
      vel[o + 1] += (-FALL - vel[o + 1]) * drag;
      pos[o] += vel[o] * dt;
      pos[o + 1] += vel[o + 1] * dt;
      pos[o + 2] += vel[o + 2] * dt;
      if (pos[o + 1] < this.floor[i] || this.life[i] <= 0) {
        this.kill(i--);
        continue;
      }
      pos[o + 3] = Math.min(1, this.life[i] * 3) * 0.35;
    }
    this.geo.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n) {
      this.posAttr.needsUpdate = true;
      this.velAttr.needsUpdate = true;
    }
  }

  private add(x: number, y: number, z: number, vx: number, vy: number, vz: number, floor: number, life: number) {
    if (this.n >= MAX) return;
    const i = this.n++, o = i * 4;
    this.pos[o] = x;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z;
    this.pos[o + 3] = 0;
    this.vel[o] = vx;
    this.vel[o + 1] = vy;
    this.vel[o + 2] = vz;
    this.vel[o + 3] = WIDTH * (0.6 + Math.random() * 0.8);
    this.floor[i] = floor;
    this.life[i] = life;
  }

  private kill(i: number) {
    const last = --this.n;
    if (i === last) return;
    this.pos.copyWithin(i * 4, last * 4, last * 4 + 4);
    this.vel.copyWithin(i * 4, last * 4, last * 4 + 4);
    this.floor[i] = this.floor[last];
    this.life[i] = this.life[last];
  }

  /** Over the lip of the skylight, mostly on its upwind side, carried a little downwind as it falls. */
  private spawnSky() {
    const r = Math.random;
    const up = -0.4 - 0.6 * r(); // upwind half of the opening, where the wind spills over the collar
    const across = (r() * 2 - 1) * SKY.w;
    const dx = wind.dx, dz = wind.dz;
    const lx = Math.max(-SKY.w, Math.min(SKY.w, dx * up * SKY.w - dz * across));
    const lz = Math.max(-SKY.w, Math.min(SKY.w, dz * up * SKY.w + dx * across));
    const push = 1.2 + 1.5 * r();
    this.add(ORIGIN.x + lx, ORIGIN.y + SKY.h * r(), ORIGIN.z + ROOM_Z + lz, dx * push, -1 - r(), dz * push,
      ORIGIN.y + FLOOR, 6);
  }

  /** In at the hut's door, low, skidding inwards and down onto the landing and the first stairs. */
  private spawnDoor() {
    const r = Math.random;
    const lx = (r() * 2 - 1) * HUT.door;
    const ly = 0.05 + 1.6 * r() * r();
    const lz = HUT.z1 - 0.05;
    const inward = 2.5 + 3.5 * r();
    const stop = HUT.z1 - 0.5 - inward * 0.6 * r();
    this.add(ORIGIN.x + lx, ORIGIN.y + ly, ORIGIN.z + lz, (r() * 2 - 1) * 0.6, 0.3 * r(), -inward,
      ORIGIN.y + stairY(stop), 2.5);
  }
}
