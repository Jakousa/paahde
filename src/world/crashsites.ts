// Crash sites: draws the wrecks and debris (public/models/crashsites.glb, from tools/blender/crashsites.py)
// that shared/crashsites.ts lays out, and the smoke over the ones still smouldering (crashSmoke.ts). The
// layout and hitboxes live in shared/crashsites.ts (the server collides players with them too); this only
// turns pieces into instance matrices.
//
// Each glb node (one per CRASH_KINDS entry) becomes one InstancedMesh per mesh/material in it, filled with
// every piece of that kind within VIEW of the player. Rebuilt when the player has moved REBUILD metres or
// the sand under a piece is dug. Wrecks are big landmarks, so the view distance is long.
//
// The emissive material `CrashGlow` (status lights, cracked consoles) flickers irregularly, each site on
// its own phase. If the glb (or a node) is missing, a kind is drawn as grey boxes around its hitbox
// capsules with a glowing beacon cube: a harmless fallback that keeps the layout visible.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { color, float, instancedBufferAttribute, mx_noise_float, smoothstep, texture, vec2 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { CRASH_KINDS, type CrashKind } from '../../shared/crashKinds.ts';
import { crashSitesNear, pieceY, type CrashPiece, type CrashSite } from '../../shared/crashsites.ts';
import { EDIT_CELL, EDIT_CHUNK, edits } from '../../shared/terrain.ts';
import { CrashSmoke } from './crashSmoke.ts';
import { time } from './env.ts';

const MODEL_URL = './models/crashsites.glb';
const GLOW = 'CrashGlow';
/** Sites whose centre is within this distance (m) are drawn. */
export const CRASH_VIEW = 1000;
/** Rebuild the instances after moving this far (m). */
const REBUILD = 40;
/** Instances per kind: main wrecks appear once per site, debris several times. */
const MAX_SITES = 24;
const MAIN_CAPACITY = MAX_SITES;
const DEBRIS_CAPACITY = MAX_SITES * 8;

type Part = { mesh: THREE.InstancedMesh; phase: THREE.InstancedBufferAttribute | null };
type Kind = { parts: Part[]; count: number; capacity: number };

const _q = new THREE.Quaternion();
const _qt = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
const _t = new THREE.Matrix4();

/** Per-site flicker phase in [0, 1), from the id (visual only). */
function sitePhase(id: number): number {
  let h = Math.imul(id ^ 0x5bd1e995, 0x27d4eb2d);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Irregular emissive flicker for a phase in [0, 1): a slow uneven breathing, a fast shimmer and now and
 * then a dropout, like a failing power bus.
 */
function flicker(phase: Node<'float'>): Node<'float'> {
  const p = phase.mul(37.1);
  const slow = mx_noise_float(vec2(time.mul(1.7).add(p), p.mul(0.37)));
  const fast = mx_noise_float(vec2(time.mul(13).add(p.mul(1.3)), p.add(4.1)));
  const drop = smoothstep(0.45, 0.6, mx_noise_float(vec2(time.mul(0.55).add(p.mul(0.7)), p.add(9.3))));
  return float(0.82).add(slow.mul(0.16)).add(fast.mul(0.06)).mul(float(1).sub(drop.mul(0.8)));
}

/** A glow material that flickers per instance (phase attribute), copying the source's look. */
function glowMaterial(src: THREE.Material | null, phase: THREE.InstancedBufferAttribute): THREE.Material {
  const s = src as THREE.MeshStandardMaterial | null;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0 });
  m.name = GLOW;
  m.color.copy(s?.color ?? new THREE.Color(0x1a0d08));
  if (s?.map) m.map = s.map;
  const emissive = s && s.emissive && s.emissive.getHex() !== 0 ? s.emissive.clone().multiplyScalar(Math.max(1, s.emissiveIntensity)) : new THREE.Color(0xff6a2a).multiplyScalar(3);
  const ph = instancedBufferAttribute(phase, 'float') as unknown as Node<'float'>;
  const tint = s?.emissiveMap ? texture(s.emissiveMap).rgb.mul(color(emissive)) : color(emissive);
  m.emissiveNode = tint.mul(flicker(ph));
  return m;
}

export class CrashSites {
  private group = new THREE.Group();
  private kinds: Kind[] = [];
  private smoke: CrashSmoke;
  private lastX = NaN;
  private lastZ = NaN;
  private dirty = false;
  /** Sites currently drawn, nearest first (also read by the sound and debug). */
  sites: CrashSite[] = [];

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    this.smoke = new CrashSmoke(scene);
    new GLTFLoader().load(MODEL_URL, (gltf) => this.init(gltf.scene), undefined, (err) => {
      console.warn('crashsites: failed to load the model; drawing placeholder boxes', err);
      this.init(null);
    });
    const prev = edits.onChange;
    edits.onChange = (cx, cz) => {
      prev?.(cx, cz);
      const span = EDIT_CHUNK * EDIT_CELL;
      const x = (cx + 0.5) * span, z = (cz + 0.5) * span;
      for (const s of this.sites) if (Math.abs(s.x - x) < s.radius + span && Math.abs(s.z - z) < s.radius + span) this.dirty = true;
    };
  }

  private init(root: THREE.Object3D | null) {
    root?.updateMatrixWorld(true);
    this.kinds = CRASH_KINDS.map((kind) => {
      const capacity = kind.main ? MAIN_CAPACITY : DEBRIS_CAPACITY;
      const node = root?.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(kind.node));
      const parts = node ? this.partsFrom(node, capacity) : [];
      if (!parts.length) {
        if (root) console.warn(`crashsites: no node "${kind.node}"; drawing a placeholder`);
        parts.push(...this.placeholder(kind, capacity));
      }
      return { parts, count: 0, capacity };
    });
    this.dirty = true;
  }

  /** One InstancedMesh per mesh under `node`, its geometry baked into the node's frame (minus its position). */
  private partsFrom(node: THREE.Object3D, capacity: number): Part[] {
    const parts: Part[] = [];
    _t.makeTranslation(-node.matrixWorld.elements[12], -node.matrixWorld.elements[13], -node.matrixWorld.elements[14]);
    node.traverse((o) => {
      const src = o as THREE.Mesh;
      if (!src.isMesh) return;
      const geo = src.geometry.clone().applyMatrix4(_m.multiplyMatrices(_t, src.matrixWorld));
      const mats = Array.isArray(src.material) ? src.material : [src.material];
      // Multi-material meshes come out of GLTFLoader as one mesh per primitive, so one material here.
      const mat = mats[0];
      parts.push(this.part(geo, mat, mat.name === GLOW, capacity));
    });
    return parts;
  }

  private part(geo: THREE.BufferGeometry, mat: THREE.Material, glow: boolean, capacity: number): Part {
    const phase = glow ? new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1) : null;
    const mesh = new THREE.InstancedMesh(geo, phase ? glowMaterial(mat, phase) : mat, capacity);
    mesh.castShadow = !glow;
    mesh.receiveShadow = true;
    mesh.count = 0;
    this.group.add(mesh);
    return { mesh, phase };
  }

  /** Grey boxes around the hitbox capsules (reaching below the sand), plus a glowing cube at the beacon. */
  private placeholder(kind: CrashKind, capacity: number): Part[] {
    const boxes = kind.capsules.map((c) => {
      const g = new THREE.BoxGeometry(2 * c.r, c.h + 1, 2 * (c.half + c.r));
      g.rotateY(Math.atan2(c.ax, c.az));
      g.translate(c.x, (c.h - 1) / 2, c.z);
      return g;
    });
    const hull = boxes.length > 1 ? mergeGeometries(boxes)! : boxes[0] ?? new THREE.BoxGeometry(1, 1, 1);
    const metal = new THREE.MeshStandardNodeMaterial({ color: 0x5c4a3e, roughness: 0.55, metalness: 0.6 });
    const [bx, by, bz] = kind.beacon;
    const light = new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(bx, by, bz);
    return [this.part(hull, metal, false, capacity), this.part(light, new THREE.MeshStandardMaterial({ color: 0x1a0d08 }), true, capacity)];
  }

  /** Called every frame with the local player's position. */
  update(focus: THREE.Vector3) {
    if (!this.kinds.length) return;
    if (!this.dirty && Math.hypot(focus.x - this.lastX, focus.z - this.lastZ) < REBUILD) return;
    this.lastX = focus.x;
    this.lastZ = focus.z;
    this.dirty = false;
    this.sites = crashSitesNear(focus.x, focus.z, CRASH_VIEW).slice(0, MAX_SITES);
    for (const k of this.kinds) k.count = 0;
    for (const s of this.sites) {
      const phase = sitePhase(s.id);
      for (const pc of s.pieces) this.place(pc, phase);
    }
    for (const k of this.kinds) {
      for (const p of k.parts) {
        p.mesh.count = k.count;
        p.mesh.instanceMatrix.needsUpdate = true;
        if (p.phase) p.phase.needsUpdate = true;
        p.mesh.computeBoundingSphere();
      }
    }
    this.smoke.setSites(this.sites);
  }

  private place(pc: CrashPiece, phase: number) {
    const kind = this.kinds[pc.kind];
    if (!kind || kind.count >= kind.capacity) return;
    _q.setFromEuler(_e.set(0, Math.atan2(pc.dx, pc.dz), 0));
    if (pc.i > 0) {
      // Debris lies a little askew (visual only; its hitbox stays upright).
      const a = Math.sin(pc.x * 12.9898 + pc.z * 78.233) * 43758.5453;
      const f = a - Math.floor(a);
      _qt.setFromEuler(_e.set((f - 0.5) * 0.3, 0, (f * 7 % 1 - 0.5) * 0.4));
      _q.multiply(_qt);
    }
    _p.set(pc.x, pieceY(pc), pc.z);
    _m.compose(_p, _q, _s);
    const i = kind.count++;
    for (const p of kind.parts) {
      p.mesh.setMatrixAt(i, _m);
      if (p.phase) p.phase.setX(i, (phase + pc.i * 0.137) % 1);
    }
  }
}
