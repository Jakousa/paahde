// First-person camera. Click the canvas to lock the pointer; the mouse moves yaw/pitch.
// The yaw is also the movement frame sent to the server (see shared/sim.ts step()), and the body faces it.
//
// Feel: the eye height is smoothed a little so slopes don't jitter, the head bobs with stride, hard
// landings dip the view on a spring, strafing rolls it slightly, and sprinting kicks the FOV out.
// T toggles a third-person view: the camera backs off along the view ray from the eye, so the screen centre
// (crosshair) still aims where the dig/pickup rays go, and the boom shortens so it never sinks into a dune.
import * as THREE from 'three/webgpu';
import { heightAt } from '../shared/terrain.ts';
import { WALK_SPEED, SPRINT_SPEED } from '../shared/sim.ts';
import { EYE_HEIGHT } from '../shared/dig.ts'; // the dig and pickup rays start here too
import { terrainHidden } from '../shared/base.ts';
const SENSITIVITY = 0.0022;
const PITCH_LIMIT = (85 * Math.PI) / 180;
// Riding in first person the rider's body is drawn (headless) around the eye: a neck's range keeps the view out of it.
const RIDE_YAW_LIMIT = (100 * Math.PI) / 180; // either side of the bike's heading
const RIDE_PITCH_DOWN = (55 * Math.PI) / 180; // looking ahead over the bars; less over a shoulder (see limitRide)
const BASE_FOV = 72;
const SPRINT_FOV_KICK = 9;
/** Widest the view gets (sprinting); the sun's shadow cascades are fitted to it. */
export const MAX_FOV = BASE_FOV + SPRINT_FOV_KICK;
const STRIDE = 1.15; // metres per step (half a bob cycle)
const BOOM = 4.5; // third-person distance behind the eye (m)
const BOOM_CLEARANCE = 0.35; // keep the camera this far above the sand
const THIRD_PERSON_KEY = 'dadajam.thirdPerson';

/** What the camera needs from the local player each frame. */
export type ViewPose = { x: number; y: number; z: number; vx: number; vy: number; vz: number; grounded: boolean; sliding?: boolean; crouching?: boolean; riding?: boolean;
  /** The bike's lean into a turn (rad, + = left): the view rolls with part of it. */
  lean?: number;
  /** The bike's heading while riding (rad), for the neck limits. */
  heading?: number };

export class FirstPersonCamera {
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0;
  pitch = -0.05;

  private eyeY = NaN; // smoothed feet height
  private bobPhase = 0;
  private bobAmount = 0; // 0..1, fades in with walking, out when airborne/stopped
  private crouch = 0; // 0..1, eased in while sliding (crouching: 0.7): the eye drops and the view rolls a touch
  private dip = 0; // landing dip offset (m), spring back to 0
  private dipVel = 0;
  private roll = 0;
  private fov = BASE_FOV;
  /** Magnification (spyglass, src/telescope.ts); 1 = none. The view eases towards it. */
  zoom = 1;
  private zoomShown = 1;
  private wasGrounded = true;
  private lastVy = 0;
  /** Third-person view on (T toggles it, remembered per browser). */
  thirdPerson = false;
  /** Lying dead (shared/ragdoll.ts): third person whatever the T setting, looking at the body. */
  down = false;
  private boom = 0; // current boom length (m), eased toward BOOM or 0
  private rideHeading = NaN; // set while riding in first person: the view is limited to a neck's range of it

  constructor(dom: HTMLElement) {
    try {
      this.thirdPerson = localStorage.getItem(THIRD_PERSON_KEY) === '1';
    } catch {}
    document.body.classList.toggle('third-person', this.thirdPerson);
    addEventListener('keydown', (e) => {
      if (e.code !== 'KeyT' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      this.thirdPerson = !this.thirdPerson;
      document.body.classList.toggle('third-person', this.thirdPerson);
      try {
        localStorage.setItem(THIRD_PERSON_KEY, this.thirdPerson ? '1' : '0');
      } catch {}
    });
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, 0.05, 6000);
    this.camera.rotation.order = 'YXZ';
    dom.addEventListener('click', () => {
      if (document.pointerLockElement !== dom) dom.requestPointerLock();
    });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== dom) return;
      const s = SENSITIVITY / this.zoomShown; // zoomed in, the same hand movement turns the view less
      this.yaw -= e.movementX * s;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - e.movementY * s));
      if (Number.isFinite(this.rideHeading)) this.limitRide(1);
    });
  }

  /** Pull yaw/pitch back inside the riding neck limits, all the way (t = 1) or part of it (easing in on mounting). */
  private limitRide(t: number) {
    const d = Math.atan2(Math.sin(this.yaw - this.rideHeading), Math.cos(this.yaw - this.rideHeading));
    const turn = d + (Math.max(-RIDE_YAW_LIMIT, Math.min(RIDE_YAW_LIMIT, d)) - d) * t;
    this.yaw += turn - d;
    const down = RIDE_PITCH_DOWN * (1 - (0.6 * Math.abs(turn)) / RIDE_YAW_LIMIT);
    if (this.pitch < -down) this.pitch += (-down - this.pitch) * t;
  }

  /** Step phase in radians (one step per π), so hands/footsteps can sync to the bob. */
  get stepPhase() {
    return this.bobPhase;
  }

  /** Draw the local body: the camera is far enough behind the head not to be inside it. */
  get showBody() {
    return this.boom > 0.9;
  }

  /** Place the eye at the player's feet position `p` (predicted state + visual error offset). */
  update(p: ViewPose, dt: number) {
    const speed = Math.hypot(p.vx, p.vz);
    // On the bike in first person, keep the view to a neck's range (eased, so mounting or leaving third person doesn't snap).
    this.rideHeading = p.riding && !this.thirdPerson && p.heading !== undefined ? p.heading : NaN;
    if (Number.isFinite(this.rideHeading)) this.limitRide(1 - Math.exp(-dt * 8));

    // Eye height: follow the feet quickly but smoothly; snap if far (respawn/teleport) or airborne.
    if (!Number.isFinite(this.eyeY) || Math.abs(p.y - this.eyeY) > 3) this.eyeY = p.y;
    else this.eyeY += (p.y - this.eyeY) * (1 - Math.exp(-dt * (p.grounded ? 22 : 40)));

    // Landing dip: a damped spring kicked by the impact speed.
    if (p.grounded && !this.wasGrounded) {
      const impact = Math.max(0, -this.lastVy);
      this.dipVel -= Math.min(impact, 30) * 0.06;
    }
    this.wasGrounded = p.grounded;
    this.lastVy = p.vy;
    const k = 120, c = 16;
    this.dipVel += (-k * this.dip - c * this.dipVel) * dt;
    this.dip = Math.max(-0.45, this.dip + this.dipVel * dt);

    // Head bob tied to distance travelled.
    const moving = p.grounded && speed > 0.5;
    // Past a walk it grows only gently (sprint ≈ 1.1×, its faster step rate is enough), and the vertical shape is sin², which is smooth
    // at footfall where |sin| had a hard cusp.
    const pace = speed / WALK_SPEED;
    const bobTarget = moving && !p.sliding && !p.riding ? (pace <= 1 ? pace : Math.min(1 + (pace - 1) * 0.12, 1.15)) : 0;
    this.bobAmount += (bobTarget - this.bobAmount) * (1 - Math.exp(-dt * 6));
    if (p.grounded) this.bobPhase += (speed * dt * Math.PI) / STRIDE;
    const s = Math.sin(this.bobPhase);
    const bobY = (0.5 - s * s) * 0.03 * this.bobAmount;
    const bobX = s * 0.015 * this.bobAmount;

    // Camera basis on the ground plane.
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const rightX = cy, rightZ = -sy;
    const lateral = p.vx * rightX + p.vz * rightZ;
    this.roll += (-lateral * 0.0035 + (p.lean ?? 0) * 0.4 - this.roll) * (1 - Math.exp(-dt * 6));

    const x = p.x + rightX * bobX;
    const z = p.z + rightZ * bobX;
    this.crouch += ((p.grounded ? (p.sliding ? 1 : p.crouching ? 0.7 : 0) : 0) - this.crouch) * (1 - Math.exp(-dt * 12));
    let y = this.eyeY + EYE_HEIGHT - 0.65 * this.crouch + bobY + this.dip;
    // Never look out from under a dune (in the base's entrance and bunker the sand isn't in the way).
    if (!terrainHidden(x, z, p.y)) y = Math.max(y, heightAt(x, z) + 0.3);

    // Third person: back off along the view ray, shortening the boom where it would dip under the sand.
    const pitch = this.pitch + this.dip * 0.12;
    const cp = Math.cos(pitch);
    const bx = sy * cp, by = -Math.sin(pitch), bz = cy * cp; // unit vector pointing behind the view
    const third = this.thirdPerson || this.down;
    let reach = third ? BOOM : 0;
    for (let i = 1; i <= 12 && reach > 0; i++) {
      const d = (BOOM * i) / 12;
      if (d > reach) break;
      const px = x + bx * d, pz = z + bz * d;
      if (y + by * d < heightAt(px, pz) + BOOM_CLEARANCE) reach = Math.max(0, d - BOOM / 12);
    }
    // Ease out smoothly, but snap in when terrain cuts the boom short.
    this.boom = reach < this.boom && third ? reach : this.boom + (reach - this.boom) * (1 - Math.exp(-dt * 8));
    if (this.boom < 0.01) this.boom = 0;
    this.camera.position.set(x + bx * this.boom, y + by * this.boom, z + bz * this.boom);
    this.camera.rotation.set(pitch, this.yaw, this.roll + bobX * 0.1);

    // FOV kick when moving faster than a walk (sprint, slides).
    const t = Math.max(0, Math.min(1, (speed - WALK_SPEED - 0.5) / (SPRINT_SPEED - WALK_SPEED - 1)));
    const target = BASE_FOV + SPRINT_FOV_KICK * t;
    this.fov += (target - this.fov) * (1 - Math.exp(-dt * 5));
    // Zoom narrows the view by the magnification (tan of the half-angle), snapping back out when it ends.
    this.zoomShown = this.zoom <= 1 ? 1 : this.zoomShown + (this.zoom - this.zoomShown) * (1 - Math.exp(-dt * 12));
    const fov = this.zoomShown > 1 ? (360 / Math.PI) * Math.atan(Math.tan((this.fov * Math.PI) / 360) / this.zoomShown) : this.fov;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }
}
