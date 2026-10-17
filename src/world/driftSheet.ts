// The low sheet of blown sand that streams over the dunes in wind: what saltation looks like from a
// few metres away. Individual grains are invisible at that distance; what you see is a translucent,
// streaky veil a few centimetres to half a metre deep, densest at the ground, racing downwind in
// snaking ribbons near the threshold and merging into a continuous flow in a storm.
//
// Drawn as a stack of terrain-hugging shells (one instanced grid around the player, each instance
// lifted along the normal). The shader cuts the streamers out of wind-aligned noise advected with the
// saltation speed; higher shells are softer and fainter, so the stack reads as a volume.
//
// How much sand moves is wind.sample() at every grid vertex, every frame: gusts racing downwind, the
// speed-up on crests and high ridges, the sheltered lee. Where a slip face drops away behind a brink
// the sheet does not follow the ground: it is carried on at the brink's height, sinking slowly and
// spreading, so the sand smokes off the whole crest line and thins out over the lee.
// Purely visual, client-side.
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { attribute, cameraPosition, dot, exp, float, instancedBufferAttribute, length, mix, mx_noise_float, pow, smoothstep, saturate, uniform, varying, vec2, vec3 } from 'three/tsl';
import { EDIT_CELL, EDIT_CHUNK, edits, heightAt, WIND } from '../../shared/terrain.ts';
import { time } from './env.ts';
import { PEAK_LOCAL, ustarFrom10, USTAR_T, wind, type WindSample } from './wind.ts';

const HALF = 48; // grid half-width (m)
const STEP = 1; // grid spacing (m)
const RECENTRE = 8; // rebuild the grid when the player is this far from its centre (m)
const SHELL_HEIGHTS = [0.03, 0.07, 0.12, 0.19, 0.28, 0.4, 0.55];
const SIDE = Math.round((2 * HALF) / STEP) + 1;
/** Interleave the per-vertex wind sampling over this many frames. */
const SAMPLE_FRAMES = 4;
// Crest plumes
const PLUME_REACH = 24; // how far downwind of a brink the plume is followed (m)
const PLUME_FALL = 0.32; // the plume sinks this much per metre downwind
const PLUME_DECAY = 8; // m over which it thins out (sand settles onto the slip face)
const PLUME_SPREAD = 0.3; // extra thickness per metre downwind (turbulent mixing)
const VEER_REBUILD = Math.cos(0.08); // re-trace plumes when the wind has turned this much
/** The ground is cached with a margin so plumes can be traced upwind of the grid edge. */
const MARGIN = PLUME_REACH + 1;
const BIG = SIDE + 2 * MARGIN;

/** Integrated saltation travel (m, xz): the streamers move with the grains, slower than the air. */
const drift = uniform(new THREE.Vector2());

export class DriftSheet {
  private geo = new THREE.InstancedBufferGeometry();
  private mesh: THREE.Mesh;
  private cx = NaN;
  private cz = NaN;
  private wx = 0;
  private wz = 0;
  private frame = 0;
  // Ground heights on the STEP grid with a margin: origin (gx, gz), shifted and reused on recentre.
  private ground = new Float32Array(BIG * BIG);
  private spare = new Float32Array(BIG * BIG);
  private gx = NaN;
  private gz = NaN;
  private dirty: { x0: number; z0: number; x1: number; z1: number }[] = [];
  // Where each vertex takes its wind from (the brink for plume vertices), and how much of it reaches.
  private srcX = new Float32Array(SIDE * SIDE);
  private srcZ = new Float32Array(SIDE * SIDE);
  private reach = new Float32Array(SIDE * SIDE);
  private sand = new Float32Array(SIDE * SIDE);
  private sample: WindSample = { dx: 0, dz: 0, ustar: 0, q: 0, emit: 0 };

  constructor(scene: THREE.Scene) {
    const verts = SIDE * SIDE;
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    this.geo.setAttribute('spread', new THREE.BufferAttribute(new Float32Array(verts), 1));
    this.geo.setAttribute('sand', new THREE.BufferAttribute(this.sand, 1).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint16Array((SIDE - 1) * (SIDE - 1) * 6);
    let k = 0;
    for (let j = 0; j < SIDE - 1; j++) {
      for (let i = 0; i < SIDE - 1; i++) {
        const a = j * SIDE + i, b = a + 1, c = a + SIDE, d = c + 1;
        idx.set([a, c, b, b, c, d], k);
        k += 6;
      }
    }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const shells = new THREE.InstancedBufferAttribute(new Float32Array(SHELL_HEIGHTS), 1);
    this.geo.setAttribute('shell', shells);
    this.geo.instanceCount = SHELL_HEIGHTS.length;

    this.mesh = new THREE.Mesh(this.geo, this.material(shells));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    scene.add(this.mesh);

    const prev = edits.onChange;
    edits.onChange = (cx, cz) => {
      prev?.(cx, cz);
      // Digging changed the ground: refresh that chunk's heights and re-trace next frame.
      const size = EDIT_CHUNK * EDIT_CELL;
      this.dirty.push({ x0: cx * size, z0: cz * size, x1: (cx + 1) * size, z1: (cz + 1) * size });
    };
  }

  private material(shells: THREE.InstancedBufferAttribute) {
    const shell = instancedBufferAttribute(shells, 'float') as unknown as Node<'float'>;
    const pos = attribute('position', 'vec3') as unknown as Node<'vec3'>;
    const nor = attribute('normal', 'vec3') as unknown as Node<'vec3'>;
    const spread = attribute('spread', 'float') as unknown as Node<'float'>;
    const mat = new THREE.MeshLambertNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const h = shell.mul(spread);
    mat.positionNode = pos.add(nor.mul(h));

    const wp = varying(pos.add(nor.mul(h)));
    const hk = varying(shell);
    // How much sand moves here, 0..1, from the live wind (per vertex, see update).
    const a = varying(attribute('sand', 'float') as unknown as Node<'float'>);
    // Wind-aligned frame (the dunes' wind: a fixed frame keeps the pattern from sweeping as the live
    // wind veers; the drift follows the live direction). Higher shells ride faster air.
    const q = wp.xz.sub(drift.mul(hk.mul(1.5).add(1)));
    const along = dot(q, vec2(WIND.x, WIND.z));
    const across = q.y.mul(WIND.x).sub(q.x.mul(WIND.z));
    const t = time;
    const n01 = (p: Node<'vec3'>) => mx_noise_float(p).mul(0.5).add(0.5);
    const billow = n01(vec3(along.div(25), across.div(12), t.mul(0.05)));
    const streak = n01(vec3(along.div(10), across.div(1.4), t.mul(0.2)));
    const fine = n01(vec3(along.div(1.8), across.div(0.22), t.mul(0.5)));
    // Near the threshold only the strongest streamers carry sand; in strong wind they merge.
    const field = streak.mul(0.65).add(billow.mul(0.35));
    const thr = mix(float(0.75), float(0.4), a);
    let density = smoothstep(thr, thr.add(0.22), field);
    // Fine striations near the ground, smoothed out higher up.
    density = density.mul(mix(fine.mul(0.8).add(0.35), float(0.8), saturate(hk.mul(3))));
    // Dense at the ground, thinning with height; strong wind lifts it higher.
    const scaleH = mix(float(0.08), float(0.25), a);
    const vertical = exp(hk.div(scaleH).negate());
    // Fade out towards the grid edge (and wherever the grid lags behind the player).
    const dist = length(wp.xz.sub(cameraPosition.xz));
    const edge = float(1).sub(smoothstep(HALF * 0.5, HALF * 0.9, dist));
    mat.opacityNode = density.mul(vertical).mul(edge).mul(pow(a, 0.6)).mul(0.09);

    // Lit by the same sun, sky fill and cascaded shadows as the sand below (shaded with the ground's
    // normal), just a touch paler: fine grains. So it dims on shaded slopes and in dune/palm shadows.
    mat.colorNode = vec3(0.85, 0.52, 0.27);
    return mat;
  }

  /** Per render frame. `focus` is the local player's feet. */
  update(dt: number, focus: { x: number; z: number }) {
    // Nothing anywhere unless the peak gust on the most exposed crest can lift sand.
    this.mesh.visible = ustarFrom10(wind.u10 * PEAK_LOCAL) > USTAR_T;
    if (!this.mesh.visible) {
      drift.value.set(0, 0); // calm: restart the advection so it never loses float precision
      return;
    }
    // Saltating sand moves at a fraction of the 10 m wind (1–3 m/s).
    drift.value.x += wind.dx * 0.18 * wind.u10 * dt;
    drift.value.y += wind.dz * 0.18 * wind.u10 * dt;
    const moved = !(Math.abs(focus.x - this.cx) < RECENTRE && Math.abs(focus.z - this.cz) < RECENTRE);
    if (moved || this.dirty.length || wind.dx * this.wx + wind.dz * this.wz < VEER_REBUILD) this.rebuild(focus, moved);

    // Local transport from the live wind (gusts, topography, altitude), taken at the brink for plumes.
    // Plumes need more than the threshold: only strong gusts throw sand clear of the crest.
    // Gust patches are tens of metres wide, so each vertex is refreshed every few frames.
    const s = this.sample;
    for (let v = this.frame++ % SAMPLE_FRAMES; v < SIDE * SIDE; v += SAMPLE_FRAMES) {
      const amt = Math.min(1, wind.sample(this.srcX[v], this.srcZ[v], s).q / 4);
      const r = this.reach[v];
      this.sand[v] = r >= 1 ? amt : amt * r * Math.min(1, Math.max(0, (amt - 0.15) / 0.35));
    }
    this.geo.attributes.sand.needsUpdate = true;
  }

  /** Ground heights, plume lids and wind sources for the grid around the player. */
  private rebuild(focus: { x: number; z: number }, moved: boolean) {
    if (moved) {
      this.cx = Math.round(focus.x / STEP) * STEP;
      this.cz = Math.round(focus.z / STEP) * STEP;
    }
    this.updateGround();
    const wx = (this.wx = wind.dx), wz = (this.wz = wind.dz);
    const x0 = this.cx - HALF, z0 = this.cz - HALF;
    const pos = this.geo.attributes.position.array as Float32Array;
    const nor = this.geo.attributes.normal.array as Float32Array;
    const spread = this.geo.attributes.spread.array as Float32Array;
    const g = this.ground;
    for (let j = 0, v = 0; j < SIDE; j++) {
      const z = z0 + j * STEP;
      for (let i = 0; i < SIDE; i++, v++) {
        const x = x0 + i * STEP;
        const k = (j + MARGIN) * BIG + i + MARGIN;
        const y = g[k];
        // Trace upwind for a brink whose sand, sinking at PLUME_FALL, still passes above this point.
        let lid = y, from = 0;
        for (let d = 1; d <= PLUME_REACH; d++) {
          const top = this.height(x - wx * d, z - wz * d) - PLUME_FALL * d;
          if (top > lid) {
            lid = top;
            from = d;
          }
        }
        // Ground normal from the cached heights; a plume in the air is lit from above instead.
        const up = Math.min(1, (lid - y) / 0.5);
        const gx = (g[k + 1] - g[k - 1]) / (2 * STEP), gz = (g[k + BIG] - g[k - BIG]) / (2 * STEP);
        const nx = -gx * (1 - up), nz = -gz * (1 - up), nl = 1 / Math.hypot(nx, 1, nz);
        pos[v * 3] = x;
        pos[v * 3 + 1] = lid;
        pos[v * 3 + 2] = z;
        nor[v * 3] = nx * nl;
        nor[v * 3 + 1] = nl;
        nor[v * 3 + 2] = nz * nl;
        spread[v] = 1 + PLUME_SPREAD * from;
        this.srcX[v] = x - wx * from;
        this.srcZ[v] = z - wz * from;
        this.reach[v] = from === 0 ? 1 : Math.exp(-from / PLUME_DECAY) * 0.999;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    this.geo.attributes.spread.needsUpdate = true;
  }

  /** Bring the cached heights to the current centre, reusing the overlap, and refresh dug chunks. */
  private updateGround() {
    const nx = this.cx - HALF - MARGIN * STEP, nz = this.cz - HALF - MARGIN * STEP;
    if (nx !== this.gx || nz !== this.gz) {
      const old = this.ground, next = this.spare;
      const di = Math.round((nx - this.gx) / STEP), dj = Math.round((nz - this.gz) / STEP);
      for (let j = 0; j < BIG; j++) {
        const oj = j + dj;
        for (let i = 0; i < BIG; i++) {
          const oi = i + di;
          next[j * BIG + i] = oi >= 0 && oj >= 0 && oi < BIG && oj < BIG ? old[oj * BIG + oi] : heightAt(nx + i * STEP, nz + j * STEP);
        }
      }
      this.spare = old;
      this.ground = next;
      this.gx = nx;
      this.gz = nz;
    }
    for (const r of this.dirty) {
      const i0 = Math.max(0, Math.floor((r.x0 - nx) / STEP)), i1 = Math.min(BIG - 1, Math.ceil((r.x1 - nx) / STEP));
      const j0 = Math.max(0, Math.floor((r.z0 - nz) / STEP)), j1 = Math.min(BIG - 1, Math.ceil((r.z1 - nz) / STEP));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.ground[j * BIG + i] = heightAt(nx + i * STEP, nz + j * STEP);
    }
    this.dirty.length = 0;
  }

  /** Ground height, bilinear from the cache where it covers (x, z), else from the terrain. */
  private height(x: number, z: number): number {
    const fx = (x - this.gx) / STEP, fz = (z - this.gz) / STEP;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= BIG - 1 || j >= BIG - 1) return heightAt(x, z);
    const tx = fx - i, tz = fz - j, g = this.ground, k = j * BIG + i;
    const a = g[k] + (g[k + 1] - g[k]) * tx;
    const b = g[k + BIG] + (g[k + BIG + 1] - g[k + BIG]) * tx;
    return a + (b - a) * tz;
  }
}
