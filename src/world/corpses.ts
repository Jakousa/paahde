// The packs dead players leave (shared/corpse.ts): a tied canvas bundle on the sand, and beside it a stick pushed in
// at a slant with a rag of the dead player's colour flapping from it, so it can be found again from a way off. The
// locator bar (src/locator.ts) shows each one as a flag; so does the spyglass (src/telescope.ts).
import * as THREE from 'three/webgpu';
import { CORPSES, type Corpse } from '../../shared/corpse.ts';
import { heightAt } from '../../shared/terrain.ts';
import type { LocatorTarget } from '../locator';

/** Drawn within this distance (m). */
const VIEW = 700;
/** The stick: length (m) and lean (rad). */
const STICK = 2.6;
const LEAN = 0.16;
/** The rag: width along the wind, height (m), and segments along it. */
const RAG_W = 0.75, RAG_H = 0.42, RAG_SEG = 8;

const CANVAS = new THREE.MeshStandardNodeMaterial({ color: 0x8a7350, roughness: 0.95, metalness: 0 });
const STRAP = new THREE.MeshStandardNodeMaterial({ color: 0x3e2c1c, roughness: 0.8, metalness: 0 });
const WOOD = new THREE.MeshStandardNodeMaterial({ color: 0x7a5a3a, roughness: 0.9, metalness: 0 });

const SACK_GEO = new THREE.SphereGeometry(0.34, 14, 10).scale(1.15, 0.62, 0.85);
const NECK_GEO = new THREE.CylinderGeometry(0.07, 0.12, 0.16, 10);
const STRAP_GEO = new THREE.TorusGeometry(0.3, 0.025, 6, 20);
const STICK_GEO = new THREE.CylinderGeometry(0.02, 0.028, STICK, 6).translate(0, STICK / 2, 0);

type Shown = { group: THREE.Group; rag: THREE.Mesh; phase: number };

/** Locator ids for packs: players are positive, home -1, wrecks count down from -100. */
const LOCATE_ID = -1_000_000_000;

/** Every pack lying in the world, for the locator bar: a flag of the rag's colour at the top of the stick. */
export function corpseTargets(): LocatorTarget[] {
  return [...CORPSES.values()].map((c) => ({ id: LOCATE_ID - c.id, color: c.color, x: c.x, y: heightAt(c.x, c.z) + STICK, z: c.z, shape: 'flag' }));
}

export class CorpseView {
  private group = new THREE.Group();
  private shown = new Map<number, Shown>();
  private time = 0;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  update(dt: number, me: { x: number; z: number }) {
    this.time += dt;
    for (const [id, s] of this.shown) {
      if (CORPSES.has(id)) continue;
      s.group.removeFromParent();
      s.rag.geometry.dispose();
      (s.rag.material as THREE.Material).dispose();
      this.shown.delete(id);
    }
    for (const c of CORPSES.values()) {
      let s = this.shown.get(c.id);
      if (!s) this.shown.set(c.id, (s = this.make(c)));
      // Sits on the sand as it is now (dug around, drifted over).
      s.group.position.set(c.x, heightAt(c.x, c.z) - 0.04, c.z);
      s.group.visible = Math.hypot(c.x - me.x, c.z - me.z) < VIEW;
      if (s.group.visible) this.flap(s);
    }
  }

  private make(c: Corpse): Shown {
    const g = new THREE.Group();
    // Seeded by id so everyone sees it lie the same way.
    const r = (k: number) => ((Math.sin(c.id * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
    const sack = new THREE.Group();
    sack.rotation.y = r(1) * Math.PI * 2;
    sack.rotation.z = (r(2) - 0.5) * 0.3;
    const body = new THREE.Mesh(SACK_GEO, CANVAS);
    body.position.y = 0.18;
    const neck = new THREE.Mesh(NECK_GEO, CANVAS);
    neck.position.set(0.36, 0.24, 0);
    neck.rotation.z = -1.1;
    const strap = new THREE.Mesh(STRAP_GEO, STRAP);
    strap.position.y = 0.2;
    strap.rotation.y = Math.PI / 2;
    strap.scale.set(1, 0.68, 1);
    sack.add(body, neck, strap);
    for (const m of [body, neck, strap]) m.castShadow = m.receiveShadow = true;
    g.add(sack);

    const stick = new THREE.Group();
    const a = r(3) * Math.PI * 2;
    stick.position.set(Math.sin(a) * 0.55, -0.15, Math.cos(a) * 0.55);
    stick.rotation.set(Math.cos(a) * LEAN, 0, -Math.sin(a) * LEAN);
    const pole = new THREE.Mesh(STICK_GEO, WOOD);
    pole.castShadow = true;
    const col = new THREE.Color(c.color);
    // A rag: the colour washed out a little by the sun, glowing faintly so it shows at dusk.
    const ragMat = new THREE.MeshStandardNodeMaterial({ color: col.clone().lerp(new THREE.Color(0xd8c8b0), 0.2), roughness: 1, metalness: 0, side: THREE.DoubleSide });
    ragMat.emissive = col.clone().multiplyScalar(0.18);
    const rag = new THREE.Mesh(new THREE.PlaneGeometry(RAG_W, RAG_H, RAG_SEG, 1).translate(RAG_W / 2, 0, 0), ragMat);
    rag.position.y = STICK - RAG_H / 2 - 0.04;
    rag.castShadow = true;
    rag.userData.rest = Float32Array.from(rag.geometry.attributes.position.array as ArrayLike<number>);
    stick.add(pole, rag);
    g.add(stick);
    this.group.add(g);
    return { group: g, rag, phase: r(4) * 10 };
  }

  /** Ripples running down the rag, bigger towards its free end; the whole rag swings round the stick a little. */
  private flap(s: Shown) {
    const t = this.time + s.phase;
    const pos = s.rag.geometry.attributes.position as THREE.BufferAttribute;
    const rest = s.rag.userData.rest as Float32Array;
    for (let i = 0; i < pos.count; i++) {
      const x = rest[i * 3], y = rest[i * 3 + 1];
      const u = x / RAG_W;
      pos.setZ(i, Math.sin(x * 7 - t * 9) * 0.07 * u + Math.sin(x * 13 - t * 15 + y * 3) * 0.025 * u);
      pos.setY(i, y - u * u * 0.08 + Math.sin(x * 5 - t * 6) * 0.02 * u);
    }
    pos.needsUpdate = true;
    s.rag.geometry.computeVertexNormals();
    s.rag.rotation.y = Math.sin(t * 0.7) * 0.35 + 0.6;
  }
}
