// One view frustum per frame, for the objects that decide for themselves whether to be drawn: a whole machine or a pickup is
// tested once with a sphere instead of every one of its (dozens, hundreds of) objects being frustum-tested by the renderer
// and visited for matrices (src/world/crash.ts, loot.ts). `begin()` every frame after the camera has moved.
import * as THREE from 'three/webgpu';

const frustum = new THREE.Frustum();
const viewProj = new THREE.Matrix4();
const ball = new THREE.Sphere();

export const viewCull = {
  camera: null as THREE.Camera | null,
  begin() {
    const cam = this.camera;
    if (!cam) return;
    cam.updateMatrixWorld();
    viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProj);
  },
  /** Is a sphere of radius `r` at (x, y, z) at least partly in view? (True when there is no camera yet.) */
  visible(x: number, y: number, z: number, r: number): boolean {
    if (!this.camera) return true;
    ball.center.set(x, y, z);
    ball.radius = r;
    return frustum.intersectsSphere(ball);
  },
};
