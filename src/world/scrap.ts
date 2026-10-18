// Scrap piles: draws the junkyard props (public/models/junkyard_props.glb) that shared/scrap.ts lays
// out over the desert — barrels, gears, sheets and planks, some half-buried or sticking up out of the
// sand. The layout and hitboxes live in shared/scrap.ts (the server collides players with them too);
// this only turns each piece into an instance matrix.
//
// Only cells within VIEW_CELLS of the player are drawn; each prop kind is one InstancedMesh, rebuilt
// when the player crosses into another cell, the ground under a pile is dug, or a piece is picked up
// or respawns.
//
// Model: "Junkyard Props" by haroonimtiaz35, CC-BY-4.0
// https://sketchfab.com/3d-models/junkyard-props-37343a1b386f4d75879be93319dbb717
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SCRAP_CELL, SCRAP_KINDS, scrapListeners, scrapPieces, scrapTaken, type ScrapPiece } from '../../shared/scrap.ts';
import { EDIT_CELL, EDIT_CHUNK, edits, heightAt, normalAt } from '../../shared/terrain.ts';

const MODEL_URL = './models/junkyard_props.glb';

/** Cells drawn around the player's cell in each direction (4 → up to ~400 m away). */
const VIEW_CELLS = 4;
/** Instance capacity per kind: enough for every piece in view to be that kind. */
const CAPACITY = (2 * VIEW_CELLS + 1) ** 2 * 8;

type Kind = { mesh: THREE.InstancedMesh; half: THREE.Vector3; count: number };

const _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _rot = new THREE.Matrix3();

export class Scrap {
  private group = new THREE.Group();
  private kinds: (Kind | undefined)[] = [];
  private cellX = NaN;
  private cellZ = NaN;
  private dirty = false;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    scrapListeners.push(() => (this.dirty = true)); // picked up or respawned
    new GLTFLoader().load(MODEL_URL, (gltf) => this.init(gltf.scene), undefined, (err) => console.warn('scrap: failed to load', err));
    const prev = edits.onChange;
    edits.onChange = (cx, cz) => {
      prev?.(cx, cz);
      // Re-seat props only if the edited chunk is within the drawn area.
      const span = EDIT_CHUNK * EDIT_CELL;
      const mx = Math.floor(((cx + 0.5) * span) / SCRAP_CELL), mz = Math.floor(((cz + 0.5) * span) / SCRAP_CELL);
      if (Math.abs(mx - this.cellX) <= VIEW_CELLS && Math.abs(mz - this.cellZ) <= VIEW_CELLS) this.dirty = true;
    };
  }

  private init(root: THREE.Object3D) {
    root.updateMatrixWorld(true);
    let material: THREE.Material | undefined;
    this.kinds = SCRAP_KINDS.map((kind) => {
      const node = root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(kind.node));
      let src: THREE.Mesh | undefined;
      node?.traverse((o) => { if (!src && (o as THREE.Mesh).isMesh) src = o as THREE.Mesh; });
      if (!src) { console.warn(`scrap: no mesh "${kind.node}"`); return undefined; }
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
      return { mesh, half, count: 0 };
    });
    this.dirty = true;
  }

  /** A lone mesh of scrap kind `kind` (SCRAP_KINDS index), centred on its middle, for junk in flight
   *  (src/throw.ts); null until the model has loaded. */
  mesh(kind: number): THREE.Mesh | null {
    const k = this.kinds[kind];
    if (!k) return null;
    const m = new THREE.Mesh(k.mesh.geometry, k.mesh.material);
    m.castShadow = true;
    return m;
  }

  /** Called every frame with the local player's position. */
  update(focus: THREE.Vector3) {
    if (!this.kinds.length) return;
    const cx = Math.floor(focus.x / SCRAP_CELL), cz = Math.floor(focus.z / SCRAP_CELL);
    if (cx === this.cellX && cz === this.cellZ && !this.dirty) return;
    this.cellX = cx;
    this.cellZ = cz;
    this.dirty = false;
    for (const k of this.kinds) if (k) k.count = 0;
    for (let iz = cz - VIEW_CELLS; iz <= cz + VIEW_CELLS; iz++) {
      for (let ix = cx - VIEW_CELLS; ix <= cx + VIEW_CELLS; ix++) {
        for (const pc of scrapPieces(ix, iz)) this.place(pc);
      }
    }
    for (const k of this.kinds) {
      if (!k) continue;
      k.mesh.count = k.count;
      k.mesh.instanceMatrix.needsUpdate = true;
      k.mesh.computeBoundingSphere(); // for frustum culling of the whole batch
    }
  }

  private place(pc: ScrapPiece) {
    const kind = this.kinds[pc.kind];
    if (!kind || kind.count >= CAPACITY || scrapTaken.has(pc.key)) return;
    _qb.setFromEuler(_e.set(Math.atan2(pc.ts, pc.tc), Math.atan2(pc.dx, pc.dz), pc.roll));
    // Lean with the ground, a little: props rest on dune slopes instead of poking out. Pieces with a
    // hitbox stay upright so their top matches where players stand.
    normalAt(pc.x, pc.z, _n);
    _n.lerp(_up, pc.hitbox ? 1 : 0.25).normalize();
    _qa.setFromUnitVectors(_up, _n);
    _q.multiplyQuaternions(_qa, _qb);
    // Vertical support depth of the rotated bounding box: sum |(R·e_i).y| · half_i. The same rule as
    // the hitbox height in shared/scrap.ts.
    _rot.setFromMatrix4(_m.makeRotationFromQuaternion(_q));
    const e = _rot.elements, h = kind.half;
    const depth = (Math.abs(e[1]) * h.x + Math.abs(e[4]) * h.y + Math.abs(e[7]) * h.z) * pc.scale;
    _p.set(pc.x, heightAt(pc.x, pc.z) + depth * (1 - pc.sink), pc.z);
    _m.compose(_p, _q, _s.setScalar(pc.scale));
    kind.mesh.setMatrixAt(kind.count++, _m);
  }
}
