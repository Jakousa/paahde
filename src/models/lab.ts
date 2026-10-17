// Model review page (models-lab.html): every scavenger clip side by side under a warm low sun, plus the
// first-person hands and props when present. Drag to orbit, wheel to zoom. ?clip=Run shows one clip large.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ScavengerModel, type ScavengerClip } from './scavenger';

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc9773a);
scene.fog = new THREE.Fog(0xd98a45, 25, 90);
scene.add(new THREE.HemisphereLight(0xf2a35a, 0x5a2a14, 0.9));
const sun = new THREE.DirectionalLight(0xffc68a, 3.2);
// low sun (~15° elevation) behind the camera's left shoulder; ?backlit puts it in front, as in the game
sun.position.set(-8, 3.2, new URLSearchParams(location.search).has('backlit') ? -10 : 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 0.5, far: 60 });
sun.shadow.bias = -0.0005;
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(80, 64).rotateX(-Math.PI / 2),
  new THREE.MeshStandardNodeMaterial({ color: 0xc46a24, roughness: 0.95 }),
);
ground.receiveShadow = true;
scene.add(ground);

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.05, 300);
const target = new THREE.Vector3(0, 1.0, 0);
let yaw = 0.35;
let pitch = 0.12;
let dist = 11;

const params = new URLSearchParams(location.search);
const only = params.get('clip') as ScavengerClip | null;
const clips: ScavengerClip[] = only ? [only] : ['Idle', 'Walk', 'Run', 'Jump', 'Dig', 'Slide'];
const colors = [0xd8452b, 0x2f8fd8, 0xe0b23a, 0x4fae5a, 0xb455c8, 0xe8e2d6];
if (only) dist = 4;
if (params.has('yaw')) yaw = Number(params.get('yaw'));
if (params.has('dist')) dist = Number(params.get('dist'));

const models: { m: ScavengerModel; clip: ScavengerClip }[] = [];
clips.forEach((clip, i) => {
  const m = new ScavengerModel(colors[i % colors.length]);
  m.root.position.set((i - (clips.length - 1) / 2) * 1.6, 0, 0);
  m.root.rotation.y = Math.PI + 0.5; // face the camera, turned a little to show the profile
  if (clip === 'Jump') m.root.position.y = 0.5;
  scene.add(m.root);
  models.push({ m, clip });
  void m.ready.then(() => m.play(clip, 0));
});

// optional extras (first-person hands, props) laid out behind the characters
const loader = new GLTFLoader();
const extras = ['hands', 'debris', 'crate', 'console'];
extras.forEach((name, i) => {
  loader.load(
    `./models/${name}.glb`,
    (gltf) => {
      const obj = gltf.scene;
      obj.position.set((i - 1.5) * 2.4, 0, 3.5);
      obj.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
      });
      if (name === 'hands') obj.position.y = 1.4;
      scene.add(obj);
      if (gltf.animations.length) {
        const mixer = new THREE.AnimationMixer(obj);
        mixer.clipAction(gltf.animations[0]).play();
        mixers.push(mixer);
      }
    },
    undefined,
    () => {}, // not authored yet
  );
});
const mixers: THREE.AnimationMixer[] = [];

let dragging = false;
renderer.domElement.addEventListener('pointerdown', () => (dragging = true));
addEventListener('pointerup', () => (dragging = false));
addEventListener('pointermove', (e) => {
  if (!dragging) return;
  yaw -= e.movementX * 0.005;
  pitch = Math.max(-0.2, Math.min(1.3, pitch + e.movementY * 0.005));
});
addEventListener('wheel', (e) => (dist = Math.max(1.5, Math.min(40, dist * (1 + e.deltaY * 0.001)))));
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

await renderer.init();
const timer = new THREE.Timer();
const label = document.getElementById('label')!;
label.textContent = clips.join(' · ');

renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), 0.1);
  for (const { m, clip } of models) {
    // drive through update() so the clip-selection logic is exercised too
    const pose = {
      speed: clip === 'Walk' ? 1.3 : clip === 'Run' ? 6 : 0,
      grounded: clip !== 'Jump',
      digging: clip === 'Dig',
      sliding: clip === 'Slide',
      pitch: clip === 'Idle' ? Math.sin(time / 1500) * 0.5 : 0,
    };
    m.update(pose, dt);
  }
  for (const mx of mixers) mx.update(dt);
  camera.position.set(
    target.x + Math.sin(yaw) * Math.cos(pitch) * dist,
    target.y + Math.sin(pitch) * dist,
    target.z + Math.cos(yaw) * Math.cos(pitch) * dist,
  );
  camera.lookAt(target);
  renderer.render(scene, camera);
});
