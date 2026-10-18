// Footprints in the sand: a client-side, purely visual ring buffer of small darkening decals that fade out.
// They multiply the already-lit sand beneath them, so they read right by day and night. Boot prints are drawn in the
// shader from a signed distance (forefoot + waist, separate heel, lug pattern, mirrored per foot) and shaded as a
// shallow dent: the inner wall facing the sun brightens, the one facing away darkens with a short shadow, and a
// faint pushed-up lip rings the outside. Avatars call `footprints.add()` when a foot plants; one InstancedMesh
// draws them all. The bike's tyre marks are plain ovals (`tyreprints`). Sliding bodies lay
// `streaks` instead: soft-edged strips placed end to end, so a slide leaves one continuous groove.
// Prints whose ground gets dug or piled are erased, so they never float over a hole.
import * as THREE from 'three/webgpu';
import {
  abs, clamp, cos, dot, float, fract, Fn, fwidth, instancedBufferAttribute, length, max, min, mix, normalize, positionWorld,
  pow, sin, smoothstep, uv, vec2, vec3, vec4,
} from 'three/tsl';
import { EDIT_CELL, EDIT_CHUNK, edits, heightAt, normalAt } from '../shared/terrain.ts';
import { hazeFactor, sunDirection, time } from './world/env.ts';

import type { Node } from 'three/webgpu';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

const MAX = 1024;
const LIFE = 90; // seconds until a print has fully faded
const CHUNK_M = EDIT_CHUNK * EDIT_CELL;
const ERASE_DY = 0.03; // ground moved more than this under a print → erase it
/** Fraction of a soft strip's length that fades in at each end; strips should overlap their neighbours by this. */
export const END_FADE = 0.2;

// Boot print plane, metres (scaled per print by `size`/`length`). Toe towards -Z (uv.y = 1).
const BOOT_W = 0.15, BOOT_L = 0.34;

/** Ellipse distance (approximate, fine near the edge), negative inside. */
const ellipse = (p: V2, c: [number, number], r: [number, number]) =>
  length(p.sub(vec2(...c)).div(vec2(...r))).sub(1).mul(Math.min(...r));

/** Rounded box distance, negative inside. */
const roundBox = (p: V2, c: [number, number], half: [number, number], rad: number) => {
  const q = abs(p.sub(vec2(...c))).sub(vec2(half[0] - rad, half[1] - rad));
  return length(max(q, vec2(0))).add(min(max(q.x, q.y), 0)).sub(rad);
};

/** Right boot sole in metres: x across (inner side −x), y along the foot (toe +y). Returns vec2(sole, heel) distances. */
const bootSdf = Fn(([p]: [V2]) => {
  const fore = ellipse(p, [-0.004, 0.058], [0.054, 0.095]);
  const waist = ellipse(p, [0.01, -0.025], [0.04, 0.07]);
  // Smooth union of forefoot and waist, cut flat before the heel.
  const k = float(0.02);
  const h = clamp(float(0.5).add(waist.sub(fore).mul(0.5).div(k)), 0, 1);
  const sole = max(mix(waist, fore, h).sub(k.mul(h).mul(float(1).sub(h))), p.y.negate().sub(0.045));
  const heel = roundBox(p, [0.004, -0.112], [0.042, 0.04], 0.022);
  return vec2(sole, heel);
});

/** Pressed-boot multiply colour (before fading) at uv, for foot `side` (+1 right, −1 left) facing yaw `facing`. */
const bootColor = Fn(([facing, side]: [F, F]) => {
  const p = vec2(uv().x.sub(0.5).mul(BOOT_W).mul(side), uv().y.sub(0.5).mul(BOOT_L)).toVar();
  const e = 0.002;
  const dd = bootSdf(p);
  const d = min(dd.x, dd.y);
  const dx = min(bootSdf(p.add(vec2(e, 0))).x, bootSdf(p.add(vec2(e, 0))).y).sub(d);
  const dy = min(bootSdf(p.add(vec2(0, e))).x, bootSdf(p.add(vec2(0, e))).y).sub(d);
  const out = normalize(vec2(dx, dy).add(vec2(1e-6, 0))); // outward from the print
  // Sun in the print's (mirrored) frame: local +X is world (cos f, −sin f), toe +Y is world (−sin f, −cos f).
  const sx = sunDirection.x.mul(cos(facing)).sub(sunDirection.z.mul(sin(facing))).mul(side);
  const sy = sunDirection.x.mul(sin(facing)).add(sunDirection.z.mul(cos(facing))).negate();
  const sun2 = vec2(sx, sy);
  const grazing = clamp(length(sun2).mul(1.4), 0, 1).mul(smoothstep(-0.05, 0.05, sunDirection.y));
  const sunL = normalize(sun2.add(vec2(1e-6, 0)));
  const lit = dot(out.negate(), sunL); // inner wall: + faces the sun, − in its own shadow

  const aa = max(fwidth(d), 0.0008);
  const inside = float(1).sub(smoothstep(aa.negate(), aa, d));
  // Wall band just inside the edge; the shadowed side throws a wider shadow onto the floor when the sun is low.
  const shadowW = mix(float(0.008), float(0.022), grazing);
  const wallW = mix(float(0.008), shadowW, clamp(lit.negate(), 0, 1));
  const wall = smoothstep(wallW.negate(), float(0), d).mul(inside);
  // Lugs: chevron bars on the sole, cross bars on the heel, kept off a solid outer rim.
  const chevron = fract(p.y.mul(46).add(abs(p.x).mul(22)));
  const bars = fract(p.y.mul(40));
  const isHeel = smoothstep(0.002, -0.002, dd.y.sub(dd.x));
  const lugLine = mix(chevron, bars, isHeel);
  const lug = smoothstep(0.38, 0.5, lugLine).mul(smoothstep(0.92, 0.8, lugLine));
  const rimFree = smoothstep(-0.007, -0.012, d);
  const floor = mix(vec3(0.74, 0.67, 0.6), vec3(0.6, 0.53, 0.46), lug.mul(rimFree));
  const wallCol = mix(vec3(0.42, 0.34, 0.28), vec3(1.12, 1.08, 1.02), smoothstep(-0.7, 0.7, lit));
  const inner = mix(floor, mix(floor, wallCol, grazing.mul(0.85).add(0.15)), wall);
  // Pushed-up lip outside the edge: its outer slope faces the other way to the wall below it.
  const lipBand = smoothstep(0, 0.004, d).mul(smoothstep(0.016, 0.006, d));
  const lipCol = mix(vec3(0.82, 0.78, 0.74), vec3(1.08, 1.05, 1.0), smoothstep(-0.6, 0.6, dot(out, sunL)));
  const outer = mix(vec3(1), lipCol, lipBand.mul(grazing.mul(0.7).add(0.15)));
  return mix(outer, inner, inside);
});

type Kind = 'plain' | 'soft' | 'boot';

class Footprints {
  readonly mesh: THREE.InstancedMesh;
  private spawn = new Float32Array(MAX).fill(-1e6);
  // Where each print sits (ground height at placement), to erase it if the ground changes.
  private px = new Float32Array(MAX);
  private py = new Float32Array(MAX).fill(NaN);
  private pz = new Float32Array(MAX);
  private dirty = new Set<string>();
  private spawnAttr: THREE.InstancedBufferAttribute;
  // Per print: facing yaw and foot side (+1 right, −1 left), for the boot shader.
  private pose = new Float32Array(MAX * 2).fill(1);
  private poseAttr: THREE.InstancedBufferAttribute;
  private next = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private n = { x: 0, y: 1, z: 0 };
  private up = new THREE.Vector3(0, 1, 0);
  private nv = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private p = new THREE.Vector3();

  /**
   * `geo` lies flat (normal +Y), front towards -Z. `boot` draws a boot sole on it (uv-based); `soft` feathers its sides (uv.x) and fades its ends (uv.y) linearly
   * over END_FADE, so strips overlapping by that much blend into one seamless line.
   */
  constructor(geo: THREE.BufferGeometry, kind: Kind = 'plain') {
    this.spawnAttr = new THREE.InstancedBufferAttribute(this.spawn, 1);
    this.poseAttr = new THREE.InstancedBufferAttribute(this.pose, 2);
    const age = time.sub(instancedBufferAttribute(this.spawnAttr, 'float'));
    let fade = clamp(float(1).sub(age.div(LIFE)), 0, 1).mul(float(1).sub(hazeFactor(positionWorld)));
    if (kind === 'soft') {
      const ends = clamp(min(uv().y, float(1).sub(uv().y)).div(END_FADE), 0, 1);
      fade = fade.mul(smoothstep(0.5, 0.2, abs(uv().x.sub(0.5)))).mul(ends);
    }
    // Pressed sand: a bit darker and warmer than the surface around it. Output is the multiply factor, faded as a
    // power so that overlapping partial fades (soft strip ends) multiply back to exactly one full print.
    let col: V3 = vec3(0.66, 0.6, 0.55);
    if (kind === 'boot') {
      const pose = instancedBufferAttribute(this.poseAttr, 'vec2') as unknown as V2;
      col = bootColor(pose.x, pose.y);
    }
    const factor = pow(col, vec3(fade));
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, toneMapped: false });
    mat.outputNode = vec4(factor, 1);
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.ZeroFactor;
    mat.blendDst = THREE.SrcColorFactor;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.frustumCulled = false;
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) this.mesh.setMatrixAt(i, this.m);
    this.mesh.renderOrder = 1;

    // Edits fire per vertex; collect the touched chunks and check prints once per batch.
    const prev = edits.onChange;
    edits.onChange = (cx, cz) => {
      prev?.(cx, cz);
      if (this.dirty.size === 0) queueMicrotask(() => this.eraseDisturbed());
      this.dirty.add(`${cx},${cz}`);
    };
  }

  private eraseDisturbed() {
    let changed = false;
    for (let i = 0; i < MAX; i++) {
      const y = this.py[i];
      if (Number.isNaN(y)) continue;
      const x = this.px[i], z = this.pz[i];
      if (!this.dirty.has(`${Math.floor(x / CHUNK_M)},${Math.floor(z / CHUNK_M)}`)) continue;
      if (Math.abs(heightAt(x, z) - y) <= ERASE_DY) continue;
      this.py[i] = NaN;
      this.m.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, this.m);
      changed = true;
    }
    this.dirty.clear();
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * A foot planted at ground point (x, y, z) facing yaw `facing` (0 = -Z), scaled `size` across, `length` along;
   * `side` +1 for a right foot, −1 for a left one (mirrors a boot print).
   */
  add(x: number, y: number, z: number, facing: number, size = 1, length = size, side = 1) {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    normalAt(x, z, this.n);
    this.nv.set(this.n.x, this.n.y, this.n.z);
    this.q.setFromUnitVectors(this.up, this.nv);
    this.q2.setFromAxisAngle(this.up, facing);
    this.q.multiply(this.q2);
    this.p.set(x, y + 0.02, z);
    this.s.set(size, 1, length);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.spawn[i] = time.value;
    this.pose[i * 2] = facing;
    this.pose[i * 2 + 1] = side;
    this.poseAttr.needsUpdate = true;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.spawnAttr.needsUpdate = true;
  }
}

// Boot prints: a plane the size of a sole, the shape drawn in the shader. Toe towards -Z.
export const footprints = new Footprints(new THREE.PlaneGeometry(BOOT_W, BOOT_L).rotateX(-Math.PI / 2), 'boot');
// Tyre marks: plain ovals.
export const tyreprints = new Footprints(new THREE.CircleGeometry(0.5, 10).rotateX(-Math.PI / 2).scale(0.15, 1, 0.3));
// A unit strip, stretched per segment over the distance slid since the last one (plus the end-fade overlap).
export const streaks = new Footprints(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), 'soft');
