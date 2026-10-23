// Player avatars (local + remote).
//
// `Avatar` owns placement (position, smoothed facing, terrain), derived motion state (sliding),
// footprints, footstep sounds and the name tag. Its visuals are a swappable `AvatarModel`: the simple procedural
// placeholder below, or the rigged scavenger (src/models/scavenger.ts) with the same interface.
import * as THREE from 'three/webgpu';
import { indoors, sandHidden } from '../shared/shelters.ts';
import { isSlipFace, slopeAt } from '../shared/sim.ts';
import { wornBit } from '../shared/gearBits.ts';
import { heightAt } from '../shared/terrain.ts';
import { END_FADE, footprints, streaks } from './footprints.ts';
import { footsteps } from './footsteps.ts';
import { tyreDust } from './tyreDust.ts';
import { SHADOW_ONLY_LAYER } from './world/env.ts';

export type AvatarPose = {
  x: number; y: number; z: number; facing: number; speed: number; grounded: boolean;
  sliding?: boolean; digging?: boolean; pitch?: number;
  /** In an intentional (Ctrl) slide, as opposed to slipping down a slip face (`sliding`). */
  powerSlide?: boolean;
  crouching?: boolean;
  /** Ground velocity, for which way the legs walk relative to facing (defaults to straight ahead). */
  vx?: number; vz?: number;
  /** Seated on a sand bike: the caller has already placed the root (Bike.seat), so x/y/z/facing are ignored. */
  ride?: RidePose;
  /** Drinking from the canteen in hand (see setOutfit). */
  drinking?: boolean;
  /** A gun in hand raised to aim along `pitch` (else carried at the low ready). */
  aiming?: boolean;
  /** Dead: a ragdoll thrown by this push (m/s, world; shared/ragdoll.ts). Placement stays where it fell. */
  down?: [number, number, number] | null;
  /** The head turned this far from where the body faces (rad, + = left): the local player's free look (Alt). */
  look?: number;
};

/** A seated rider's contact points and body English, in the avatar root's space (forward is -z). */
export type RidePose = {
  /** Where the hips go. */
  seat: THREE.Vector3;
  /** Left and right hands (wrists aim here, fingers round the grip) and feet. */
  grips: [THREE.Vector3, THREE.Vector3];
  pegs: [THREE.Vector3, THREE.Vector3];
  /** Upper body roll (rad, + = to the left), yaw (+ = turned left) and forward tuck (+ = bent over the bars). */
  lean: number;
  twist: number;
  tuck: number;
};

/** What a model needs each frame; placement is already applied to its parent. */
export type ModelPose = {
  speed: number; grounded: boolean; digging?: boolean; sliding?: boolean; pitch?: number;
  /** Intentional (Ctrl) slide: lies back on the sand and follows its slope (tiltPitch / tiltRoll). */
  powerSlide?: boolean;
  /** Ctrl held without sliding: crouched, slow. */
  crouching?: boolean;
  /** Ground slope along / across the facing (rad): + pitch = uphill ahead, + roll = uphill to the right. */
  tiltPitch?: number; tiltRoll?: number;
  /** Direction of travel relative to facing (rad): 0 ahead, +π/2 to the right, ±π backwards. */
  heading?: number;
  /** Grade along the way you're walking (tan; + = uphill): climbing trudges, leaning in with shorter steps. */
  climb?: number;
  /** Sand height under the feet, when standing on sand (not scrap): lets the model plant its feet. */
  ground?: (x: number, z: number) => number;
  ride?: RidePose;
  drinking?: boolean;
  aiming?: boolean;
  /** Where the eyes look relative to the body's facing (rad, + = to the left): nonzero when the body faces
   *  its travel instead (feet first in a slide); the head turns towards it. Given, it adds to that (free look). */
  look?: number;
};

export interface AvatarModel {
  readonly root: THREE.Object3D;
  setColor(hex: number): void;
  update(pose: ModelPose, dt: number): void;
  /** What's in the hand (an item kind, null for none) and the gear worn (shared/gear.ts wornGear bits). */
  setOutfit?(item: string | null, gear: number, tiers?: number): boolean;
  /** First person on the bike: draw the body (hands on the bars) but not the head the camera is in. */
  setHeadless?(on: boolean): void;
  /** The eyes' world position, once posed (riding in first person, the camera sits there). */
  eye?(out: THREE.Vector3): boolean;
  /** The held gun's muzzle (world), if there is one in hand and drawn. */
  muzzle?(out: THREE.Vector3): boolean;
  /** Go limp as a ragdoll thrown by `push`, or get back up (null). False if it can't (then the Avatar tips it over). */
  ragdoll?(push: THREE.Vector3 | null, ground: (x: number, z: number) => number): boolean;
  /** The ragdoll's middle (world), while it is one. */
  ragdollCenter?(out: THREE.Vector3): boolean;
  dispose(): void;
}

const STRIDE = 1.72; // metres per footstep, matches the first-person head bob (src/camera.ts) and the Run clip
const STREAK_STEP = 0.3; // metres per slide-streak segment
const STREAK_WIDTH = 0.42;

export class Avatar {
  readonly root = new THREE.Group();
  private model: AvatarModel;
  private facing = NaN;
  private stepDist = 0;
  private foot = 1;
  // Where the current slide streak last ended; NaN when not sliding.
  private streakX = NaN;
  private streakZ = NaN;
  /** How fast the body turns to its facing (eased: slower while it goes feet first in a slide). */
  private turnRate = 18;
  /** Seconds into the current slide (0 when not sliding) and sand puffs owed to the spray. */
  private slideFor = 0;
  private sprayOwed = 0;
  private label?: THREE.Sprite;
  private labelText = '';
  /** Leave footprints even when the root is hidden (the local first-person player). */
  footprints = true;
  private shadowOnly = false;
  /** Dead (AvatarPose.down): the model is a ragdoll, or (`tipped`) a model without one lies tipped over. */
  private down = false;
  private tipped = false;

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

  setHeadless(on: boolean) {
    this.model.setHeadless?.(on);
  }

  /** What's in hand and worn and how good (see AvatarModel.setOutfit); call every frame, it's cheap when nothing changed. */
  setOutfit(item: string | null, gear: number, tiers = 0) {
    // New meshes (an item taken out, a model loaded) get the layers too.
    if (this.model.setOutfit?.(item, gear, tiers)) this.attach(this.model);
  }

  /** The eyes' world position as last drawn; false if the model can't tell (placeholder). */
  eye(out: THREE.Vector3): boolean {
    return this.model.eye?.(out) ?? false;
  }

  /** The held gun's muzzle (world) as last drawn; false if none is drawn. */
  muzzle(out: THREE.Vector3): boolean {
    return this.root.visible && (this.model.muzzle?.(out) ?? false);
  }

  /** Show or hide the tag (the fly camera's clean view, src/flyCam.ts). */
  showLabel(on: boolean) {
    if (this.label) this.label.visible = on;
  }

  /** Floating tag over the head (remote players). */
  setLabel(text: string, color: number) {
    if (this.label && text === this.labelText) return;
    this.clearLabel();
    this.labelText = text;
    const font = 'bold 34px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const canvas = document.createElement('canvas');
    let g = canvas.getContext('2d')!;
    g.font = font;
    // Wide enough for the name (up to NAME_MAX characters), at least the old 256 px.
    const w = g.measureText(text).width + 36;
    canvas.width = Math.max(256, Math.ceil(w + 16));
    canvas.height = 64;
    g = canvas.getContext('2d')!;
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(20, 10, 5, 0.55)';
    const cx = canvas.width / 2;
    g.beginPath();
    g.roundRect(cx - w / 2, 8, w, 48, 24);
    g.fill();
    g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    g.fillText(text, cx, 33);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
    this.label = new THREE.Sprite(mat);
    this.label.scale.set((0.3 * canvas.width) / canvas.height, 0.3, 1);
    this.label.position.y = 2.25;
    this.root.add(this.label);
  }

  private clearLabel() {
    if (!this.label) return;
    this.label.removeFromParent();
    this.label.material.map?.dispose();
    this.label.material.dispose();
    this.label.dispose();
    this.label = undefined;
  }

  /** Where the body lies while down (the ragdoll's middle, else just above the feet); false when not down. */
  downAt(out: THREE.Vector3): boolean {
    if (!this.down) return false;
    if (!this.model.ragdollCenter?.(out)) out.copy(this.root.position).setY(this.root.position.y + 0.3);
    return true;
  }

  /** Dead or alive (AvatarPose.down): fall as a ragdoll where it stands, or get back up. True while down. */
  private fall(pose: AvatarPose, dt: number): boolean {
    if (pose.down && !this.down) {
      this.down = true;
      this.streakX = NaN;
      if (!pose.ride) this.root.position.set(pose.x, pose.y, pose.z); // first frame we see them: already dead
      // In the base the bunker floor is under the feet, not the sand overhead.
      const y = this.root.position.y;
      const ground = (x: number, z: number) => (sandHidden(x, z, y) ? y : heightAt(x, z));
      this.tipped = !this.model.ragdoll?.(_push.fromArray(pose.down), ground);
    } else if (!pose.down && this.down) {
      this.down = false;
      this.model.ragdoll?.(null, heightAt);
      this.root.rotation.x = 0;
      this.facing = pose.facing;
    }
    if (!this.down) return false;
    if (this.tipped) this.root.rotation.x += (-Math.PI / 2 - this.root.rotation.x) * (1 - Math.exp(-dt * 6));
    this.model.update({ speed: 0, grounded: true }, dt);
    return true;
  }

  /** Called every render frame. */
  update(pose: AvatarPose, dt: number) {
    if (this.fall(pose, dt)) return;
    if (pose.ride) {
      this.facing = pose.facing; // so getting off turns from here, not from where we got on
      this.streakX = NaN;
      this.model.update({ speed: 0, grounded: true, pitch: pose.pitch, ride: pose.ride }, dt);
      return;
    }
    this.root.position.set(pose.x, pose.y, pose.z);
    const power = !!pose.powerSlide && pose.grounded;
    const vx = pose.vx ?? 0, vz = pose.vz ?? 0;
    const onSand = pose.grounded && Math.abs(pose.y - heightAt(pose.x, pose.z)) < 0.05;
    // Uphill grade along the way you're going (tan; + = climbing), and how fast you're gaining ground up the slope (m/s).
    let climb = 0, upSpeed = 0;
    if (onSand && pose.speed > 0.5 && pose.vx !== undefined) {
      const g = slopeAt(pose.x, pose.z, tmpSlope);
      climb = (vx * g.gx + vz * g.gz) / pose.speed;
      upSpeed = (vx * g.gx + vz * g.gz) / Math.max(1e-6, Math.hypot(g.gx, g.gz));
    }
    // Climbing a slip face is walking (sim.ts lets you claw up one), not sliding down it.
    const slip = !power && (pose.sliding ?? (pose.grounded && pose.speed > 2 && upSpeed < 1 && isSlipFace(pose.x, pose.z)));
    const sliding = slip || power;
    // Facing comes from 20 Hz snapshots (remote) or the mouse (local): smooth it a little. In a speed slide the
    // body goes feet first the way it is travelling (the head turns to where it looks), turning more slowly.
    const feetFirst = power && pose.vx !== undefined && Math.hypot(vx, vz) > 1;
    const want = feetFirst ? Math.atan2(-vx, -vz) : pose.facing;
    if (!Number.isFinite(this.facing)) this.facing = want;
    this.turnRate += ((feetFirst ? 9 : 18) - this.turnRate) * (1 - Math.exp(-dt * 4));
    const d = Math.atan2(Math.sin(want - this.facing), Math.cos(want - this.facing));
    this.facing += d * (1 - Math.exp(-dt * this.turnRate));
    this.root.rotation.y = this.facing;
    const look = Math.atan2(Math.sin(pose.facing - this.facing), Math.cos(pose.facing - this.facing)) + (pose.look ?? 0);

    // Travel direction in the body frame (facing f looks along (-sin f, -cos f)).
    const ahead = -vx * Math.sin(this.facing) - vz * Math.cos(this.facing);
    const right = vx * Math.cos(this.facing) - vz * Math.sin(this.facing);
    const heading = pose.vx === undefined ? 0 : Math.atan2(right, ahead);
    let tiltPitch = 0, tiltRoll = 0;
    if (power && onSand) {
      // Lie along the ground: the slope's rise along the body's forward and right directions.
      const g = slopeAt(pose.x, pose.z, tmpSlope);
      const fx = -Math.sin(this.facing), fz = -Math.cos(this.facing);
      tiltPitch = Math.atan(g.gx * fx + g.gz * fz);
      tiltRoll = Math.atan(g.gx * -fz + g.gz * fx);
    }
    this.model.update(
      {
        speed: pose.speed, grounded: pose.grounded, sliding: slip, powerSlide: power, crouching: pose.crouching, tiltPitch, tiltRoll,
        digging: pose.digging, pitch: pose.pitch, heading, climb: sliding ? 0 : climb, drinking: pose.drinking, aiming: pose.aiming, ground: onSand && !power ? heightAt : undefined,
        look,
      },
      dt,
    );
    if (sliding && onSand) this.spray(pose, vx, vz, power, dt);
    else this.slideFor = 0;

    // Footprints: one per stride while walking; a sliding body draws a continuous streak instead. Only on the sand
    // itself: on the bunker's stairs and floors the print would hang at the sand's height overhead.
    const prints = this.footprints && onSand && !sandHidden(pose.x, pose.z, pose.y);
    if (!prints || !sliding) this.streakX = NaN;
    if (!this.footprints || !pose.grounded) return;
    if (sliding) {
      this.stepDist = 0;
      if (prints) this.streak(pose.x, pose.z);
      return;
    }
    this.stepDist += pose.speed * dt;
    if (this.stepDist < STRIDE) return;
    this.stepDist %= STRIDE;
    this.foot = -this.foot;
    const side = 0.13 * this.foot;
    const fx = pose.x + Math.cos(this.facing) * side, fz = pose.z - Math.sin(this.facing) * side;
    // Toes turned out a little; the boot print mirrors per foot.
    if (prints) footprints.add(fx, heightAt(fx, fz), fz, this.facing - this.foot * 0.08, 1, 1, this.foot);
    footsteps.step(fx, fz, pose.speed, indoors(fx, pose.y, fz) ? 'concrete' : 'sand');
  }

  /** Sand thrown up while sliding: ploughed off the leading boot and, in a speed slide, the hand trailing behind
   *  on the left; a burst as the slide starts. Faster throws more. */
  private spray(pose: AvatarPose, vx: number, vz: number, power: boolean, dt: number) {
    const fx = -Math.sin(this.facing), fz = -Math.cos(this.facing); // forward; right is (-fz, fx)
    const burst = this.slideFor === 0 && power ? 14 : 0;
    this.slideFor += dt;
    this.sprayOwed += dt * Math.max(0, pose.speed - 2) * (power ? 5 : 2.5) + burst;
    for (; this.sprayOwed >= 1; this.sprayOwed--) {
      const hand = power && Math.random() < 0.35;
      // Leading boot (left leg out front) or the trailing left hand, in the body's frame.
      const ahead = hand ? -0.3 : power ? 0.75 : 0.25, side = hand ? -0.45 : power ? -0.1 : 0;
      const x = pose.x + fx * ahead - fz * side, z = pose.z + fz * ahead + fx * side;
      const out = (hand ? -1 : Math.random() < 0.5 ? -1 : 1) * (0.8 + Math.random() * 1.8);
      const keep = hand ? 0.15 + Math.random() * 0.2 : 0.6 + Math.random() * 0.4; // the boot ploughs sand on ahead
      tyreDust.emit(x, heightAt(x, z) + 0.08, z, vx * keep - fz * out, (hand ? 0.5 : 1) + Math.random() * 1.6, vz * keep + fx * out,
        (hand ? 0.06 : 0.09) + Math.random() * 0.08, 0.7 + Math.random() * 0.9);
    }
  }

  /** Extend the slide streak to (x, z): a strip from where it last ended, once it is long enough. */
  private streak(x: number, z: number) {
    if (Number.isNaN(this.streakX)) {
      this.streakX = x;
      this.streakZ = z;
      return;
    }
    const dx = x - this.streakX, dz = z - this.streakZ;
    const len = Math.hypot(dx, dz);
    if (len < STREAK_STEP) return;
    if (len < 3) {
      const mx = this.streakX + dx / 2, mz = this.streakZ + dz / 2;
      // Stretched so each end fade overlaps the neighbouring strip's, and the joins blend.
      streaks.add(mx, heightAt(mx, mz), mz, Math.atan2(-dx, -dz), STREAK_WIDTH, len / (1 - END_FADE));
    } // else a teleport or snapshot jump: start afresh
    this.streakX = x;
    this.streakZ = z;
  }

  dispose() {
    this.model.dispose();
    this.clearLabel();
    this.root.removeFromParent();
  }
}

// --- Placeholder model --------------------------------------------------------------------------
// A small hooded scavenger from primitives: robe cone, pointed hood, dark face, two glowing eyes,
// a scrap backpack, boots that swing with a walk cycle. Tinted by the player colour. Facing -Z.

const tmpSlope = { gx: 0, gz: 0 };
const _push = new THREE.Vector3();
const ROBE_BASE = new THREE.Color(0x5a3b24);

export class PlaceholderModel implements AvatarModel {
  readonly root = new THREE.Group();
  private robeMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  private sashMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.8 });
  private body = new THREE.Group(); // bobs and leans
  private pack = new THREE.Group();
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
    // Sash in full player colour, and a scrap backpack (shown with one equipped).
    const sash = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.035, 6, 16), this.sashMat);
    sash.position.y = 0.95;
    sash.rotation.x = Math.PI / 2;
    const bag = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.42, 0.18), dark);
    bag.position.set(0, 1.08, 0.3);
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.4, 8), metal);
    can.position.set(0.2, 1.12, 0.33);
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.6, 4), metal);
    antenna.position.set(-0.12, 1.5, 0.32);
    this.pack.add(bag, can, antenna);
    this.pack.visible = false;
    this.body.add(this.robe, head, sash, this.pack);

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

  setOutfit(_item: string | null, gear: number) {
    this.pack.visible = (gear & wornBit('back')) !== 0;
    return false;
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
    this.slide += ((p.sliding || p.powerSlide ? 1 : 0) - this.slide) * k(8);
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
      o.dispose();
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.robeMat.dispose();
    this.sashMat.dispose();
  }
}
