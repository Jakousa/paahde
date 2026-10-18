// The home base: draws the bunker (public/models/base/bunker.glb) where shared/base.ts lays it out (the
// same layout the physics collides with). Made by tools/blender/base/bunker.py.
//
// The terrain stays on top as the bunker's roof; `outsideTerrainHoles` cuts the sand away over the
// entrance and the skylight (colour and shadow), so the sun shines down the shaft onto the pump.
// Indoors the sky's hemisphere fill is wrong, so indoor surfaces are lit only by the sun (through the door
// and the skylight, shadowed by everything else), a bounce light under the skylight that follows the
// daylight, the bulb over the stairs, ceiling lamps (public/models/base/lamp.glb, tools/blender/base/lamp.py)
// in the hallway and the room, and a faint glow so the corners are never pitch black. Those lights are kept
// out of the scene so they don't shine through the walls onto the sand outside.
import * as THREE from 'three/webgpu';
import { bool, lights, positionWorld } from 'three/tsl';
import type { LightsNode, Node } from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BASE, BASE_PIECES, FLOOR, HALL, HUT, ROOM, ROOM_Z, STAIRS, TERRAIN_HOLES, vaultCrown } from '../../shared/base.ts';
import { moonColor, sunColor, sunDirection, sunLight } from './env.ts';
import { shelterHoles } from './shelters.ts';

/** False inside the holes cut in the terrain (shared/base.ts TERRAIN_HOLES, and the nearest shelters' huts,
 *  src/world/shelters.ts): use as a material's maskNode. */
export function outsideTerrainHoles(): Node<'bool'> {
  let outside: Node<'bool'> = bool(true);
  const p = positionWorld;
  for (const [x0, z0, x1, z1] of TERRAIN_HOLES) {
    outside = outside.and(p.x.lessThan(x0).or(p.x.greaterThan(x1)).or(p.z.lessThan(z0)).or(p.z.greaterThan(z1)));
  }
  for (const h of shelterHoles) {
    outside = outside.and(p.x.lessThan(h.x).or(p.x.greaterThan(h.z)).or(p.z.lessThan(h.y)).or(p.z.greaterThan(h.w)));
  }
  return outside;
}

/** Bounce light under the skylight: intensity at full daylight, and how far it reaches. */
const BOUNCE = { intensity: 14, distance: 22 };
/** The bulb over the stairs (local position matches tools/blender/base/bunker.py BULB). */
const BULB = { x: 0, y: 1.95, z: HUT.z0 + 0.25, intensity: 2, distance: 9 };
/** Ceiling lamps (local x, z; they hang from the ceiling there): the hallway, over the benches and the pump, by the
 *  room's front and back walls. Each has a warm point light at its bulb. */
/** Room lamps hang on rods from the ceiling, their mounts this high above the floor (shade bottom about 3.9 m). */
const LAMP_MOUNT = 4.3;
/** The work lamps over the workbench and the disassembly table hang low and bright (shade bottom about 2.4 m, above
 *  a head), so the benches and the machine being taken apart are well lit. The table's hangs a little higher, out
 *  of the camera's way when it looks down at the machine (src/teardown). */
const WORK_MOUNT = 2.7;
const TABLE_MOUNT = 3.2;
const BENCH_X = ROOM.w - 1.0;
const HALL_LAMP_Z = (STAIRS.z - STAIRS.n * STAIRS.run + HALL.z) / 2;
const LAMPS = [
  { x: 0, z: HALL_LAMP_Z, ceil: vaultCrown(HALL_LAMP_Z) - FLOOR, intensity: 0.8 },
  { x: -BENCH_X, z: ROOM_Z, ceil: WORK_MOUNT, intensity: 9 },
  { x: 0, z: ROOM_Z, ceil: TABLE_MOUNT, intensity: 9 },
  { x: BENCH_X, z: ROOM_Z, ceil: LAMP_MOUNT, intensity: 5.5 }, // over the pump
  { x: 0, z: HALL.z - 3, ceil: LAMP_MOUNT, intensity: 5.5 },
  { x: 0, z: ROOM.z + 3, ceil: LAMP_MOUNT, intensity: 5.5 },
];
/** The lamp's bulb below its ceiling mount (tools/blender/base/lamp.py BULB_Y), and its light's reach. */
const LAMP = { bulbY: -0.26, distance: 10, decay: 1.5 };
/** A work light at your eye while you take a machine apart on the table, so the face you are looking at is lit
 *  however it is turned (the lamp overhead only lights the top). Lights only the machine. */
const VIEW_LIGHT = { intensity: 7, distance: 8, decay: 1.2 };
/** Never quite dark: emissive fraction of each surface's own colour. */
const GLOW = 0.03;

export class Base {
  readonly group = new THREE.Group();
  private bounce = new THREE.PointLight(0xffffff, 0, BOUNCE.distance, 1.2);
  private bulb = new THREE.PointLight(0xffb060, BULB.intensity, BULB.distance, 1.5);
  private lamps = LAMPS.map((l) => new THREE.PointLight(0xffb060, l.intensity, LAMP.distance, LAMP.decay));
  private tint = new THREE.Color();
  private view = new THREE.PointLight(0xfff0dc, 0, VIEW_LIGHT.distance, VIEW_LIGHT.decay);

  constructor(scene: THREE.Scene) {
    this.group.position.set(BASE.x, BASE.y, BASE.z);
    scene.add(this.group);
    this.bounce.position.set(BASE.x, BASE.y + FLOOR + ROOM.h - 0.6, BASE.z + ROOM_Z);
    this.bulb.position.set(BASE.x + BULB.x, BASE.y + BULB.y, BASE.z + BULB.z);
    this.bounce.updateMatrixWorld();
    this.bulb.updateMatrixWorld();
    LAMPS.forEach((l, i) => {
      this.lamps[i].position.set(BASE.x + l.x, BASE.y + FLOOR + l.ceil + LAMP.bulbY, BASE.z + l.z);
      this.lamps[i].updateMatrixWorld();
    });
    const loader = new GLTFLoader();
    this.ready = Promise.all([
      loader.loadAsync('./models/base/bunker.glb').then(
        (gltf) => this.place(gltf.scene),
        (err) => console.warn('base: failed to load bunker.glb', err),
      ),
      loader.loadAsync('./models/base/lamp.glb').then(
        (gltf) => this.hangLamps(gltf.scene),
        (err) => console.warn('base: failed to load lamp.glb', err),
      ),
    ]).then(() => {});
  }

  /** Resolves once the bunker and its lamps are in place (or failed to load). */
  readonly ready: Promise<void>;

  private lit = lights([sunLight, this.bounce, this.bulb, ...this.lamps]);
  /** The bunker's lights and the work light at your eye, for the machine on the table. */
  private machineLit = lights([sunLight, this.bounce, this.bulb, ...this.lamps, this.view]);

  private place(root: THREE.Object3D) {
    const lit = this.lit;
    // The hut's outside keeps the scene's lights; everything indoors gets the bunker's.
    const hut = root.getObjectByName('hut');
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      let outdoors = false;
      for (let a: THREE.Object3D | null = m; a; a = a.parent) outdoors ||= a === hut;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      m.castShadow = !mats.some((mt) => mt.name.startsWith('Glass'));
      m.receiveShadow = true;
      const conv = (mt: THREE.Material) => {
        const c = convert(mt as THREE.MeshStandardMaterial, outdoors ? null : lit);
        // Cast from both sides. The shadow pass draws back faces only, and this model isn't made of closed
        // solids: the hut is one outer shell, hollow and open at the bottom, so its sunward roof and walls
        // never reached the shadow map, and the vault and the arch walls are single sheets. Only the 2 cm
        // concrete skins stood between the sun and the stairwell, too thin for the normal offset and PCF:
        // the sun leaked onto the walls in sawtooth bands and lit the steps underground.
        c.shadowSide = THREE.DoubleSide;
        return c;
      };
      m.material = Array.isArray(m.material) ? m.material.map(conv) : conv(m.material);
    });
    // The shell (hut, stairs, rooms) is placed at the origin; pieces from BASE_PIECES by node name.
    const pieces = new Set(BASE_PIECES.map((p) => p.node));
    for (const child of [...root.children]) {
      if (!pieces.has(child.name)) this.group.add(child);
    }
    for (const p of BASE_PIECES) {
      const src = root.getObjectByName(p.node);
      if (!src) {
        console.warn(`base: no node ${p.node} in bunker.glb`);
        continue;
      }
      const o = src.clone();
      o.position.set(p.x, p.y ?? 0, p.z);
      o.rotation.set(0, Math.atan2(p.fx, p.fz), 0);
      this.group.add(o);
    }
  }

  private hangLamps(root: THREE.Object3D) {
    const lamp = root.getObjectByName('lamp');
    if (!lamp) return console.warn('base: no node lamp in lamp.glb');
    lamp.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.receiveShadow = true;
      m.material = convert(m.material as THREE.MeshStandardMaterial, this.lit);
    });
    const rodMat = convert(new THREE.MeshStandardMaterial({ color: 0x3a3430, roughness: 0.7, metalness: 0.3 }), this.lit);
    for (const l of LAMPS) {
      const o = lamp.clone();
      o.position.set(l.x, FLOOR + l.ceil, l.z);
      this.group.add(o);
      const rod = l.ceil < ROOM.h ? ROOM.h - l.ceil : 0;
      if (rod > 0) {
        const r = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, rod, 6), rodMat);
        r.position.set(l.x, FLOOR + l.ceil + rod / 2, l.z);
        this.group.add(r);
      }
    }
  }

  /** A glTF material converted like the bunker's own, lit by its indoor lights (things placed on its floor). */
  indoorMaterial(src: THREE.Material): THREE.Material {
    return convert(src as THREE.MeshStandardMaterial, this.lit);
  }

  /** Light a machine on the disassembly table with the bunker's lights instead of the scene's, so the work
   *  lamps reach it at night, and with the work light at your eye (viewFrom). Changes its node materials in place. */
  lightIndoors(root: THREE.Object3D) {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      for (const mt of Array.isArray(m.material) ? m.material : [m.material]) {
        if ((mt as THREE.MeshStandardNodeMaterial).isMeshStandardNodeMaterial) {
          (mt as THREE.MeshStandardNodeMaterial).lightsNode = this.machineLit;
          mt.needsUpdate = true;
        }
      }
    });
  }

  /** Put the work light at the eye while working at the table (`at` null: off). */
  viewFrom(at: THREE.Vector3 | null) {
    this.view.intensity = at ? VIEW_LIGHT.intensity : 0;
    if (!at) return;
    this.view.position.copy(at);
    this.view.updateMatrixWorld();
  }

  /** Follow the daylight with the bounce under the skylight. */
  update() {
    const day = THREE.MathUtils.smoothstep(sunDirection.value.y, 0.0, 0.5);
    this.tint.copy(sunColor.value).multiplyScalar(day).add(moonColor.value);
    const level = Math.max(this.tint.r, this.tint.g, this.tint.b);
    this.bounce.color.copy(this.tint).multiplyScalar(level > 0 ? 1 / level : 0);
    this.bounce.intensity = BOUNCE.intensity * Math.min(level, 1.5);
  }
}

/** A node copy of a glTF material, with the bunker's own lights if `lit`; glass see-through, emissive bits glowing. */
function convert(src: THREE.MeshStandardMaterial, lit: LightsNode | null): THREE.Material {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = src.name;
  m.color.copy(src.color);
  m.roughness = src.roughness;
  m.metalness = src.metalness;
  m.side = src.side;
  m.vertexColors = src.vertexColors;
  if (lit) {
    m.lightsNode = lit;
    m.emissive.copy(src.color).multiplyScalar(GLOW);
  }
  if (src.name.startsWith('Glass')) {
    m.transparent = true;
    m.opacity = 0.22;
    m.depthWrite = false;
    m.side = THREE.DoubleSide;
    m.roughness = 0.05;
    m.metalness = 0;
  } else if (src.name.startsWith('Emit')) {
    m.emissive.copy(src.emissive);
    m.emissiveIntensity = Math.max(src.emissiveIntensity, 2);
  }
  return m;
}
