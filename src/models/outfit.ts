// What a player avatar holds and wears, beyond the scavenger glb (src/models/scavenger.ts): stand-in models
// for the item in the hand (the selected hotbar slot) and for the wrist computer and storm detector when
// equipped (the backpack is part of the glb). Small boxes and cylinders, like the loot on the sand
// (src/world/loot.ts); parts use the disassembly part models (src/teardown/junk.ts). The laser rifle and pistol use
// their own models (public/models/rifle.glb, pistol.glb; tools/models/rifle.py, pistol.py), the jammer
// src/models/jammer.ts, the receivers src/models/receiver.ts.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { parsePart } from '../../shared/items.ts';
import { TIERS } from '../../shared/salvage.ts';
import { loadPart } from '../teardown/junk';
import { jammerModel } from './jammer';
import { grinderModel } from './grinder';
import { wrenchModel } from './wrench';
import { receiverModel } from './receiver';
import { BOSS_KINDS, RECEIVERS } from '../../shared/bosses.ts';

const mat = (color: number, rough = 0.8, metal = 0.2) => new THREE.MeshStandardNodeMaterial({ color, roughness: rough, metalness: metal });
const RUST = mat(0x7a4a2e, 0.9, 0.3);
const DARK = mat(0x2e2a26, 0.7, 0.4);
const STEEL = mat(0x8a8f86, 0.5, 0.7);
const CLOTH = mat(0x7a5e3a, 0.95, 0);
const WOOD = mat(0x6b4a2e, 0.9, 0);
const RED = mat(0xa84a32, 0.6, 0.3);
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
 * and carried by the caller. The canteen isn't here: it has its own model and drinking pose. `loaded` is for
 * models that arrive later.
 */
const HELD: Record<string, (loaded: () => void) => THREE.Object3D> = {
  // The first-person spyglass (public/models/telescope.glb; objective -Z, origin at the grip), carried collapsed: the
  // avatar places it and draws the tubes out as it's raised to the eye (scavenger.ts holdScope, userData.draws).
  spyglass: (loaded) => {
    const g = glbModel('./models/telescope.glb', () => {
      g.userData.draws = ['TelescopeDraw1', 'TelescopeDraw2'].map((n, i) => {
        const d = g.getObjectByName(n);
        if (d) d.position.z = DRAW_IN[i];
        return d;
      }).filter((d) => !!d);
      loaded();
    });
    return g;
  },
  backpack: () => {
    const g = new THREE.Group();
    box(g, 0.3, 0.36, 0.14, CLOTH, 0, -0.22, 0);
    handle(g, -0.04, 0.08);
    return g;
  },
  storm_detector: () => {
    const g = new THREE.Group();
    box(g, 0.12, 0.16, 0.08, STEEL, 0, -0.13, 0);
    cyl(g, 0.006, 0.25, DARK, -0.045, 0.07, 0.025);
    handle(g, -0.05, 0.05);
    return g;
  },
  wristpad: () => {
    const g = new THREE.Group();
    // On edge, its top edge in the fist.
    box(g, 0.03, 0.08, 0.16, CLOTH, 0, -0.03, 0);
    box(g, 0.02, 0.07, 0.07, DARK, -0.012, -0.035, 0);
    return g;
  },
  // Muzzle forward and a little down. The avatar turns and places the guns itself (scavenger.ts GUN_HOLD: the rifle
  // across the body in both hands, or shouldered to aim; the pistol by the thigh, or held out at arm's length).
  laser_rifle: (loaded) => {
    const g = gunModel('./models/rifle.glb', loaded, 0.087, 0.588);
    g.rotation.set(-0.25, Math.PI, 0); // the model's muzzle is +Z
    return g;
  },
  laser_pistol: (loaded) => {
    const g = gunModel('./models/pistol.glb', loaded, 0.064, 0.205);
    g.rotation.set(-0.45, Math.PI, 0);
    return g;
  },
  // Held like the pistol (src/models/jammer.ts is built in its frame), antenna forward.
  jammer: () => {
    const { obj: g, lamp } = jammerModel();
    g.userData.lamp = lamp; // blinked by the avatar while it's raised (src/models/scavenger.ts)
    g.rotation.set(-0.45, Math.PI, 0);
    shadows(g);
    return g;
  },
  // The grinder: held like the jammer.
  grinder: () => {
    const g = grinderModel().obj;
    g.rotation.set(0, Math.PI, 0);
    shadows(g);
    return g;
  },
  // The wrench (src/models/wrench.ts, built in the pistol's frame): held like the jammer, jaw up.
  wrench: () => {
    const g = wrenchModel().obj;
    g.rotation.set(-0.45, Math.PI, 0);
    shadows(g);
    return g;
  },
  // The receivers: held like the jammer.
  ...Object.fromEntries(BOSS_KINDS.map((k) => [RECEIVERS[k], () => {
    const g = receiverModel(k).obj;
    g.rotation.set(-0.45, Math.PI, 0);
    shadows(g);
    return g;
  }])),
};

const gunSrc = new Map<string, Promise<THREE.Object3D>>();

/**
 * The laser rifle or pistol (public/models/rifle.glb, pistol.glb): origin at the grip, muzzle +Z, up +Y, materials
 * 'Rifle' / 'Pistol' and the emissive glow. Empty until loaded (then `loaded` is called); each copy has its own
 * geometry, so disposeModel() can free it. A child 'Muzzle' marks the tip of the bore (`bore` m up, `tip` m forward:
 * rifle.py / pistol.py BZ, MUZZLE_Y), where its shots start (heldMuzzle).
 */
function gunModel(url: string, loaded: (() => void) | undefined, bore: number, tip: number): THREE.Group {
  const g = glbModel(url, loaded);
  const muzzle = new THREE.Object3D();
  muzzle.name = 'Muzzle';
  muzzle.position.set(0, bore, tip);
  g.add(muzzle);
  return g;
}

/** Spyglass draw tubes: glTF z of TelescopeDraw1 / 2 when pushed in (telescope.py COLLAPSED). */
export const DRAW_IN = [-0.075, -0.14];

/** A copy of the glb at `url` (fetched once), with its own geometry; empty until loaded, then `loaded` is called. */
function glbModel(url: string, loaded: (() => void) | undefined): THREE.Group {
  const g = new THREE.Group();
  let src = gunSrc.get(url);
  if (!src) gunSrc.set(url, (src = new GLTFLoader().loadAsync(url).then((gltf) => gltf.scene)));
  src.then(
    (src) => {
      const m = src.clone(true);
      m.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry = mesh.geometry.clone();
      });
      g.add(m);
      shadows(g);
      loaded?.();
    },
    (e) => console.warn(`${url} failed to load`, e),
  );
  return g;
}

/** The muzzle of a held gun (heldModel) in world space into `out`, or null if it has none. */
export function heldMuzzle(held: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 | null {
  const m = held.getObjectByName('Muzzle');
  if (!m) return null;
  m.updateWorldMatrix(true, false);
  return m.getWorldPosition(out);
}

/** A battered crate hanging from the hand by a rope handle: scrap, carried machines, anything without a model of its own. */
function crate(size = 0.28, lid: THREE.Material = RUST) {
  const g = new THREE.Group();
  box(g, size, size * 0.8, size * 0.85, WOOD, 0, -size * 0.45 - 0.04, 0);
  box(g, size * 1.04, 0.03, size * 0.9, lid, 0, -size * 0.08 - 0.04, 0);
  handle(g, -size * 0.065 - 0.04, Math.min(0.12, size * 0.5));
  return g;
}

/** A rope handle in the fist (the origin, running fore and aft), tied down to `top` at either end, `span` apart. */
function handle(g: THREE.Object3D, top: number, span: number) {
  box(g, 0.022, 0.022, span + 0.03, CLOTH);
  for (const z of [-span / 2, span / 2]) box(g, 0.016, -top, 0.016, CLOTH, 0, top / 2, z);
}

/** Size (m) parts are shrunk to in the hand. */
const PART_HELD = 0.22;

/** The model of `kind` held in the hand (see HELD); `loaded` is called if a part model arrives later. */
export function heldModel(kind: string, loaded: () => void): THREE.Object3D {
  const make = HELD[kind];
  if (make) return shadows(make(loaded));
  const part = parsePart(kind);
  if (!part) return shadows(crate());
  const g = new THREE.Group();
  loadPart(part.part, TIERS[part.tier]).then((m) => {
    const b = new THREE.Box3().setFromObject(m);
    const s = PART_HELD / Math.max(...b.getSize(new THREE.Vector3()).toArray(), 1e-3);
    m.scale.multiplyScalar(s);
    // Centred under the fist, tied to a rope handle.
    const c = b.getCenter(new THREE.Vector3()).multiplyScalar(s);
    m.position.set(-c.x, -0.05 - b.max.y * s, -c.z);
    g.add(m);
    handle(g, -0.05, Math.min(0.1, b.getSize(new THREE.Vector3()).z * s * 0.6));
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
  o.traverse((c) => {
    c.dispose();
    if ((c as THREE.Mesh).isMesh) (c as THREE.Mesh).geometry.dispose();
  });
}
