// Player avatars (local + remote).
//
// `Avatar` owns placement (position, smoothed facing, terrain), derived motion state (sliding),
// footprints and the name tag. Its visuals are a swappable `AvatarModel`: the simple procedural
// placeholder below, or the rigged scavenger (src/models/scavenger.ts) with the same interface.
import * as THREE from 'three/webgpu';
import { isSlipFace } from '../shared/sim.ts';
import { heightAt } from '../shared/terrain.ts';
import { footprints } from './footprints.ts';
import { SHADOW_ONLY_LAYER } from './world/env.ts';

export type AvatarPose = {
  x: number; y: number; z: number; facing: number; speed: number; grounded: boolean;
  sliding?: boolean; digging?: boolean; pitch?: number;
};

/** What a model needs each frame; placement is already applied to its parent. */
export type ModelPose = {
  speed: number; grounded: boolean; digging?: boolean; sliding?: boolean; pitch?: number;
  /** Sand height under the feet, when standing on sand (not scrap): lets the model plant its feet. */
  ground?: (x: number, z: number) => number;
};

export interface AvatarModel {
  readonly root: THREE.Object3D;
  setColor(hex: number): void;
  update(pose: ModelPose, dt: number): void;
  dispose(): void;
}

const STRIDE = 1.15; // metres per footstep, matches the first-person head bob

export class Avatar {
  readonly root = new THREE.Group();
  private model: AvatarModel;
  private facing = NaN;
  private stepDist = 0;
  private foot = 1;
  private label?: THREE.Sprite;
  /** Leave footprints even when the root is hidden (the local first-person player). */
  footprints = true;
  private shadowOnly = false;

  constructor(color: number, model: AvatarModel = new PlaceholderModel()) {
    this.model = model;
    this.attach(model);
    this.model.setColor(color);
  }

  /** Swap the visuals (e.g. to the rigged scavenger once its glTF has loaded). */
  setModel(model: AvatarModel, color: number) {
    this.model.dispose();
    this.model = model;
    this.attach(model);
    model.setColor(color);
  }

  /** Cast a sun shadow but don't draw the body (the local first-person player). */
  setShadowOnly(on: boolean) {
    this.shadowOnly = on;
    this.attach(this.model);
  }

  /** Every mesh casts a full silhouette (legs and head too) and darkens in dune shadow. */
  private attach(model: AvatarModel) {
    this.root.add(model.root);
    model.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.castShadow = true;
      o.receiveShadow = !this.shadowOnly;
      if (this.shadowOnly) o.layers.set(SHADOW_ONLY_LAYER);
      else o.layers.set(0);
    });
  }

  setColor(color: number) {
    this.model.setColor(color);
  }

  /** Floating tag over the head (remote players). */
  setLabel(text: string, color: number) {
    this.label?.removeFromParent();
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const g = canvas.getContext('2d')!;
    g.font = 'bold 34px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(20, 10, 5, 0.55)';
    const w = g.measureText(text).width + 36;
    g.beginPath();
    g.roundRect(128 - w / 2, 8, w, 48, 24);
    g.fill();
    g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    g.fillText(text, 128, 33);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
    this.label = new THREE.Sprite(mat);
    this.label.scale.set(1.2, 0.3, 1);
    this.label.position.y = 2.25;
    this.root.add(this.label);
  }

  /** Called every render frame. */
  update(pose: AvatarPose, dt: number) {
    this.root.position.set(pose.x, pose.y, pose.z);
    // Facing comes from 20 Hz snapshots (remote) or the mouse (local): smooth it a little.
    if (!Number.isFinite(this.facing)) this.facing = pose.facing;
    const d = Math.atan2(Math.sin(pose.facing - this.facing), Math.cos(pose.facing - this.facing));
    this.facing += d * (1 - Math.exp(-dt * 18));
    this.root.rotation.y = this.facing;

    const sliding = pose.sliding ?? (pose.grounded && pose.speed > 2 && isSlipFace(pose.x, pose.z));
    const onSand = pose.grounded && Math.abs(pose.y - heightAt(pose.x, pose.z)) < 0.05;
    this.model.update(
      { speed: pose.speed, grounded: pose.grounded, sliding, digging: pose.digging, pitch: pose.pitch, ground: onSand ? heightAt : undefined },
      dt,
    );

    // Footprints: one per stride while walking; a sliding body leaves a smear of prints instead.
    if (!this.footprints || !pose.grounded) return;
    this.stepDist += pose.speed * dt;
    const stride = sliding ? 0.6 : STRIDE;
    if (this.stepDist < stride) return;
    this.stepDist %= stride;
    this.foot = -this.foot;
    const side = sliding ? 0 : 0.13 * this.foot;
    const fx = pose.x + Math.cos(this.facing) * side, fz = pose.z - Math.sin(this.facing) * side;
    footprints.add(fx, heightAt(fx, fz), fz, this.facing, sliding ? 2.2 : 1);
  }

  dispose() {
    this.model.dispose();
    this.root.removeFromParent();
  }
}

// --- Placeholder model --------------------------------------------------------------------------
// A small hooded scavenger from primitives: robe cone, pointed hood, dark face, two glowing eyes,
// a scrap backpack, boots that swing with a walk cycle. Tinted by the player colour. Facing -Z.

const ROBE_BASE = new THREE.Color(0x5a3b24);

export class PlaceholderModel implements AvatarModel {
  readonly root = new THREE.Group();
  private robeMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  private sashMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.8 });
  private body = new THREE.Group(); // bobs and leans
  private legs: THREE.Group[] = [];
  private arms: THREE.Group[] = [];
  private robe: THREE.Mesh;
  private phase = 0;
  private lean = 0;
  private sway = 0;
  private swayVel = 0;
  private lastSpeed = 0;
  private air = 0;
  private slide = 0;

  constructor() {
    const dark = new THREE.MeshStandardNodeMaterial({ color: 0x1e140e, roughness: 0.9 });
    const boot = new THREE.MeshStandardNodeMaterial({ color: 0x2c1d14, roughness: 0.85 });
    const metal = new THREE.MeshStandardNodeMaterial({ color: 0x6d6a62, roughness: 0.5, metalness: 0.7 });
    const eye = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1, 0.75, 0.2).multiplyScalar(6) });

    // Robe: a flared lathe from shoulders (1.35 m) to hem (0.35 m).
    const pts = [
      new THREE.Vector2(0.0, 1.42), new THREE.Vector2(0.2, 1.38), new THREE.Vector2(0.27, 1.25),
      new THREE.Vector2(0.3, 0.9), new THREE.Vector2(0.37, 0.5), new THREE.Vector2(0.42, 0.32),
    ];
    // Pivot at the shoulders so the hem swings.
    this.robe = new THREE.Mesh(new THREE.LatheGeometry(pts, 14).translate(0, -1.4, 0), this.robeMat);
    this.robe.position.y = 1.4;
    // Hood: a pointed cone over a head sphere, tip flopping back.
    const head = new THREE.Group();
    head.position.y = 1.5;
    const hood = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.62, 14, 1, true), this.robeMat);
    hood.position.set(0, 0.12, 0.04);
    hood.rotation.x = 0.28;
    hood.material.side = THREE.DoubleSide;
    const face = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8), dark);
    face.position.set(0, -0.02, -0.04);
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), eye);
      e.position.set(0.065 * s, 0.0, -0.18);
      head.add(e);
    }
    head.add(hood, face);
    // Sash in full player colour, and a scrap backpack.
    const sash = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.035, 6, 16), this.sashMat);
    sash.position.y = 0.95;
    sash.rotation.x = Math.PI / 2;
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.42, 0.18), dark);
    pack.position.set(0, 1.08, 0.3);
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.4, 8), metal);
    can.position.set(0.2, 1.12, 0.33);
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.6, 4), metal);
    antenna.position.set(-0.12, 1.5, 0.32);
    this.body.add(this.robe, head, sash, pack, can, antenna);

    // Arms: sleeves pivoting at the shoulder.
    for (const s of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(0.28 * s, 1.3, 0);
      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.55, 8), this.robeMat);
      sleeve.position.y = -0.27;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), dark);
      hand.position.y = -0.58;
      arm.add(sleeve, hand);
      this.arms.push(arm);
      this.body.add(arm);
    }
    // Legs: shins + boots under the hem, pivoting at the hip.
    for (const s of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(0.12 * s, 0.75, 0);
      const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.055, 0.7, 6), dark);
      shin.position.y = -0.38;
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.12, 0.26), boot);
      b.position.set(0, -0.7, -0.04);
      leg.add(shin, b);
      this.legs.push(leg);
      this.root.add(leg);
    }
    this.root.add(this.body);
  }

  setColor(hex: number) {
    const c = new THREE.Color(hex);
    this.sashMat.color.copy(c);
    this.robeMat.color.copy(ROBE_BASE).lerp(c, 0.35);
  }

  update(p: ModelPose, dt: number) {
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    const run = Math.min(p.speed / 11, 1);
    this.air += ((p.grounded ? 0 : 1) - this.air) * k(10);
    this.slide += ((p.sliding ? 1 : 0) - this.slide) * k(8);
    if (p.grounded) this.phase += (p.speed * dt * Math.PI) / STRIDE;
    const walk = Math.min(p.speed / 3, 1) * (1 - this.air) * (1 - this.slide);
    const sw = Math.sin(this.phase);

    // Legs and arms swing opposite; airborne tucks the legs and lifts the arms; sliding braces.
    const legSwing = sw * (0.45 + 0.35 * run) * walk;
    this.legs[0].rotation.x = legSwing - 0.5 * this.air + 0.3 * this.slide;
    this.legs[1].rotation.x = -legSwing - 0.2 * this.air - 0.3 * this.slide;
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1;
      this.arms[i].rotation.x = (i === 0 ? -legSwing : legSwing) * 0.9 - 0.4 * this.air;
      this.arms[i].rotation.z = s * (0.12 + 0.9 * this.air + 1.1 * this.slide);
    }

    // Lean into acceleration and speed; bob with steps; robe hem sways on a spring.
    const accel = (p.speed - this.lastSpeed) / Math.max(dt, 1e-3);
    this.lastSpeed = p.speed;
    this.lean += (0.12 * run + 0.01 * Math.max(-8, Math.min(8, accel)) - (this.slide * 0.25) - this.lean) * k(6);
    this.body.rotation.x = -this.lean;
    this.body.rotation.y = this.slide * 0.9;
    this.body.position.y = Math.abs(Math.cos(this.phase)) * 0.05 * walk - 0.06 * this.slide;
    this.swayVel += (-60 * this.sway - 6 * this.swayVel + accel * 0.6 + sw * 4 * walk) * dt;
    this.sway += this.swayVel * dt;
    this.robe.rotation.x = Math.max(-0.2, Math.min(0.2, this.sway * 0.04));
  }

  dispose() {
    this.root.removeFromParent();
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.robeMat.dispose();
    this.sashMat.dispose();
  }
}
