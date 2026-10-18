// Night drones (shared/guardians.ts): the hovering body (public/models/drone.glb, rotors spinning) and its
// searchlight: a glare at the lens, a faint haze cone (back faces only, so it also reads from inside, brightest
// along its axis and near the lamp, soft at the edges) and a bright pool where it meets the sand. Warm white while
// it sweeps, red once it has locked on to someone. Purely visual: the server decides who is lit.
//
// Shot (shared/rifle.ts): hit once it sparks, trails smoke and wobbles, its light stuttering; brought down, the light
// dies and it drops, tumbling and spinning down on a smoke trail, crashes in a burst of sparks and dust (onCrash) and
// smokes on the sand until the server clears it. The rifle tests shots against it here (raycast). Jammed
// (shared/jammer.ts) it goes dark and sinks level, rotors winding down, and settles on the sand whole.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { abs, dot, float, length, normalView, positionViewDirection, pow, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import { BEAM_HALF, beamGround } from '../../shared/guardians.ts';
import { nearStorm, type Storm } from '../../shared/storm.ts';
import { sunElevation } from '../../shared/sun.ts';
import { heightAt } from '../../shared/terrain.ts';
import { timeOfDay } from './dayNight';
import type { DroneFrame } from './botFrames.ts';
import { zaps } from './zaps.ts';
import { tyreDust } from '../tyreDust.ts';

const SHOW_R = 900;
/** The lamp, in the body frame. */
const LAMP = new THREE.Vector3(0, -0.4, 0.55);
const WARM = new THREE.Color(1.0, 0.86, 0.62);
const RED = new THREE.Color(1.0, 0.16, 0.08);
/** Haze brightness (HDR, before bloom), the pool's, and the lens glare's (and its size, m), at night; by day the
 *  haze and pool are scaled down to DAY_GAIN (the glare to halfway), as a lamp is lost in sunlight. */
const BEAM_GAIN = 0.17;
const POOL_GAIN = 1.2;
const GLARE_GAIN = 2.5;
const GLARE_SIZE = 1.1;
const DAY_GAIN = 0.12;

let model: { body: THREE.Object3D; rotors: THREE.Object3D[] } | null = null;
let loading = false;

function load() {
  if (loading) return;
  loading = true;
  new GLTFLoader().loadAsync('./models/drone.glb').then(
    (gltf) => {
      const body = gltf.scene.getObjectByName('Drone_Body');
      if (!body) throw new Error('drone.glb has no Drone_Body');
      const rotors: THREE.Object3D[] = [];
      for (let i = 0; i < 4; i++) {
        const r = gltf.scene.getObjectByName(`Drone_Rotor_${i}`);
        if (r) rotors.push(r);
      }
      // The beam starts at the lamp's lens.
      body.updateMatrixWorld(true);
      body.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || (m.material as THREE.Material).name !== 'DroneLamp') return;
        m.geometry.computeBoundingBox();
        m.geometry.boundingBox!.getCenter(LAMP).applyMatrix4(m.matrixWorld);
      });
      model = { body, rotors };
    },
    (e) => console.warn('drones: model failed, using a box', e),
  );
}

function placeholder() {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x2c2622, roughness: 0.6, metalness: 0.6 });
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.35, 1.2), m));
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.18), new THREE.MeshBasicNodeMaterial({ color: 0xfff0c0 }));
  lamp.position.copy(LAMP);
  g.add(lamp);
  return g;
}

/** Unit cone along +Z, apex at the origin, radius 1 at z = 1 (open ended). */
const coneGeo = (() => {
  const g = new THREE.CylinderGeometry(0.02, 1, 1, 24, 1, true);
  g.translate(0, -0.5, 0);
  g.rotateX(-Math.PI / 2);
  return g;
})();
/** The pool is a grid laid on the sand every frame (POOL_N × POOL_N cells), so it follows the dunes. */
const POOL_N = 12;
const POOL_LIFT = 0.08;

type View = {
  root: THREE.Group;
  rotors: THREE.Object3D[];
  beam: THREE.Mesh;
  pool: THREE.Mesh;
  /** The pool grid's own (across, along) coordinates, -1..1, per vertex. */
  grid: Float32Array;
  glare: THREE.Sprite;
  color: THREE.Color;
  model: boolean;
  /** Hits seen, the tumble while falling (spin, tip), smoke owed, and whether it has hit the sand. */
  hurt: number; spin: number; tip: number; smoke: number; crashed: boolean;
  /** Brought down (shot or jammed): no longer a target. */
  down: boolean;
};

/** A drone's body, for the hit test (m, about its centre). */
const HIT_R = 1.25;

const _lamp = new THREE.Vector3(), _dir = new THREE.Vector3(), _hit = { x: 0, y: 0, z: 0 };
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4();

export class Drones {
  private views = new Map<number, View>();
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    load();
  }

  private make(): View {
    const root = new THREE.Group();
    let rotors: THREE.Object3D[] = [];
    if (model) {
      root.add(model.body.clone());
      rotors = model.rotors.map((r) => {
        const c = r.clone();
        root.add(c);
        return c;
      });
    } else root.add(placeholder());
    root.traverse((o) => (o.castShadow = true));
    const color = WARM.clone();
    const tint = uniform(color.clone());
    const gtint = uniform(color.clone());
    // Brightest along the axis (where the surface faces us, i.e. through the most haze) and near the lamp, nothing
    // at the silhouette, fading towards the far end.
    const beamMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide });
    const facing = pow(abs(dot(normalView, positionViewDirection)), float(3));
    const along = uv().y; // 1 at the lamp, 0 at the far end
    beamMat.colorNode = tint.mul(BEAM_GAIN);
    beamMat.opacityNode = facing.mul(pow(along, float(1.6)).mul(0.8).add(0.2)).mul(smoothstep(0, 0.15, along));
    const beam = new THREE.Mesh(coneGeo, beamMat);
    beam.frustumCulled = false;
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
    const glareMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const g = float(1).sub(smoothstep(0, 1, length(uv().sub(0.5)).mul(2)));
    glareMat.colorNode = gtint.mul(GLARE_GAIN);
    glareMat.opacityNode = g.mul(g).mul(g);
    const glare = new THREE.Sprite(glareMat);
    glare.position.copy(LAMP);
    glare.scale.setScalar(GLARE_SIZE);
    root.add(beam, glare);
    this.scene.add(root, pool);
    beam.userData.tint = tint;
    glare.userData.tint = gtint;
    return { root, rotors, beam, pool, grid, glare, color, model: model !== null, hurt: 0, spin: 0, tip: 0, smoke: 0, crashed: false, down: false };
  }

  update(frames: DroneFrame[], dt: number, focus: { x: number; z: number }, storms: readonly Storm[], t: number) {
    const seen = new Set<number>();
    const now = performance.now() / 1000;
    const night = smooth01((0.08 - sunElevation(timeOfDay(Date.now()))) / 0.14);
    const gain = DAY_GAIN + (1 - DAY_GAIN) * night;
    for (const f of frames) {
      if (Math.hypot(f.x - focus.x, f.z - focus.z) > SHOW_R) continue;
      seen.add(f.id);
      let v = this.views.get(f.id);
      if (v && !v.model && model) {
        this.drop(v);
        v = undefined;
      }
      if (!v) {
        this.views.set(f.id, (v = this.make()));
        // Came into view already hit or down: don't replay it.
        v.hurt = f.hurt;
        v.crashed = f.down > 0 && f.y - heightAt(f.x, f.z) < 1;
      }
      if (f.hurt > v.hurt) {
        v.hurt = f.hurt;
        zaps.burst(f.x, f.y, f.z, 0, -0.3, 0, 22, 1.5);
        this.onHit(f.x, f.y, f.z);
      }
      v.down = f.down > 0;
      if (f.down > 0) {
        this.falling(v, f, dt);
        continue;
      }
      // Hit: trailing smoke and sparks, the light stuttering.
      if (v.hurt > 0) {
        v.smoke += dt * 6;
        for (; v.smoke >= 1; v.smoke--) zaps.puff(f.x, f.y + 0.2, f.z, 0.7, 1.5);
        if (Math.random() < dt * 3) zaps.burst(f.x, f.y, f.z, 0, -1, 0, 5);
      }
      // Being jammed by us (src/jammer.ts): it twitches and its light stutters, more as the lock builds.
      const jam = this.jamming?.id === f.id ? this.jamming.level : 0;
      const wob = v.hurt > 0 ? 1 : jam;
      // Hovering: a slow bob and a lean into the way it's going.
      v.root.position.set(f.x, f.y + Math.sin(now * 1.3 + f.id) * 0.25, f.z);
      v.root.rotation.set(0.08 + wob * Math.sin(now * 5.3) * 0.12, f.yaw, Math.sin(now * 0.9 + f.id) * 0.04 + wob * Math.sin(now * 4.1) * 0.15, 'YXZ');
      // Light out near a storm (the server has it ignore everyone there).
      const lit = !nearStorm(storms, f.x, f.z, t);
      v.glare.visible = v.beam.visible = lit && (!wob || Math.sin(now * 23) * Math.sin(now * 7) > -0.6);
      v.rotors.forEach((r, i) => (r.rotation.y += (i % 2 ? -1 : 1) * dt * 60));
      v.color.lerp(f.lock ? RED : WARM, 1 - Math.exp(-dt * 6));
      (v.beam.userData.tint as { value: THREE.Color }).value.copy(v.color).multiplyScalar(gain);
      (v.glare.userData.tint as { value: THREE.Color }).value.copy(v.color).multiplyScalar(0.5 + 0.5 * gain);
      // Beam from the lamp to the sand (world space; the cone is a child of the body, so undo its transform).
      v.root.updateMatrixWorld();
      _lamp.copy(LAMP).applyMatrix4(v.root.matrixWorld);
      _dir.set(f.dx, f.dy, f.dz);
      beamGround(_lamp.x, _lamp.y, _lamp.z, f.dx, f.dy, f.dz, _hit);
      const len = Math.max(1, Math.hypot(_hit.x - _lamp.x, _hit.y - _lamp.y, _hit.z - _lamp.z));
      const rad = len * Math.tan(BEAM_HALF);
      v.beam.matrixAutoUpdate = false;
      _z.copy(_dir);
      _x.set(0, 1, 0).cross(_z);
      if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0);
      _x.normalize();
      _y.crossVectors(_z, _x);
      _m.makeBasis(_x.multiplyScalar(rad), _y.multiplyScalar(rad), _z.multiplyScalar(len)).setPosition(_lamp);
      v.beam.matrix.copy(v.root.matrixWorld).invert().multiply(_m);
      // The pool: an ellipse stretched along the beam the flatter it comes in, its grid dropped onto the sand.
      const flat = Math.max(0.25, Math.abs(f.dy)), hl = Math.hypot(f.dx, f.dz) || 1;
      const ax = f.dx / hl, az = f.dz / hl, across = rad * 1.15, along = across / flat;
      const pos = v.pool.geometry.attributes.position as THREE.BufferAttribute, grid = v.grid;
      for (let i = 0; i < pos.count; i++) {
        const u = grid[i * 2], w = grid[i * 2 + 1]; // -1..1 across and along (the ellipse is inscribed)
        const x = _hit.x + az * u * across + ax * w * along, z = _hit.z - ax * u * across + az * w * along;
        pos.setXYZ(i, x, heightAt(x, z) + POOL_LIFT, z);
      }
      pos.needsUpdate = true;
      v.pool.visible = lit && len < 74;
    }
    for (const [id, v] of this.views) if (!seen.has(id)) {
      this.drop(v);
      this.views.delete(id);
    }
  }

  /** Shot down: light out, tumbling down on a smoke trail; then a crash and a smoking wreck. */
  private falling(v: View, f: DroneFrame, dt: number) {
    v.beam.visible = v.pool.visible = v.glare.visible = false;
    const ground = heightAt(f.x, f.z);
    if (f.jammed) return this.sinking(v, f, dt, ground);
    if (!v.crashed && f.y - ground < 0.9 && f.down > 0.15) {
      v.crashed = true;
      zaps.burst(f.x, ground + 0.4, f.z, 0, 1, 0, 60, 3);
      zaps.beam(f.x, ground + 0.5, f.z, f.x, ground + 0.6, f.z); // just the flash
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        tyreDust.emit(f.x, ground + 0.2, f.z, Math.cos(a) * 3, 1 + Math.random() * 1.5, Math.sin(a) * 3, 0.9);
      }
      this.onCrash(f.x, ground, f.z);
    }
    if (!v.crashed) {
      // Spinning up as it drops, tipping over.
      v.spin += dt * Math.min(9, 2 + f.down * 6);
      v.tip = Math.min(1.1, v.tip + dt * 0.9);
      v.rotors.forEach((r, i) => (r.rotation.y += (i % 2 ? -1 : 1) * dt * 25 * Math.max(0, 1 - f.down)));
      v.smoke += dt * 22;
      for (; v.smoke >= 1; v.smoke--) zaps.puff(f.x, f.y + 0.2, f.z, 0.9, 0.6);
      if (Math.random() < dt * 12) zaps.burst(f.x, f.y, f.z, 0, 0, 0, 3);
    } else {
      // On the sand, on its side, smoking.
      v.tip = Math.min(1.25, v.tip + dt * 4);
      v.smoke += dt * 5;
      for (; v.smoke >= 1; v.smoke--) zaps.puff(f.x + (Math.random() - 0.5), ground + 0.5, f.z + (Math.random() - 0.5), 1.2, 1.8);
      if (Math.random() < dt * 0.8) zaps.burst(f.x, ground + 0.5, f.z, 0, 1, 0, 6);
    }
    v.root.position.set(f.x, v.crashed ? ground + 0.35 : f.y, f.z);
    v.root.rotation.set(v.tip, f.yaw + v.spin, v.tip * 0.4, 'YXZ');
  }

  /** Jammed: light out, rotors winding down, sinking level with a slight sway; it settles on the sand upright. */
  private sinking(v: View, f: DroneFrame, dt: number, ground: number) {
    const now = performance.now() / 1000;
    if (!v.crashed && f.y - ground < 0.9 && f.down > 0.15) {
      v.crashed = true;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        tyreDust.emit(f.x, ground + 0.15, f.z, Math.cos(a) * 1.5, 0.4 + Math.random() * 0.5, Math.sin(a) * 1.5, 0.7);
      }
      this.onLand(f.x, ground, f.z);
    }
    const spin = v.crashed ? 0 : Math.max(0.15, 1 - f.down * 0.12);
    v.rotors.forEach((r, i) => (r.rotation.y += (i % 2 ? -1 : 1) * dt * 60 * spin));
    const sway = v.crashed ? 0 : 0.06;
    v.root.position.set(f.x, v.crashed ? ground + 0.3 : f.y, f.z);
    v.root.rotation.set(sway * Math.sin(now * 1.7 + f.id), f.yaw, sway * Math.sin(now * 1.3 + f.id * 2), 'YXZ');
  }

  /** The first flying drone the shot from `o` along unit `d` strikes within `max` m: its id, distance, the point. */
  raycast(o: THREE.Vector3, d: THREE.Vector3, max: number): { drone: number; dist: number; point: THREE.Vector3 } | null {
    let best: { drone: number; dist: number; point: THREE.Vector3 } | null = null;
    for (const [id, v] of this.views) {
      if (v.down) continue;
      const c = v.root.position;
      const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
      const b = ox * d.x + oy * d.y + oz * d.z, disc = b * b - (ox * ox + oy * oy + oz * oz - HIT_R * HIT_R);
      if (disc < 0) continue;
      const t = -b - Math.sqrt(disc);
      if (t < 0 || t > max || (best && t >= best.dist)) continue;
      best = { drone: id, dist: t, point: o.clone().addScaledVector(d, t) };
    }
    return best;
  }

  /** A shot-down drone hit the sand at (x, y, z) (src/guardians.ts: the bang). */
  onCrash: (x: number, y: number, z: number) => void = () => {};
  /** The drones still flying, where they're drawn (the jammer's targets). */
  *flying(): Generator<{ id: number; x: number; y: number; z: number }> {
    for (const [id, v] of this.views) if (!v.down) yield { id, x: v.root.position.x, y: v.root.position.y, z: v.root.position.z };
  }

  /** The drone our jammer is on and how far its lock has built (0..1), or null (src/jammer.ts). */
  jamming: { id: number; level: number } | null = null;

  /** A jammed drone settled on the sand at (x, y, z). */
  onLand: (x: number, y: number, z: number) => void = () => {};
  /** A shot hit a drone (every hit counts, the last brings it down). */
  onHit: (x: number, y: number, z: number) => void = () => {};

  private drop(v: View) {
    v.root.removeFromParent();
    v.pool.removeFromParent();
    (v.beam.material as THREE.Material).dispose();
    (v.pool.material as THREE.Material).dispose();
    v.pool.geometry.dispose();
    v.glare.material.dispose();
  }
}

function smooth01(v: number) {
  const t = Math.min(1, Math.max(0, v));
  return t * t * (3 - 2 * t);
}
