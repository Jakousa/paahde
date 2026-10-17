import * as THREE from 'three/webgpu';
import { DT, PLATFORMS, SIZE } from '../shared/sim.ts';
import { readInput } from './input';
import { getBrowserId, Net } from './net';
import { wasm } from './wasm';

// WebGPURenderer uses WebGPU when available and falls back to WebGL2 otherwise.
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1d2a);
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 4, 22);

scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(4, 10, 6);
scene.add(sun);

const platformMat = new THREE.MeshStandardNodeMaterial({ color: 0x556070 });
for (const p of PLATFORMS) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(p.w, p.h, 2), platformMat);
  mesh.position.set(p.x, p.y, 0);
  scene.add(mesh);
}

const cubeGeo = new THREE.BoxGeometry(SIZE, SIZE, SIZE);
function makeCube(color: number) {
  const mesh = new THREE.Mesh(cubeGeo, new THREE.MeshStandardNodeMaterial({ color }));
  scene.add(mesh);
  return mesh;
}

const net = new Net(getBrowserId());
const meMesh = makeCube(0xffffff);
const remoteMeshes = new Map<number, THREE.Mesh>();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
const info = document.getElementById('info')!;

const timer = new THREE.Timer();
let accumulator = 0;

// Little flourish computed in wasm: spin while airborne. Purely visual, so each client
// animates every player locally from the grounded/vx it already knows.
function animateSpin(mesh: THREE.Mesh, grounded: boolean, vx: number, dt: number) {
  const spin: number = grounded ? 0 : wasm.spin(mesh.userData.spin ?? 0, dt, 8);
  mesh.userData.spin = spin;
  if (Math.abs(vx) > 0.01) mesh.userData.dir = Math.sign(vx);
  mesh.rotation.z = -(mesh.userData.dir ?? 1) * spin;
}
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const frameDt = Math.min(timer.getDelta(), 0.25);

  // Fixed-step simulation: identical DT on client and server keeps prediction in agreement.
  accumulator += frameDt;
  while (accumulator >= DT) {
    net.tick(readInput());
    accumulator -= DT;
  }

  const remotes = net.frame(frameDt);

  (meMesh.material as THREE.MeshStandardNodeMaterial).color.setHex(net.color);
  meMesh.visible = net.connected;
  meMesh.position.set(net.me.x + net.errorX, net.me.y + net.errorY, 0);
  animateSpin(meMesh, net.me.grounded, net.me.vx, frameDt);

  const seen = new Set<number>();
  for (const r of remotes) {
    seen.add(r.id);
    let mesh = remoteMeshes.get(r.id);
    if (!mesh) remoteMeshes.set(r.id, (mesh = makeCube(r.color)));
    mesh.position.set(r.x, r.y, 0);
    animateSpin(mesh, r.grounded, r.vx, frameDt);
  }
  for (const [id, mesh] of remoteMeshes) {
    if (!seen.has(id)) {
      scene.remove(mesh);
      remoteMeshes.delete(id);
    }
  }

  camera.position.x += (meMesh.position.x - camera.position.x) * Math.min(1, frameDt * 3);
  camera.lookAt(camera.position.x, 3, 0);

  info.textContent = `${backend} · ${net.status} · ${remotes.length + (net.connected ? 1 : 0)} online · build ${__BUILD_SHA__}`;
  renderer.render(scene, camera);
});
