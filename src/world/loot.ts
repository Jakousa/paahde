// Loot on the sand (shared/loot.ts, from the server via src/net.ts): broken gear at crash sites and near the
// spawn, dug-up caches, things dropped from a full bag. Buried loot isn't drawn (the metal detector hears it,
// src/detector.ts). Gear is a small model built here from boxes and cylinders; broken gear has a small warm
// glow on it so it catches the eye among the crash-site debris; parts use the disassembly part models (src/teardown/junk.ts);
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
/** The glow on broken gear: size (m) up close, and how far away it shows (it fades out towards there). */
const GLOW_SIZE = 1.3;
const GLOW_VIEW = 160;

const mat = (color: number, rough = 0.8, metal = 0.2) => new THREE.MeshStandardNodeMaterial({ color, roughness: rough, metalness: metal });
const RUST = mat(0x7a4a2e, 0.9, 0.3);
const DARK = mat(0x2e2a26, 0.7, 0.4);
const STEEL = mat(0x8a8f86, 0.5, 0.7);
const CLOTH = mat(0x7a5e3a, 0.95, 0);
const RED = mat(0xa84a32, 0.6, 0.3);
const WOOD = mat(0x6b4a2e, 0.9, 0);
const glowPulse = uniform(1);
/** A soft warm disc, added on top (one material: all of them pulse together). */
const GLOW = (() => {
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const r = length(uv().sub(0.5));
  const soft = float(1).sub(smoothstep(0.0, 0.5, r));
  m.colorNode = vec3(1.0, 0.72, 0.38);
  m.opacityNode = soft.mul(soft).mul(glowPulse);
  return m;
})();

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

type Shown = { obj: THREE.Group; glow: THREE.Sprite | null; l: Loot };

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
    glowPulse.value = 0.55 + 0.15 * Math.sin(this.t * 2.2);
    for (const [id, s] of this.shown) {
      const l = loot.get(id);
      if (!l || l.depth > 0 || Math.hypot(l.x - me.x, l.z - me.z) > VIEW + 20) {
        this.group.remove(s.obj);
        s.obj.traverse((o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.dispose());
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
      if (s.glow) {
        // Grows a little with distance so it stays a few pixels across, fades out before GLOW_VIEW.
        s.glow.visible = d < GLOW_VIEW;
        const k = GLOW_SIZE * Math.max(1, d / 35) * Math.min(1, (GLOW_VIEW - d) / 40);
        s.glow.scale.set(k, k, 1);
      }
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
    obj.rotation.y = (l.id * 2.39996) % (Math.PI * 2); // some variety, the same for everyone
    let glow: THREE.Sprite | null = null;
    const part = parsePart(l.kind);
    if (isGear(l.kind)) {
      GEAR_MODELS[l.kind]?.(obj);
      // Broken gear glows faintly.
      if (!repaired({ id: 0, kind: l.kind, n: 1, parts: l.parts })) {
        glow = new THREE.Sprite(GLOW);
        glow.position.y = 0.7;
        obj.add(glow);
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
    this.group.add(obj);
    return { obj, glow, l };
  }
}

/** How a piece of loot is named in the F prompt. */
export function lootName(l: Loot, label: (kind: string) => string): string {
  if (!isGear(l.kind)) return label(l.kind);
  const n = GEAR[l.kind].slots.length;
  const have = (l.parts ?? []).filter(Boolean).length;
  return have === n ? label(l.kind) : `broken ${label(l.kind).toLowerCase()} (${have}/${n} parts)`;
}
