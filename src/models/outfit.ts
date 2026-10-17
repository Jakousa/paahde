// What a player avatar holds and wears, beyond the scavenger glb (src/models/scavenger.ts): stand-in models
// for the item in the hand (the selected hotbar slot) and for the wrist computer and storm detector when
// equipped (the backpack is part of the glb). Small boxes and cylinders, like the loot on the sand
// (src/world/loot.ts); parts use the disassembly part models (src/teardown/junk.ts).
import * as THREE from 'three/webgpu';
import { parsePart } from '../../shared/items.ts';
import { TIERS } from '../../shared/salvage.ts';
import { loadPart } from '../teardown/junk';

const mat = (color: number, rough = 0.8, metal = 0.2) => new THREE.MeshStandardNodeMaterial({ color, roughness: rough, metalness: metal });
const RUST = mat(0x7a4a2e, 0.9, 0.3);
const DARK = mat(0x2e2a26, 0.7, 0.4);
const STEEL = mat(0x8a8f86, 0.5, 0.7);
const CLOTH = mat(0x7a5e3a, 0.95, 0);
const WOOD = mat(0x6b4a2e, 0.9, 0);
const RED = mat(0xa84a32, 0.6, 0.3);
const BRASS = mat(0xc09040, 0.45, 0.8);
const SCREEN = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0.35, 1, 0.75).multiplyScalar(1.6) });

function box(g: THREE.Object3D, w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y, z);
  g.add(o);
  return o;
}
/** A cylinder along Y. */
function cyl(g: THREE.Object3D, r: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0, open = false) {
  const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 12, 1, open), m);
  o.position.set(x, y, z);
  g.add(o);
  return o;
}

/** A long tool held at the side: built hanging down -Y from the grip, then tipped forward by `tip` (rad). */
function tool(tip: number, build: (g: THREE.Group) => void) {
  const g = new THREE.Group();
  build(g);
  g.rotation.x = tip;
  return g;
}

/**
 * Held items in the avatar root's space (forward -Z, right +X, up +Y) with the origin at the fist; tipped
 * and carried by the caller. The canteen isn't here: it has its own model and drinking pose.
 */
const HELD: Record<string, () => THREE.Object3D> = {
  shovel: () => tool(0.45, (g) => {
    cyl(g, 0.017, 1.0, WOOD, 0, -0.3, 0);
    box(g, 0.12, 0.03, 0.03, WOOD, 0, 0.2, 0); // T grip
    box(g, 0.22, 0.28, 0.02, STEEL, 0, -0.92, 0);
  }),
  metal_detector: (() => () => {
    const tip = 0.85;
    return tool(tip, (g) => {
      cyl(g, 0.012, 1.05, STEEL, 0, -0.45, 0);
      box(g, 0.07, 0.1, 0.11, DARK, 0, -0.05, -0.05);
      // The coil lies flat on the ground ahead.
      const coil = cyl(g, 0.14, 0.025, RUST, 0, -0.98, 0);
      coil.rotation.x = -tip;
    });
  })(),
  spyglass: () => {
    const g = new THREE.Group();
    cyl(g, 0.03, 0.42, BRASS, 0, 0, -0.06).rotation.x = Math.PI / 2;
    cyl(g, 0.038, 0.12, WOOD, 0, 0, 0.08).rotation.x = Math.PI / 2;
    g.rotation.x = -0.35; // eyepiece up a little
    return g;
  },
  backpack: () => {
    const g = new THREE.Group();
    box(g, 0.3, 0.36, 0.14, CLOTH, 0, -0.2, 0);
    box(g, 0.03, 0.04, 0.03, WOOD, 0, -0.01, 0);
    return g;
  },
  storm_detector: () => {
    const g = new THREE.Group();
    box(g, 0.12, 0.16, 0.08, STEEL, 0, -0.04, 0);
    cyl(g, 0.006, 0.25, DARK, 0.04, 0.16, 0);
    return g;
  },
  wristpad: () => {
    const g = new THREE.Group();
    box(g, 0.08, 0.03, 0.16, CLOTH, 0, -0.02, 0);
    box(g, 0.07, 0.02, 0.07, DARK, 0, 0.005, 0);
    return g;
  },
  motorcycle: () => crate(0.36, RED),
};

/** A battered crate hanging from the hand: scrap, carried machines, anything without a model of its own. */
function crate(size = 0.28, lid: THREE.Material = RUST) {
  const g = new THREE.Group();
  box(g, size, size * 0.8, size * 0.85, WOOD, 0, -size * 0.45, 0);
  box(g, size * 1.04, 0.03, size * 0.9, lid, 0, -size * 0.08, 0);
  return g;
}

/** Size (m) parts are shrunk to in the hand. */
const PART_HELD = 0.22;

/** The model of `kind` held in the hand (see HELD); `loaded` is called if a part model arrives later. */
export function heldModel(kind: string, loaded: () => void): THREE.Object3D {
  const make = HELD[kind];
  if (make) return shadows(make());
  const part = parsePart(kind);
  if (!part) return shadows(crate());
  const g = new THREE.Group();
  loadPart(part.part, TIERS[part.tier]).then((m) => {
    const b = new THREE.Box3().setFromObject(m);
    const s = PART_HELD / Math.max(...b.getSize(new THREE.Vector3()).toArray(), 1e-3);
    m.scale.multiplyScalar(s);
    m.position.y = -PART_HELD * 0.8;
    g.add(m);
    shadows(g);
    loaded();
  }, () => {
    g.add(crate(PART_HELD));
    shadows(g);
    loaded();
  });
  return g;
}

/** The wrist computer: a cuff round the forearm (along +Y) with a glowing screen on the back of the wrist (+Z). */
export function wristModel(): THREE.Object3D {
  const g = new THREE.Group();
  cyl(g, 0.045, 0.09, CLOTH, 0, 0, 0, true).material = CLOTH;
  box(g, 0.06, 0.075, 0.018, DARK, 0, 0, 0.048);
  box(g, 0.048, 0.06, 0.004, SCREEN, 0, 0, 0.058);
  return shadows(g);
}

/** The storm detector on the belt: a box facing out (+X) with a stubby antenna. */
export function beltModel(): THREE.Object3D {
  const g = new THREE.Group();
  box(g, 0.05, 0.11, 0.09, STEEL, 0, 0, 0);
  box(g, 0.006, 0.05, 0.06, DARK, 0.027, 0.02, 0);
  cyl(g, 0.004, 0.14, DARK, 0, 0.12, 0.03);
  return shadows(g);
}

function shadows<T extends THREE.Object3D>(o: T): T {
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) c.castShadow = c.receiveShadow = true;
  });
  return o;
}

/** Free a held model's geometries (the materials are shared). */
export function disposeModel(o: THREE.Object3D) {
  o.removeFromParent();
  o.traverse((c) => (c as THREE.Mesh).isMesh && (c as THREE.Mesh).geometry.dispose());
}
