// The home base: draws the bunker (public/models/base/bunker.glb) where shared/base.ts lays it out (the
// same layout the physics collides with). Made by tools/blender/base/bunker.py.
//
// The terrain stays on top as the bunker's roof; `outsideTerrainHoles` cuts the sand away over the
// entrance and the skylight (colour and shadow), so the sun shines down the shaft onto the pump.
// Indoors the sky's hemisphere fill is wrong, so indoor surfaces are lit only by the sun (through the door
// and the skylight, shadowed by everything else), a bounce light under the skylight that follows the
// daylight, the bulb over the stairs, and a faint glow so the corners are never pitch black. Those lights
// are kept out of the scene so they don't shine through the walls onto the sand outside.
import * as THREE from 'three/webgpu';
import { bool, lights, positionWorld } from 'three/tsl';
import type { LightsNode, Node } from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BASE, BASE_PIECES, FLOOR, HUT, ROOM, ROOM_Z, TERRAIN_HOLES } from '../../shared/base.ts';
import { moonColor, sunColor, sunDirection, sunLight } from './env.ts';

/** False inside the holes cut in the terrain (shared/base.ts TERRAIN_HOLES): use as a material's maskNode. */
export function outsideTerrainHoles(): Node<'bool'> {
  let outside: Node<'bool'> = bool(true);
  for (const [x0, z0, x1, z1] of TERRAIN_HOLES) {
    const p = positionWorld;
    outside = outside.and(p.x.lessThan(x0).or(p.x.greaterThan(x1)).or(p.z.lessThan(z0)).or(p.z.greaterThan(z1)));
  }
  return outside;
}

/** Bounce light under the skylight: intensity at full daylight, and how far it reaches. */
const BOUNCE = { intensity: 10, distance: 16 };
/** The bulb over the stairs (local position matches tools/blender/base/bunker.py BULB). */
const BULB = { x: 0, y: 2.25, z: HUT.z0 + 0.25, intensity: 2, distance: 9 };
/** Never quite dark: emissive fraction of each surface's own colour. */
const GLOW = 0.03;

export class Base {
  readonly group = new THREE.Group();
  private bounce = new THREE.PointLight(0xffffff, 0, BOUNCE.distance, 1.2);
  private bulb = new THREE.PointLight(0xffb060, BULB.intensity, BULB.distance, 1.5);
  private tint = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.group.position.set(BASE.x, BASE.y, BASE.z);
    scene.add(this.group);
    this.bounce.position.set(BASE.x, BASE.y + FLOOR + ROOM.h - 0.6, BASE.z + ROOM_Z);
    this.bulb.position.set(BASE.x + BULB.x, BASE.y + BULB.y, BASE.z + BULB.z);
    this.bounce.updateMatrixWorld();
    this.bulb.updateMatrixWorld();
    new GLTFLoader().load(
      './models/base/bunker.glb',
      (gltf) => this.place(gltf.scene),
      undefined,
      (err) => console.warn('base: failed to load bunker.glb', err),
    );
  }

  private place(root: THREE.Object3D) {
    const lit = lights([sunLight, this.bounce, this.bulb]);
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
      const conv = (mt: THREE.Material) => convert(mt as THREE.MeshStandardMaterial, outdoors ? null : lit);
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
