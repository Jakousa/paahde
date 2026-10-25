// Vehicles standing in the world (shared/vehicles.ts, from the server via src/net.ts): the sand bike's model
// (src/bike.ts) where each one is, nobody riding it. A broken one lies on its side, half sunk in the sand, glowing
// along its edges in the colour of its parts' tier like broken gear on the sand (src/world/loot.ts); a working one
// stands on its wheels, pitched along the slope and leaning a little on its stand. While someone rides it, it isn't
// drawn here: src/main.ts draws it under its rider (src/bike.ts Bike). Your own ones are on the locator bar
// (src/locator.ts), however far, as a little bike in your colour; and each one standing within sight has a small green
// standby lamp on its dash, breathing slowly like a parked thing left armed, to tell it from everyone else's on the
// sand, by day or night. Others' bikes never show it.
import * as THREE from 'three/webgpu';
import { float, length, mix, sin, smoothstep, uv, vec3 } from 'three/tsl';
import { parsePart } from '../../shared/items.ts';
import { slopeAt } from '../../shared/sim.ts';
import { parked, vehicles, type Vehicle } from '../../shared/vehicles.ts';
import { loadBikeModel } from '../bike';
import type { LocatorTarget } from '../locator';
import { applyTier } from '../tierLook';
import { nightLevel, time } from './env';
import { addRims, glowColor, RIM_VIEW } from './loot';

/** Drawn within this distance (m). */
const VIEW = 350;
/** A broken one lies over on its side by this much (rad), its low side this far (m) above the sand origin. */
const ROLL = 1.3;
const LIFT = 0.12;
/** A working one leans on its stand (rad, to the left). */
const STAND_LEAN = 0.12;

/** The standby lamp on your own: on the dash gauge (bike frame, tools/blender/sandbike.py), its colour, brightness (HDR,
 *  before bloom) by day and night, and its glow's size (m): never smaller than this, and from afar this much per metre
 *  of distance (a few pixels: a point of light, not a marker). One breath every BREATH s. */
const LED = new THREE.Vector3(0.08, 1.2, -0.33);
const LED_COLOR = vec3(0.35, 1, 0.45);
const LED_DAY = 3.2;
const LED_NIGHT = 1.4;
const LED_SIZE = 0.09;
const LED_PER_M = 0.0055;
const BREATH = 2.8;

/** One material for every standby lamp: a soft additive dot breathing between dim and full. */
let ledMat: THREE.SpriteNodeMaterial | null = null;
function ledMaterial() {
  if (ledMat) return ledMat;
  ledMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const g = float(1).sub(smoothstep(0, 1, length(uv().sub(0.5)).mul(2)));
  const breath = sin(time.mul((2 * Math.PI) / BREATH)).mul(0.35).add(0.65);
  ledMat.colorNode = LED_COLOR.mul(mix(float(LED_DAY), float(LED_NIGHT), nightLevel)).mul(breath);
  ledMat.opacityNode = g.mul(g).mul(g);
  return ledMat;
}

type Shown = { obj: THREE.Group; key: string; rims: THREE.Mesh[] | null; tilt: THREE.Group; led: THREE.Sprite | null };

/** The tier its parts look (0 Scrap .. 3 Space-grade): the mean of the fitted parts', rounded down, as gear's. */
function tierOf(v: Vehicle): number {
  const tiers = v.parts.flatMap((p) => (p ? [parsePart(p)?.tier ?? 0] : []));
  return tiers.length ? Math.floor(tiers.reduce((a, b) => a + b, 0) / tiers.length + 1e-6) : 0;
}

const tmpSlope = { gx: 0, gz: 0 };

/** Locator ids for vehicles: players are positive, home -1, wrecks count down from -100, packs from -1e9. */
const LOCATE_ID = -500_000_000;

/** Your own vehicles (`mine`: their ids) standing in the world, for the locator bar, in your `color`. Not one being
 *  ridden: where it stood is no use then. */
export function ownVehicleTargets(mine: ReadonlySet<number>, color: number): LocatorTarget[] {
  if (!mine.size) return [];
  return vehicles.flatMap((v) => (mine.has(v.id) && parked(v) ? [{ id: LOCATE_ID - v.id, color, x: v.x, y: v.y + 1, z: v.z, shape: 'bike' as const }] : []));
}

export class VehicleView {
  private group = new THREE.Group();
  private shown = new Map<number, Shown>();

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  /** Every frame: the vehicles near `me` that nobody is riding (`riding`: is player `id` on their bike now); `mine`
   *  the ids of yours. */
  update(list: Vehicle[], mine: ReadonlySet<number>, me: { x: number; y: number; z: number }, riding: (id: number) => boolean) {
    const want = new Map<number, Vehicle>();
    for (const v of list) {
      if (v.rider !== undefined && riding(v.rider)) continue;
      if (Math.hypot(v.x - me.x, v.z - me.z) > VIEW) continue;
      want.set(v.id, v);
    }
    for (const [id, s] of this.shown) {
      const v = want.get(id);
      if (v && s.key === keyOf(v)) continue;
      this.group.remove(s.obj);
      this.shown.delete(id);
    }
    for (const v of want.values()) {
      let s = this.shown.get(v.id);
      if (!s) this.shown.set(v.id, (s = this.build(v)));
      const d = Math.hypot(v.x - me.x, v.z - me.z);
      if (s.rims) {
        const on = d < RIM_VIEW;
        for (const r of s.rims) r.visible = on;
      }
      const lit = v.up && mine.has(v.id);
      if (lit && !s.led) {
        s.led = new THREE.Sprite(ledMaterial());
        s.led.position.copy(LED);
        s.led.castShadow = s.led.receiveShadow = false;
        s.tilt.add(s.led);
      } else if (!lit && s.led) {
        s.tilt.remove(s.led);
        s.led = null;
      }
      s.led?.scale.setScalar(Math.max(LED_SIZE, Math.hypot(d, v.y - me.y) * LED_PER_M));
    }
  }

  private build(v: Vehicle): Shown {
    const obj = new THREE.Group();
    obj.position.set(v.x, v.y, v.z);
    obj.rotation.y = v.heading;
    const tier = tierOf(v);
    const rims = v.up ? null : ([] as THREE.Mesh[]);
    const tilt = new THREE.Group();
    tilt.rotation.order = 'YXZ';
    if (v.up) {
      // Along the slope (the sim's nose: shared/sim.ts stepBike), on its stand.
      const g = slopeAt(v.x, v.z, tmpSlope);
      tilt.rotation.x = Math.atan(-g.gx * Math.sin(v.heading) - g.gz * Math.cos(v.heading));
      tilt.rotation.z = STAND_LEAN;
    } else {
      tilt.rotation.z = ROLL;
      tilt.position.y = LIFT;
    }
    obj.add(tilt);
    loadBikeModel().then((gltf) => {
      const m = gltf.scene.clone(true);
      m.traverse((o) => {
        o.castShadow = o.receiveShadow = true;
        o.userData.shared = true; // its geometry is the ridden bikes' too: never disposed
      });
      if (!v.up) m.getObjectByName('Handlebar')?.rotation.set(0, 0.45, 0);
      applyTier(m, tier);
      tilt.add(m);
      if (rims) addRims(m, rims, glowColor(tier));
    }, () => {});
    this.group.add(obj);
    return { obj, key: keyOf(v), rims, tilt, led: null };
  }
}

/** What it's drawn from: a change rebuilds it. */
const keyOf = (v: Vehicle) => `${v.up ? 1 : 0}|${tierOf(v)}|${v.x}|${v.y}|${v.z}|${v.heading}`;
