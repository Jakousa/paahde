import * as THREE from 'three/webgpu';
import { wasm } from './wasm';

// WebGPURenderer uses WebGPU when available and falls back to WebGL2 otherwise.
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1.5, 4);
camera.lookAt(0, 0, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(3, 5, 2);
scene.add(sun);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardNodeMaterial({ color: 0xff6633 }),
);
scene.add(cube);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
document.getElementById('info')!.textContent = `${backend} · build ${__BUILD_SHA__}`;

const timer = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = timer.getDelta();
  cube.rotation.y = wasm.spin(cube.rotation.y, dt, 1.2);
  cube.rotation.x = wasm.spin(cube.rotation.x, dt, 0.5);
  renderer.render(scene, camera);
});
