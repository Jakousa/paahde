// Crash sites: draws the wrecks and debris (public/models/crashsites.glb, from tools/blender/crashsites.py)
// that shared/crashsites.ts lays out, including the ground dressing under each machine, and the smoke over the
// ones still smouldering (crashSmoke.ts: every site until its large machine is stripped, shared/crash.ts
// crashSpent; one that goes spent in view fades out). The
// layout and hitboxes live in shared/crashsites.ts (the server collides players with them too); this only
// turns pieces into instance matrices.
//
// Each glb node (one per CRASH_KINDS entry) becomes one InstancedMesh per mesh/material in it, filled with
// every piece of that kind within VIEW of the player. Rebuilt when the player has moved REBUILD metres, the
// sand under a piece is dug, or a debris piece is picked up (crashTaken) or lies there again. Wrecks are big landmarks, so the view distance is long.
//
// Dressing pieces (the sand berms, cradle, straps and cables under each machine) are draped over the dunes
// instead: their vertices are lifted to the terrain under each one and every piece in view is merged into one
// mesh per material. Their sand is drawn with the terrain's own sand material, so berms blend into the dunes.
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
import { crashListeners, crashSpent, crashTaken } from '../../shared/crash.ts';
import { crashSitesNear, pieceY, type CrashPiece, type CrashSite } from '../../shared/crashsites.ts';
import { EDIT_CELL, EDIT_CHUNK, edits, heightAt } from '../../shared/terrain.ts';
import { createSandMaterial } from './sandMaterial.ts';
import { CrashSmoke, STOP_TAPER } from './crashSmoke.ts';
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
/** One material of the dressing kinds: the source geometry per kind, and the merged, draped mesh. */
type Drape = { src: Map<number, THREE.BufferGeometry>; mesh: THREE.Mesh };
const SAND = 'CrashSand';

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
  private drapes = new Map<string, Drape>();
  private smoke: CrashSmoke;
  private lastX = NaN;
  private lastZ = NaN;
  private dirty = false;
  /** Sites currently drawn, nearest first (also read by the sound and debug). */
  sites: CrashSite[] = [];
  /** Sites seen smouldering this session, and when the smoke of each one seen going spent stops (`time`). */
  private live = new Set<number>();
  private stops = new Map<number, number>();
  private stopAt = (id: number) => {
    if (!crashSpent.has(id)) {
      this.live.add(id);
      return Infinity;
    }
    let t = this.stops.get(id);
    if (t === undefined) this.stops.set(id, (t = this.live.has(id) ? time.value + STOP_TAPER : -Infinity));
    return t;
  };

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    this.smoke = new CrashSmoke(scene);
    crashListeners.push(() => (this.dirty = true));
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
    this.kinds = CRASH_KINDS.map((kind, ki) => {
      const capacity = kind.main ? MAIN_CAPACITY : DEBRIS_CAPACITY;
      const node = root?.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(kind.node));
      if (kind.dressing) {
        if (node) this.drapeFrom(ki, node);
        return { parts: [], count: 0, capacity: 0 };
      }
      const parts = node ? this.partsFrom(node, capacity) : [];
      if (!parts.length) {
        if (root) console.warn(`crashsites: no node "${kind.node}"; drawing a placeholder`);
        parts.push(...this.placeholder(kind, capacity));
      }
      return { parts, count: 0, capacity };
    });
    this.dirty = true;
  }

  /** Keep a dressing kind's meshes (in the node's frame) for draping, one Drape per material. */
  private drapeFrom(kind: number, node: THREE.Object3D) {
    _t.makeTranslation(-node.matrixWorld.elements[12], -node.matrixWorld.elements[13], -node.matrixWorld.elements[14]);
    node.traverse((o) => {
      const src = o as THREE.Mesh;
      if (!src.isMesh) return;
      const mat = (Array.isArray(src.material) ? src.material[0] : src.material) as THREE.Material;
      let d = this.drapes.get(mat.name);
      if (!d) {
        const m = mat.name === SAND ? createSandMaterial() : mat;
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), m);
        mesh.castShadow = mat.name !== SAND;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        this.group.add(mesh);
        this.drapes.set(mat.name, (d = { src: new Map(), mesh }));
      }
      const geo = src.geometry.clone().applyMatrix4(_m.multiplyMatrices(_t, src.matrixWorld));
      // The terrain's sand material reads a per-vertex crest weight (terrain.ts); dressing sand is never a crest.
      if (mat.name === SAND) geo.setAttribute('crest', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1));
      const prev = d.src.get(kind);
      d.src.set(kind, prev ? mergeGeometries([prev, geo])! : geo);
    });
  }

  /** Merge every dressing piece in view per material, each vertex lifted onto the (dug) terrain under it. */
  private drape() {
    for (const d of this.drapes.values()) {
      const geos: THREE.BufferGeometry[] = [];
      for (const s of this.sites) {
        for (const pc of s.pieces) {
          const src = d.src.get(pc.kind);
          if (!src) continue;
          const g = src.clone();
          const a = Math.atan2(pc.dx, pc.dz), c = Math.cos(a), sn = Math.sin(a);
          const pos = g.attributes.position as THREE.BufferAttribute;
          for (let i = 0; i < pos.count; i++) {
            const lx = pos.getX(i), lz = pos.getZ(i);
            const x = pc.x + lx * c + lz * sn, z = pc.z - lx * sn + lz * c;
            pos.setXYZ(i, x, pos.getY(i) + heightAt(x, z) - pc.sink, z);
          }
          // Positions are world now; the normals turn with the yaw.
          const nrm = g.attributes.normal as THREE.BufferAttribute | undefined;
          if (nrm) for (let i = 0; i < nrm.count; i++) {
            const nx = nrm.getX(i), nz = nrm.getZ(i);
            nrm.setXYZ(i, nx * c + nz * sn, nrm.getY(i), -nx * sn + nz * c);
          }
          geos.push(g);
        }
      }
      d.mesh.geometry.dispose();
      d.mesh.geometry = geos.length ? mergeGeometries(geos)! : new THREE.BufferGeometry();
      for (const g of geos) g.dispose();
    }
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
    this.drape();
    this.smoke.setSites(this.sites, this.stopAt);
  }

  private place(pc: CrashPiece, phase: number) {
    const kind = this.kinds[pc.kind];
    if (!kind || kind.count >= kind.capacity || (pc.id && crashTaken.has(pc.id))) return;
    _q.setFromEuler(_e.set(0, Math.atan2(pc.dx, pc.dz), 0));
    if (pc.i > 0 && !CRASH_KINDS[pc.kind].dressing) {
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
