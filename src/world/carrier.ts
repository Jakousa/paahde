// The hive carrier (shared/carrier.ts) as drawn: public/models/carrier.glb (tools/blender/carrier.py), the hull with
// a duct and rotor cloned onto each fan, the fans' glowing hubs its weak points. Hovering it bobs and leans as the
// server says (banked into turns, nose down with speed, listing toward dead fans), the ducts tilt with its motion,
// the rotors spin (a dead one runs down and stops, smoking), the nav lamps blink, and its downwash kicks sand up under
// every live fan. Three searchlights under it sweep the sand (the drones' look, src/world/drones.ts: haze cone, glare,
// a pool laid on the dunes), bright at night and faint by day; one swings onto the player it's after and turns red.
//
// Bombs ('bomb' bossFx: drop point, velocity, fall time) fall out of the bay on shared/carrier.ts bombAt, blinking,
// whistling, and burst on the sand when the server's do (fire, sparks, dust, shake, boom). Dead (s.dead), it falls
// from where it died to where it lands (CS_OX..: the snapshot is already there), tumbling on a smoke trail, slams
// into the sand in a huge burst, and the wreck burns and sinks slowly until it goes.
//
// Its gun drones (CS_LEN.. slots) are small dark discs on four rotors with a red eye, buzzing; one drops out of the
// bay with a clunk when its slot fills, goes back in when it empties. Aiming ('daim') the eye swells and a flickering
// red thread runs from it to a dot on the spot it will fire at, whining up; then the shot ('dshot'): a hot red beam,
// sparks and a crack. The carrier dying, they drop out of the sky, trailing smoke, and burst on the sand.
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { abs, dot, float, length, normalView, positionViewDirection, pow, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import { BOSSES, type BossSnap } from '../../shared/bosses.ts';
import {
  bombAt, CS_ALL, CS_FALL, CS_LEN, CS_LOCK, CS_OX, CS_OY, CS_OZ, CS_PITCH, CS_ROLL, CS_SPIN, CS_TX, CS_TZ, CS_VX, CS_VZ, DRONE_R,
  DRONE_SLOTS, DS_LEN, DS_ON, DS_X, DS_Y, DS_Z, FANS, HULL,
} from '../../shared/carrier.ts';
import { sunElevation } from '../../shared/sun.ts';
import { heightAt } from '../../shared/terrain.ts';
import { carrierSound } from '../carrierSound';
import { guardianSound } from '../guardianSound';
import { rifleSound } from '../rifleSound';
import { tyreDust } from '../tyreDust';
import { weakPoint, type BossCtx, type BossFxMsg, type BossView } from './bossParts';
import { timeOfDay } from './dayNight';
import { zaps } from './zaps';

/** Searchlight lenses on the hull (tools/blender/carrier.py LAMPS), the weak point lens under each fan's motor. */
const LAMPS = [new THREE.Vector3(0, -6.6, 21), new THREE.Vector3(-11, -6.4, -17), new THREE.Vector3(11, -6.4, -17)];
const HUB_LENS = new THREE.Vector3(0, -3.3, 0);
const HUB_R = 1.5;
/** Rotor speed (rad/s) and how fast a dead one runs down (1/s). */
const SPIN = 7;
const SPIN_DOWN = 0.35;
/** Searchlights: cone half angle (rad), haze / pool / glare brightness at night (scaled down by day to DAY_GAIN). */
const BEAM_HALF = 0.1;
const BEAM_GAIN = 0.15;
const POOL_GAIN = 1.0;
const GLARE_GAIN = 2.5;
const GLARE_SIZE = 3.2;
const DAY_GAIN = 0.3;
const WARM = new THREE.Color(1.0, 0.86, 0.62);
const RED = new THREE.Color(1.0, 0.16, 0.08);
const POOL_N = 12;
/** Downwash dust: puffs per second per live fan, within this height over the sand (m) and this far from us (m). */
const DUST_RATE = 7;
const DUST_HEIGHT = 120;
const DUST_SEEN = 700;
/** The wreck sinks this deep (m) over its time on the sand. */
const WRECK_SINK = 7;

type Model = { hull: THREE.Object3D; duct: THREE.Object3D; rotor: THREE.Object3D; red: THREE.MeshStandardMaterial[]; white: THREE.MeshStandardMaterial[] };
let model: Model | null = null;
let loading: Promise<void> | null = null;

function load() {
  loading ??= new GLTFLoader().loadAsync('./models/carrier.glb').then(
    (gltf) => {
      const get = (n: string) => {
        const o = gltf.scene.getObjectByName(n);
        if (!o) throw new Error(`carrier.glb has no ${n}`);
        o.position.set(0, 0, 0);
        return o;
      };
      const red: THREE.MeshStandardMaterial[] = [], white: THREE.MeshStandardMaterial[] = [];
      gltf.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!m || !(o as THREE.Mesh).isMesh) return;
        o.castShadow = true;
        if (m.name === 'CarrierNavRed' && !red.includes(m)) red.push(m);
        if (m.name === 'CarrierNavWhite' && !white.includes(m)) white.push(m);
      });
      model = { hull: get('Carrier_Hull'), duct: get('Carrier_Duct'), rotor: get('Carrier_Rotor'), red, white };
    },
    (e) => console.warn('carrier: model failed, using boxes', e),
  );
}

/** Unit cone along +Z, apex at the origin, radius 1 at z = 1 (open ended), as the drones'. */
const coneGeo = (() => {
  const g = new THREE.CylinderGeometry(0.02, 1, 1, 20, 1, true);
  g.translate(0, -0.5, 0);
  g.rotateX(-Math.PI / 2);
  return g;
})();
const bombGeo = (() => {
  const g = new THREE.CapsuleGeometry(0.45, 1.6, 3, 8);
  g.rotateX(Math.PI / 2); // along +Z
  return g;
})();
const finGeo = new THREE.BoxGeometry(1.4, 0.08, 0.5).translate(0, 0, -1.1);
const bombMat = new THREE.MeshStandardNodeMaterial({ color: 0x2a221d, roughness: 0.5, metalness: 0.6 });

/** Gun drone parts: a flattened disc body, a crossed pair of arms, a blurred rotor disc at each arm's end, the eye
 *  under its nose (forward +Z). */
const droneBodyGeo = new THREE.SphereGeometry(DRONE_R, 14, 8).scale(1, 0.42, 1.1);
const droneArmGeo = new THREE.BoxGeometry(DRONE_R * 2.9, 0.1, 0.2);
const droneRotorGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.02, 14);
const droneEyeGeo = new THREE.SphereGeometry(0.2, 10, 8);
const DRONE_EYE = new THREE.Vector3(0, -0.22, DRONE_R * 0.9);
const DRONE_ROTORS = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([x, z]) => new THREE.Vector3(x * DRONE_R * 1.02, 0.12, z * DRONE_R * 1.02));
const rotorMat = new THREE.MeshBasicNodeMaterial({ color: 0x15100c, transparent: true, opacity: 0.4, depthWrite: false });
const eyeMat = new THREE.MeshStandardNodeMaterial({ color: 0x3a0400, roughness: 0.25, metalness: 0.1, emissive: 0xff2a08, emissiveIntensity: 2 });
/** Unit tube along +Z from z = 0 to 1: the aim thread and the shot's beam. */
const tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
/** Thread and beam radii (m), how long a shot's beam lasts (s); a falling dead drone's gravity (m/s²). */
const THREAD_R = 0.025;
const SHOT_R = 0.12;
const SHOT_S = 0.22;
const DRONE_FALL_G = 12;

function glowMat(color: THREE.Color | Node<'vec3'>, soft = 1) {
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const g = float(1).sub(smoothstep(0, 1, length(uv().sub(0.5)).mul(2)));
  m.colorNode = color instanceof THREE.Color ? vec3(color.r, color.g, color.b) : color;
  m.opacityNode = soft === 1 ? g.mul(g).mul(g) : g.mul(g);
  return m;
}

type Beam = { cone: THREE.Mesh; pool: THREE.Mesh; grid: Float32Array; glare: THREE.Sprite; tint: { value: THREE.Color }; gtint: { value: THREE.Color }; color: THREE.Color; aim: THREE.Vector3 };
type Bomb = { t0: number; x: number; y: number; z: number; vx: number; vz: number; T: number; mesh: THREE.Group; lamp: THREE.Sprite; whistle: ((p: THREE.Vector3) => void) | null; started: boolean };
type Burst = { sprite: THREE.Sprite; fade: { value: number }; age: number; size: number; life: number };
/** A gun drone slot as drawn: its group, out or not, where it is (and how fast it's going, from frame to frame),
 *  facing, what it's aiming at (server time it started, s it lasts, the spot) or null, its thread and dot, and once
 *  the carrier died, its fall. */
type DroneView = {
  g: THREE.Group; on: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number;
  eye: THREE.Sprite; eyeTint: { value: THREE.Color };
  aim: { t0: number; T: number; x: number; y: number; z: number; heard: boolean } | null;
  thread: THREE.Mesh; threadFade: { value: number }; dot: THREE.Sprite; dotTint: { value: THREE.Color };
  falling: boolean; spinX: number; spinZ: number;
};
type Shot = { mesh: THREE.Mesh; fade: { value: number }; age: number };

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _d = new THREE.Vector3(), _m = new THREE.Matrix4(), _inv = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _p = { x: 0, y: 0, z: 0 };
const _o = new THREE.Vector3(), _r = new THREE.Vector3();

export class CarrierView implements BossView {
  readonly points: THREE.Object3D[] = [];
  private scene: THREE.Scene;
  private root = new THREE.Group();
  /** Per fan: the tilting group (duct, rotor, hub lens) and its rotor; spin speed now. */
  private fans: THREE.Group[] = [];
  private rotors: (THREE.Object3D | null)[] = [null, null, null, null];
  private spin = [SPIN, SPIN, SPIN, SPIN];
  private placeholder: THREE.Group | null = null;
  private built = false;
  private beams: Beam[] = [];
  private bombs: Bomb[] = [];
  private bursts: Burst[] = [];
  private fires: THREE.Sprite[] = [];
  private fireMat = glowMat(new THREE.Color(3.2, 1.0, 0.25), 2);
  private dust = 0;
  private smoke = 0;
  private crashed = false;
  private seenAlive = false;
  private t = Math.random() * 100;
  private drones: (DroneView | null)[] = new Array(DRONE_SLOTS).fill(null);
  /** Drone aims and shots waiting for their server time to come round (the snapshot is drawn a little late). */
  private pending: BossFxMsg[] = [];
  private shots: Shot[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    load();
    for (let i = 0; i < FANS.length; i++) {
      const g = new THREE.Group();
      g.position.set(FANS[i][0], FANS[i][1], FANS[i][2]);
      const p = weakPoint(HUB_R);
      p.position.copy(HUB_LENS);
      p.rotation.x = Math.PI / 2; // facing down
      g.add(p);
      this.root.add(g);
      this.fans.push(g);
      this.points.push(p);
    }
    if (BOSSES.carrier.points !== this.points.length) console.warn('carrier: weak point count mismatch');
    // Boxes while the model loads.
    const ph = new THREE.Group();
    const m = new THREE.MeshStandardNodeMaterial({ color: 0x26211e, roughness: 0.6, metalness: 0.5 });
    ph.add(new THREE.Mesh(new THREE.BoxGeometry(HULL[0] * 2, HULL[1] * 2, HULL[2] * 2), m));
    for (const [x, y, z] of FANS) {
      const r = new THREE.Mesh(new THREE.CylinderGeometry(11.5, 11.5, 4, 16, 1, true), m);
      r.position.set(x, y, z);
      ph.add(r);
    }
    this.placeholder = ph;
    this.root.add(ph);
    for (const l of LAMPS) this.beams.push(this.beam(l));
    scene.add(this.root);
  }

  private build() {
    if (this.built || !model) return;
    this.built = true;
    if (this.placeholder) this.root.remove(this.placeholder);
    this.placeholder = null;
    this.root.add(model.hull.clone());
    this.fans.forEach((g, i) => {
      g.add(model!.duct.clone());
      const r = model!.rotor.clone();
      r.rotation.y = i * 0.7;
      g.add(r);
      this.rotors[i] = r;
    });
  }

  private beam(lamp: THREE.Vector3): Beam {
    const color = WARM.clone();
    const tint = uniform(new THREE.Color()), gtint = uniform(new THREE.Color());
    const beamMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide });
    const facing = pow(abs(dot(normalView, positionViewDirection)), float(3));
    const along = uv().y;
    beamMat.colorNode = tint.mul(BEAM_GAIN);
    beamMat.opacityNode = facing.mul(pow(along, float(1.6)).mul(0.8).add(0.2)).mul(smoothstep(0, 0.15, along));
    const cone = new THREE.Mesh(coneGeo, beamMat);
    cone.frustumCulled = false;
    cone.matrixAutoUpdate = false;
    const poolMat = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, side: THREE.DoubleSide,
    });
    const r = length(uv().sub(0.5)).mul(2);
    poolMat.colorNode = tint.mul(POOL_GAIN).mul(vec3(1, 0.95, 0.9));
    poolMat.opacityNode = float(1).sub(smoothstep(0.1, 1.0, r)).pow(1.5);
    const poolGeo = new THREE.PlaneGeometry(2, 2, POOL_N, POOL_N);
    const grid = new Float32Array(poolGeo.attributes.position.count * 2);
    for (let i = 0; i < grid.length / 2; i++) grid.set([poolGeo.attributes.position.getX(i), poolGeo.attributes.position.getY(i)], i * 2);
    (poolGeo.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    const pool = new THREE.Mesh(poolGeo, poolMat);
    pool.frustumCulled = false;
    const glare = new THREE.Sprite(glowMat(gtint.mul(GLARE_GAIN) as unknown as Node<'vec3'>));
    glare.position.copy(lamp);
    glare.scale.setScalar(GLARE_SIZE);
    this.root.add(glare);
    this.scene.add(cone, pool);
    return { cone, pool, grid, glare, tint: tint as unknown as { value: THREE.Color }, gtint: gtint as unknown as { value: THREE.Color }, color, aim: new THREE.Vector3(NaN, 0, 0) };
  }

  update(s: BossSnap, ctx: BossCtx) {
    this.build();
    const dt = ctx.dt;
    this.t += dt;
    const t = this.t;
    const dead = s.dead > 0;
    const fall = s.s[CS_FALL] || 0;
    let x = s.x, y = s.y, z = s.z, yaw = s.yaw, roll = s.s[CS_ROLL], pitch = s.s[CS_PITCH];
    if (!dead) {
      this.seenAlive = true;
      // A slow heave and sway on top of the server's lean.
      y += Math.sin(t * 0.55) * 0.7;
      roll += Math.sin(t * 0.37) * 0.012;
      pitch += Math.sin(t * 0.29 + 1) * 0.01;
    } else if (s.dead < fall) {
      // Falling: from where it died to where it lands, faster and faster, tumbling over the dead side.
      const u = s.dead / fall, sp = s.s[CS_SPIN] || 1;
      x += s.s[CS_OX] * (1 - u);
      z += s.s[CS_OZ] * (1 - u);
      y += s.s[CS_OY] * (1 - u * u) + 3 * u;
      roll += sp * 0.55 * u * u;
      pitch += 0.3 * u * u;
      yaw += sp * 0.35 * u;
    } else {
      // The wreck: down on its side in the crater, sinking.
      const sp = s.s[CS_SPIN] || 1;
      y += 3 - Math.min(WRECK_SINK, (s.dead - fall) * (WRECK_SINK / BOSSES.carrier.wreckS));
      roll += sp * 0.55;
      pitch += 0.3;
      yaw += sp * 0.35;
    }
    this.root.position.set(x, y, z);
    this.root.rotation.set(pitch, yaw, roll, 'YXZ');
    this.root.updateMatrixWorld(true);

    // Fans: spin (dead ones run down), ducts tilting into the motion, a broken one drooping.
    const vx = s.s[CS_VX], vz = s.s[CS_VZ];
    const fwd = vx * Math.sin(yaw) + vz * Math.cos(yaw), side = vx * Math.cos(yaw) - vz * Math.sin(yaw);
    let alive = 0;
    for (let i = 0; i < this.fans.length; i++) {
      const broken = (s.br & (1 << i)) !== 0 || dead;
      if (!broken) alive |= 1 << i;
      this.spin[i] = broken ? this.spin[i] * Math.exp(-SPIN_DOWN * dt) : Math.min(SPIN, this.spin[i] + dt * 2);
      const r = this.rotors[i];
      if (r) r.rotation.y += (i % 2 ? -1 : 1) * this.spin[i] * dt;
      const g = this.fans[i];
      const droop = broken ? 0.12 * Math.sign(FANS[i][0]) : 0;
      g.rotation.set(fwd * 0.025 + Math.sin(t * 0.8 + i) * 0.01, 0, -side * 0.02 - droop, 'XYZ');
      // A dead fan sparks now and then.
      if (broken && !dead && Math.random() < dt * 1.5) {
        this.points[i].getWorldPosition(_w);
        zaps.burst(_w.x, _w.y + 1, _w.z, 0, -1, 0, 6, 1.6);
      }
    }

    this.lamps(t, dead);
    this.searchlights(s, ctx, dead);
    this.downwash(ctx, alive, dt);
    _p.x = x;
    _p.y = y;
    _p.z = z;
    carrierSound.thrum(_p, alive, ctx.ear);

    if (dead) this.death(s, ctx, x, y, z, fall);
    this.updateBombs(ctx);
    this.updateBursts(dt);
    this.updateDrones(s, ctx, dead);
    this.updatePending(ctx);
    this.updateShots(dt);
  }

  private makeDrone(): DroneView {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(droneBodyGeo, bombMat));
    const a1 = new THREE.Mesh(droneArmGeo, bombMat), a2 = new THREE.Mesh(droneArmGeo, bombMat);
    a1.rotation.y = Math.PI / 4;
    a2.rotation.y = -Math.PI / 4;
    g.add(a1, a2);
    for (const p of DRONE_ROTORS) {
      const r = new THREE.Mesh(droneRotorGeo, rotorMat);
      r.position.copy(p);
      g.add(r);
    }
    const lens = new THREE.Mesh(droneEyeGeo, eyeMat);
    lens.position.copy(DRONE_EYE);
    g.add(lens);
    g.traverse((o) => (o.castShadow = true));
    const eyeTint = uniform(new THREE.Color());
    const eye = new THREE.Sprite(glowMat(eyeTint as unknown as Node<'vec3'>));
    eye.position.copy(DRONE_EYE);
    eye.scale.setScalar(0.9);
    g.add(eye);
    g.visible = false;
    this.scene.add(g);
    const threadFade = uniform(0);
    const tm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    tm.colorNode = vec3(3.2, 0.22, 0.06).mul(threadFade);
    const thread = new THREE.Mesh(tubeGeo, tm);
    thread.frustumCulled = false;
    thread.visible = false;
    const dotTint = uniform(new THREE.Color());
    const dot = new THREE.Sprite(glowMat(dotTint as unknown as Node<'vec3'>));
    dot.visible = false;
    this.scene.add(thread, dot);
    return {
      g, on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, eye, eyeTint: eyeTint as unknown as { value: THREE.Color }, aim: null,
      thread, threadFade: threadFade as unknown as { value: number }, dot, dotTint: dotTint as unknown as { value: THREE.Color },
      falling: false, spinX: 0, spinZ: 0,
    };
  }

  /** The gun drones: out of the bay, flying where the server says, aiming, and falling once the carrier is dead. */
  private updateDrones(s: BossSnap, ctx: BossCtx, dead: boolean) {
    const dt = ctx.dt, list: { id: number; at: THREE.Vector3 }[] = [];
    for (let i = 0; i < DRONE_SLOTS; i++) {
      const o = CS_LEN + i * DS_LEN;
      // Out only while both messages around now have it (positions mid-way between a slot's drone and the bay aren't).
      const on = !dead && s.s.length >= CS_ALL && s.s[o + DS_ON] >= 0.999;
      let v = this.drones[i];
      if (on && !v) v = this.drones[i] = this.makeDrone();
      if (!v) continue;
      if (v.falling) {
        this.fallDrone(v, ctx);
        continue;
      }
      const x = s.s[o + DS_X], y = s.s[o + DS_Y], z = s.s[o + DS_Z];
      if (on && !v.on) {
        v.on = true;
        v.g.visible = true;
        (v.x = x), (v.y = y), (v.z = z), (v.vx = v.vy = v.vz = 0);
        if (this.seenAlive) carrierSound.launch(_v.set(x, y, z));
      } else if (!on && v.on) {
        v.on = false;
        v.aim = null;
        v.thread.visible = v.dot.visible = false;
        // Docked (it's at the bay): gone. The carrier dead: it drops where it was.
        if (dead && this.seenAlive) {
          v.falling = true;
          v.spinX = (Math.random() - 0.5) * 6;
          v.spinZ = (Math.random() - 0.5) * 8;
          v.vy = Math.max(v.vy, 2);
        } else v.g.visible = false;
        continue;
      }
      if (!v.on) continue;
      // Velocity from frame to frame, smoothed (the snapshots come ~10 a second).
      if (dt > 0) {
        const k = 1 - Math.exp(-dt / 0.25);
        v.vx += ((x - v.x) / dt - v.vx) * k;
        v.vy += ((y - v.y) / dt - v.vy) * k;
        v.vz += ((z - v.z) / dt - v.vz) * k;
      }
      (v.x = x), (v.y = y), (v.z = z);
      // Faces where it's going, or (aiming) the spot; leans into its speed.
      const aiming = v.aim && ctx.time >= v.aim.t0 ? v.aim : null;
      const sp = Math.hypot(v.vx, v.vz);
      let want = v.yaw;
      if (aiming) want = Math.atan2(aiming.x - x, aiming.z - z);
      else if (sp > 0.8) want = Math.atan2(v.vx, v.vz);
      v.yaw += Math.atan2(Math.sin(want - v.yaw), Math.cos(want - v.yaw)) * (1 - Math.exp(-dt * (aiming ? 10 : 4)));
      const fwd = v.vx * Math.sin(v.yaw) + v.vz * Math.cos(v.yaw), side = v.vx * Math.cos(v.yaw) - v.vz * Math.sin(v.yaw);
      v.g.position.set(x, y + Math.sin(this.t * 3.1 + i * 1.7) * 0.18, z);
      v.g.rotation.set(Math.min(0.5, fwd * 0.03), v.yaw, Math.max(-0.4, Math.min(0.4, -side * 0.03)) + Math.sin(this.t * 2.3 + i) * 0.04, 'YXZ');
      v.g.updateMatrixWorld(true);
      // The eye: a dull red glow, swelling and flickering as it aims; the thread and the dot on the spot.
      const u = aiming ? Math.min(1, (ctx.time - aiming.t0) / (aiming.T * 1000)) : 0;
      const flick = 0.85 + 0.15 * Math.sin(this.t * 60 + i);
      v.eyeTint.value.setRGB(1.6, 0.12, 0.03).multiplyScalar((aiming ? 1.5 + 5 * u * u : 0.7 + 0.3 * Math.sin(this.t * 2 + i)) * flick);
      v.eye.scale.setScalar(aiming ? 0.9 + 1.4 * u : 0.9);
      if (aiming && u < 1) {
        if (!aiming.heard) {
          aiming.heard = true;
          carrierSound.aim(v.g.position, aiming.T * (1 - u));
        }
        v.eye.getWorldPosition(_o);
        this.tube(v.thread, _o, _w.set(aiming.x, aiming.y, aiming.z), THREAD_R * (1 + u));
        v.thread.visible = true;
        v.threadFade.value = (0.25 + 0.75 * u) * (Math.random() < 0.15 ? 0.3 : 1);
        v.dot.visible = true;
        v.dot.position.set(aiming.x, aiming.y, aiming.z);
        v.dot.scale.setScalar(0.8 + 1.6 * u + 0.3 * Math.sin(this.t * (8 + 30 * u)));
        v.dotTint.value.setRGB(2.4, 0.2, 0.05).multiplyScalar(0.5 + u);
      } else v.thread.visible = v.dot.visible = false;
      list.push({ id: i, at: v.g.position });
    }
    carrierSound.drones(list, ctx.ear);
  }

  /** A dead carrier's drone dropping, tumbling and smoking, bursting on the sand. */
  private fallDrone(v: DroneView, ctx: BossCtx) {
    const dt = ctx.dt;
    v.vy -= DRONE_FALL_G * dt;
    v.x += v.vx * dt;
    v.y += v.vy * dt;
    v.z += v.vz * dt;
    v.g.position.set(v.x, v.y, v.z);
    v.g.rotation.x += v.spinX * dt;
    v.g.rotation.z += v.spinZ * dt;
    v.eyeTint.value.multiplyScalar(Math.exp(-dt * 3));
    if (Math.random() < dt * 14) zaps.puff(v.x, v.y, v.z, 0.9, 1);
    const g = heightAt(v.x, v.z);
    if (v.y > g + 0.3) return;
    v.falling = false;
    v.g.visible = false;
    zaps.burst(v.x, g + 0.4, v.z, 0, 1, 0, 24, 1.6);
    for (let i = 0; i < 4; i++) zaps.puff(v.x + (Math.random() - 0.5) * 2, g + 1 + i * 0.7, v.z + (Math.random() - 0.5) * 2, 2, 2);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, s = 3 + Math.random() * 3;
      tyreDust.emit(v.x, g + 0.3, v.z, Math.cos(a) * s, 1 + Math.random() * 2, Math.sin(a) * s, 1.5 + Math.random(), 2);
    }
    _v.set(v.x, g + 0.5, v.z);
    rifleSound.impact('metal', _v, ctx.ear);
    rifleSound.firework(_v, ctx.ear, 0.5, 1.4);
  }

  /** Lay a unit tube from a to b, r m across. */
  private tube(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, r: number) {
    const len = Math.max(0.01, a.distanceTo(b));
    m.position.copy(a);
    m.lookAt(b);
    m.scale.set(r, r, len);
  }

  /** Drone aims and shots whose time has come. */
  private updatePending(ctx: BossCtx) {
    this.pending = this.pending.filter((m) => {
      if (ctx.time < m.time) return true;
      const late = ctx.time - m.time > 1500;
      const v = this.drones[m.a![0]];
      if (m.e === 'daim') {
        if (v && !late) v.aim = { t0: m.time, T: m.a![1], x: m.x, y: m.y, z: m.z, heard: false };
        return false;
      }
      // 'dshot': from the drone (where it's drawn, else where the server had it) to the spot.
      if (v) v.aim = null;
      if (late) return false;
      if (v && v.on) v.eye.getWorldPosition(_o);
      else _o.set(m.a![1], m.a![2], m.a![3]);
      _w.set(m.x, m.y, m.z);
      // The beam carries on a little past the spot (into the sand if it gets there first).
      _d.copy(_w).sub(_o).normalize();
      for (let i = 0; i < 8; i++) {
        _w.addScaledVector(_d, 0.5);
        if (_w.y < heightAt(_w.x, _w.z)) break;
      }
      const fade = uniform(1);
      const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      mat.colorNode = vec3(4.5, 0.9, 0.2).mul(fade);
      const mesh = new THREE.Mesh(tubeGeo, mat);
      mesh.frustumCulled = false;
      this.tube(mesh, _o, _w, SHOT_R);
      this.scene.add(mesh);
      this.shots.push({ mesh, fade: fade as unknown as { value: number }, age: 0 });
      zaps.burst(_w.x, _w.y, _w.z, -_d.x, -_d.y, -_d.z, 18, 1.2);
      zaps.burst(_o.x, _o.y, _o.z, _d.x, _d.y, _d.z, 4, 0.6);
      zaps.puff(_w.x, _w.y, _w.z, 0.8, 1.5);
      carrierSound.shot(_w);
      return false;
    });
  }

  private updateShots(dt: number) {
    this.shots = this.shots.filter((s) => {
      s.age += dt;
      if (s.age >= SHOT_S) {
        s.mesh.removeFromParent();
        (s.mesh.material as THREE.Material).dispose();
        return false;
      }
      const u = s.age / SHOT_S;
      s.fade.value = (1 - u) * (1 - u);
      s.mesh.scale.x = s.mesh.scale.y = SHOT_R * (1 + u);
      return true;
    });
  }

  /** Nav lamps: the red ones pulse slowly, the white ones double-flash. */
  private lamps(t: number, dead: boolean) {
    if (!model) return;
    const red = dead ? 0 : 3 + 3 * Math.max(0, Math.sin(t * 3.2));
    const ph = t % 1.6;
    const white = dead ? 0 : ph < 0.08 || (ph > 0.22 && ph < 0.3) ? 9 : 0.3;
    for (const m of model.red) m.emissiveIntensity = red;
    for (const m of model.white) m.emissiveIntensity = white;
  }

  private searchlights(s: BossSnap, ctx: BossCtx, dead: boolean) {
    const night = smooth01((0.08 - sunElevation(timeOfDay(Date.now()))) / 0.14);
    const gain = DAY_GAIN + (1 - DAY_GAIN) * night;
    const lock = s.s[CS_LOCK] > 0.5;
    const k = 1 - Math.exp(-ctx.dt * 1.5);
    this.beams.forEach((b, i) => {
      const on = !dead;
      b.cone.visible = b.pool.visible = b.glare.visible = on;
      if (!on) return;
      _o.copy(LAMPS[i]).applyMatrix4(this.root.matrixWorld);
      // Where it's pointed: sweeping the sand round under the hull, or (the front one) onto its target.
      const tt = this.t;
      let gx = _o.x + Math.sin(tt * 0.21 + i * 2.1) * 38 + Math.sin(tt * 0.53 + i) * 10;
      let gz = _o.z + Math.cos(tt * 0.17 + i * 1.3) * 38 + Math.cos(tt * 0.47 + i * 3) * 10;
      const locked = lock && i === 0;
      if (locked) (gx = s.s[CS_TX]), (gz = s.s[CS_TZ]);
      if (Number.isNaN(b.aim.x)) b.aim.set(gx, 0, gz);
      b.aim.x += (gx - b.aim.x) * (locked ? k * 2 : k);
      b.aim.z += (gz - b.aim.z) * (locked ? k * 2 : k);
      const ay = heightAt(b.aim.x, b.aim.z);
      _d.set(b.aim.x - _o.x, ay - _o.y, b.aim.z - _o.z);
      const len = Math.max(1, _d.length());
      _d.divideScalar(len);
      b.color.lerp(locked ? RED : WARM, 1 - Math.exp(-ctx.dt * 4));
      b.tint.value.copy(b.color).multiplyScalar(gain);
      b.gtint.value.copy(b.color).multiplyScalar(0.5 + 0.5 * gain);
      const rad = len * Math.tan(BEAM_HALF);
      _z.copy(_d);
      _x.set(0, 1, 0).cross(_z);
      if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0);
      _x.normalize();
      _y.crossVectors(_z, _x);
      b.cone.matrix.makeBasis(_x.multiplyScalar(rad), _y.multiplyScalar(rad), _z.multiplyScalar(len)).setPosition(_o);
      b.cone.matrixWorld.copy(b.cone.matrix);
      // The pool: an ellipse stretched along the beam the flatter it comes in, laid on the sand.
      const flat = Math.max(0.25, Math.abs(_d.y)), hl = Math.hypot(_d.x, _d.z) || 1;
      const ax = _d.x / hl, az = _d.z / hl, across = rad * 1.15, al = across / flat;
      const pos = b.pool.geometry.attributes.position as THREE.BufferAttribute, grid = b.grid;
      for (let j = 0; j < pos.count; j++) {
        const u = grid[j * 2], w = grid[j * 2 + 1];
        const px = b.aim.x + az * u * across + ax * w * al, pz = b.aim.z - ax * u * across + az * w * al;
        pos.setXYZ(j, px, heightAt(px, pz) + 0.08, pz);
      }
      pos.needsUpdate = true;
    });
  }

  /** Sand kicked up under each live fan, thrown outward, while it's low enough and near enough to see. */
  private downwash(ctx: BossCtx, alive: number, dt: number) {
    if (!alive) return;
    const ground = heightAt(this.root.position.x, this.root.position.z);
    const h = this.root.position.y - ground;
    if (h > DUST_HEIGHT || Math.hypot(this.root.position.x - ctx.ear.x, this.root.position.z - ctx.ear.z) > DUST_SEEN) return;
    const strength = 1 - h / DUST_HEIGHT;
    this.dust += dt * DUST_RATE * strength;
    for (; this.dust >= 1; this.dust--) {
      const i = Math.floor(Math.random() * 4);
      if (!((alive >> i) & 1)) continue;
      this.fans[i].getWorldPosition(_w);
      const a = Math.random() * Math.PI * 2, r = Math.random() * 9;
      const px = _w.x + Math.cos(a) * r, pz = _w.z + Math.sin(a) * r, v = 4 + Math.random() * 5;
      tyreDust.emit(px, heightAt(px, pz) + 0.4, pz, Math.cos(a) * v, 0.4 + Math.random() * 1.2, Math.sin(a) * v, 3 + Math.random() * 3, 3 + Math.random() * 2);
    }
  }

  private death(s: BossSnap, ctx: BossCtx, x: number, y: number, z: number, fall: number) {
    const dt = ctx.dt;
    // Came into view already down: no replay.
    if (!this.seenAlive && !this.crashed && s.dead > fall + 0.5) this.crash(x, y, z, false, ctx);
    if (s.dead < fall) {
      // A heavy smoke trail and sparks out of the fans as it goes down.
      this.smoke += dt * 30;
      for (; this.smoke >= 1; this.smoke--) {
        const i = Math.floor(Math.random() * 4);
        this.fans[i].getWorldPosition(_w);
        zaps.puff(_w.x + (Math.random() - 0.5) * 6, _w.y, _w.z + (Math.random() - 0.5) * 6, 4, 1);
      }
      if (Math.random() < dt * 8) zaps.burst(x, y, z, 0, 0, 0, 10, 3);
      return;
    }
    if (!this.crashed) this.crash(s.x, s.y, s.z, true, ctx);
    // The wreck burns: flickering fires on it and a column of smoke.
    this.smoke += dt * 7;
    for (; this.smoke >= 1; this.smoke--) {
      const f = this.fires[Math.floor(Math.random() * this.fires.length)];
      if (f) f.getWorldPosition(_w);
      else _w.set(x, y, z);
      zaps.puff(_w.x + (Math.random() - 0.5) * 4, _w.y + 2, _w.z + (Math.random() - 0.5) * 4, 7, 3);
    }
    this.fires.forEach((f, i) => f.scale.setScalar((5 + i % 3) * (0.75 + 0.25 * Math.sin(this.t * (9 + i) + i) + 0.15 * Math.random())));
    if (Math.random() < dt * 1.2) zaps.burst(x, y + 3, z, 0, 1, 0, 8, 2);
  }

  /** The wreck hitting the sand (`loud`: seen happen; else just the fires). */
  private crash(x: number, y: number, z: number, loud: boolean, ctx: BossCtx) {
    this.crashed = true;
    // Fires on the hull and in the dead ducts.
    const spots: [number, number, number][] = [[0, 5, 0], [-8, 4, 10], [9, 4, -12], ...FANS.map(([fx, fy, fz]) => [fx * 0.9, fy + 1, fz * 0.9] as [number, number, number])];
    for (const [fx, fy, fz] of spots) {
      const f = new THREE.Sprite(this.fireMat);
      f.position.set(fx, fy, fz);
      this.root.add(f);
      this.fires.push(f);
    }
    if (!loud) return;
    const g = heightAt(x, z);
    this.burst(x, g + 6, z, 70, 2.4);
    for (let i = 0; i < 4; i++) {
      const f = FANS[i], c = Math.cos(this.root.rotation.y), sn = Math.sin(this.root.rotation.y);
      const fx = x + f[0] * c + f[2] * sn, fz = z - f[0] * sn + f[2] * c;
      this.burst(fx, heightAt(fx, fz) + 4, fz, 35, 1.6 + Math.random());
      zaps.burst(fx, heightAt(fx, fz) + 2, fz, 0, 1, 0, 40, 6);
    }
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2, v = 8 + Math.random() * 14, r = 10 + Math.random() * 10;
      tyreDust.emit(x + Math.cos(a) * r, g + 1, z + Math.sin(a) * r, Math.cos(a) * v, 2 + Math.random() * 5, Math.sin(a) * v, 6 + Math.random() * 5, 5 + Math.random() * 3);
    }
    for (let i = 0; i < 12; i++) zaps.puff(x + (Math.random() - 0.5) * 30, g + 4 + Math.random() * 8, z + (Math.random() - 0.5) * 30, 10, 4);
    ctx.thump(x, g, z, 6, 50, 12, 6);
    ctx.shake(Math.max(0, 0.9 * (1 - Math.hypot(x - ctx.ear.x, z - ctx.ear.z) / 400)));
    _v.set(x, g + 3, z);
    rifleSound.slam(_v, ctx.ear, true);
    guardianSound.boom(x, g + 3, z, ctx.ear);
    guardianSound.boom(x + 20, g + 3, z - 15, ctx.ear);
    rifleSound.firework(_v, ctx.ear, 1.6, 0.45);
  }

  fx(m: BossFxMsg) {
    if ((m.e === 'daim' || m.e === 'dshot') && m.a && m.a[0] >= 0 && m.a[0] < DRONE_SLOTS) {
      this.pending.push(m);
      return;
    }
    if (m.e !== 'bomb' || !m.a) return;
    const mesh = new THREE.Group();
    mesh.add(new THREE.Mesh(bombGeo, bombMat));
    const f1 = new THREE.Mesh(finGeo, bombMat), f2 = new THREE.Mesh(finGeo, bombMat);
    f2.rotation.z = Math.PI / 2;
    mesh.add(f1, f2);
    const lamp = new THREE.Sprite(glowMat(new THREE.Color(4, 0.3, 0.1)));
    lamp.position.set(0, 0.5, -0.4);
    lamp.scale.setScalar(1.4);
    mesh.add(lamp);
    mesh.visible = false;
    mesh.traverse((o) => (o.castShadow = true));
    this.scene.add(mesh);
    this.bombs.push({ t0: m.time, x: m.x, y: m.y, z: m.z, vx: m.a[0], vz: m.a[1], T: m.a[2], mesh, lamp, whistle: null, started: false });
  }

  private updateBombs(ctx: BossCtx) {
    this.bombs = this.bombs.filter((b) => {
      const t = (ctx.time - b.t0) / 1000;
      if (t < 0) return true;
      if (t >= b.T) {
        bombAt(b.x, b.y, b.z, b.vx, b.vz, b.T, _p);
        b.mesh.removeFromParent();
        (b.lamp.material as THREE.Material).dispose();
        // Too late to see it (came back to the tab): no burst.
        if (t < b.T + 1) this.boom(_p.x, _p.y, _p.z, ctx);
        return false;
      }
      bombAt(b.x, b.y, b.z, b.vx, b.vz, t, _p);
      b.mesh.visible = true;
      b.mesh.position.set(_p.x, _p.y, _p.z);
      // Nose along its fall, wobbling a little.
      _d.set(b.vx, -9.8 * t, b.vz);
      _v.copy(b.mesh.position).add(_d);
      b.mesh.lookAt(_v);
      b.mesh.rotateZ(Math.sin(t * 9) * 0.2);
      b.lamp.visible = (t * 4) % 1 < 0.5;
      if (!b.started) {
        b.started = true;
        b.whistle = carrierSound.whistle(b.T - t, b.mesh.position);
      }
      b.whistle?.(b.mesh.position);
      return true;
    });
  }

  /** A bomb bursting on the sand. */
  private boom(x: number, y: number, z: number, ctx: BossCtx) {
    this.burst(x, y + 2.5, z, 24, 1.1);
    zaps.burst(x, y + 0.5, z, 0, 1, 0, 40, 5);
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2, v = 6 + Math.random() * 8;
      tyreDust.emit(x + Math.cos(a) * 2, y + 0.5, z + Math.sin(a) * 2, Math.cos(a) * v, 2 + Math.random() * 6, Math.sin(a) * v, 3.5 + Math.random() * 2.5, 3 + Math.random() * 2);
    }
    for (let i = 0; i < 4; i++) zaps.puff(x + (Math.random() - 0.5) * 4, y + 2 + i * 2, z + (Math.random() - 0.5) * 4, 5, 3);
    ctx.thump(x, y, z, 2.6, 30, 7, 3.4);
    guardianSound.boom(x, y, z, ctx.ear);
    _v.set(x, y, z);
    rifleSound.firework(_v, ctx.ear, 1.1, 0.7);
  }

  /** A ball of fire at (x, y, z) growing to `size` m over `life` s. */
  private burst(x: number, y: number, z: number, size: number, life: number) {
    const fade = uniform(1);
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const r = length(uv().sub(0.5)).mul(2);
    m.colorNode = vec3(2.4, 0.6, 0.16).mul(fade);
    m.opacityNode = float(1).sub(smoothstep(0.0, 1, r)).mul(fade).mul(0.85);
    const sprite = new THREE.Sprite(m);
    sprite.position.set(x, y, z);
    this.scene.add(sprite);
    this.bursts.push({ sprite, fade: fade as unknown as { value: number }, age: 0, size, life });
  }

  private updateBursts(dt: number) {
    this.bursts = this.bursts.filter((b) => {
      b.age += dt;
      const t = b.age / b.life;
      if (t >= 1) {
        b.sprite.removeFromParent();
        (b.sprite.material as THREE.Material).dispose();
        return false;
      }
      b.sprite.scale.setScalar(b.size * (0.3 + 0.7 * Math.sqrt(t)));
      b.fade.value = (1 - t) * (1 - t);
      return true;
    });
  }

  /** The shot from o along unit d against the hull's box (not the fans: the hubs are seen through the ducts). */
  hull(o: THREE.Vector3, d: THREE.Vector3, max: number): number | null {
    _inv.copy(this.root.matrixWorld).invert();
    _r.copy(o).applyMatrix4(_inv);
    _m.copy(_inv).setPosition(0, 0, 0);
    _w.copy(d).applyMatrix4(_m);
    let t0 = 0, t1 = max;
    for (let a = 0; a < 3; a++) {
      const oa = _r.getComponent(a), da = _w.getComponent(a), h = HULL[a];
      if (Math.abs(da) < 1e-9) {
        if (Math.abs(oa) > h) return null;
        continue;
      }
      let ta = (-h - oa) / da, tb = (h - oa) / da;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) return null;
    }
    return t0;
  }

  dispose() {
    this.scene.remove(this.root);
    for (const b of this.beams) {
      b.cone.removeFromParent();
      b.pool.removeFromParent();
      (b.cone.material as THREE.Material).dispose();
      (b.pool.material as THREE.Material).dispose();
      b.pool.geometry.dispose();
      b.glare.material.dispose();
    }
    for (const b of this.bombs) b.mesh.removeFromParent();
    for (const b of this.bursts) b.sprite.removeFromParent();
    for (const v of this.drones) {
      if (!v) continue;
      v.g.removeFromParent();
      v.thread.removeFromParent();
      v.dot.removeFromParent();
      v.eye.material.dispose();
      v.dot.material.dispose();
      (v.thread.material as THREE.Material).dispose();
    }
    for (const s of this.shots) {
      s.mesh.removeFromParent();
      (s.mesh.material as THREE.Material).dispose();
    }
    this.fireMat.dispose();
    carrierSound.stop();
  }
}

function smooth01(v: number) {
  const t = Math.min(1, Math.max(0, v));
  return t * t * (3 - 2 * t);
}
