// First-person camera. Click the canvas to lock the pointer; the mouse moves yaw/pitch.
// The yaw is also the movement frame sent to the server (see shared/sim.ts step()), and the body faces it.
//
// Feel: the eye height is smoothed a little so slopes don't jitter, the head bobs with stride, hard
// landings dip the view on a spring, strafing rolls it slightly, and sprinting kicks the FOV out.
import * as THREE from 'three/webgpu';
import { heightAt } from '../shared/terrain.ts';
import { WALK_SPEED, SPRINT_SPEED } from '../shared/sim.ts';

export const EYE_HEIGHT = 1.65;
const SENSITIVITY = 0.0022;
const PITCH_LIMIT = (85 * Math.PI) / 180;
const BASE_FOV = 72;
const SPRINT_FOV_KICK = 9;
const STRIDE = 1.15; // metres per step (half a bob cycle)

/** What the camera needs from the local player each frame. */
export type ViewPose = { x: number; y: number; z: number; vx: number; vy: number; vz: number; grounded: boolean };

export class FirstPersonCamera {
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0;
  pitch = -0.05;

  private eyeY = NaN; // smoothed feet height
  private bobPhase = 0;
  private bobAmount = 0; // 0..1, fades in with walking, out when airborne/stopped
  private dip = 0; // landing dip offset (m), spring back to 0
  private dipVel = 0;
  private roll = 0;
  private fov = BASE_FOV;
  private wasGrounded = true;
  private lastVy = 0;

  constructor(dom: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, 0.05, 6000);
    this.camera.rotation.order = 'YXZ';
    dom.addEventListener('click', () => {
      if (document.pointerLockElement !== dom) dom.requestPointerLock();
    });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== dom) return;
      this.yaw -= e.movementX * SENSITIVITY;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - e.movementY * SENSITIVITY));
    });
  }

  /** Step phase in radians (one step per π), so hands/footsteps can sync to the bob. */
  get stepPhase() {
    return this.bobPhase;
  }

  /** Place the eye at the player's feet position `p` (predicted state + visual error offset). */
  update(p: ViewPose, dt: number) {
    const speed = Math.hypot(p.vx, p.vz);

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
    const bobTarget = moving ? (pace <= 1 ? pace : Math.min(1 + (pace - 1) * 0.12, 1.15)) : 0;
    this.bobAmount += (bobTarget - this.bobAmount) * (1 - Math.exp(-dt * 6));
    if (p.grounded) this.bobPhase += (speed * dt * Math.PI) / STRIDE;
    const s = Math.sin(this.bobPhase);
    const bobY = (0.5 - s * s) * 0.03 * this.bobAmount;
    const bobX = s * 0.015 * this.bobAmount;

    // Camera basis on the ground plane.
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const rightX = cy, rightZ = -sy;
    const lateral = p.vx * rightX + p.vz * rightZ;
    this.roll += (-lateral * 0.0035 - this.roll) * (1 - Math.exp(-dt * 6));

    const x = p.x + rightX * bobX;
    const z = p.z + rightZ * bobX;
    let y = this.eyeY + EYE_HEIGHT + bobY + this.dip;
    y = Math.max(y, heightAt(x, z) + 0.3); // never look out from under a dune
    this.camera.position.set(x, y, z);
    this.camera.rotation.set(this.pitch + this.dip * 0.12, this.yaw, this.roll + bobX * 0.1);

    // FOV kick when moving faster than a walk (sprint, slides).
    const t = Math.max(0, Math.min(1, (speed - WALK_SPEED - 0.5) / (SPRINT_SPEED - WALK_SPEED - 1)));
    const target = BASE_FOV + SPRINT_FOV_KICK * t;
    this.fov += (target - this.fov) * (1 - Math.exp(-dt * 5));
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }
}
