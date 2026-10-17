// Sandstorm dust, driven by the wind (wind.ts): big soft clouds of lifted sand rolling downwind while a
// storm blows (or the odd one in a strong gust), as instanced sprites that follow the heightfield.
// Also feeds the wind to the shaders (env.ts: direction, strength, storm, drift) for the dusty haze,
// sky and sand. Grains and streamers are blownSand.ts. Purely visual.
import * as THREE from 'three/webgpu';
import { float, instancedBufferAttribute, length, mx_noise_float, smoothstep, uv, vec2, vec3 } from 'three/tsl';
import { heightAt } from '../../shared/terrain.ts';
import type { Node } from 'three/webgpu';
import { hazeColor, sandStorm, sunColor, windDir, windDrift, windStrength } from './env.ts';
import { wind } from './wind.ts';

/** 10 m wind speed that counts as full strength (wind.ts peaks at 18). */
const FULL_WIND = 18;
const PUFFS = 40;
const PUFF_RANGE = 70;

const rand = Math.random;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Colour uniforms are vec3 in the shader; the typings just don't mix them with vec3 math. */
const c3 = (u: unknown) => u as Node<'vec3'>;

/** Lit colour of airborne sand: a share of the sun on the sand albedo plus some haze. */
const dustLight = (amount: number) =>
  c3(sunColor).mul(vec3(0.55, 0.32, 0.17)).mul(amount).add(c3(hazeColor).mul(0.35));

export class Dust {
  private puffs: THREE.Sprite;
  private puffPos = new Float32Array(PUFFS * 3);
  private puffData = new Float32Array(PUFFS * 2); // alpha, size
  private puffPosAttr = new THREE.InstancedBufferAttribute(this.puffPos, 3);
  private puffDataAttr = new THREE.InstancedBufferAttribute(this.puffData, 2);
  private px = new Float32Array(PUFFS);
  private pz = new Float32Array(PUFFS);
  private pAge = new Float32Array(PUFFS);
  private pLife = new Float32Array(PUFFS);
  private pSize = new Float32Array(PUFFS);
  private pThreshold = new Float32Array(PUFFS);

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < PUFFS; i++) this.respawnPuff(i, 0, 0, true);
    const pm = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    pm.positionNode = instancedBufferAttribute(this.puffPosAttr);
    const data = instancedBufferAttribute(this.puffDataAttr, 'vec2') as unknown as Node<'vec2'>;
    pm.colorNode = dustLight(0.25);
    // Soft, lumpy disc: radial falloff broken up by noise (per puff, via its size as a seed).
    const c = uv().sub(0.5);
    const lump = mx_noise_float(vec3(c.mul(3.2), data.y)).mul(0.45).add(0.75);
    const soft = float(1).sub(smoothstep(0.0, 0.5, length(c)));
    pm.opacityNode = soft.mul(soft).mul(lump).mul(data.x);
    pm.scaleNode = vec2(data.y, data.y.mul(0.55));
    this.puffs = new THREE.Sprite(pm);
    this.puffs.count = PUFFS;
    this.puffs.frustumCulled = false;

    scene.add(this.puffs);
  }

  private respawnPuff(i: number, cx: number, cz: number, anywhere = false) {
    const d = windDir.value;
    // New puffs start upwind (or anywhere at startup) so they roll through the view.
    const along = anywhere ? (rand() * 2 - 1) * PUFF_RANGE : -PUFF_RANGE * (0.4 + rand() * 0.6);
    const across = (rand() * 2 - 1) * PUFF_RANGE;
    this.px[i] = cx + d.x * along - d.y * across;
    this.pz[i] = cz + d.y * along + d.x * across;
    this.pAge[i] = anywhere ? rand() : 0;
    this.pLife[i] = 6 + rand() * 10;
    this.pSize[i] = 10 + rand() * rand() * 22;
    this.pThreshold[i] = rand();
  }

  /** Called every render frame (after wind.update) with the camera position. */
  update(dt: number, cam: THREE.Vector3) {
    const d = windDir.value.set(wind.dx, wind.dz);
    const strength = (windStrength.value = Math.min(1, wind.u10 / FULL_WIND));
    const storm = (sandStorm.value = wind.storm);
    // Dust travels with the wind a few metres up (the same speed wind.ts moves its gusts at).
    const speed = 0.6 * wind.u10;
    windDrift.value.addScaledVector(d, speed * dt);

    // Puffs: mostly a storm thing, plus the odd one when a strong gust lifts sand.
    const raise = Math.min(1, storm + 0.35 * smooth(0.7, 1, strength));
    this.puffs.visible = raise > 0.01;
    if (this.puffs.visible) {
      for (let i = 0; i < PUFFS; i++) {
        this.pAge[i] += dt / this.pLife[i];
        this.px[i] += d.x * speed * dt;
        this.pz[i] += d.y * speed * dt;
        const far = Math.hypot(this.px[i] - cam.x, this.pz[i] - cam.z) > PUFF_RANGE * 1.2;
        if (this.pAge[i] >= 1 || far) this.respawnPuff(i, cam.x, cam.z);
        const size = this.pSize[i] * (0.6 + 0.6 * this.pAge[i]); // grows as it rolls along
        this.puffPos[i * 3] = this.px[i];
        this.puffPos[i * 3 + 1] = heightAt(this.px[i], this.pz[i]) + size * 0.3;
        this.puffPos[i * 3 + 2] = this.pz[i];
        const env = Math.sin(Math.PI * Math.min(1, this.pAge[i]));
        this.puffData[i * 2] = this.pThreshold[i] < raise ? 0.16 * env : 0;
        this.puffData[i * 2 + 1] = size;
      }
      this.puffPosAttr.needsUpdate = true;
      this.puffDataAttr.needsUpdate = true;
    }
  }
}
