// Smoke over smouldering crash sites (every one nobody has picked anything up from yet, shared/crash.ts `crashVisited`,
// and whose large machine hasn't been stripped, `crashSpent`; a site that goes visited or spent while you watch stops feeding its columns and they drift away): a lazy column of puffs rising 40–85 m
// from each smoke point, bending downwind, spreading and slowly thinning out to nothing, so players can
// spot a site on the horizon from several hundred metres. Purely visual.
//
// Columns differ: some are thick dark soot, most a paler dusty grey-brown, and each one "breathes" — puffs
// born in a lull are thinner and paler, so gaps and darker belches travel up the plume. Every puff has its
// own size, sideways offset and density on top of that.
//
// One instanced sprite (a single draw call) holds every puff of every column in view. The CPU only
// writes each puff's column base and seeds when the set of sites changes; rising, drifting, growing and
// fading all happen in the vertex/fragment nodes from the shared `time` and wind uniforms (env.ts, fed by
// dust.ts). Puffs are soft and faint, so the overdraw stays small even standing next to a plume.
import * as THREE from 'three/webgpu';
import { cos, float, fract, instancedBufferAttribute, length, mix, mx_noise_float, normalize, positionWorld, cameraPosition, pow, sin, smoothstep, uv, vec2, vec3, max, min } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { pieceY, type CrashSite } from '../../shared/crashsites.ts';
import { hazeColor, hazeColorFor, hazeFactor, sunColor, time, windDir, windStrength } from './env.ts';

/** Puffs per column. */
const PUFFS = 34;
const MAX_COLUMNS = 40;
const CAPACITY = PUFFS * MAX_COLUMNS;
/** Seconds for a puff to rise to the top (lazy: one to two metres a second). */
const LIFE = 48;
/** Share of the aerial haze the smoke takes on, < 1 so the plumes still read far away. */
const HAZE = 0.5;
/** Seconds over which a column's feed tapers off when its site goes visited or spent. */
export const STOP_TAPER = 10;

const c3 = (u: unknown) => u as Node<'vec3'>;
const hash = (x: number) => {
  const h = Math.sin(x) * 43758.5453;
  return h - Math.floor(h);
};

export class CrashSmoke {
  private sprite: THREE.Sprite;
  private base = new Float32Array(CAPACITY * 3);
  /** Per puff: phase offset, column seed, column height, width scale. */
  private data = new Float32Array(CAPACITY * 4);
  /** Per puff: column tone (0 soot … 1 pale), column density, puff seed, column pace. */
  private look = new Float32Array(CAPACITY * 4);
  private baseAttr = new THREE.InstancedBufferAttribute(this.base, 3);
  private dataAttr = new THREE.InstancedBufferAttribute(this.data, 4);
  private lookAttr = new THREE.InstancedBufferAttribute(this.look, 4);
  /** Per puff: the `time` its column stops being fed (puffs born after it are not drawn). */
  private stop = new Float32Array(CAPACITY);
  private stopAttr = new THREE.InstancedBufferAttribute(this.stop, 1);

  constructor(scene: THREE.Scene) {
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    const base = instancedBufferAttribute(this.baseAttr, 'vec3') as unknown as Node<'vec3'>;
    const d = instancedBufferAttribute(this.dataAttr, 'vec4') as unknown as Node<'vec4'>;
    const l = instancedBufferAttribute(this.lookAttr, 'vec4') as unknown as Node<'vec4'>;
    const stop = instancedBufferAttribute(this.stopAttr, 'float') as unknown as Node<'float'>;
    const seed = d.y, rise = d.z, width = d.w;
    const tone = l.x, density = l.y, ps = l.z, pace = l.w;
    // Age along the column, 0 at the vent → 1 at the top. Each column runs at its own pace.
    const life = float(LIFE).mul(pace);
    const u = fract(time.div(life).add(d.x));
    // When this puff left the vent: the column's breathing is read at that moment, so a lull or a dark
    // belch rises with the smoke instead of flickering the whole plume at once.
    const born = time.sub(u.mul(life));
    const breath = sin(born.mul(0.09).add(seed.mul(31))).mul(0.5).add(sin(born.mul(0.23).add(seed.mul(57))).mul(0.3)).add(0.5);
    const strong = smoothstep(-0.2, 1.1, breath);
    // Rises quickly out of the vent, then slows and spreads; the top bends downwind (more in a strong
    // wind, and more the higher the column gets).
    const up = pow(u, 0.7).mul(rise);
    const bend = pow(u, 1.5).mul(windStrength.mul(28).add(5)).mul(rise.div(35));
    const wander = sin(time.mul(0.21).add(seed.mul(40)).add(u.mul(3.3))).mul(u).mul(3.5);
    // Each puff strays a little off the column's centre line, more as it spreads.
    const side = ps.mul(6.283);
    const stray = vec2(cos(side), sin(side)).mul(pow(u, 0.8).mul(ps.mul(0.6).add(0.4)).mul(4).mul(width));
    const w = vec2(windDir.x, windDir.y);
    const drift = w.mul(bend).add(vec2(w.y.negate(), w.x).mul(wander)).add(stray);
    m.positionNode = base.add(vec3(drift.x, up, drift.y));
    // Far away the puffs swell (up to 2.6× at 600 m) so the column still reads on the horizon.
    const far = smoothstep(80, 600, length(base.xz.sub(cameraPosition.xz)));
    const jitter = fract(ps.mul(7.31)).mul(0.65).add(0.7);
    const size = float(1.5).add(pow(u, 0.75).mul(15)).mul(width).mul(jitter).mul(strong.mul(0.35).add(0.8)).mul(far.mul(1.6).add(1));
    m.scaleNode = vec2(size, size);
    // Soft lumpy disc; a little turbulence turning inside each puff.
    const c = uv().sub(0.5);
    const swirl = time.mul(0.12).add(ps.mul(9));
    const rc = vec2(c.x.mul(cos(swirl)).sub(c.y.mul(sin(swirl))), c.x.mul(sin(swirl)).add(c.y.mul(cos(swirl))));
    const lump = mx_noise_float(vec3(rc.mul(3.4), ps.mul(17).add(u.mul(1.5)))).mul(0.55).add(0.7);
    const soft = float(1).sub(smoothstep(0.0, 0.5, length(c)));
    // Fades in at the vent, then thins away slowly over the upper two thirds of the climb.
    const fade = smoothstep(0.0, 0.06, u).mul(pow(float(1).sub(smoothstep(0.25, 1.0, u)), 1.3));
    const puffDensity = fract(ps.mul(3.17)).mul(0.4).add(0.8);
    m.opacityNode = soft.mul(soft.sqrt()).mul(lump).mul(fade).mul(mix(float(0.85), float(0.45), u))
      .mul(density).mul(puffDensity).mul(strong.mul(0.6).add(0.4)).mul(float(1).sub(smoothstep(stop.sub(STOP_TAPER), stop, born))).min(1);
    // Sooty brown to pale dusty grey, lit by the (golden) sun with a warm haze fill; never blue-grey.
    // Smoke pales as it dilutes on the way up, and lulls come out paler than the belches.
    const t = min(tone.add(u.mul(0.45)).add(float(1).sub(strong).mul(0.25)), 1);
    const dark = c3(sunColor).mul(vec3(0.06, 0.045, 0.034)).add(c3(hazeColor).mul(0.08));
    const pale = c3(sunColor).mul(vec3(0.3, 0.27, 0.23)).add(c3(hazeColor).mul(0.24));
    const lit = mix(dark, pale, t);
    const dir = normalize(positionWorld.sub(cameraPosition));
    const flat = normalize(vec3(dir.x, min(dir.y, 0), dir.z));
    m.colorNode = mix(lit, hazeColorFor(flat), max(hazeFactor(positionWorld).mul(HAZE), 0));
    this.sprite = new THREE.Sprite(m);
    this.sprite.count = 0;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 2; // after the wrecks and other transparent ground effects
    scene.add(this.sprite);
  }

  /** Rebuild the columns for the sites in view. `stopAt(id)` is the `time` a site's smoke stops being fed
   *  (Infinity: still smouldering, -Infinity: long cold, no columns). */
  setSites(sites: CrashSite[], stopAt: (id: number) => number) {
    let n = 0;
    for (const s of sites) {
      const stop = stopAt(s.id);
      if (stop === -Infinity) continue;
      for (const [k, sp] of s.smokePoints.entries()) {
        if (n + PUFFS > CAPACITY) break;
        const pc = s.pieces[sp.piece];
        const y = pieceY(pc) + sp.y;
        // Deterministic per column (visual only): height 40–85 m, width, tone, density, pace, phase.
        const key = s.id * 12.9898 + k * 78.233;
        const r = hash(key);
        const rise = 40 + 45 * hash(key + 1.7);
        const width = (k === 0 ? 1 : 0.7) * (0.8 + 0.45 * hash(key + 2.3));
        // About a quarter of the columns are thick dark soot; the rest pale grey-brown of varied shade.
        const tr = hash(key + 3.1);
        const tone = tr < 0.25 ? 0.05 * tr : 0.25 + 0.6 * hash(key + 4.9);
        const density = (tr < 0.25 ? 0.9 : 0.55 + 0.35 * hash(key + 5.3)) * (k === 0 ? 1 : 0.8);
        const pace = 0.8 + 0.45 * hash(key + 6.7);
        for (let i = 0; i < PUFFS; i++, n++) {
          this.base[n * 3] = sp.x;
          this.base[n * 3 + 1] = y;
          this.base[n * 3 + 2] = sp.z;
          this.data[n * 4] = (i + 0.5 * hash(key + i * 1.37)) / PUFFS + r;
          this.data[n * 4 + 1] = r;
          this.data[n * 4 + 2] = rise;
          this.data[n * 4 + 3] = width;
          this.look[n * 4] = tone;
          this.look[n * 4 + 1] = density;
          this.look[n * 4 + 2] = hash(key + i * 3.71 + 0.5);
          this.look[n * 4 + 3] = pace;
          this.stop[n] = Math.min(stop, 1e9);
        }
      }
    }
    this.sprite.count = n;
    this.sprite.visible = n > 0;
    this.baseAttr.needsUpdate = true;
    this.dataAttr.needsUpdate = true;
    this.lookAttr.needsUpdate = true;
    this.stopAttr.needsUpdate = true;
  }
}
