// Draws the things placed on the bunker floor and the sand (shared/placed.ts): plant beds with their growth stage
// (shared/garden.ts), UV lamp stands, and the buildings, from public/models/placeables/*.glb
// (tools/blender/placeables.py). Floor things are lit by the bunker's indoor lights, sand things by the sky. A lamp
// throws a violet pool of light on the soil (or the floor) under it. A building looks its tier (src/tierLook.ts, by
// the parts in it): the windmill's head turns into the wind and its rotor spins, faster on better bearings and in a
// storm, and stands still while a part is missing; the battery station shows the cells it holds, each in its own tier.
// Also the see-through green / red preview of where the held placeable would go (src/placing.ts).
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { float, smoothstep, uv } from 'three/tsl';
import { WIND } from '../../shared/dunes.ts';
import { EMPTY, STAGE_NODES, type BedState } from '../../shared/garden.ts';
import { isBuilding, quality, repaired, tierOf, windmillSpin } from '../../shared/gear.ts';
import { parsePart } from '../../shared/items.ts';
import { bedLit, onSand, PLACEABLES, type Placed } from '../../shared/placed.ts';
import { applyTier } from '../tierLook.ts';
import type { Base } from './base';

/** Height of the bed's soil (tools/blender/placeables.py SOIL), for the lamp's light pool. */
const SOIL = 0.45;
/** The battery station's cells, one per battery slot (shared/gear.ts GEAR.battery_station). */
const CELL_NODE = (i: number) => `battery_station_cell${i}`;
/** A storm (0..1) spins the windmill this much faster on top. */
const STORM_SPIN = 2.5;

type Shown = { p: Placed; obj: THREE.Object3D; head?: THREE.Object3D; rotor?: THREE.Object3D; spin: number; phase: number };

export class PlacedView {
  private group = new THREE.Group();
  private models: Record<string, THREE.Object3D> = {};
  private shown = new Map<number, Shown>();
  private ghost: { kind: string; obj: THREE.Object3D } | null = null;
  private ghostOk = new THREE.MeshBasicNodeMaterial({ color: 0x7dff9a, transparent: true, opacity: 0.4, depthWrite: false });
  private ghostBad = new THREE.MeshBasicNodeMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.4, depthWrite: false });
  private pool = poolMaterial();
  private last: { list: Placed[]; garden: Map<number, BedState> } = { list: [], garden: new Map() };

  constructor(scene: THREE.Scene, base: Base) {
    scene.add(this.group);
    const loader = new GLTFLoader();
    for (const kind of Object.keys(PLACEABLES)) {
      const material = (mt: THREE.Material) => (onSand(kind) ? base.outdoorMaterial(mt) : base.indoorMaterial(mt));
      loader.load(
        `./models/placeables/${kind}.glb`,
        (gltf) => {
          gltf.scene.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            m.castShadow = m.receiveShadow = true;
            m.material = Array.isArray(m.material) ? m.material.map(material) : material(m.material);
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
        obj.position.set(p.x, p.y, p.z);
        obj.rotation.y = p.rot ? Math.PI / 2 : 0;
        if (p.kind === 'uv_lamp') {
          const pool = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.55), this.pool);
          pool.name = 'pool';
          pool.rotation.x = -Math.PI / 2;
          obj.add(pool);
        }
        this.group.add(obj);
        const head = obj.getObjectByName('windmill_head') ?? undefined, rotor = obj.getObjectByName('windmill_rotor') ?? undefined;
        this.shown.set(p.id, (s = { p, obj, head, rotor, spin: 0, phase: (p.id * 2.399) % (2 * Math.PI) }));
      }
      s.p = p;
      if (p.kind === 'plant_bed') {
        const stage = garden.get(p.id)?.stage ?? EMPTY;
        STAGE_NODES.forEach((n, i) => {
          const o = n && s!.obj.getObjectByName(n);
          if (o) o.visible = i === stage;
        });
      } else if (p.kind === 'uv_lamp') {
        const pool = s.obj.getObjectByName('pool');
        if (pool) pool.position.y = list.some((b) => b.kind === 'plant_bed' && bedLit(b, [p])) ? SOIL + 0.01 : 0.01;
      } else if (isBuilding(p.kind)) this.dress(s);
    }
  }

  /** A building's look from its parts: its tier, the windmill's spin, the battery station's cells. */
  private dress(s: Shown) {
    const it = { id: 0, kind: s.p.kind, n: 1, parts: s.p.parts ?? [] };
    applyTier(s.obj, tierOf(it));
    s.spin = repaired(it) && s.p.kind === 'windmill' ? windmillSpin(quality(it)) : 0;
    if (s.p.kind !== 'battery_station') return;
    it.parts.forEach((kind, i) => {
      const cell = s.obj.getObjectByName(CELL_NODE(i));
      if (!cell) return;
      cell.visible = !!kind;
      if (kind) applyTier(cell, parsePart(kind)?.tier ?? 1);
    });
  }

  /** Every frame: windmills turn their heads into the wind and spin. `storm`: the sandstorm here, 0..1. */
  update(dt: number, storm: number) {
    // Into the wind: the rotor (the head's +Z) faces where it comes from, swinging a little in the gusts.
    const into = Math.atan2(-WIND.x, -WIND.z);
    const t = performance.now() / 1000;
    for (const s of this.shown.values()) {
      if (!s.head || !s.rotor) continue;
      s.head.rotation.y = into - s.obj.rotation.y + 0.08 * Math.sin(t * 0.37 + s.phase) + 0.04 * Math.sin(t * 1.1 + s.phase * 2);
      s.rotor.rotation.z -= s.spin * (1 + STORM_SPIN * storm) * (1 + 0.15 * Math.sin(t * 0.6 + s.phase)) * dt;
    }
  }

  /** The placement preview: `kind` at `at` (y: what it would stand on), green if it fits, red if not; null hides it. */
  preview(kind: string | null, at: { x: number; y: number; z: number; rot: number } | null, ok: boolean) {
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
    g.position.set(at.x, at.y + 0.005, at.z);
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
  m.opacityNode = float(0.18).mul(float(1).sub(smoothstep(0.55, 1, q.x))).mul(float(1).sub(smoothstep(0.1, 1, q.y)));
  return m;
}
