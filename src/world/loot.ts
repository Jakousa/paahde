// Loot on the sand (shared/loot.ts, from the server via src/net.ts): broken gear at crash sites and near the
// spawn, dug-up caches, things dropped from a full bag. Buried loot isn't drawn (the metal detector hears it,
// src/detector.ts). Gear is a small model built here from boxes and cylinders; broken gear has a twinkling
// glint and a faint warm pool on the sand so it catches the eye among the crash-site debris; parts use the disassembly part models (src/teardown/junk.ts);
// anything else is a battered crate. Each sits on the sand where it is (also at the bottom of a hole).
import * as THREE from 'three/webgpu';
import { float, length, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import { GEAR, isGear, repaired } from '../../shared/gear.ts';
import { parsePart } from '../../shared/items.ts';
import { LOOT_REACH, type Loot } from '../../shared/loot.ts';
import { TIERS } from '../../shared/salvage.ts';
import { heightAt } from '../../shared/terrain.ts';
import { loadPart } from '../teardown/junk';

/** Drawn within this distance (m). */
const VIEW = 350;
/** The glint on broken gear: size (m) up close, and how far away it shows (it fades out towards there). */
const GLINT_SIZE = 0.24;
const GLINT_VIEW = 160;
/** The warm pool on the sand under it: radius (m) and how far away it shows. */
const POOL_R = 0.75;
const POOL_VIEW = 45;

const mat = (color: number, rough = 0.8, metal = 0.2) => new THREE.MeshStandardNodeMaterial({ color, roughness: rough, metalness: metal });
const RUST = mat(0x7a4a2e, 0.9, 0.3);
const DARK = mat(0x2e2a26, 0.7, 0.4);
const STEEL = mat(0x8a8f86, 0.5, 0.7);
const CLOTH = mat(0x7a5e3a, 0.95, 0);
const RED = mat(0xa84a32, 0.6, 0.3);
const WOOD = mat(0x6b4a2e, 0.9, 0);
const glowPulse = uniform(1);
/** A small hot point with a soft falloff, added on top; each one twinkles by its scale. */
const GLINT = (() => {
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const r = length(uv().sub(0.5));
  const soft = float(1).sub(smoothstep(0.0, 0.5, r));
  m.colorNode = vec3(1.0, 0.8, 0.5);
  m.opacityNode = soft.mul(soft).mul(soft).mul(0.65);
  return m;
})();
/** A faint warm disc lying on the sand, breathing slowly (all of them together). */
const POOL = (() => {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const r = length(uv().sub(0.5));
  const soft = float(1).sub(smoothstep(0.0, 0.5, r));
  m.colorNode = vec3(1.0, 0.65, 0.32);
  m.opacityNode = soft.mul(soft).mul(glowPulse);
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  return m;
})();
const POOL_GEO = new THREE.PlaneGeometry(POOL_R * 2, POOL_R * 2).rotateX(-Math.PI / 2);

function box(g: THREE.Group, w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0, ry = 0, rz = 0) {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y, z);
  o.rotation.set(0, ry, rz);
  o.castShadow = true;
  g.add(o);
  return o;
}
function cyl(g: THREE.Group, r: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0, rx = 0, rz = 0) {
  const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 14), m);
  o.position.set(x, y, z);
  o.rotation.set(rx, 0, rz);
  o.castShadow = true;
  g.add(o);
  return o;
}

/** Small stand-in models for the gear, lying on the sand (origin at the ground). */
const GEAR_MODELS: Record<string, (g: THREE.Group) => void> = {
  motorcycle: (g) => {
    // Lying on its side.
    cyl(g, 0.36, 0.2, DARK, -0.65, 0.12, 0, 0, 0);
    cyl(g, 0.36, 0.2, DARK, 0.65, 0.12, 0.05, 0, 0);
    box(g, 1.1, 0.16, 0.3, RED, 0, 0.24, 0.05, 0, 0.1);
    box(g, 0.5, 0.12, 0.25, DARK, -0.1, 0.36, 0.05);
    box(g, 0.08, 0.6, 0.08, STEEL, 0.55, 0.3, 0.1, 0, 0.5);
  },
  spyglass: (g) => {
    cyl(g, 0.045, 0.32, RUST, 0, 0.05, 0, 0, Math.PI / 2);
    cyl(g, 0.055, 0.2, WOOD, 0.24, 0.055, 0, 0, Math.PI / 2);
  },
  canteen: (g) => {
    cyl(g, 0.14, 0.08, STEEL, 0, 0.14, 0, Math.PI / 2, 0).scale.set(1, 1, 1);
    cyl(g, 0.03, 0.05, WOOD, 0, 0.3, 0);
  },
  backpack: (g) => {
    box(g, 0.42, 0.22, 0.55, CLOTH, 0, 0.11, 0, 0.3);
    box(g, 0.36, 0.06, 0.3, WOOD, 0.03, 0.24, 0.08, 0.3);
  },
  storm_detector: (g) => {
    box(g, 0.24, 0.14, 0.32, STEEL, 0, 0.07, 0, 0.5);
    cyl(g, 0.01, 0.3, DARK, 0.06, 0.28, 0.1, 0.3, 0);
  },
  wristpad: (g) => {
    box(g, 0.12, 0.03, 0.4, CLOTH, 0, 0.015, 0, 0.8);
    box(g, 0.14, 0.04, 0.12, DARK, 0, 0.04, 0, 0.8);
  },
  metal_detector: (g) => {
    cyl(g, 0.015, 1.1, STEEL, 0, 0.03, 0, Math.PI / 2, 0);
    cyl(g, 0.16, 0.03, RUST, 0, 0.02, 0.6);
    box(g, 0.1, 0.08, 0.14, DARK, 0, 0.06, -0.3);
  },
  shovel: (g) => {
    cyl(g, 0.02, 1.0, WOOD, 0, 0.03, 0, Math.PI / 2, 0);
    box(g, 0.24, 0.03, 0.3, STEEL, 0, 0.03, 0.6);
  },
};

type Shown = { obj: THREE.Group; glint: THREE.Sprite | null; pool: THREE.Mesh | null; l: Loot };

export class LootView {
  private group = new THREE.Group();
  private shown = new Map<number, Shown>();
  private t = 0;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  /** Every frame: draw surface loot near the player, drop what's gone or out of view. */
  update(dt: number, loot: Map<number, Loot>, me: { x: number; z: number }) {
    this.t += dt;
    glowPulse.value = 0.16 + 0.05 * Math.sin(this.t * 1.6);
    for (const [id, s] of this.shown) {
      const l = loot.get(id);
      if (!l || l.depth > 0 || Math.hypot(l.x - me.x, l.z - me.z) > VIEW + 20) {
        this.group.remove(s.obj);
        s.obj.traverse((o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry !== POOL_GEO && (o as THREE.Mesh).geometry.dispose());
        this.shown.delete(id);
      }
    }
    for (const l of loot.values()) {
      if (l.depth > 0) continue;
      const d = Math.hypot(l.x - me.x, l.z - me.z);
      if (d > VIEW) continue;
      let s = this.shown.get(l.id);
      if (!s) {
        s = this.build(l);
        this.shown.set(l.id, s);
      }
      s.l = l;
      // Follows the sand (it may be dug around, or sit at the bottom of the hole it came out of).
      s.obj.position.set(l.x, heightAt(l.x, l.z) - 0.02, l.z);
      if (s.glint) {
        // Twinkles (its own phase), grows with distance so it stays a few pixels across, fades out before GLINT_VIEW.
        s.glint.visible = d < GLINT_VIEW;
        const tw = 0.7 + 0.3 * Math.sin(this.t * 3.1 + l.id * 1.7) * Math.sin(this.t * 1.3 + l.id);
        const k = GLINT_SIZE * tw * Math.max(1, d / 18) * Math.min(1, (GLINT_VIEW - d) / 40);
        s.glint.scale.set(k, k, 1);
      }
      if (s.pool) s.pool.visible = d < POOL_VIEW;
    }
  }

  /** The surface loot in reach that the player looks most nearly at (the F target), or null. */
  target(me: { x: number; z: number }, yaw: number): Loot | null {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    let best: Loot | null = null, bestScore = -Infinity;
    for (const s of this.shown.values()) {
      const l = s.l;
      const dx = l.x - me.x, dz = l.z - me.z;
      const d = Math.hypot(dx, dz);
      if (d >= LOOT_REACH) continue;
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
    let glint: THREE.Sprite | null = null;
    let pool: THREE.Mesh | null = null;
    const part = parsePart(l.kind);
    if (isGear(l.kind)) {
      GEAR_MODELS[l.kind]?.(obj);
      // Broken gear glints, with a faint warm pool on the sand around it.
      if (!repaired({ id: 0, kind: l.kind, n: 1, parts: l.parts })) {
        // Sits just on top of the model, over its middle (worked out before the group is turned).
        const b = new THREE.Box3().setFromObject(obj);
        glint = new THREE.Sprite(GLINT);
        glint.position.set((b.min.x + b.max.x) / 2, b.max.y + 0.03, (b.min.z + b.max.z) / 2);
        obj.add(glint);
        pool = new THREE.Mesh(POOL_GEO, POOL);
        pool.position.y = 0.04;
        pool.renderOrder = 1;
        obj.add(pool);
      }
    } else if (part) {
      loadPart(part.part, TIERS[part.tier]).then((m) => {
        m.scale.multiplyScalar(0.7);
        obj.add(m);
      }, () => box(obj, 0.3, 0.2, 0.3, STEEL, 0, 0.1, 0));
    } else {
      // A battered crate for anything else (scrap, carried machines).
      box(obj, 0.5, 0.36, 0.4, WOOD, 0, 0.18, 0);
      box(obj, 0.52, 0.05, 0.42, RUST, 0, 0.3, 0);
    }
    obj.rotation.y = (l.id * 2.39996) % (Math.PI * 2); // some variety, the same for everyone
    this.group.add(obj);
    return { obj, glint, pool, l };
  }
}

/** How a piece of loot is named in the F prompt. */
export function lootName(l: Loot, label: (kind: string) => string): string {
  if (!isGear(l.kind)) return label(l.kind);
  const n = GEAR[l.kind].slots.length;
  const have = (l.parts ?? []).filter(Boolean).length;
  return have === n ? label(l.kind) : `broken ${label(l.kind).toLowerCase()} (${have}/${n} parts)`;
}
