// Scrap clusters: junkyard props (public/models/junkyard_props.glb) scattered over the desert in small
// piles — barrels, gears, sheets and planks, some half-buried or sticking up out of the sand.
//
// Placement is a pure function of WORLD_SEED and grid cell, so every client sees the same piles with
// no network traffic. Purely decorative: players walk through them (they are not in shared/sim.ts).
// Only cells within VIEW_CELLS of the player are populated; each prop kind is one InstancedMesh,
// rebuilt when the player crosses into another cell or the ground under a pile is dug.
//
// Model: "Junkyard Props" by haroonimtiaz35, CC-BY-4.0
// https://sketchfab.com/3d-models/junkyard-props-37343a1b386f4d75879be93319dbb717
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EDIT_CELL, EDIT_CHUNK, edits, heightAt, normalAt, WORLD_HALF, WORLD_SEED } from '../../shared/terrain.ts';

const MODEL_URL = './models/junkyard_props.glb';

/** Grid cell size (m); each cell holds at most one pile. */
const CELL = 90;
/** Fraction of cells that hold a pile. */
const DENSITY = 0.45;
/** Cells populated around the player's cell in each direction (4 → up to ~400 m away). */
const VIEW_CELLS = 4;
/** Piles avoid ground steeper than this (normal.y); the slip faces are ~32° (0.85). */
const MIN_FLATNESS = 0.9;
const PIECES_MIN = 3, PIECES_MAX = 8;
const PILE_RADIUS = 6;

type Pose = 'flat' | 'upright' | 'side' | 'stuck';

/**
 * Prop kinds by glTF node name (as authored; GLTFLoader sanitizes them), with a scale to real size
 * and how they tend to lie.
 */
const KINDS: { node: string; scale: number; weight: number; poses: [Pose, number][] }[] = [
  { node: 'Barrel v1 ', scale: 0.28, weight: 3, poses: [['upright', 0.5], ['side', 0.4], ['stuck', 0.1]] },
  { node: 'Barrel v2.001', scale: 0.28, weight: 2, poses: [['upright', 0.4], ['side', 0.5], ['stuck', 0.1]] },
  { node: 'Gear v1.001', scale: 0.35, weight: 1.5, poses: [['flat', 0.6], ['stuck', 0.4]] },
  { node: 'Metal peice 2 v1.001', scale: 0.45, weight: 2, poses: [['flat', 0.5], ['stuck', 0.5]] },
  { node: 'Metal peice 2 v2.001', scale: 0.45, weight: 2, poses: [['flat', 0.5], ['stuck', 0.5]] },
  { node: 'Metal plank v1.001', scale: 0.35, weight: 2, poses: [['flat', 0.6], ['stuck', 0.4]] },
  { node: 'Metal sheet v1.001', scale: 0.75, weight: 2, poses: [['flat', 0.6], ['stuck', 0.4]] },
  { node: 'Metal sheet v2.001', scale: 0.75, weight: 2, poses: [['flat', 0.6], ['stuck', 0.4]] },
  { node: 'Metal spring v1.001', scale: 0.3, weight: 1, poses: [['flat', 1]] },
];
const TOTAL_WEIGHT = KINDS.reduce((s, k) => s + k.weight, 0);
/** Instance capacity per kind: enough for every piece in view to be that kind. */
const CAPACITY = (2 * VIEW_CELLS + 1) ** 2 * PIECES_MAX;

/** Deterministic PRNG seeded from a cell (integer hashing only). */
function rng(ix: number, iz: number) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(WORLD_SEED, 0x9e3779b1) ^ 0x5c4a9;
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: number, items: [T, number][]): T {
  for (const [item, w] of items) if ((r -= w) < 0) return item;
  return items[items.length - 1][0];
}

type Kind = { mesh: THREE.InstancedMesh; half: THREE.Vector3; count: number };

const _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _rot = new THREE.Matrix3();

export class Scrap {
  private group = new THREE.Group();
  private kinds: Kind[] = [];
  private cellX = NaN;
  private cellZ = NaN;
  private dirty = false;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    new GLTFLoader().load(MODEL_URL, (gltf) => this.init(gltf.scene), undefined, (err) => console.warn('scrap: failed to load', err));
    const prev = edits.onChange;
    edits.onChange = (cx, cz) => {
      prev?.(cx, cz);
      // Re-seat props only if the edited chunk is within the populated area.
      const span = EDIT_CHUNK * EDIT_CELL;
      const mx = Math.floor(((cx + 0.5) * span) / CELL), mz = Math.floor(((cz + 0.5) * span) / CELL);
      if (Math.abs(mx - this.cellX) <= VIEW_CELLS && Math.abs(mz - this.cellZ) <= VIEW_CELLS) this.dirty = true;
    };
  }

  private init(root: THREE.Object3D) {
    root.updateMatrixWorld(true);
    let material: THREE.Material | undefined;
    for (const kind of KINDS) {
      const node = root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(kind.node));
      let src: THREE.Mesh | undefined;
      node?.traverse((o) => { if (!src && (o as THREE.Mesh).isMesh) src = o as THREE.Mesh; });
      if (!src) { console.warn(`scrap: no mesh "${kind.node}"`); continue; }
      // Bake the glTF's node transforms, scale to real size and centre on the bounding box, so
      // instances rotate about their middle.
      const geo = src.geometry.clone().applyMatrix4(src.matrixWorld).scale(kind.scale, kind.scale, kind.scale);
      geo.computeBoundingBox();
      const center = geo.boundingBox!.getCenter(new THREE.Vector3());
      geo.translate(-center.x, -center.y, -center.z);
      const half = geo.boundingBox!.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      // Every prop shares one atlas texture and identical settings: one material, one pipeline.
      if (!material) {
        material = src.material as THREE.Material;
        const map = (material as THREE.MeshStandardMaterial).map;
        if (map) map.anisotropy = 8;
      }
      const mesh = new THREE.InstancedMesh(geo, material, CAPACITY);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      this.group.add(mesh);
      this.kinds.push({ mesh, half, count: 0 });
    }
    this.dirty = true;
  }

  /** Called every frame with the local player's position. */
  update(focus: THREE.Vector3) {
    if (!this.kinds.length) return;
    const cx = Math.floor(focus.x / CELL), cz = Math.floor(focus.z / CELL);
    if (cx === this.cellX && cz === this.cellZ && !this.dirty) return;
    this.cellX = cx;
    this.cellZ = cz;
    this.dirty = false;
    for (const k of this.kinds) k.count = 0;
    for (let iz = cz - VIEW_CELLS; iz <= cz + VIEW_CELLS; iz++) {
      for (let ix = cx - VIEW_CELLS; ix <= cx + VIEW_CELLS; ix++) this.pile(ix, iz);
    }
    for (const k of this.kinds) {
      k.mesh.count = k.count;
      k.mesh.instanceMatrix.needsUpdate = true;
      k.mesh.computeBoundingSphere(); // for frustum culling of the whole batch
    }
  }

  /** Place the pile (if any) of grid cell (ix, iz). */
  private pile(ix: number, iz: number) {
    const r = rng(ix, iz);
    // The spawn cell always gets one, so new players see scrap straight away.
    if (r() >= DENSITY && !(ix === 0 && iz === 0)) return;
    // A few candidate centres; keep the first on reasonably flat ground (no piles on slip faces).
    let px = 0, pz = 0, ok = false;
    for (let t = 0; t < 4 && !ok; t++) {
      px = (ix + 0.1 + 0.8 * r()) * CELL;
      pz = (iz + 0.1 + 0.8 * r()) * CELL;
      ok = normalAt(px, pz, _n).y > MIN_FLATNESS && Math.abs(px) < WORLD_HALF && Math.abs(pz) < WORLD_HALF;
    }
    if (!ok) return;
    const n = PIECES_MIN + Math.floor(r() * (PIECES_MAX - PIECES_MIN + 1));
    for (let i = 0; i < n; i++) {
      // Pieces bunch towards the middle of the pile.
      const a = r() * Math.PI * 2, d = PILE_RADIUS * r() * (0.3 + 0.7 * r());
      this.piece(px + Math.cos(a) * d, pz + Math.sin(a) * d, r);
    }
  }

  private piece(x: number, z: number, r: () => number) {
    let w = r() * TOTAL_WEIGHT, ki = 0;
    while (ki < KINDS.length - 1 && (w -= KINDS[ki].weight) >= 0) ki++;
    const kind = this.kinds[ki];
    if (!kind || kind.count >= CAPACITY) return;
    const pose = pick(r(), KINDS[ki].poses);
    const yaw = r() * Math.PI * 2;
    // Orientation in the ground's frame (local Y = ground normal). Flat props have Y as their thin axis.
    let sink: number; // fraction of the support depth pushed into the sand
    switch (pose) {
      case 'upright': _e.set((r() - 0.5) * 0.15, yaw, (r() - 0.5) * 0.15, 'YXZ'); sink = 0.05 + 0.1 * r(); break;
      case 'side': _e.set(Math.PI / 2, yaw, 0, 'YXZ'); sink = 0.15 + 0.25 * r(); break;
      case 'stuck': _e.set(0.5 + r() * 0.8, yaw, (r() - 0.5) * 0.6, 'YXZ'); sink = 0.3 + 0.35 * r(); break;
      default: _e.set((r() - 0.5) * 0.25, yaw, (r() - 0.5) * 0.25, 'YXZ'); sink = 0.1 + 0.4 * r(); break;
    }
    _qb.setFromEuler(_e);
    // Lean with the ground (mostly) so props rest on dune slopes instead of floating.
    normalAt(x, z, _n);
    _n.lerp(_up, 0.25).normalize();
    _qa.setFromUnitVectors(_up, _n);
    _q.multiplyQuaternions(_qa, _qb);
    // Support depth of the rotated bounding box along the normal: sum |R·e_i · n| · half_i.
    _rot.setFromMatrix4(_m.makeRotationFromQuaternion(_q));
    const e = _rot.elements, h = kind.half;
    const depth = Math.abs(e[0] * _n.x + e[1] * _n.y + e[2] * _n.z) * h.x
      + Math.abs(e[3] * _n.x + e[4] * _n.y + e[5] * _n.z) * h.y
      + Math.abs(e[6] * _n.x + e[7] * _n.y + e[8] * _n.z) * h.z;
    const scale = 0.85 + 0.3 * r();
    const lift = depth * scale * (1 - sink);
    _p.set(x + _n.x * lift, heightAt(x, z) + _n.y * lift, z + _n.z * lift);
    _m.compose(_p, _q, _s.setScalar(scale));
    kind.mesh.setMatrixAt(kind.count++, _m);
  }
}
