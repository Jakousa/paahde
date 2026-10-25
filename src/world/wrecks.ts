// Salvage wrecks in the desert (shared/wrecks.ts), drawn with their Blender models (public/models/salvage/<id>.glb,
// tools/blender/salvage/*.py). Walk up and press F to pick one up: it goes into the bag through the same
// server path as the small crash-site machines (net.crashTake), vanishes for everyone until it respawns, and is
// taken apart on a dismantling bench (src/world/crash.ts Bench). Wrecks within LOCATE_R show on the
// locator bar as diamonds, so you can go looking for them.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { crashListeners, crashTaken } from '../../shared/crash.ts';
import { SALVAGE, type SalvageId } from '../../shared/salvage.ts';
import { heightAt } from '../../shared/terrain.ts';
import { WRECK_REACH, wrecksNear, type Wreck } from '../../shared/wrecks.ts';
import type { LocatorTarget } from '../locator';

/** Models are drawn out to here (they are small: a few thousand triangles each). */
const SHOW_R = 450;
/** Wrecks this close get a locator marker. */
const LOCATE_R = 450;
const LOCATE_COLOR = 0xe8a050;

const loader = new GLTFLoader();
const models = new Map<SalvageId, THREE.Object3D | null>();

function load(kind: SalvageId) {
  if (models.has(kind)) return;
  models.set(kind, null);
  loader.loadAsync(`./models/${SALVAGE[kind].model}`).then(
    (gltf) => {
      gltf.scene.traverse((o) => {
        o.castShadow = true;
        o.receiveShadow = true;
      });
      models.set(kind, gltf.scene);
    },
    (e) => console.warn('wrecks: model failed', kind, e),
  );
}

interface View {
  wreck: Wreck;
  obj: THREE.Object3D | null;
  locator: LocatorTarget;
}

export class Wrecks {
  private scene: THREE.Scene;
  private views = new Map<string, View>();
  private nextId = -100; // locator ids: players are positive, home is -1
  private dirty = true;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    crashListeners.push(() => (this.dirty = true));
  }

  /** Every frame with the local player's position. */
  update(focus: THREE.Vector3) {
    const keep = new Set<string>();
    for (const w of wrecksNear(focus.x, focus.z, SHOW_R)) {
      keep.add(w.id);
      let v = this.views.get(w.id);
      if (!v) {
        load(w.kind);
        v = { wreck: w, obj: null, locator: { id: this.nextId--, color: LOCATE_COLOR, x: w.x, y: heightAt(w.x, w.z) + 0.5, z: w.z, shape: 'wreck' } };
        this.views.set(w.id, v);
      }
      const model = models.get(w.kind);
      if (!v.obj && model) {
        v.obj = model.clone(true);
        v.obj.position.set(w.x, heightAt(w.x, w.z) - 0.04, w.z);
        v.obj.rotation.y = w.yaw;
        this.dirty = true;
      }
      if (v.obj && this.dirty) {
        const gone = crashTaken.has(w.id);
        if (gone && v.obj.parent) this.scene.remove(v.obj);
        else if (!gone && !v.obj.parent) this.scene.add(v.obj);
      }
    }
    for (const [id, v] of this.views) {
      if (keep.has(id)) continue;
      if (v.obj) this.scene.remove(v.obj);
      this.views.delete(id);
    }
    this.dirty = false;
  }

  /** The wreck within reach of (x, z) that can be picked up right now. */
  nearest(x: number, z: number): Wreck | null {
    let best: Wreck | null = null;
    let bd = WRECK_REACH;
    for (const v of this.views.values()) {
      if (!v.obj?.parent) continue;
      const d = Math.hypot(v.wreck.x - x, v.wreck.z - z);
      if (d < bd) {
        bd = d;
        best = v.wreck;
      }
    }
    return best;
  }

  /** Locator markers for the wrecks still lying out there within LOCATE_R of (x, z). */
  targets(x: number, z: number): LocatorTarget[] {
    const out: LocatorTarget[] = [];
    for (const v of this.views.values()) {
      if (crashTaken.has(v.wreck.id) || Math.hypot(v.wreck.x - x, v.wreck.z - z) > LOCATE_R) continue;
      out.push(v.locator);
    }
    return out;
  }
}
