// Loot on the sand (shared/loot.ts, from the server via src/net.ts): broken gear at crash sites and near the
// spawn, caches out in the desert, things dropped from a full bag. Gear has its own model (FIND_MODELS); parts use the disassembly
// part models (src/teardown/junk.ts); broken gear, parts and relics have a faint glow along their edges and a fainter pool
// on the sand, in the colour of their quality (RARITY; relics warm), so they catch the eye among the crash-site debris;
// anything else is a battered crate. Each sits on the sand where it is (also at the bottom of a hole).
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { cameraPosition, float, length, max, modelPosition, normalLocal, positionLocal, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import { GEAR, isGear, repaired, tierOf } from '../../shared/gear.ts';
import { applyTier } from '../tierLook';
import { RECEIVERS, RELICS } from '../../shared/bosses.ts';
import { RELIC_DROPS } from '../../shared/tables.ts';
import { parsePart, WIRING } from '../../shared/items.ts';
import { wrenchModel } from '../models/wrench';
import { lootReach, lootY, type Loot } from '../../shared/loot.ts';
import { RARITY, TIERS } from '../../shared/salvage.ts';
import { heightAt } from '../../shared/terrain.ts';
import { shelterFloorY } from '../../shared/shelters.ts';
import { loadPart } from '../teardown/junk';
import { viewCull } from './viewCull';
import { TEXT } from '../../shared/text.ts';

/** Drawn within this distance (m). */
const VIEW = 350;
/** Pickups made per frame as they come into range. */
const BUILDS_PER_FRAME = 3;
/** The glowing edge on broken gear: about this many m wide per m away (so it stays a pixel or two across), never
 * thinner than RIM_MIN (m) up close, and how far away it shows. */
const RIM_PER_M = 0.0024;
const RIM_MIN = 0.007;
export const RIM_VIEW = 160;
/** The warm pool on the sand under it: radius (m) and how far away it shows. */
const POOL_R = 0.75;
const POOL_VIEW = 45;

const mat = (color: number, rough = 0.8, metal = 0.2) => new THREE.MeshStandardNodeMaterial({ color, roughness: rough, metalness: metal });
const RUST = mat(0x7a4a2e, 0.9, 0.3);
const STEEL = mat(0x8a8f86, 0.5, 0.7);
const WOOD = mat(0x6b4a2e, 0.9, 0);
const glowPulse = uniform(1);
const rimPulse = uniform(1);
/** The glow's colour for an item of quality `tier` (0..3, RARITY), or a warm one for things without (relics). */
const WARM = 0xffa040;
export const glowColor = (tier: number | null) => (tier === null ? WARM : RARITY[TIERS[tier]].color);
/** How bright the rim is over its colour: a hint at the outline, only just touching the bloom (src/post.ts). */
const RIM_GAIN = 1.1;
const rimMats = new Map<number, THREE.Material>();
const poolMats = new Map<number, THREE.Material>();
/**
 * The glowing edge: each mesh of the model again, pushed out along its normals and drawn inside out, so only a thin
 * rim of it shows around the model's outline (the model itself hides the rest). Its width follows the distance from
 * the camera (RIM_PER_M), so it stays a pixel or two across. One material per colour.
 */
function rimMaterial(hex: number) {
  let m = rimMats.get(hex);
  if (m) return m;
  const n = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.BackSide, fog: false });
  const w = max(float(RIM_MIN), cameraPosition.distance(modelPosition).mul(RIM_PER_M));
  const c = new THREE.Color(hex);
  n.positionNode = positionLocal.add(normalLocal.mul(w));
  n.colorNode = vec3(c.r, c.g, c.b).mul(RIM_GAIN);
  n.opacityNode = rimPulse;
  rimMats.set(hex, n);
  return n;
}

/** Give every mesh under `root` its rim (see rimMaterial); also the broken vehicles' (src/world/vehicles.ts). */
export function addRims(root: THREE.Object3D, rims: THREE.Mesh[], hex: number) {
  const meshes: THREE.Mesh[] = [];
  const rim = rimMaterial(hex);
  root.traverse((o) => (o as THREE.Mesh).isMesh && !o.userData.rim && meshes.push(o as THREE.Mesh));
  for (const o of meshes) {
    const mesh = new THREE.Mesh(o.geometry, rim);
    mesh.userData.rim = mesh.userData.shared = true; // the geometry is the model's: disposed with it
    mesh.castShadow = mesh.receiveShadow = false;
    mesh.renderOrder = 2;
    o.add(mesh);
    rims.push(mesh);
  }
}

/** A faint disc of the glow's colour lying on the sand, breathing slowly (all of them together). */
function poolMaterial(hex: number) {
  let m = poolMats.get(hex);
  if (m) return m;
  const n = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const r = length(uv().sub(0.5));
  const soft = float(1).sub(smoothstep(0.0, 0.5, r));
  const c = new THREE.Color(hex);
  n.colorNode = vec3(c.r, c.g, c.b);
  n.opacityNode = soft.mul(soft).mul(glowPulse);
  n.polygonOffset = true;
  n.polygonOffsetFactor = -2;
  poolMats.set(hex, n);
  return n;
}
/** Laid over the sand vertex by vertex (drape()): a flat disc would sink into a slope and show a hard edge. */
const POOL_GEO = new THREE.PlaneGeometry(POOL_R * 2, POOL_R * 2, 8, 8).rotateX(-Math.PI / 2);

function box(g: THREE.Group, w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0, ry = 0, rz = 0) {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y, z);
  o.rotation.set(0, ry, rz);
  o.castShadow = true;
  g.add(o);
  return o;
}

/**
 * The real models of the gear (issue #8): the water bottle, telescope and guns are the held ones lying down; the rest
 * were made for lying on the sand (public/models/finds/, tools/blender/finds.py). `rot` lays the model down (XYZ, rad).
 */
const FIND_MODELS: Record<string, { url: string; rot?: [number, number, number] }> = {
  canteen: { url: './models/canteen.glb', rot: [-Math.PI / 2, 0, 0] },
  spyglass: { url: './models/telescope.glb' },
  laser_rifle: { url: './models/rifle.glb', rot: [0, 0, Math.PI / 2] },
  laser_pistol: { url: './models/pistol.glb', rot: [0, 0, Math.PI / 2] },
  ...Object.fromEntries(['backpack', 'storm_detector', 'wristpad', 'jammer', 'grinder', ...Object.values(RECEIVERS)]
    .map((k) => [k, { url: `./models/finds/${k}.glb` }])),
  // Made upright, as worn: lies on its back, the emitter to the sky.
  shield: { url: './models/finds/shield.glb', rot: [-Math.PI / 2, 0, 0] },
};
/** The enemies' and bosses' own parts (shared/tables.ts RELIC_DROPS, shared/bosses.ts RELICS): tools/blender/relics.py. */
const RELIC_KINDS = new Set([...Object.values(RELIC_DROPS).map((r) => r.kind), ...Object.values(RELICS)]);
const findCache = new Map<string, Promise<THREE.Object3D>>();
const gltf = new GLTFLoader();

/** Load `kind`'s model (once), laid down and sat on the sand at the origin, into `g`; then rim it if `g` has rims. */
function addFind(g: THREE.Group, kind: string) {
  const spec = FIND_MODELS[kind];
  let p = findCache.get(kind);
  if (!p) {
    p = gltf.loadAsync(spec.url).then((m) => {
      const lay = new THREE.Group();
      lay.add(m.scene);
      if (spec.rot) lay.rotation.set(...spec.rot);
      const wrap = new THREE.Group();
      wrap.add(lay);
      const b = new THREE.Box3().setFromObject(wrap);
      const c = b.getCenter(new THREE.Vector3());
      lay.position.set(-c.x, -b.min.y, -c.z);
      return wrap;
    });
    findCache.set(kind, p);
  }
  p.then((src) => {
    const m = src.clone(true);
    m.traverse((o) => {
      o.castShadow = true;
      o.userData.shared = true; // every copy shares the loaded geometry: never disposed
    });
    g.add(m);
    if (g.userData.tier !== undefined) applyTier(m, g.userData.tier);
    if (g.userData.rims) addRims(m, g.userData.rims, g.userData.glow);
  }, (e) => console.warn(`${spec.url} failed to load`, e));
}

type Shown = { obj: THREE.Group; rims: THREE.Mesh[] | null; pool: THREE.Mesh | null; poolY: number; l: Loot; age: number; frozen: boolean };

/** Lay the pool's vertices just above the sand around (x, z), wherever it has been dug. */
function drape(pool: THREE.Mesh, x: number, z: number) {
  const pos = pool.geometry.getAttribute('position') as THREE.BufferAttribute;
  const floor = shelterFloorY(x, z);
  for (let i = 0; i < pos.count; i++) pos.setY(i, (floor ?? heightAt(x + pos.getX(i), z + pos.getZ(i))) + 0.04);
  pos.needsUpdate = true;
  pool.geometry.computeBoundingSphere();
}

export class LootView {
  private group = new THREE.Group();
  private shown = new Map<number, Shown>();
  private t = 0;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  /** Every frame: draw loot near the player, drop what's gone or out of view. */
  update(dt: number, loot: Map<number, Loot>, me: { x: number; z: number }) {
    this.t += dt;
    glowPulse.value = 0.08 + 0.025 * Math.sin(this.t * 1.6);
    rimPulse.value = 0.3 + 0.08 * Math.sin(this.t * 2.2);
    for (const [id, s] of this.shown) {
      const l = loot.get(id);
      if (!l || Math.hypot(l.x - me.x, l.z - me.z) > VIEW + 20) {
        this.group.remove(s.obj);
        s.obj.traverse((o) => (o as THREE.Mesh).isMesh && !o.userData.shared && (o as THREE.Mesh).geometry.dispose());
        if (s.pool) {
          this.group.remove(s.pool);
          s.pool.geometry.dispose();
        }
        this.shown.delete(id);
      }
    }
    let built = 0;
    for (const l of loot.values()) {
      const d = Math.hypot(l.x - me.x, l.z - me.z);
      if (d > VIEW) continue;
      let s = this.shown.get(l.id);
      if (!s) {
        if (built >= BUILDS_PER_FRAME) continue; // a few a frame: each one makes its models and materials
        built++;
        s = this.build(l);
        this.shown.set(l.id, s);
      }
      s.l = l;
      s.age += dt;
      // Follows the sand (it may be dug around, or sit at the bottom of the hole it came out of), or a shelter's floor. Its matrix
      // is made only when it moves: a pickup lies still, and every object under it would otherwise be rebuilt every frame.
      const y = lootY(l) - 0.02;
      const p = s.obj.position;
      if (p.x !== l.x || p.y !== y || p.z !== l.z) {
        p.set(l.x, y, l.z);
        s.obj.updateMatrix();
        s.obj.matrixWorldNeedsUpdate = true;
      }
      if (!s.frozen && s.age > 1.5) {
        s.frozen = true;
        s.obj.traverse((o) => {
          if (o === s!.obj) return;
          o.updateMatrix();
          o.matrixAutoUpdate = false;
        });
      }
      // Out of view (and not close enough for its shadow to matter): not drawn at all.
      const seen = d < 12 || viewCull.visible(l.x, y + 0.3, l.z, 2);
      s.obj.visible = seen;
      if (s.rims) {
        const on = d < RIM_VIEW;
        for (const r of s.rims) r.visible = on;
      }
      if (s.pool) {
        s.pool.visible = seen && d < POOL_VIEW;
        if (s.pool.visible && s.poolY !== s.obj.position.y) {
          s.poolY = s.obj.position.y;
          drape(s.pool, l.x, l.z);
        }
      }
    }
  }

  /** The surface loot in reach that the player looks most nearly at (the F target), or null. */
  target(me: { x: number; y: number; z: number }, yaw: number): Loot | null {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    let best: Loot | null = null, bestScore = -Infinity;
    for (const s of this.shown.values()) {
      const l = s.l;
      const dx = l.x - me.x, dz = l.z - me.z;
      const d = Math.hypot(dx, dz);
      if (!lootReach(me, l)) continue;
      const facing = d < 0.6 ? 1 : (dx * fx + dz * fz) / d;
      if (facing < 0.3) continue;
      const score = facing - d * 0.3;
      if (score > bestScore) {
        bestScore = score;
        best = l;
      }
    }
    return best;
  }

  private build(l: Loot): Shown {
    const obj = new THREE.Group();
    let rims: THREE.Mesh[] | null = null;
    let pool: THREE.Mesh | null = null;
    // (Wiring lies there as a Scrap-tier coil, which is what it comes out of: shared/parts.ts UNTIERED.)
    const part = parsePart(l.kind) ?? (l.kind === WIRING ? { part: 'coil' as const, tier: 0 } : null);
    // Broken gear, parts and relics glow along their edges, with a faint pool on the sand around them: small and
    // dark, they'd otherwise be lost on the sand (a boss's spoils scattered over its wreck, a kill's drop). The colour
    // tells their quality: a part's tier, gear's tier from the parts it still has (tierOf).
    const item = { id: 0, kind: l.kind, n: 1, parts: l.parts };
    const glow = isGear(l.kind) ? !repaired(item) : !!part || RELIC_KINDS.has(l.kind);
    const hex = glowColor(isGear(l.kind) ? tierOf(item) : part ? part.tier : null);
    if (glow) {
      rims = obj.userData.rims = [];
      obj.userData.glow = hex;
      // In the loot group, not the turned model: its vertices follow the sand (drape()).
      pool = new THREE.Mesh(POOL_GEO.clone(), poolMaterial(hex));
      pool.position.set(l.x, 0, l.z);
      pool.updateMatrix();
      pool.matrixAutoUpdate = false; // (it lies where it was put: only its vertices follow the sand)
      pool.renderOrder = 1;
      this.group.add(pool);
    }
    if (isGear(l.kind)) {
      // Gear looks its parts' tier (src/tierLook.ts): broken, it's Scrap at best.
      obj.userData.tier = tierOf(item);
      if (FIND_MODELS[l.kind]) addFind(obj, l.kind);
      if (rims) addRims(obj, rims, hex);
    } else if (l.kind === 'grinder') {
      addFind(obj, l.kind); // a tool, not gear: its model lies in FIND_MODELS
    } else if (l.kind === 'wrench') {
      // Lying flat on the sand (it is modelled standing up in the hand), a little bigger to be seen.
      const w = wrenchModel().obj;
      w.rotation.z = Math.PI / 2;
      w.position.y = 0.01;
      w.scale.setScalar(1.6);
      obj.add(w);
    } else if (RELIC_KINDS.has(l.kind)) {
      FIND_MODELS[l.kind] ??= { url: `./models/items/${l.kind}.glb` };
      addFind(obj, l.kind);
    } else if (part) {
      const add = (m: THREE.Object3D) => {
        obj.add(m);
        if (rims) addRims(m, rims, hex);
      };
      loadPart(part.part, TIERS[part.tier]).then((m) => {
        m.scale.multiplyScalar(0.7);
        m.traverse((o) => { o.userData.shared = true; }); // the cached part's geometry: never disposed
        add(m);
      }, () => add(box(new THREE.Group(), 0.3, 0.2, 0.3, STEEL, 0, 0.1, 0)));
    } else {
      // A battered crate for anything else (scrap, carried machines).
      box(obj, 0.5, 0.36, 0.4, WOOD, 0, 0.18, 0);
      box(obj, 0.52, 0.05, 0.42, RUST, 0, 0.3, 0);
    }
    obj.rotation.y = (l.id * 2.39996) % (Math.PI * 2); // some variety, the same for everyone
    obj.updateMatrix();
    obj.matrixAutoUpdate = false; // moved by update() only when the pickup moves
    this.group.add(obj);
    return { obj, rims, pool, poolY: NaN, l, age: 0, frozen: false };
  }
}

/** The F prompt for a piece of loot: gear with parts missing says how many it has. */
export function lootPrompt(l: Loot, label: (kind: string) => string): string {
  const n = isGear(l.kind) ? GEAR[l.kind].slots.length : 0;
  const have = (l.parts ?? []).filter(Boolean).length;
  return have < n ? TEXT.prompt.pickUpBroken(label(l.kind), have, n) : TEXT.prompt.pickUp(label(l.kind));
}
