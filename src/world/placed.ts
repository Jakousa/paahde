// Draws the things placed on the floors and the sand (shared/placed.ts): plant beds with their growth stage
// (shared/garden.ts), UV lamp stands, and the buildings, the work stations and the chest, from
// public/models/placeables/*.glb (tools/blender/placeables.py, tools/blender/stations.py). Things on the bunker's floor
// are lit by its indoor lights, on a shelter's by the shelter's, sand things by the sky (Where: one copy of a model per
// kind and lighting, made as it's first needed). A lamp
// throws a violet pool of light on the soil (or the floor) under it. A building looks its tier (src/tierLook.ts, by
// the parts in it): the windmill's head turns into the wind and its rotor turns with it (shared/power.ts rotorSpeed:
// the wind now, the bearings), the tail folding it out of a gale, still while a bearing or the motor is missing; the
// battery station shows the cells it holds, each in its own tier, each one's lamp lit while it holds charge. A beacon
// (src/world/beacons.ts, its model made in code) lights its lens and its beam in its colour while it has power.
// A tarp (src/world/tarps.ts) is built in code for its own patch of sand, its canvas moving in the same wind.
// Also the see-through green / red preview of where the held placeable would go (src/placing.ts).
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { float, smoothstep, uv } from 'three/tsl';
import { WIND } from '../../shared/dunes.ts';
import { EMPTY, STAGE_NODES, type BedState } from '../../shared/garden.ts';
import { isBuilding, tierOf } from '../../shared/gear.ts';
import { furl, rotorSpeed, windSpeed, type PowerState } from '../../shared/power.ts';
import { parsePart } from '../../shared/items.ts';
import { BEACON, bedLit, PLACEABLES, TARP, type Placed } from '../../shared/placed.ts';
import { TARP_WIND, tarpModel } from './tarps.ts';
import { inBase } from '../../shared/base.ts';
import { inShelter } from '../../shared/shelters.ts';
import { BeaconBeams, beaconModel, LENS, lensColor } from './beacons.ts';
import { applyTier } from '../tierLook.ts';
import { cells } from '../../shared/power.ts';

/** What lights a placed thing: the sky (out on the sand), the bunker's lamps, a shelter's fill. */
export type Where = 'out' | 'bunker' | 'shelter';
const whereOf = (p: { x: number; y: number; z: number }): Where =>
  inBase(p.x, p.y + 0.1, p.z) ? 'bunker' : inShelter(p.x, p.y + 0.1, p.z) ? 'shelter' : 'out';

/** Height of the bed's soil (tools/blender/placeables.py SOIL), for the lamp's light pool. */
const SOIL = 0.45;
/** The battery station's cells, one per battery slot (shared/gear.ts GEAR.battery_station). */
const CELL_NODE = (i: number) => `battery_station_cell${i}`;
/** How fast the rotor takes up a change of wind (1/s): it has some heft. */
const ROTOR_LAG = 0.6;
/** A battery's lamp is lit above this share of its charge. */
const LIT = 0.02;
/** Folded right out of the wind, the head turns this far (rad). */
const FURLED = (75 * Math.PI) / 180;

type Shown = { p: Placed; obj: THREE.Object3D; head?: THREE.Object3D; rotor?: THREE.Object3D; spin: number; phase: number;
  /** A battery station's cells' lamps, by slot. */
  lamps?: THREE.Object3D[][];
  /** A beacon's lens (its own material). */
  lens?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicNodeMaterial> };

export class PlacedView {
  private group = new THREE.Group();
  /** Each kind's model as loaded, and its copies with each lighting's materials (`kind:where`). */
  private loaded: Record<string, THREE.Object3D> = {};
  private models = new Map<string, THREE.Object3D>();
  private material: (mt: THREE.Material, where: Where) => THREE.Material;
  private shown = new Map<number, Shown>();
  private ghost: { kind: string; obj: THREE.Object3D } | null = null;
  private ghostOk = new THREE.MeshBasicNodeMaterial({ color: 0x7dff9a, transparent: true, opacity: 0.4, depthWrite: false });
  private ghostBad = new THREE.MeshBasicNodeMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.4, depthWrite: false });
  private pool = poolMaterial();
  private last: { list: Placed[]; garden: Map<number, BedState> } = { list: [], garden: new Map() };
  private beams: BeaconBeams;

  /** `material` makes a model's material lit for where it stands. */
  constructor(scene: THREE.Scene, material: (mt: THREE.Material, where: Where) => THREE.Material) {
    scene.add(this.group);
    this.material = material;
    this.beams = new BeaconBeams(scene);
    const beacon = beaconModel();
    beacon.traverse((o) => ((o as THREE.Mesh).isMesh && o.name !== LENS && (o.castShadow = o.receiveShadow = true)));
    for (const w of ['out', 'bunker', 'shelter'] as Where[]) this.models.set(`${BEACON}:${w}`, beacon);
    const loader = new GLTFLoader();
    for (const kind of Object.keys(PLACEABLES)) {
      if (kind === BEACON || kind === TARP) continue;
      loader.load(
        `./models/placeables/${kind}.glb`,
        (gltf) => {
          gltf.scene.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh) m.castShadow = m.receiveShadow = true;
          });
          this.loaded[kind] = gltf.scene;
          this.sync(this.last.list, this.last.garden);
        },
        undefined,
        (err) => console.warn(`placed: failed to load ${kind}.glb`, err),
      );
    }
  }

  /** `kind`'s model lit for `where`, or undefined while it loads. */
  private model(kind: string, where: Where): THREE.Object3D | undefined {
    const key = `${kind}:${where}`;
    let m = this.models.get(key);
    if (m || !this.loaded[kind]) return m;
    m = this.loaded[kind].clone();
    const conv = new Map<THREE.Material, THREE.Material>();
    const one = (mt: THREE.Material) => {
      let c = conv.get(mt);
      if (!c) conv.set(mt, (c = this.material(mt, where)));
      return c;
    };
    m.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.material = Array.isArray(mesh.material) ? mesh.material.map(one) : one(mesh.material);
    });
    this.models.set(key, m);
    return m;
  }

  /** Match the drawn things to the list and the beds' stages. Call when either changes. */
  sync(list: Placed[], garden: Map<number, BedState>) {
    this.last = { list, garden };
    const ids = new Set(list.map((p) => p.id));
    for (const [id, s] of this.shown) {
      if (ids.has(id)) continue;
      this.group.remove(s.obj);
      if (s.p.kind === TARP) disposeGeometry(s.obj);
      this.shown.delete(id);
    }
    for (const p of list) {
      const model = p.kind === TARP ? undefined : this.model(p.kind, whereOf(p));
      if (!model && p.kind !== TARP) continue;
      let s = this.shown.get(p.id);
      if (!s) {
        const obj = p.kind === TARP ? tarpModel(p.x, p.y, p.z, p.rot, p.id) : model!.clone();
        obj.position.set(p.x, p.y, p.z);
        if (p.kind !== TARP) obj.rotation.y = p.rot ? Math.PI / 2 : 0;
        if (p.kind === 'uv_lamp') {
          const pool = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.55), this.pool);
          pool.name = 'pool';
          pool.rotation.x = -Math.PI / 2;
          obj.add(pool);
        }
        this.group.add(obj);
        const lens = obj.getObjectByName(LENS) as Shown['lens'] | undefined;
        if (lens) lens.material = lens.material.clone();
        const head = obj.getObjectByName('windmill_head') ?? undefined, rotor = obj.getObjectByName('windmill_rotor') ?? undefined;
        this.shown.set(p.id, (s = { p, obj, head, rotor, lens, spin: 0, phase: (p.id * 2.399) % (2 * Math.PI) }));
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
    this.lightBeacons();
  }

  /** A building's look from its parts: its tier, the windmill's spin, the battery station's cells. */
  private dress(s: Shown) {
    const it = { id: 0, kind: s.p.kind, n: 1, parts: s.p.parts ?? [] };
    applyTier(s.obj, tierOf(it));
    if (s.p.kind !== 'battery_station') return;
    s.lamps ??= it.parts.map((_, i) => {
      const out: THREE.Object3D[] = [];
      s.obj.getObjectByName(CELL_NODE(i))?.traverse((o) => {
        const m = o as THREE.Mesh;
        const name = ((m.userData.tierBase ?? m.material) as THREE.Material | undefined)?.name ?? '';
        if (m.isMesh && name.startsWith('EmitLed')) out.push(m);
      });
      return out;
    });
    this.light(s);
    it.parts.forEach((kind, i) => {
      const cell = s.obj.getObjectByName(CELL_NODE(i));
      if (!cell) return;
      cell.visible = !!kind;
      if (kind) applyTier(cell, parsePart(kind)?.tier ?? 1);
    });
  }

  /** The batteries' charge came in (shared/power.ts): each cell's lamp. */
  setPower(state: PowerState) {
    this.power = state;
    for (const s of this.shown.values()) if (s.lamps) this.light(s);
    this.lightBeacons();
  }

  /** The beacons the server says are lit: their lenses and beams in their colours, the rest dark. */
  private lightBeacons() {
    const lit = new Set(this.power.lit ?? []);
    const on: Placed[] = [];
    for (const s of this.shown.values()) {
      if (!s.lens) continue;
      const yes = lit.has(s.p.id);
      lensColor(s.p.color, yes, s.lens.material.color);
      if (yes) on.push(s.p);
    }
    this.beams.set(on);
  }

  private power: PowerState = { gen: {}, store: {} };

  /** A station's lamps: lit on each battery holding charge. */
  private light(s: Shown) {
    const charge = this.power.store[s.p.id]?.charge ?? [];
    const cs = cells(s.p.parts);
    s.lamps?.forEach((ls, i) => {
      const on = !!cs[i] && (charge[i] ?? 0) > cs[i]!.kwh * LIT;
      for (const l of ls) l.visible = on;
    });
  }

  /** Every frame: windmills turn their heads into the wind and their rotors with it. `worldMs`: the shared clock;
   *  `stormAt`: a sandstorm's strength at a point (0..1). */
  update(dt: number, worldMs: number, stormAt: (x: number, z: number) => number) {
    // Into the wind: the rotor (the head's +Z) faces where it comes from, swinging a little in the gusts.
    const into = Math.atan2(-WIND.x, -WIND.z);
    const t = performance.now() / 1000;
    // The tarps' canvas: the wind where the stormiest of them stands (one wind for them all; a storm is kilometres wide).
    let storm = 0;
    for (const s of this.shown.values()) if (s.p.kind === TARP) storm = Math.max(storm, stormAt(s.p.x, s.p.z));
    TARP_WIND.value = windSpeed(worldMs, storm);
    for (const s of this.shown.values()) {
      if (!s.head || !s.rotor) continue;
      const v = windSpeed(worldMs, stormAt(s.p.x, s.p.z));
      s.spin += (rotorSpeed(s.p.parts, v) - s.spin) * Math.min(1, dt * ROTOR_LAG);
      s.head.rotation.y = into - s.obj.rotation.y + furl(v) * FURLED + 0.08 * Math.sin(t * 0.37 + s.phase) + 0.04 * Math.sin(t * 1.1 + s.phase * 2);
      s.rotor.rotation.z -= s.spin * dt;
    }
  }

  /** The placement preview: `kind` at `at` (y: what it would stand on), green if it fits, red if not; null hides it. */
  preview(kind: string | null, at: { x: number; y: number; z: number; rot: number } | null, ok: boolean) {
    const model = kind && kind !== TARP ? this.model(kind, 'out') : undefined;
    if (!kind || !at || (!model && kind !== TARP)) {
      if (this.ghost) this.ghost.obj.visible = false;
      return;
    }
    // A tarp's is built for the spot (it stands on the sand under each pole).
    const spot = kind === TARP ? `${kind}:${at.x}:${at.z}:${at.rot}` : kind;
    if (this.ghost?.kind !== spot) {
      if (this.ghost) {
        this.group.remove(this.ghost.obj);
        if (this.ghost.kind.startsWith(`${TARP}:`)) disposeGeometry(this.ghost.obj);
      }
      const obj = kind === TARP ? tarpModel(at.x, at.y, at.z, at.rot) : model!.clone();
      STAGE_NODES.forEach((n) => {
        const o = n && obj.getObjectByName(n);
        if (o) o.visible = false;
      });
      obj.traverse((o) => ((o as THREE.Mesh).castShadow = false));
      this.group.add(obj);
      this.ghost = { kind: spot, obj };
    }
    const g = this.ghost.obj;
    g.visible = true;
    g.position.set(at.x, at.y + 0.005, at.z);
    if (kind !== TARP) g.rotation.y = at.rot ? Math.PI / 2 : 0;
    const mat = ok ? this.ghostOk : this.ghostBad;
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = mat;
    });
  }
}

/** Free a model's own geometry (one built for its spot: a tarp's), not its shared materials. */
function disposeGeometry(o: THREE.Object3D) {
  o.traverse((m) => (m as THREE.Mesh).isMesh && (m as THREE.Mesh).geometry.dispose());
}

/** The lamp's violet light on what's under it: additive, brightest in the middle, fading out to the edges. */
function poolMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({ color: 0xb04dff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const q = uv().sub(0.5).abs().mul(2);
  m.opacityNode = float(0.18).mul(float(1).sub(smoothstep(0.55, 1, q.x))).mul(float(1).sub(smoothstep(0.1, 1, q.y)));
  return m;
}
