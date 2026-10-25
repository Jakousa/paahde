// The trophies by the crashed ship (shared/trophies.ts): each boss kind beaten sets up a big piece of it, full size, on the sand
// round the ship, built from the boss's own model (tools/blender/<kind>.py): the worm's head rearing out of the sand,
// jaws spread, the segment behind it sunk; the colossus's head sunk to the chin and its arm raised out of the sand beside it; one of
// the carrier's fan ducts on edge with its rotor; the queen's thorax nose-up, cutters open, a leg arching out of the sand each side.
// Dead: their lamps barely glow, the weak points are dark glass. Client-only looks; the collision is shared.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BOSS_KINDS, bossBit, type BossKind } from '../../shared/bosses.ts';
import { FEMUR } from '../../shared/queen.ts';
import { trophyPlaces } from '../../shared/trophies.ts';
import { brokenLensMat, lensGeo, mergePart } from './bossParts';

const D = Math.PI / 180;
/** The lamps of a dead boss: their glow turned right down. */
const embers = new THREE.MeshBasicNodeMaterial({ vertexColors: true, color: 0x2a2a2a });

/** Each kind's model and the nodes a trophy takes from it. */
const MODELS: Record<BossKind, { glb: string; nodes: string[] }> = {
  worm: { glb: 'worm', nodes: ['Worm_Head', 'Worm_Jaw', 'Worm_Grinder', 'Worm_Segment'] },
  colossus: { glb: 'colossus', nodes: ['Colossus_Head', 'Colossus_UpperArm', 'Colossus_Forearm'] },
  carrier: { glb: 'carrier', nodes: ['Carrier_Duct', 'Carrier_Rotor'] },
  queen: { glb: 'queen', nodes: ['Queen_Thorax', 'Queen_MandibleL', 'Queen_MandibleR', 'Queen_Femur', 'Queen_Tibia'] },
};

type Parts = Record<string, THREE.Object3D>;

/** Part `n` merged (shadow-casting, its lamps dimmed), to place. */
function part(parts: Parts, n: string): THREE.Group {
  const g = mergePart(parts[n]);
  for (const c of g.children) {
    const m = c as THREE.Mesh;
    if (m.isMesh && !m.castShadow) m.material = embers;
  }
  return g;
}

/** A dead weak point: dark glass of radius r at p in `on`. */
function deadLens(on: THREE.Object3D, r: number, x: number, y: number, z: number) {
  const m = new THREE.Mesh(lensGeo, brokenLensMat);
  m.scale.setScalar(r);
  m.position.set(x, y, z);
  on.add(m);
}

/** An object at (x, y, z) in the trophy's frame, turned by Euler (rx, ry, rz) in degrees. */
function at<T extends THREE.Object3D>(o: T, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): T {
  o.position.set(x, y, z);
  o.rotation.set(rx * D, ry * D, rz * D);
  return o;
}

/** Each kind's trophy, in its frame: origin on the sand, +Z towards the ship (shared/trophies.ts). */
const BUILD: Record<BossKind, (p: Parts) => THREE.Object3D> = {
  worm(p) {
    const g = new THREE.Group();
    // The head pitched up 70°, the collar's underside in the sand; the segment behind it along its axis, mostly sunk.
    const head = at(new THREE.Group(), 0, 4.4, 0, -70, 0, 8);
    head.add(part(p, 'Worm_Head'), at(part(p, 'Worm_Grinder'), 0, 0, 0, 0, 0, 20));
    for (let k = 0; k < 3; k++) {
      const holder = at(new THREE.Group(), 0, 0, 0, 0, 0, k * 120);
      holder.add(at(part(p, 'Worm_Jaw'), 0, 4.3, 2.0, -(k === 0 ? 70 : 52)));
      head.add(holder);
    }
    g.add(head, at(part(p, 'Worm_Segment'), 0, 0.3, -1.5, -70, 0, 14));
    return g;
  },
  colossus(p) {
    const g = new THREE.Group();
    // The head sunk to the chin, looking up past the ship; beside it an arm out of the sand: the upper arm a ridge
    // along it from the buried shoulder, the forearm raised from the elbow, fist up.
    g.add(at(part(p, 'Colossus_Head'), 0, -0.8, 0, -15, 0, 9));
    g.add(at(part(p, 'Colossus_UpperArm'), 20, -2.5, -5, 0, 0, -101.5));
    g.add(at(part(p, 'Colossus_Forearm'), 6.3, 0.3, -5, 180 + 10, 25, -12));
    return g;
  },
  carrier(p) {
    const g = new THREE.Group();
    // The duct on edge, its axis towards the ship, leaning back a little and rolled; a third of it in the sand.
    const fan = at(new THREE.Group(), 0, 8, 0, 90 - 12, 0, 9);
    fan.add(part(p, 'Carrier_Duct'), at(part(p, 'Carrier_Rotor'), 0, 0, 0, 0, 33, 0));
    deadLens(fan, 1.1, 0, -3.3, 0);
    g.add(fan);
    return g;
  },
  queen(p) {
    const g = new THREE.Group();
    // The thorax nose-up out of the sand, cutters spread; a leg out of each side arching up to the knee and back down.
    const body = at(new THREE.Group(), 0, 1.5, 0, -40, 0, -6);
    body.add(part(p, 'Queen_Thorax'));
    body.add(at(part(p, 'Queen_MandibleL'), -1.0, -0.8, 8.3, 0, -30, 0));
    body.add(at(part(p, 'Queen_MandibleR'), 1.0, -0.8, 8.3, 0, 30, 0));
    deadLens(body, 1.0, 0, 0.2, 9.1);
    g.add(body);
    for (const s of [-1, 1]) {
      // Hip by the body, the femur rising 55° outwards, the tibia bending back down 60° into the sand.
      const femur = at(new THREE.Group(), 3.5 * s, -0.5, 0, 0, 80 * s, 0);
      const pitch = at(new THREE.Group(), 0, 0, 0, -55);
      pitch.add(part(p, 'Queen_Femur'), at(part(p, 'Queen_Tibia'), 0, 0, FEMUR, 115));
      femur.add(pitch);
      g.add(femur);
    }
    return g;
  },
};

/** Which trophies show: the kinds beaten (the game), or all or none of them (the debug menu; looks only, the
 *  collision still follows the kinds beaten). */
export type TrophyShow = 'won' | 'all' | 'none';

export class Trophies {
  private built = new Map<BossKind, THREE.Object3D>();
  private models = new Map<string, Promise<Parts>>();
  private scene: THREE.Scene;
  private beaten = 0;
  private mode: TrophyShow = 'won';

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** The nodes of public/models/<glb>.glb by name, loaded once. */
  private load(glb: string): Promise<Parts> {
    let m = this.models.get(glb);
    if (!m) {
      m = new GLTFLoader().loadAsync(`./models/${glb}.glb`).then((gltf) => {
        const parts: Parts = {};
        gltf.scene.updateMatrixWorld(true);
        for (const c of gltf.scene.children) {
          c.position.set(0, 0, 0);
          c.quaternion.identity();
          parts[c.name] = c;
        }
        return parts;
      });
      this.models.set(glb, m);
    }
    return m;
  }

  /** The kinds beaten (shared/bosses.ts bossBit mask). */
  set(beaten: number) {
    this.beaten = beaten;
    this.update();
  }

  /** Debug: show the kinds beaten, all of them or none. */
  show(mode: TrophyShow) {
    this.mode = mode;
    this.update();
  }

  private shown(kind: BossKind) {
    return this.mode === 'all' || (this.mode === 'won' && !!(this.beaten & bossBit(kind)));
  }

  /** Build the ones to show that aren't yet (once each), and show or hide each built one. */
  private update() {
    for (const kind of BOSS_KINDS) {
      const o = this.built.get(kind);
      if (o) {
        o.visible = this.shown(kind);
        continue;
      }
      if (!this.shown(kind)) continue;
      const p = trophyPlaces()[kind];
      if (!p) continue;
      const g = new THREE.Group();
      g.position.set(p.x, p.y, p.z);
      g.rotation.y = Math.atan2(p.fx, p.fz);
      this.built.set(kind, g);
      this.scene.add(g);
      const { glb, nodes } = MODELS[kind];
      this.load(glb).then((parts) => {
        for (const n of nodes) if (!parts[n]) throw new Error(`${glb}.glb has no ${n}`);
        g.add(BUILD[kind](parts));
      }).catch((e) => console.warn(`trophy ${kind} failed`, e));
    }
  }
}
