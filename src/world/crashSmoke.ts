// Smoke over smouldering crash sites (shared/crashsites.ts `smoke`): a thin, lazy column of dark
// brown-grey puffs rising 25–40 m from each smoke point and bending downwind, so players can spot a site
// on the horizon from several hundred metres. Purely visual.
//
// One instanced sprite (a single draw call) holds every puff of every column in view. The CPU only
// writes each puff's column base and seed when the set of sites changes; rising, drifting, growing and
// fading all happen in the vertex/fragment nodes from the shared `time` and wind uniforms (env.ts, fed by
// dust.ts). Puffs are soft and faint, so the overdraw stays small even standing next to a plume.
import * as THREE from 'three/webgpu';
import { cos, float, fract, instancedBufferAttribute, length, mix, mx_noise_float, normalize, positionWorld, cameraPosition, pow, sin, smoothstep, uv, vec2, vec3, max, min } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { pieceY, type CrashSite } from '../../shared/crashsites.ts';
import { hazeColor, hazeColorFor, hazeFactor, sunColor, time, windDir, windStrength } from './env.ts';

/** Puffs per column. */
const PUFFS = 26;
const MAX_COLUMNS = 40;
const CAPACITY = PUFFS * MAX_COLUMNS;
/** Seconds for a puff to rise to the top (lazy: about a metre a second). */
const LIFE = 30;
/** Share of the aerial haze the smoke takes on, < 1 so the plumes still read far away. */
const HAZE = 0.5;

const c3 = (u: unknown) => u as Node<'vec3'>;

export class CrashSmoke {
  private sprite: THREE.Sprite;
  private base = new Float32Array(CAPACITY * 3);
  /** Per puff: phase offset, seed, column height, width scale. */
  private data = new Float32Array(CAPACITY * 4);
  private baseAttr = new THREE.InstancedBufferAttribute(this.base, 3);
  private dataAttr = new THREE.InstancedBufferAttribute(this.data, 4);

  constructor(scene: THREE.Scene) {
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    const base = instancedBufferAttribute(this.baseAttr, 'vec3') as unknown as Node<'vec3'>;
    const d = instancedBufferAttribute(this.dataAttr, 'vec4') as unknown as Node<'vec4'>;
    const seed = d.y, rise = d.z, width = d.w;
    // Age along the column, 0 at the vent → 1 at the top. Each column runs at its own pace.
    const u = fract(time.div(float(LIFE).mul(float(0.85).add(seed.mul(0.3)))).add(d.x));
    // Rises quickly out of the vent, then slows and spreads; the top bends downwind (more in a strong wind).
    const up = pow(u, 0.75).mul(rise);
    const bend = pow(u, 1.6).mul(windStrength.mul(28).add(5));
    const wander = sin(time.mul(0.23).add(seed.mul(40)).add(u.mul(3))).mul(u).mul(2.2);
    const w = vec2(windDir.x, windDir.y);
    const drift = w.mul(bend).add(vec2(w.y.negate(), w.x).mul(wander));
    m.positionNode = base.add(vec3(drift.x, up, drift.y));
    // Far away the puffs swell (up to 2.6× at 600 m) so the thin column still reads on the horizon.
    const far = smoothstep(80, 600, length(base.xz.sub(cameraPosition.xz)));
    const size = float(1.6).add(pow(u, 0.8).mul(10)).mul(width).mul(far.mul(1.6).add(1));
    m.scaleNode = vec2(size, size);
    // Soft lumpy disc; a little turbulence turning inside each puff.
    const c = uv().sub(0.5);
    const swirl = time.mul(0.15).add(seed.mul(9));
    const rc = vec2(c.x.mul(cos(swirl)).sub(c.y.mul(sin(swirl))), c.x.mul(sin(swirl)).add(c.y.mul(cos(swirl))));
    const lump = mx_noise_float(vec3(rc.mul(3.4), seed.mul(17).add(u.mul(1.5)))).mul(0.5).add(0.72);
    const soft = float(1).sub(smoothstep(0.0, 0.5, length(c)));
    const fade = smoothstep(0.0, 0.07, u).mul(pow(float(1).sub(u), 1.1));
    // Denser low down; thins as it spreads.
    m.opacityNode = soft.mul(soft.sqrt()).mul(lump).mul(fade).mul(mix(float(0.9), float(0.6), u)).min(1);
    // Dark sooty brown lit by the (golden) sun, a warm haze fill in the shadowed side; never blue-grey.
    const lit = c3(sunColor).mul(vec3(0.055, 0.04, 0.03)).add(c3(hazeColor).mul(0.07));
    const dir = normalize(positionWorld.sub(cameraPosition));
    const flat = normalize(vec3(dir.x, min(dir.y, 0), dir.z));
    m.colorNode = mix(lit, hazeColorFor(flat), max(hazeFactor(positionWorld).mul(HAZE), 0));
    this.sprite = new THREE.Sprite(m);
    this.sprite.count = 0;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 2; // after the wrecks and other transparent ground effects
    scene.add(this.sprite);
  }

  /** Rebuild the columns for the sites in view (only smouldering ones have smoke points). */
  setSites(sites: CrashSite[]) {
    let n = 0;
    for (const s of sites) {
      for (const [k, sp] of s.smokePoints.entries()) {
        if (n + PUFFS > CAPACITY) break;
        const pc = s.pieces[sp.piece];
        const y = pieceY(pc) + sp.y;
        // Deterministic per column (visual only): height 25–40 m, width, pace, start phase.
        const h = Math.sin(s.id * 12.9898 + k * 78.233) * 43758.5453;
        const r = h - Math.floor(h);
        const rise = 25 + 15 * r;
        const width = (k === 0 ? 1 : 0.7) * (0.85 + 0.3 * ((r * 7.3) % 1));
        for (let i = 0; i < PUFFS; i++, n++) {
          this.base[n * 3] = sp.x;
          this.base[n * 3 + 1] = y;
          this.base[n * 3 + 2] = sp.z;
          this.data[n * 4] = (i + 0.35 * ((r * (i + 3) * 1.7) % 1)) / PUFFS + r;
          this.data[n * 4 + 1] = r;
          this.data[n * 4 + 2] = rise;
          this.data[n * 4 + 3] = width;
        }
      }
    }
    this.sprite.count = n;
    this.sprite.visible = n > 0;
    this.baseAttr.needsUpdate = true;
    this.dataAttr.needsUpdate = true;
  }
}
