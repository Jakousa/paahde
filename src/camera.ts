// Third-person orbit camera. Click the canvas to lock the pointer; mouse moves yaw/pitch.
// The yaw is also the movement frame sent to the server (see shared/sim.ts step()).
import * as THREE from 'three/webgpu';
import { heightAt } from '../shared/terrain.ts';

const DISTANCE = 7;
const TARGET_HEIGHT = 1.6;
const SENSITIVITY = 0.0025;

export class OrbitCamera {
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0;
  pitch = -0.25;

  constructor(dom: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 6000);
    dom.addEventListener('click', () => dom.requestPointerLock());
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== dom) return;
      this.yaw -= e.movementX * SENSITIVITY;
      this.pitch = Math.max(-1.3, Math.min(0.6, this.pitch - e.movementY * SENSITIVITY));
    });
  }

  /** Place the camera behind `target` (the player's feet). */
  update(target: THREE.Vector3) {
    const cp = Math.cos(this.pitch);
    const offset = new THREE.Vector3(Math.sin(this.yaw) * cp, -Math.sin(this.pitch), Math.cos(this.yaw) * cp)
      .multiplyScalar(DISTANCE);
    const look = target.clone().setY(target.y + TARGET_HEIGHT);
    const pos = look.clone().add(offset);
    pos.y = Math.max(pos.y, heightAt(pos.x, pos.z) + 0.5); // don't dip under dunes
    this.camera.position.copy(pos);
    this.camera.lookAt(look);
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }
}
