// Fly camera for shooting video (F3 → "Fly camera"): the view leaves the body, which stands still where it was, and
// glides freely. WASD moves along the view, Space / Ctrl (or C) rise and sink, Shift is faster, Alt slower, the mouse
// wheel sets the speed. Movement and look are eased (the "smooth" setting), and the view banks a little into turns.
// The world streams in around the camera (main.ts uses it as the focus); the sand still can't be flown under.
// "Hide HUD" (body.clean) hides everything on screen but the picture, name tags included.
import * as THREE from 'three/webgpu';
import { actionHeld } from './input';
import { heightAt } from '../shared/terrain.ts';
import { sandHidden } from '../shared/shelters.ts';

const SENSITIVITY = 0.0022;
const PITCH_LIMIT = (89 * Math.PI) / 180;

export class FlyCam {
  active = false;
  /** Hide every overlay (HUD, crosshair, name tags) while flying. */
  clean = false;
  /** Base speed (m/s); the wheel scales it. */
  speed = 8;
  /** Target field of view (degrees); the view eases to it, so changing it zooms smoothly. */
  fov = 60;
  /** 0..1: how much movement and look are eased (0 = raw, 1 = slow drifting glides). */
  smooth = 0.6;
  /** 0..1: how far the view banks into turns. */
  bank = 0.5;
  /** The player's view when flying started: held, so the body doesn't turn with the mouse. */
  heldYaw = 0;
  heldPitch = 0;
  readonly pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private aimYaw = 0;
  private aimPitch = 0;
  private roll = 0;
  private fovShown = 60;
  private wish = new THREE.Vector3();
  readonly dom: HTMLElement;

  constructor(dom: HTMLElement) {
    this.dom = dom;
    addEventListener('mousemove', (e) => {
      if (!this.active || document.pointerLockElement !== dom) return;
      const s = (SENSITIVITY * this.fovShown) / 72;
      this.aimYaw -= e.movementX * s;
      this.aimPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.aimPitch - e.movementY * s));
    });
    addEventListener('wheel', (e) => {
      if (!this.active || document.pointerLockElement !== dom) return;
      this.speed = Math.max(0.25, Math.min(300, this.speed * Math.pow(1.15, -Math.sign(e.deltaY))));
    });
  }

  /** Start flying from where `camera` is now; `yaw` / `pitch` are the player's, held until the end. */
  start(camera: THREE.PerspectiveCamera, yaw: number, pitch: number) {
    this.active = true;
    this.heldYaw = yaw;
    this.heldPitch = pitch;
    this.pos.copy(camera.position);
    this.vel.set(0, 0, 0);
    this.yaw = this.aimYaw = camera.rotation.y;
    this.pitch = this.aimPitch = camera.rotation.x;
    this.roll = 0;
    this.fovShown = camera.fov;
    this.setClean(this.clean);
  }

  /** Put the camera at `pos` looking along yaw / pitch at once (tools/perf.ts pictures). */
  place(pos: THREE.Vector3, yaw: number, pitch: number) {
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.yaw = this.aimYaw = yaw;
    this.pitch = this.aimPitch = pitch;
    this.roll = 0;
  }

  stop() {
    this.active = false;
    this.setClean(this.clean);
  }

  setClean(on: boolean) {
    this.clean = on;
    document.body.classList.toggle('clean', on && this.active);
  }

  /** Move and turn, then place `camera` (after everything else has moved it). */
  update(dt: number, camera: THREE.PerspectiveCamera) {
    // Ease rates: smooth 0 is near-instant, 1 is a slow drift.
    const lookRate = 40 * Math.pow(1 / 40, this.smooth); // 40/s .. 1/s
    const moveRate = 30 * Math.pow(1 / 60, this.smooth); // 30/s .. 0.5/s
    const lk = 1 - Math.exp(-dt * lookRate);
    const lastYaw = this.yaw;
    this.yaw += (this.aimYaw - this.yaw) * lk;
    this.pitch += (this.aimPitch - this.pitch) * lk;
    const turn = dt > 0 ? (this.yaw - lastYaw) / dt : 0; // rad/s
    this.roll += (Math.max(-0.35, Math.min(0.35, turn * 0.12 * this.bank)) - this.roll) * (1 - Math.exp(-dt * 3));

    const f = (actionHeld('forward') ? 1 : 0) - (actionHeld('back') ? 1 : 0);
    const r = (actionHeld('right') ? 1 : 0) - (actionHeld('left') ? 1 : 0);
    const u = (actionHeld('jump') ? 1 : 0) - (actionHeld('crouch') ? 1 : 0);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw), sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    // Forward is along the view (pitch included); up is straight up.
    this.wish.set(-sy * cp * f + cy * r, sp * f + u, -cy * cp * f - sy * r);
    if (this.wish.lengthSq() > 1) this.wish.normalize();
    const speed = this.speed * (actionHeld('sprint') ? 4 : 1) * (actionHeld('freeLook') ? 0.25 : 1);
    this.vel.lerp(this.wish.multiplyScalar(speed), 1 - Math.exp(-dt * moveRate));
    this.pos.addScaledVector(this.vel, dt);
    if (!sandHidden(this.pos.x, this.pos.z, this.pos.y - 1.6)) {
      const floor = heightAt(this.pos.x, this.pos.z) + 0.3;
      if (this.pos.y < floor) {
        this.pos.y = floor;
        this.vel.y = Math.max(0, this.vel.y);
      }
    }

    this.fovShown += (this.fov - this.fovShown) * (1 - Math.exp(-dt * 4));
    camera.position.copy(this.pos);
    camera.rotation.set(this.pitch, this.yaw, this.roll);
    if (Math.abs(camera.fov - this.fovShown) > 0.001) {
      camera.fov = this.fovShown;
      camera.updateProjectionMatrix();
    }
  }
}
