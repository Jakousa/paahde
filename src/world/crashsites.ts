// Crash sites: draws the wrecks and debris (public/models/crashsites.glb, from tools/blender/crashsites.py)
// that shared/crashsites.ts lays out, including the ground dressing under each machine, and the smoke over the
// ones still smouldering (crashSmoke.ts: every site until someone picks something up there, shared/crash.ts
// crashVisited, or its large machine is stripped, crashSpent; one that goes in view fades out). The
// layout and hitboxes live in shared/crashsites.ts (the server collides players with them too); this only
// turns pieces into instance matrices.
//
// Each glb node (one per CRASH_KINDS entry) has a mesh per material. Every piece of every site within VIEW of the player is baked
// into world space and merged into ONE mesh per material (about seven draw calls for all the wrecks, instead of one instanced mesh
// per kind and material, ~100, each drawn again in every shadow cascade). A site's baked geometry is kept; the merged meshes are
// rebuilt when the set of sites in view changes, the sand under a piece is dug, or a debris piece is picked up (crashTaken) or lies
// there again. Wrecks are big landmarks, so the view distance is long.
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
import { attribute, color, float, mx_noise_float, smoothstep, texture, vec2 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { CRASH_KINDS, type CrashKind } from '../../shared/crashKinds.ts';
import { crashListeners, crashSpent, crashTaken, crashVisited } from '../../shared/crash.ts';
import { crashSitesNear, pieceY, type CrashPiece, type CrashSite } from '../../shared/crashsites.ts';
import { EDIT_CELL, EDIT_CHUNK, edits, heightAt } from '../../shared/terrain.ts';
import { createSandMaterial } from './sandMaterial.ts';
import { CrashSmoke, STOP_TAPER } from './crashSmoke.ts';
import { time } from './env.ts';
import { tagBig } from './shadowLod.ts';

const MODEL_URL = './models/crashsites.glb';
const GLOW = 'CrashGlow';
/** Sites whose centre is within this distance (m) are drawn. */
export const CRASH_VIEW = 1000;
/** Rebuild the instances after moving this far (m). */
const REBUILD = 40;
/** Most sites drawn at once (the nearest). */
const MAX_SITES = 24;

/** One mesh of a kind, its geometry baked into the node's frame, and the material it is drawn with. */
type Part = { geo: THREE.BufferGeometry; mat: THREE.Material; glow: boolean };
/** One material of the dressing kinds: the source geometry per kind, and the merged, draped mesh. */
type Drape = { src: Map<number, THREE.BufferGeometry>; mesh: THREE.Mesh };
const SAND = 'CrashSand';

type Kind = { parts: Part[] };

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

/** A glow material that flickers per piece (the `phase` vertex attribute), copying the source's look. */
function glowMaterial(src: THREE.Material | null): THREE.Material {
  const s = src as THREE.MeshStandardMaterial | null;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0 });
  m.name = GLOW;
  m.color.copy(s?.color ?? new THREE.Color(0x1a0d08));
  if (s?.map) m.map = s.map;
  const emissive = s && s.emissive && s.emissive.getHex() !== 0 ? s.emissive.clone().multiplyScalar(Math.max(1, s.emissiveIntensity)) : new THREE.Color(0xff6a2a).multiplyScalar(3);
  const ph = attribute('phase', 'float') as unknown as Node<'float'>;
  const tint = s?.emissiveMap ? texture(s.emissiveMap).rgb.mul(color(emissive)) : color(emissive);
  m.emissiveNode = tint.mul(flicker(ph));
  return m;
}

export class CrashSites {
  private group = new THREE.Group();
  private kinds: Kind[] = [];
  private drapes = new Map<string, Drape>();
  /** The merged mesh of each material, the glow material made for each source material, and each site's baked geometry per material. */
  private meshes = new Map<THREE.Material, THREE.Mesh>();
  private glowMats = new Map<THREE.Material, THREE.Material>();
  private glowSet = new Set<THREE.Material>();
  private siteGeos = new Map<number, Map<THREE.Material, THREE.BufferGeometry>>();
  private siteKey = '';
  private smoke: CrashSmoke;
  private lastX = NaN;
  private lastZ = NaN;
  private dirty = false;
  /** Sites currently drawn, nearest first (also read by the sound and debug). */
  sites: CrashSite[] = [];
  /** Sites seen smouldering this session, and when the smoke of each one seen going spent or visited stops (`time`). */
  private live = new Set<number>();
  private stops = new Map<number, number>();
  private stopAt = (id: number) => {
    if (!crashSpent.has(id) && !crashVisited.has(id)) {
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
      const node = root?.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(kind.node));
      if (kind.dressing) {
        if (node) this.drapeFrom(ki, node);
        return { parts: [] };
      }
      const parts = node ? this.partsFrom(node) : [];
      if (!parts.length) {
        if (root) console.warn(`crashsites: no node "${kind.node}"; drawing a placeholder`);
        parts.push(...this.placeholder(kind));
      }
      return { parts };
    });
    this.siteKey = '';
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
        mesh.visible = false; // no vertices until at least one dressing piece uses this material
        mesh.castShadow = mat.name !== SAND;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        tagBig(mesh);
        this.group.add(mesh);
        this.drapes.set(mat.name, (d = { src: new Map(), mesh }));
      }
      const geo = src.geometry.clone().applyMatrix4(_m.multiplyMatrices(_t, src.matrixWorld));
      // Dressing is plain sand. Supply every terrain blend channel rather than relying on Three's missing-attribute fallback.
      if (mat.name === SAND) for (const name of ['crest', 'rock', 'mud', 'silt']) {
        geo.setAttribute(name, new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1));
      }
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
      const merged = geos.length ? mergeGeometries(geos) : null;
      d.mesh.visible = merged !== null; // empty placeholders must not compile main or shadow-pass shaders
      d.mesh.geometry.dispose();
      d.mesh.geometry = merged ?? new THREE.BufferGeometry();
      for (const g of geos) g.dispose();
    }
  }

  /** One Part per mesh under `node`, its geometry baked into the node's frame (minus its position). */
  private partsFrom(node: THREE.Object3D): Part[] {
    const parts: Part[] = [];
    _t.makeTranslation(-node.matrixWorld.elements[12], -node.matrixWorld.elements[13], -node.matrixWorld.elements[14]);
    node.traverse((o) => {
      const src = o as THREE.Mesh;
      if (!src.isMesh) return;
      const geo = src.geometry.clone().applyMatrix4(_m.multiplyMatrices(_t, src.matrixWorld));
      const mats = Array.isArray(src.material) ? src.material : [src.material];
      // Multi-material meshes come out of GLTFLoader as one mesh per primitive, so one material here.
      const mat = mats[0];
      parts.push({ geo, mat, glow: mat.name === GLOW });
    });
    return parts;
  }

  /** Grey boxes around the hitbox capsules (reaching below the sand), plus a glowing cube at the beacon. */
  private placeholder(kind: CrashKind): Part[] {
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
    return [{ geo: hull, mat: metal, glow: false }, { geo: light, mat: new THREE.MeshStandardMaterial({ color: 0x1a0d08 }), glow: true }];
  }

  /** Called every frame with the local player's position. */
  update(focus: THREE.Vector3) {
    if (!this.kinds.length) return;
    if (!this.dirty && Math.hypot(focus.x - this.lastX, focus.z - this.lastZ) < REBUILD) return;
    this.lastX = focus.x;
    this.lastZ = focus.z;
    this.sites = crashSitesNear(focus.x, focus.z, CRASH_VIEW).slice(0, MAX_SITES);
    const key = this.sites.map((s) => s.id).join(',');
    const changed = this.dirty || key !== this.siteKey;
    if (this.dirty) this.siteGeos.clear(); // a piece was taken or put back, or sand under one was dug
    this.dirty = false;
    if (changed) {
      this.siteKey = key;
      this.build();
      this.drape();
    }
    this.smoke.setSites(this.sites, this.stopAt);
  }

  /** The merged mesh of every material, from the baked geometry of each site in view. */
  private build() {
    const per = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const s of this.sites) {
      let geos = this.siteGeos.get(s.id);
      if (!geos) this.siteGeos.set(s.id, (geos = this.bake(s)));
      for (const [mat, g] of geos) {
        const list = per.get(mat);
        if (list) list.push(g);
        else per.set(mat, [g]);
      }
    }
    for (const [id, geos] of this.siteGeos) {
      if (this.sites.some((s) => s.id === id)) continue;
      for (const g of geos.values()) g.dispose();
      this.siteGeos.delete(id);
    }
    for (const [mat, mesh] of this.meshes) {
      const list = per.get(mat);
      mesh.visible = !!list;
      if (!list) continue;
      mesh.geometry.dispose();
      mesh.geometry = list.length === 1 ? list[0].clone() : mergeAll(list);
    }
    for (const [mat, list] of per) {
      if (this.meshes.has(mat)) continue;
      const glow = this.glowSet.has(mat);
      let drawn = mat;
      if (glow) {
        let g = this.glowMats.get(mat);
        if (!g) this.glowMats.set(mat, (g = glowMaterial(mat)));
        drawn = g;
      }
      const mesh = new THREE.Mesh(list.length === 1 ? list[0].clone() : mergeAll(list), drawn);
      mesh.castShadow = !glow;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // (it spans every site in view)
      tagBig(mesh);
      this.group.add(mesh);
      this.meshes.set(mat, mesh);
    }
  }

  /** One site's pieces placed in the world, merged per material (a glow part gets a flicker phase per piece). */
  private bake(site: CrashSite): Map<THREE.Material, THREE.BufferGeometry> {
    const lists = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const phase = sitePhase(site.id);
    for (const pc of site.pieces) {
      const kind = this.kinds[pc.kind];
      if (!kind || !kind.parts.length || (pc.id && crashTaken.has(pc.id))) continue;
      this.place(pc);
      for (const p of kind.parts) {
        const g = p.geo.clone().applyMatrix4(_m);
        if (p.glow) this.glowSet.add(p.mat);
        if (p.glow) g.setAttribute('phase', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill((phase + pc.i * 0.137) % 1), 1));
        const list = lists.get(p.mat);
        if (list) list.push(g);
        else lists.set(p.mat, [g]);
      }
    }
    const out = new Map<THREE.Material, THREE.BufferGeometry>();
    for (const [mat, list] of lists) {
      out.set(mat, mergeAll(list));
      for (const g of list) g.dispose();
    }
    return out;
  }

  /** `_m` = the world matrix of a piece. */
  private place(pc: CrashPiece) {
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
  }
}

/** mergeGeometries for geometries that may differ in what they carry: only the attributes all have are kept, and all are indexed or none. */
function mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (list.length === 1) return list[0].clone();
  const common = Object.keys(list[0].attributes).filter((n) => list.every((g) => n in g.attributes));
  const indexed = list.every((g) => g.index);
  const norm = list.map((g) => {
    const c = indexed ? g.clone() : g.index ? g.toNonIndexed() : g.clone();
    for (const n of Object.keys(c.attributes)) if (!common.includes(n)) c.deleteAttribute(n);
    return c;
  });
  const merged = mergeGeometries(norm)!;
  for (const g of norm) g.dispose();
  return merged;
}
