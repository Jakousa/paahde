// The trophies at the base: each boss kind beaten (shared/bosses.ts, the 'lives' message's `beaten`) puts its part up
// on a steel bracket on one of the flag mast's buttress fins (src/world/mast.ts), big: the carrier's hive core, the
// queen's eye, the colossus's furnace heart and the worm's tooth (public/models/items/, tools/blender/relics.py).
// Client-only decoration, out of reach on the fins' slopes.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BASE, MAST } from '../../shared/base.ts';
import { BOSS_KINDS, bossBit, RELICS, type BossKind } from '../../shared/bosses.ts';

/** How far out along its fin (m from the pole's axis) the trophy sits, and how much bigger than the item it is. */
const OUT = 2.0;
const SCALE = 7;
const STEEL = new THREE.MeshStandardNodeMaterial({ color: 0x3a3430, roughness: 0.6, metalness: 0.6 });

/** The model each kind's trophy is. */
const MODEL: Record<BossKind, string> = { ...(RELICS as Record<BossKind, string>), worm: 'worm_tooth' };

/** Height of the fin's sloping top edge at `r` m out (src/world/mast.ts: from (reach, 0.25) up to (0, h)). */
const finTop = (r: number) => 0.25 + ((MAST.fins.reach - r) / MAST.fins.reach) * (MAST.fins.h - 0.25);

export class Trophies {
  private group = new THREE.Group();
  private up = new Set<BossKind>();
  private gltf = new GLTFLoader();

  constructor(scene: THREE.Scene) {
    this.group.position.set(BASE.x + MAST.x, BASE.y, BASE.z + MAST.z);
    scene.add(this.group);
  }

  /** The kinds beaten (shared/bosses.ts bossBit mask): put up the ones not yet up. */
  set(beaten: number) {
    BOSS_KINDS.forEach((kind, i) => {
      if (!(beaten & bossBit(kind)) || this.up.has(kind)) return;
      this.up.add(kind);
      // Fin i (src/world/mast.ts turns fin i by i quarter turns): out along its local +X.
      const fin = new THREE.Group();
      fin.rotation.y = (i / MAST.fins.n) * Math.PI * 2;
      this.group.add(fin);
      const y = finTop(OUT);
      const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, MAST.fins.t + 0.12), STEEL);
      bracket.position.set(OUT, y + 0.04, 0);
      bracket.castShadow = true;
      fin.add(bracket);
      this.gltf.loadAsync(`./models/items/${MODEL[kind]}.glb`).then((m) => {
        const o = m.scene;
        o.scale.setScalar(SCALE);
        o.position.set(OUT, y + 0.08, 0);
        o.traverse((c) => (c.castShadow = true));
        fin.add(o);
      }, (e) => console.warn(`trophy ${kind} failed to load`, e));
    });
  }
}
