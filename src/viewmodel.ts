// First-person viewmodel: the local player's gloved hands (public/models/hands.glb, tools/models/hands.py),
// optionally holding the canteen or the spyglass. Parented to the camera, so it is drawn in view space.
//
//   const vm = new ViewModel(orbit, scene);
//   vm.update(dt, { speed, grounded, digging, sliding });  // every render frame, after orbit.update()
//
// Empty hands are lowered out of view (hidden); the clips Idle / Walk / Dig still run under them.
// Clips: Idle / Walk / Dig with empty hands; CanteenIdle / CanteenWalk / Drink / Fill with the canteen
// (the `Canteen` mesh, parented to the right hand bone, is shown only then). Missing clips fall back to the
// empty-hand ones, a missing Canteen node just means no canteen. Spyglass: TelescopeIdle / TelescopeWalk,
// and TelescopeRaise (to the eye, played while `playerHands.looking`) on the `Telescope` mesh; once it is
// at the eye (`scoped`, src/telescope.ts) the hands are hidden behind the lens mask. It is carried
// collapsed: its `TelescopeDraw1/2` child nodes slide out (DRAW_S) while raising and back in when lowered. Walk clips are phase-locked to the camera's
// step phase so the hands bob in time with the head.
//
// Scaled down about the eye: the picture is identical (scaling about the projection centre doesn't change
// what projects where) but the hands sit inside the player's collision radius, so they don't poke through
// walls the camera is pressed against.
//
// Laser rifle (src/rifle.ts): RifleIdle / RifleWalk with both hands on it, RifleAim (to the eye, played clamped
// while `playerHands.aim` rises; once there the scope view takes over and the hands hide) on the `Rifle` mesh. Firing
// kicks it back into the shoulder and up on a spring (`playerHands.kick`); its `RifleGlow` material dims as the cell
// empties and brightens as it recharges. While aiming the mouse-look sway is mostly taken out, so the sights stay on.
// Laser pistol: the same with PistolIdle / PistolWalk / PistolAim (out at arm's length onto the iron sights; the hands
// stay in view) on the `Pistol` mesh, one-handed. The jammer (src/jammer.ts) is held with the pistol's clips (PistolAim
// pointing it while jamming): its model (src/models/jammer.ts) sits where the pistol would, its lamp lit by
// `playerHands.jamLamp`.
//
// Debug (with ?debug, `dbg.viewmodel`): ?hold=canteen|telescope forces what's held, ?anim=Drink loops one clip.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { FirstPersonCamera } from './camera';
import { playerHands, type Held } from './water';
import { jammerModel, LAMP_ON } from './models/jammer';

export type HandsPose = { speed: number; grounded: boolean; digging?: boolean; sliding?: boolean };

const URL = './models/hands.glb';
/** Model forward extent is ~0.63 m; × this keeps it inside PLAYER_RADIUS (0.35) and past the near plane. */
const SCALE = 0.55;
const FADE = 0.2;
const MOVING = 0.6; // m/s
/** Rest pose tipped down about the eye (rad): the clip's hands sit a little high for a desert view. */
const REST_PITCH = -0.05;
const SWITCH_S = 0.22; // lower (or raise) time when changing what's held
/** Walk clip phase offset (fraction of a cycle) against the camera bob. */
const WALK_PHASE = 0;
/** Walk clip cycles per two steps: ½ swings the hands once every four steps, a calmer sway than the head bob. */
const WALK_RATE = 0.5;
/** Spyglass draw tubes: glTF z of TelescopeDraw1 / 2 when pushed in (telescope.py COLLAPSED), slide time. */
const DRAW_IN = [-0.075, -0.14];
const DRAW_S = 0.3;
/** The recoil spring's longest step (s): a slow frame taken whole would make it swing ever harder. */
const SPRING_DT = 1 / 120;

const params = new URLSearchParams(location.search);
const forcedHold = params.get('hold') as Held | null;
const forcedAnim = params.get('anim');

export class ViewModel {
  readonly root = new THREE.Group();
  /** Sway / lower offsets, rotating about the eye. */
  private sway = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private canteen: THREE.Object3D | null = null;
  private telescope: THREE.Object3D | null = null;
  private rifle: THREE.Object3D | null = null;
  private rifleMuzzle: THREE.Object3D | null = null;
  private rifleGlow: THREE.MeshStandardMaterial[] = [];
  private pistol: THREE.Object3D | null = null;
  private pistolMuzzle: THREE.Object3D | null = null;
  private jammer: ReturnType<typeof jammerModel> | null = null;
  /** Recoil kick on a spring: offset and velocity. */
  private kick = 0;
  private kickV = 0;
  private lastKick = 0;
  private draws: THREE.Object3D[] = [];
  private drawn = 0; // spyglass draw tubes: 0 = pushed in, 1 = drawn out
  private tint: THREE.MeshStandardMaterial[] = [];
  private shown: Held = 'none';
  private lower = 1; // 0 = up in view, 1 = fully lowered (starts lowered and raises on load)
  private slide = 0;
  private lagYaw = NaN;
  private lagPitch = 0;
  private color = 0xffffff;
  private view: FirstPersonCamera;

  constructor(view: FirstPersonCamera, scene: THREE.Scene) {
    this.view = view;
    // Children of the camera only render if the camera is in the scene graph.
    if (!view.camera.parent) scene.add(view.camera);
    this.root.name = 'ViewModel';
    this.root.scale.setScalar(SCALE);
    this.root.add(this.sway);
    view.camera.add(this.root);
    new GLTFLoader().loadAsync(URL).then(
      (gltf) => this.init(gltf.scene, gltf.animations),
      (e) => console.warn('hands model failed to load', e),
    );
  }

  private init(model: THREE.Object3D, clips: THREE.AnimationClip[]) {
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false; // the shadow-only body already casts the player's shadow
      mesh.receiveShadow = false; // it would sit inside that body and always be in its shadow
      mesh.frustumCulled = false; // skinned bounds don't follow the animation; it's always in view anyway
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const own = mats.map((m) => {
        if (m.name !== 'PlayerTint') return m;
        const c = (m as THREE.MeshStandardMaterial).clone();
        this.tint.push(c);
        return c;
      });
      mesh.material = Array.isArray(mesh.material) ? own : own[0];
    });
    this.canteen = model.getObjectByName('Canteen') ?? null;
    this.telescope = model.getObjectByName('Telescope') ?? null;
    this.rifle = model.getObjectByName('Rifle') ?? null;
    this.rifleMuzzle = model.getObjectByName('RifleMuzzle') ?? null;
    this.pistol = model.getObjectByName('Pistol') ?? null;
    this.pistolMuzzle = model.getObjectByName('PistolMuzzle') ?? null;
    if (this.pistol?.parent) {
      // The jammer in the pistol's place (same frame: grip at the origin, forward +Z).
      this.jammer = jammerModel();
      const j = this.jammer.obj;
      j.position.copy(this.pistol.position);
      j.quaternion.copy(this.pistol.quaternion);
      j.scale.copy(this.pistol.scale);
      j.traverse((o) => (o.frustumCulled = false));
      this.pistol.parent.add(j);
    }
    for (const gun of [this.rifle, this.pistol]) gun?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (m.name === 'RifleGlow' || m.name === 'PistolGlow') {
          m.userData.base = (m as THREE.MeshStandardMaterial).emissiveIntensity || 1;
          this.rifleGlow.push(m as THREE.MeshStandardMaterial);
        }
      }
    });
    this.draws = ['TelescopeDraw1', 'TelescopeDraw2'].map((n) => model.getObjectByName(n)).filter((o) => !!o);
    this.setDrawn(0);
    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of clips) this.actions.set(clip.name, this.mixer.clipAction(clip));
    this.sway.add(model);
    this.setColor(this.color);
    this.applyHeld();
    this.play('Idle', 0);
  }

  setColor(hex: number) {
    this.color = hex;
    for (const m of this.tint) m.color.setHex(hex);
  }

  /** Clip names available once loaded. */
  get clips(): string[] {
    return [...this.actions.keys()];
  }

  private applyHeld() {
    if (this.canteen) this.canteen.visible = this.shown === 'canteen';
    if (this.telescope) this.telescope.visible = this.shown === 'telescope';
    if (this.rifle) this.rifle.visible = this.shown === 'rifle';
    if (this.pistol) this.pistol.visible = this.shown === 'pistol';
    if (this.jammer) this.jammer.obj.visible = this.shown === 'jammer';
  }

  /** The gun's muzzle in world space (as drawn: scaled about the eye like the rest), or null if it isn't out. */
  muzzle(out: THREE.Vector3): THREE.Vector3 | null {
    const m = this.shown === 'rifle' ? this.rifleMuzzle : this.shown === 'pistol' ? this.pistolMuzzle : null;
    if (!m || !this.root.visible || !this.sway.visible) return null; // hidden behind the scope: not drawn
    m.updateWorldMatrix(true, false);
    return m.getWorldPosition(out);
  }

  private setDrawn(d: number) {
    this.drawn = d;
    const e = smooth(d);
    this.draws.forEach((o, i) => (o.position.z = DRAW_IN[i] * (1 - e)));
  }

  private has(name: string) {
    return this.actions.has(name);
  }

  private play(name: string, fade = FADE, once = false) {
    const next = this.actions.get(name);
    if (!next) return;
    if (next === this.current) {
      // Held one-shot (still drinking/filling after it ended): go again.
      if (once && !next.isRunning()) next.reset().play();
      return;
    }
    const prev = this.current;
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = once;
    next.timeScale = 1;
    next.setEffectiveWeight(1);
    next.play();
    if (prev && fade > 0) prev.crossFadeTo(next, fade, false);
    else if (prev) prev.stop();
    this.current = next;
  }

  /** Called every render frame, after the camera has been updated. */
  update(dt: number, pose: HandsPose) {
    const view = this.view;
    // Mouse-look sway: the hands trail the view a little, then catch up.
    if (!Number.isFinite(this.lagYaw)) this.lagYaw = view.yaw;
    let dYaw = view.yaw - this.lagYaw;
    dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
    const k = 1 - Math.exp(-dt * 14);
    this.lagYaw += dYaw * k;
    this.lagPitch += (view.pitch - this.lagPitch) * k;
    const swayYaw = clamp(dYaw, -0.15, 0.15);
    const swayPitch = clamp(view.pitch - this.lagPitch, -0.12, 0.12);

    // Swap what's held behind a quick lower/raise.
    const want = forcedHold ?? playerHands.held;
    if (this.mixer) {
      // Empty hands stay lowered out of view; only something held brings them up.
      if (want !== this.shown || want === 'none') {
        this.lower = Math.min(1, this.lower + dt / SWITCH_S);
        if (this.lower >= 1 && want !== this.shown) {
          this.shown = want;
          this.applyHeld();
          this.current?.stop();
          this.current = null;
        }
      } else {
        this.lower = Math.max(0, this.lower - dt / SWITCH_S);
      }
    }
    this.sway.visible = this.lower < 1 && !playerHands.scoped && !playerHands.rifleScoped;
    // Recoil: kicked back and up on firing, sprung back with a little overshoot.
    if (playerHands.kick > this.lastKick + 0.5) this.kickV += 9;
    this.lastKick = playerHands.kick;
    for (let n = Math.ceil(dt / SPRING_DT), h = dt / n; n > 0; n--) {
      this.kickV += (-260 * this.kick - 24 * this.kickV) * h;
      this.kick += this.kickV * h;
    }
    // Aiming down the sights: the sights follow the view, not trail it.
    const steady = 1 - 0.8 * playerHands.aim;
    this.slide += ((pose.sliding && pose.grounded ? 1 : 0) - this.slide) * (1 - Math.exp(-dt * 10));
    const l = smooth(this.lower);
    const rest = REST_PITCH * (1 - playerHands.aim);
    this.sway.rotation.set(
      rest - swayPitch * 0.5 * steady - l * 0.9 - this.slide * 0.25 + this.kick * 0.09,
      -swayYaw * 0.6 * steady,
      -swayYaw * 0.35 * steady + this.kick * 0.02,
    );
    this.sway.position.set(-swayYaw * 0.04 * steady, -this.kick * 0.01, this.kick * 0.09);
    for (const g of this.rifleGlow) g.emissiveIntensity = (g.userData.base as number) * (0.15 + 0.85 * playerHands.charge ** 3 + 4 * playerHands.kick);

    if (!this.mixer) return;
    const draw = this.shown === 'telescope' && playerHands.looking ? 1 : 0;
    if (draw !== this.drawn) this.setDrawn(clamp(this.drawn + Math.sign(draw - this.drawn) * (dt / DRAW_S), 0, 1));
    const moving = pose.grounded && !pose.sliding && pose.speed > MOVING;
    let walk: string | null = null;
    if (forcedAnim && this.has(forcedAnim)) this.play(forcedAnim);
    else if (this.shown === 'canteen') {
      if (playerHands.filling && this.has('Fill')) this.play('Fill', 0.15, true);
      else if (playerHands.drinking && this.has('Drink')) this.play('Drink', 0.15, true);
      else if (moving) this.play((walk = this.has('CanteenWalk') ? 'CanteenWalk' : 'Walk'));
      else this.play(this.has('CanteenIdle') ? 'CanteenIdle' : 'Idle');
    } else if (this.shown === 'telescope') {
      if (playerHands.looking && this.has('TelescopeRaise')) this.play('TelescopeRaise', 0.1, true);
      else if (moving) this.play((walk = this.has('TelescopeWalk') ? 'TelescopeWalk' : 'Walk'));
      else this.play(this.has('TelescopeIdle') ? 'TelescopeIdle' : 'Idle');
    } else if (this.shown === 'rifle') {
      if (playerHands.aim > 0 && this.has('RifleAim')) {
        // Scrubbed by the aim (raising and lowering), not played: it follows the button exactly.
        this.play('RifleAim', 0.08);
        const a = this.current!;
        a.timeScale = 0;
        a.time = smooth(playerHands.aim) * a.getClip().duration * 0.999;
      } else if (moving) this.play((walk = this.has('RifleWalk') ? 'RifleWalk' : 'Walk'));
      else this.play(this.has('RifleIdle') ? 'RifleIdle' : 'Idle');
    } else if (this.shown === 'pistol' || this.shown === 'jammer') {
      if (playerHands.aim > 0 && this.has('PistolAim')) {
        this.play('PistolAim', 0.08);
        const a = this.current!;
        a.timeScale = 0;
        a.time = smooth(playerHands.aim) * a.getClip().duration * 0.999;
      } else if (moving) this.play((walk = this.has('PistolWalk') ? 'PistolWalk' : 'Walk'));
      else this.play(this.has('PistolIdle') ? 'PistolIdle' : 'Idle');
    } else if (pose.digging) this.play('Dig', 0.12);
    else if (moving) this.play((walk = 'Walk'));
    else this.play('Idle');

    // Walk clips hold two steps per cycle; lock them to the head bob (one step per π of stepPhase), at
    // WALK_RATE cycles per two steps so running and sprinting don't shake the hands.
    if (walk && this.current) {
      const a = this.current;
      a.timeScale = 0;
      const f = (view.stepPhase / (2 * Math.PI)) * WALK_RATE + WALK_PHASE;
      a.time = (f - Math.floor(f)) * a.getClip().duration;
    }
    if (this.jammer) this.jammer.lamp.color.copy(LAMP_ON).multiplyScalar(playerHands.jamLamp);
    this.mixer.update(dt);
  }
}

function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x));
}

function smooth(t: number) {
  return t * t * (3 - 2 * t);
}
