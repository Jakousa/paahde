// Wind-blown sand, client-side and purely visual (see world/wind.ts for when and where sand moves).
//
// Two particle pools, each drawn as one instanced mesh whose quads are built in the vertex shader from
// per-instance position/velocity, so the CPU only writes two small arrays per frame:
//   - Saltating grains around the player: short motion-blurred streaks that hop along the ground in
//     ballistic arcs (gravity + drag towards the log-law wind at their height), bouncing a few times.
//     Their emission follows the wind's streamers, so near the threshold sand snakes across the dunes
//     and in strong wind the whole surface flows ankle-deep.
//   - Crest plumes: soft puffs blown off dune brinks in strong gusts, drifting over and sinking into
//     the sheltered slip face. Brinks are found by random probing and kept as emitters.
// Grains glow when backlit by the low sun (forward scattering), so they catch the bloom.
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { cameraPosition, cross, dot, float, instancedBufferAttribute, length, max, mix, normalize, pow, saturate, smoothstep, uv, vec3 } from 'three/tsl';
import { edits, heightAt, normalAt } from '../shared/terrain.ts';
import { hazeDensity, sunColor, sunDirection } from './world/env.ts';
import { uAt, USTAR_T, ustarFrom10, wind, type WindSample } from './world/wind.ts';

const G = 9.81;

// Saltation
const GRAINS = 20000;
const RADIUS = 28; // grains spawn within this distance of the player (m)
const SPAWN_DENSITY = 6; // grains per m² per second at full emission (each streak stands for many real grains)
const DRAG_TAU = 0.35; // s, how fast a grain picks up the wind speed
const REBOUND = 0.85; // chance a landing grain bounces on instead of settling
const GROUND_CELLS = 8192; // cached 1 m ground cells (the spawn disc covers ~2500)
const SHUTTER = 0.05; // s of motion blur for the streaks
const GRAIN_WIDTH = 0.02; // m

// Crest plumes
const PUFFS = 1500;
const EMITTERS = 250;
const PLUME_RADIUS = 160; // search and keep brink emitters within this distance (m)
const PROBES = 30; // random brink probes per frame
const SETTLE = 0.35; // m/s, fall speed of the fine sand in a plume

type Pool = {
  n: number;
  pos: Float32Array; // x, y, z, opacity
  vel: Float32Array; // vx, vy, vz, size
  light: Float32Array; // direct sunlight on the ground below, 0–1
  posAttr: THREE.InstancedBufferAttribute;
  velAttr: THREE.InstancedBufferAttribute;
  lightAttr: THREE.InstancedBufferAttribute;
  geo: THREE.InstancedBufferGeometry;
};

function makePool(max: number): Pool {
  const pos = new Float32Array(max * 4);
  const vel = new Float32Array(max * 4);
  const posAttr = new THREE.InstancedBufferAttribute(pos, 4).setUsage(THREE.DynamicDrawUsage);
  const velAttr = new THREE.InstancedBufferAttribute(vel, 4).setUsage(THREE.DynamicDrawUsage);
  const light = new Float32Array(max).fill(1);
  const lightAttr = new THREE.InstancedBufferAttribute(light, 1).setUsage(THREE.DynamicDrawUsage);
  const geo = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1) as unknown as THREE.InstancedBufferGeometry);
  geo.instanceCount = 0;
  return { n: 0, pos, vel, light, posAttr, velAttr, lightAttr, geo };
}

/** Per-instance vec4 (the typings don't infer the swizzles). */
const vec4Attr = (a: THREE.InstancedBufferAttribute) => instancedBufferAttribute(a, 'vec4') as unknown as Node<'vec4'>;

const floatAttr = (a: THREE.InstancedBufferAttribute) => instancedBufferAttribute(a, 'float') as unknown as Node<'float'>;

/** Sunlit sand colour seen along the view ray: bright orange, HDR when backlit by the low sun. */
function grainColor(center: Node<'vec3'>, light: Node<'float'>, albedo: [number, number, number], forward: number) {
  const mu = dot(normalize(center.sub(cameraPosition)), sunDirection);
  const phase = pow(saturate(mu), 8).mul(forward).add(0.45);
  return vec3(...albedo).mul(sunColor).mul(phase).mul(light).add(vec3(0.12, 0.05, 0.025));
}

export class BlownSand {
  private grains = makePool(GRAINS);
  private puffs = makePool(PUFFS);
  // Per-grain simulation state beyond pos/vel: [ground y0, slope x, slope z, origin x, origin z, u*, age, life]
  private gs = new Float32Array(GRAINS * 8);
  // Per-puff: [start y, u*, age, life, size0]
  private ps = new Float32Array(PUFFS * 5);
  private emitters: { x: number; y: number; z: number; key: number }[] = [];
  private emitterKeys = new Set<number>();
  private sample: WindSample = { dx: 0, dz: 0, ustar: 0, q: 0, emit: 0 };
  private n = { x: 0, y: 1, z: 0 };
  private baseHaze = hazeDensity.value;
  private groundSlots = new Map<number, number>();
  private groundCache = new Float32Array(GROUND_CELLS * 4);

  constructor(scene: THREE.Scene) {
    scene.add(this.grainMesh(), this.puffMesh());
    // Digging changes the ground: forget the cached cells (edits are rare next to grain hops).
    const prev = edits.onChange;
    edits.onChange = (cx, cz) => {
      prev?.(cx, cz);
      this.groundSlots.clear();
    };
  }

  private grainMesh() {
    const p = vec4Attr(this.grains.posAttr);
    const v = vec4Attr(this.grains.velAttr);
    const center = p.xyz;
    const speed = max(length(v.xyz), 1e-3);
    const dir = v.xyz.div(speed);
    const toCam = normalize(cameraPosition.sub(center));
    const side = normalize(cross(dir, toCam).add(vec3(0, 1e-4, 0)));
    // Never thinner than ~1.5 px so far grains shimmer instead of aliasing; fade them to keep energy.
    const width = max(v.w, length(cameraPosition.sub(center)).mul(0.0015));
    const len = speed.mul(SHUTTER).add(width);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    mat.positionNode = center.add(dir.mul(uv().x.sub(0.5).mul(len))).add(side.mul(uv().y.sub(0.5).mul(width)));
    const along = uv().x.mul(2).sub(1), across = uv().y.mul(2).sub(1);
    const shape = saturate(float(1).sub(along.mul(along))).mul(saturate(float(1).sub(across.mul(across))));
    mat.opacityNode = p.w.mul(v.w.div(width)).mul(shape);
    mat.colorNode = grainColor(center, floatAttr(this.grains.lightAttr), [1.0, 0.7, 0.42], 4);
    const mesh = new THREE.Mesh(this.grains.geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    return mesh;
  }

  private puffMesh() {
    const p = vec4Attr(this.puffs.posAttr);
    const v = vec4Attr(this.puffs.velAttr);
    const center = p.xyz;
    const toCam = normalize(cameraPosition.sub(center));
    const side = normalize(cross(vec3(0, 1, 0), toCam));
    const up = cross(toCam, side);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    mat.positionNode = center.add(side.mul(uv().x.sub(0.5)).add(up.mul(uv().y.sub(0.5))).mul(v.w));
    const r = length(uv().sub(0.5)).mul(2);
    mat.opacityNode = p.w.mul(pow(saturate(float(1).sub(smoothstep(0.1, 1, r))), 1.5));
    // Fine dust is paler than the dune surface and scatters forward even more strongly.
    mat.colorNode = mix(grainColor(center, float(1), [0.85, 0.55, 0.3], 6), vec3(0.9, 0.5, 0.25), 0.15);
    const mesh = new THREE.Mesh(this.puffs.geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    return mesh;
  }

  /** Per render frame. `focus` is the local player's feet. */
  update(dt: number, focus: { x: number; y: number; z: number }) {
    if (dt <= 0) return;
    // Airborne dust thickens the haze in strong wind.
    const storm = wind.storm;
    hazeDensity.value = this.baseHaze * (1 + 1.5 * storm * storm);

    // Saltation is only possible somewhere if the strongest gust on the most exposed crest can do it.
    if (ustarFrom10(wind.u10 * 1.25 * 1.6) > USTAR_T) this.spawnGrains(dt, focus);
    this.stepGrains(dt, focus);
    this.findBrinks(focus);
    this.spawnPuffs(dt, focus);
    this.stepPuffs(dt);
  }

  private spawnGrains(dt: number, focus: { x: number; z: number }) {
    const g = this.grains, s = this.gs;
    const expected = Math.PI * RADIUS * RADIUS * SPAWN_DENSITY * dt;
    const tries = Math.floor(expected + Math.random());
    for (let k = 0; k < tries && g.n < GRAINS; k++) {
      const a = Math.random() * Math.PI * 2, r = RADIUS * Math.sqrt(Math.random());
      const x = focus.x + Math.cos(a) * r, z = focus.z + Math.sin(a) * r;
      const w = wind.sample(x, z, this.sample);
      if (Math.random() >= w.emit) continue;
      const i = g.n++;
      this.setGround(i, x, z);
      const vy = 0.8 + Math.random() * 1.6; // hops of 3–30 cm
      const vh = 0.3 * uAt(w.ustar, 0.05);
      g.pos.set([x, s[i * 8] + 0.01, z, 0], i * 4);
      g.vel.set([w.dx * vh, vy, w.dz * vh, GRAIN_WIDTH], i * 4);
      s[i * 8 + 5] = w.ustar;
      s[i * 8 + 6] = 0;
      s[i * 8 + 7] = 1 + Math.random() * 2;
    }
  }

  /** Store the local ground plane under grain i (height and slope), so hops need no height lookups. */
  private setGround(i: number, x: number, z: number) {
    const s = this.gs, o = i * 8, c = this.groundCell(x, z) * 4;
    const gc = this.groundCache;
    s[o] = gc[c];
    s[o + 1] = gc[c + 1];
    s[o + 2] = gc[c + 2];
    s[o + 3] = Math.floor(x) + 0.5;
    s[o + 4] = Math.floor(z) + 0.5;
    this.grains.light[i] = gc[c + 3];
  }

  /**
   * Slot in groundCache of the 1 m cell around (x, z): [height, slope x, slope z, sunlight] at its centre.
   * Sunlight uses the sand shader's terminator and a short march towards the sun for dune shadows,
   * so grains go dark over shaded slopes and in the shadow behind crests.
   */
  private groundCell(x: number, z: number): number {
    const ix = Math.floor(x), iz = Math.floor(z);
    const key = ix * 65536 + iz;
    let slot = this.groundSlots.get(key);
    if (slot !== undefined) return slot;
    if (this.groundSlots.size >= GROUND_CELLS) this.groundSlots.clear();
    slot = this.groundSlots.size;
    this.groundSlots.set(key, slot);
    const cx = ix + 0.5, cz = iz + 0.5, c = slot * 4, gc = this.groundCache;
    const n = normalAt(cx, cz, this.n), sun = sunDirection.value;
    const h = heightAt(cx, cz);
    let light = Math.min(1, Math.max(0, (n.x * sun.x + n.y * sun.y + n.z * sun.z) * 1.6));
    const flat = Math.hypot(sun.x, sun.z), rise = sun.y / Math.max(flat, 1e-3);
    for (let d = 3; d < 100 && light > 0; d *= 2) {
      if (heightAt(cx + (sun.x / flat) * d, cz + (sun.z / flat) * d) > h + d * rise) light = 0;
    }
    gc[c] = h;
    gc[c + 1] = -n.x / n.y;
    gc[c + 2] = -n.z / n.y;
    gc[c + 3] = light;
    return slot;
  }

  private stepGrains(dt: number, focus: { x: number; z: number }) {
    const g = this.grains, s = this.gs, dx = wind.dx, dz = wind.dz;
    const fx = focus.x, fz = focus.z;
    for (let i = 0; i < g.n; i++) {
      const o = i * 8, p = i * 4;
      const age = (s[o + 6] += dt), life = s[o + 7];
      if (age >= life) {
        this.kill(g, s, 8, i--);
        continue;
      }
      let x = g.pos[p], y = g.pos[p + 1], z = g.pos[p + 2];
      let vx = g.vel[p], vy = g.vel[p + 1], vz = g.vel[p + 2];
      const uw = uAt(s[o + 5], Math.max(y - (s[o] + s[o + 1] * (x - s[o + 3]) + s[o + 2] * (z - s[o + 4])), 0.005));
      vx += ((uw * dx - vx) / DRAG_TAU) * dt;
      vz += ((uw * dz - vz) / DRAG_TAU) * dt;
      vy += (-G - vy * 0.5) * dt;
      x += vx * dt;
      y += vy * dt;
      z += vz * dt;
      if (vy < 0 && y < s[o] + s[o + 1] * (x - s[o + 3]) + s[o + 2] * (z - s[o + 4])) {
        if (Math.random() > REBOUND || life - age < 0.2) {
          this.kill(g, s, 8, i--);
          continue;
        }
        // Rebound (and splash): part of the momentum goes back up, the grain re-lands on new ground.
        this.setGround(i, x, z);
        y = s[o] + 0.005;
        vy = Math.max(0.6, -vy * 0.6 + Math.random() * 0.6);
        vx *= 0.7;
        vz *= 0.7;
      }
      // Fade out towards the edge of the spawn disc so the carpet has no visible border.
      const d = Math.hypot(x - fx, z - fz);
      const edge = 1 - Math.min(1, Math.max(0, (d - RADIUS * 0.6) / (RADIUS * 0.4)));
      g.pos[p] = x;
      g.pos[p + 1] = y;
      g.pos[p + 2] = z;
      g.pos[p + 3] = 0.5 * edge * Math.min(1, age / 0.1, (life - age) / 0.25);
      g.vel[p] = vx;
      g.vel[p + 1] = vy;
      g.vel[p + 2] = vz;
    }
    this.upload(g);
  }

  /** Probe random spots for dune brinks (a sharp drop just downwind of rising ground) to emit plumes from. */
  private findBrinks(focus: { x: number; z: number }) {
    for (let k = this.emitters.length - 1; k >= 0; k--) {
      const e = this.emitters[k];
      if (Math.hypot(e.x - focus.x, e.z - focus.z) > PLUME_RADIUS * 1.1) {
        this.emitterKeys.delete(e.key);
        this.emitters.splice(k, 1);
      }
    }
    if (wind.storm < 0.1) return;
    const wx = wind.dx, wz = wind.dz;
    for (let k = 0; k < PROBES && this.emitters.length < EMITTERS; k++) {
      const a = Math.random() * Math.PI * 2, r = PLUME_RADIUS * Math.sqrt(Math.random());
      const x = focus.x + Math.cos(a) * r, z = focus.z + Math.sin(a) * r;
      const key = Math.floor(x / 3) * 65536 + Math.floor(z / 3);
      if (this.emitterKeys.has(key)) continue;
      const h = heightAt(x, z);
      if (h - heightAt(x + 4 * wx, z + 4 * wz) < 1.8 || h - heightAt(x - 4 * wx, z - 4 * wz) < 0.2) continue;
      this.emitters.push({ x, y: h, z, key });
      this.emitterKeys.add(key);
    }
  }

  private spawnPuffs(dt: number, focus: { x: number; z: number }) {
    const g = this.puffs, s = this.ps, wx = wind.dx, wz = wind.dz;
    for (const e of this.emitters) {
      // Wind just upwind of the brink, on the exposed windward slope.
      const w = wind.sample(e.x - 3 * wx, e.z - 3 * wz, this.sample);
      const rate = Math.min(4, 2 * (w.q - 0.8)); // puffs per second
      if (rate <= 0 || Math.random() >= rate * dt) continue;
      if (g.n >= PUFFS) break;
      const i = g.n++;
      const along = (Math.random() - 0.5) * 3; // spread along the crest
      const far = Math.hypot(e.x - focus.x, e.z - focus.z) / PLUME_RADIUS;
      const u = uAt(w.ustar, 1) * 0.7;
      g.pos.set([e.x - wz * along, e.y + 0.15, e.z + wx * along, 0], i * 4);
      g.vel.set([wx * u, 0.2 + Math.random() * 0.8, wz * u, 0], i * 4);
      s[i * 5] = e.y;
      s[i * 5 + 1] = w.ustar;
      s[i * 5 + 2] = 0;
      s[i * 5 + 3] = 2 + Math.random() * 2;
      s[i * 5 + 4] = (0.5 + Math.random() * 0.5) * (1 + far); // bigger far away so plumes stay readable
    }
  }

  private stepPuffs(dt: number) {
    const g = this.puffs, s = this.ps, dx = wind.dx, dz = wind.dz;
    for (let i = 0; i < g.n; i++) {
      const o = i * 5, p = i * 4;
      const age = (s[o + 2] += dt), life = s[o + 3];
      if (age >= life) {
        this.kill(g, s, 5, i--);
        continue;
      }
      const uw = uAt(s[o + 1], Math.max(0.3, g.pos[p + 1] - s[o] + 0.3)) * 0.8;
      const tau = 0.8;
      g.vel[p] += ((uw * dx - g.vel[p]) / tau + (Math.random() - 0.5) * 3) * dt;
      g.vel[p + 1] += ((-SETTLE - g.vel[p + 1]) / 1.5 + (Math.random() - 0.5) * 2) * dt;
      g.vel[p + 2] += ((uw * dz - g.vel[p + 2]) / tau + (Math.random() - 0.5) * 3) * dt;
      g.pos[p] += g.vel[p] * dt;
      g.pos[p + 1] += g.vel[p + 1] * dt;
      g.pos[p + 2] += g.vel[p + 2] * dt;
      const t = age / life;
      g.pos[p + 3] = 0.16 * Math.min(1, age / 0.3) * (1 - t) * (1 - t);
      g.vel[p + 3] = s[o + 4] * (1 + age * 1.2); // plumes spread as they go
    }
    this.upload(g);
  }

  /** Remove particle i by moving the last live one into its slot. */
  private kill(g: Pool, state: Float32Array, stride: number, i: number) {
    const last = --g.n;
    if (i === last) return;
    g.pos.copyWithin(i * 4, last * 4, last * 4 + 4);
    g.vel.copyWithin(i * 4, last * 4, last * 4 + 4);
    g.light[i] = g.light[last];
    state.copyWithin(i * stride, last * stride, last * stride + stride);
  }

  private upload(g: Pool) {
    g.geo.instanceCount = g.n;
    g.posAttr.needsUpdate = true;
    g.velAttr.needsUpdate = true;
    g.lightAttr.needsUpdate = true;
  }
}
