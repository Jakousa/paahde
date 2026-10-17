// Draws the things placed on the bunker floor (shared/placed.ts): plant beds with their growth stage
// (shared/garden.ts) and UV lamp stands, from public/models/placeables/*.glb (tools/blender/placeables.py),
// lit by the bunker's indoor lights. A lamp throws a violet pool of light on the soil (or the floor) under it.
// Also the see-through green / red preview of where the held placeable would go (src/placing.ts).
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { float, smoothstep, uv } from 'three/tsl';
import { EMPTY, STAGE_NODES, type BedState } from '../../shared/garden.ts';
import { bedLit, PLACE_FLOOR_Y, PLACEABLES, type Placed } from '../../shared/placed.ts';
import type { Base } from './base';

/** Height of the bed's soil (tools/blender/placeables.py SOIL), for the lamp's light pool. */
const SOIL = 0.45;

export class PlacedView {
  private group = new THREE.Group();
  private models: Record<string, THREE.Object3D> = {};
  private shown = new Map<number, { p: Placed; obj: THREE.Object3D }>();
  private ghost: { kind: string; obj: THREE.Object3D } | null = null;
  private ghostOk = new THREE.MeshBasicNodeMaterial({ color: 0x7dff9a, transparent: true, opacity: 0.4, depthWrite: false });
  private ghostBad = new THREE.MeshBasicNodeMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.4, depthWrite: false });
  private pool = poolMaterial();
  private last: { list: Placed[]; garden: Map<number, BedState> } = { list: [], garden: new Map() };

  constructor(scene: THREE.Scene, base: Base) {
    scene.add(this.group);
    const loader = new GLTFLoader();
    for (const kind of Object.keys(PLACEABLES)) {
      loader.load(
        `./models/placeables/${kind}.glb`,
        (gltf) => {
          gltf.scene.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            m.castShadow = m.receiveShadow = true;
            m.material = Array.isArray(m.material) ? m.material.map((mt) => base.indoorMaterial(mt)) : base.indoorMaterial(m.material);
          });
          this.models[kind] = gltf.scene;
          this.sync(this.last.list, this.last.garden);
        },
        undefined,
        (err) => console.warn(`placed: failed to load ${kind}.glb`, err),
      );
    }
  }

  /** Match the drawn things to the list and the beds' stages. Call when either changes. */
  sync(list: Placed[], garden: Map<number, BedState>) {
    this.last = { list, garden };
    const ids = new Set(list.map((p) => p.id));
    for (const [id, s] of this.shown) {
      if (ids.has(id)) continue;
      this.group.remove(s.obj);
      this.shown.delete(id);
    }
    for (const p of list) {
      const model = this.models[p.kind];
      if (!model) continue;
      let s = this.shown.get(p.id);
      if (!s) {
        const obj = model.clone();
        obj.position.set(p.x, PLACE_FLOOR_Y, p.z);
        obj.rotation.y = p.rot ? Math.PI / 2 : 0;
        if (p.kind === 'uv_lamp') {
          const pool = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.55), this.pool);
          pool.name = 'pool';
          pool.rotation.x = -Math.PI / 2;
          obj.add(pool);
        }
        this.group.add(obj);
        this.shown.set(p.id, (s = { p, obj }));
      }
      if (p.kind === 'plant_bed') {
        const stage = garden.get(p.id)?.stage ?? EMPTY;
        STAGE_NODES.forEach((n, i) => {
          const o = n && s!.obj.getObjectByName(n);
          if (o) o.visible = i === stage;
        });
      } else if (p.kind === 'uv_lamp') {
        const pool = s.obj.getObjectByName('pool');
        if (pool) pool.position.y = list.some((b) => b.kind === 'plant_bed' && bedLit(b, [p])) ? SOIL + 0.01 : 0.01;
      }
    }
  }

  /** The placement preview: `kind` at `at`, green if it fits, red if not; null hides it. */
  preview(kind: string | null, at: { x: number; z: number; rot: number } | null, ok: boolean) {
    if (!kind || !at || !this.models[kind]) {
      if (this.ghost) this.ghost.obj.visible = false;
      return;
    }
    if (this.ghost?.kind !== kind) {
      if (this.ghost) this.group.remove(this.ghost.obj);
      const obj = this.models[kind].clone();
      STAGE_NODES.forEach((n) => {
        const o = n && obj.getObjectByName(n);
        if (o) o.visible = false;
      });
      obj.traverse((o) => ((o as THREE.Mesh).castShadow = false));
      this.group.add(obj);
      this.ghost = { kind, obj };
    }
    const g = this.ghost.obj;
    g.visible = true;
    g.position.set(at.x, PLACE_FLOOR_Y + 0.005, at.z);
    g.rotation.y = at.rot ? Math.PI / 2 : 0;
    const mat = ok ? this.ghostOk : this.ghostBad;
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = mat;
    });
  }
}

/** The lamp's violet light on what's under it: additive, brightest in the middle, fading out to the edges. */
function poolMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({ color: 0xb04dff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const q = uv().sub(0.5).abs().mul(2);
  m.opacityNode = float(0.3).mul(float(1).sub(smoothstep(0.55, 1, q.x))).mul(float(1).sub(smoothstep(0.1, 1, q.y)));
  return m;
}
