// The low sheet of blown sand that streams over the dunes in wind: what saltation looks like from a
// few metres away. Individual grains are invisible at that distance; what you see is a translucent,
// streaky veil a few centimetres to half a metre deep, densest at the ground, racing downwind in
// snaking ribbons near the threshold and merging into a continuous flow in a storm.
//
// Drawn as a stack of terrain-hugging shells (one instanced grid around the player, each instance
// lifted along the normal). The shader cuts the streamers out of wind-aligned noise advected with the
// saltation speed; higher shells are softer and fainter, so the stack reads as a volume.
// Purely visual, client-side; wind.ts decides how much sand moves.
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { attribute, cameraPosition, dot, exp, float, instancedBufferAttribute, length, mix, mx_noise_float, normalize, pow, saturate, smoothstep, uniform, varying, vec2, vec3 } from 'three/tsl';
import { edits, heightAt, normalAt, WIND } from '../../shared/terrain.ts';
import { sunColor, sunDirection, time } from './env.ts';
import { ustarFrom10, USTAR_T, wind } from './wind.ts';

const HALF = 48; // grid half-width (m)
const STEP = 1; // grid spacing (m)
const RECENTRE = 8; // rebuild the grid when the player is this far from its centre (m)
const SHELL_HEIGHTS = [0.03, 0.07, 0.12, 0.19, 0.28, 0.4, 0.55];

/** How much sand is moving, 0..1 (regional, gusts excluded). */
const amount = uniform(0);
/** Integrated saltation travel (m, xz): the streamers move with the grains, slower than the air. */
const drift = uniform(new THREE.Vector2());

export class DriftSheet {
  private geo = new THREE.InstancedBufferGeometry();
  private mesh: THREE.Mesh;
  private cx = NaN;
  private cz = NaN;
  private n = { x: 0, y: 1, z: 0 };

  constructor(scene: THREE.Scene) {
    const side = Math.round((2 * HALF) / STEP) + 1;
    const verts = side * side;
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    const idx = new Uint16Array((side - 1) * (side - 1) * 6);
    let k = 0;
    for (let j = 0; j < side - 1; j++) {
      for (let i = 0; i < side - 1; i++) {
        const a = j * side + i, b = a + 1, c = a + side, d = c + 1;
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
    this.mesh.visible = false;
    scene.add(this.mesh);

    const prev = edits.onChange;
    edits.onChange = (cx, cz) => {
      prev?.(cx, cz);
      this.cx = NaN; // digging changed the ground: rebuild next frame
    };
  }

  private material(shells: THREE.InstancedBufferAttribute) {
    const h = instancedBufferAttribute(shells, 'float') as unknown as Node<'float'>;
    const pos = attribute('position', 'vec3') as unknown as Node<'vec3'>;
    const nor = attribute('normal', 'vec3') as unknown as Node<'vec3'>;
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    mat.positionNode = pos.add(nor.mul(h));

    const wp = varying(pos.add(nor.mul(h)));
    const n = varying(nor);
    const hk = varying(h);
    // Wind-aligned frame (the dunes' wind; the live direction only wobbles a few degrees around it).
    // Higher shells ride faster air, so they slide over the lower ones.
    const q = wp.xz.sub(drift.mul(hk.mul(1.5).add(1)));
    const along = dot(q, vec2(WIND.x, WIND.z));
    const across = q.y.mul(WIND.x).sub(q.x.mul(WIND.z));
    const t = time;
    const n01 = (p: Node<'vec3'>) => mx_noise_float(p).mul(0.5).add(0.5);
    const gust = n01(vec3(along.div(45), across.div(30), t.mul(0.03)));
    const streak = n01(vec3(along.div(10), across.div(1.4), t.mul(0.2)));
    const fine = n01(vec3(along.div(1.8), across.div(0.22), t.mul(0.5)));
    // Near the threshold only the strongest streamers carry sand; in a storm they merge into a sheet.
    const field = streak.mul(0.65).add(gust.mul(0.35));
    const thr = mix(float(0.72), float(0.42), amount);
    let density = smoothstep(thr, thr.add(0.22), field);
    // Fine striations near the ground, smoothed out higher up.
    density = density.mul(mix(fine.mul(0.8).add(0.35), float(0.8), saturate(hk.mul(3))));
    // Slip faces sit in the sheltered eddy behind the brink: almost nothing moves there.
    const lee = smoothstep(0.1, 0.35, dot(n.xz, vec2(WIND.x, WIND.z)));
    density = density.mul(float(1).sub(lee.mul(0.85)));
    // Dense at the ground, thinning with height; storms lift it higher.
    const scaleH = mix(float(0.08), float(0.25), amount);
    const vertical = exp(hk.div(scaleH).negate());
    // Fade out towards the grid edge (and wherever the grid lags behind the player).
    const dist = length(wp.xz.sub(cameraPosition.xz));
    const edge = float(1).sub(smoothstep(HALF * 0.5, HALF * 0.9, dist));
    mat.opacityNode = density.mul(vertical).mul(edge).mul(pow(amount, 0.6)).mul(0.14);

    // Lit like the sand below it but paler (fine grains), with a soft forward-scattering glow when
    // backlit. Kept well below bloom so it reads as dust, not sparks.
    const mu = dot(normalize(wp.sub(cameraPosition)), sunDirection);
    const light = saturate(dot(n, sunDirection).mul(1.6)).mul(0.65).add(0.35);
    const phase = pow(saturate(mu), 6).mul(0.5).add(0.45);
    mat.colorNode = vec3(0.75, 0.48, 0.28).mul(sunColor).mul(light).mul(phase).add(vec3(0.1, 0.05, 0.03));
    return mat;
  }

  /** Per render frame. `focus` is the local player's feet. */
  update(dt: number, focus: { x: number; z: number }) {
    const us = ustarFrom10(wind.u10);
    // Regional transport strength as in wind.ts, plus a little headroom so gusts show near threshold.
    const q = Math.max(0, (us * us - USTAR_T * USTAR_T) / (USTAR_T * USTAR_T) + 0.4);
    amount.value = Math.min(1, q / 4);
    this.mesh.visible = amount.value > 0.005;
    if (!this.mesh.visible) {
      drift.value.set(0, 0); // calm: restart the advection so it never loses float precision
      return;
    }
    // Saltating sand moves at a fraction of the 10 m wind (1–5 m/s).
    drift.value.x += wind.dx * 0.25 * wind.u10 * dt;
    drift.value.y += wind.dz * 0.25 * wind.u10 * dt;
    if (!(Math.abs(focus.x - this.cx) < RECENTRE && Math.abs(focus.z - this.cz) < RECENTRE)) this.rebuild(focus);
  }

  private rebuild(focus: { x: number; z: number }) {
    this.cx = Math.round(focus.x / STEP) * STEP;
    this.cz = Math.round(focus.z / STEP) * STEP;
    const pos = this.geo.attributes.position.array as Float32Array;
    const nor = this.geo.attributes.normal.array as Float32Array;
    const side = Math.round((2 * HALF) / STEP) + 1;
    for (let j = 0, v = 0; j < side; j++) {
      const z = this.cz - HALF + j * STEP;
      for (let i = 0; i < side; i++, v += 3) {
        const x = this.cx - HALF + i * STEP;
        const nn = normalAt(x, z, this.n);
        pos[v] = x;
        pos[v + 1] = heightAt(x, z);
        pos[v + 2] = z;
        nor[v] = nn.x;
        nor[v + 1] = nn.y;
        nor[v + 2] = nn.z;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
  }
}
