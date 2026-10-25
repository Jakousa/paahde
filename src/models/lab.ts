// Model review page (models-lab.html): every scavenger clip side by side under a warm low sun, plus the
// first-person hands and props when present. Drag to orbit, wheel to zoom. ?clip=Run shows one clip large.
// ?walk: the characters walk circles over rolling dunes instead, to check foot planting and leg IK;
// &heading=1.57 strafes right, 3.14 backs up (travel direction relative to facing).
// ?item=laser_rifle puts that item in every hand; &aim raises it to aim (&pitch=0.3 aims up).
// &target=x,y,z: where the camera looks (default 0,1,0).
// ?gear=255 wears and carries that gear (shared/gear.ts wornGear | carriedGear bits).
// ?look=0,38354534400 dresses the characters in those looks (shared/look.ts packLook), one after another.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ScavengerModel, type ScavengerClip } from './scavenger';
import { CROUCH_SPEED } from '../../shared/sim.ts';

const renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance' });
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

const params = new URLSearchParams(location.search);
const walking = params.has('walk');
const heading = Number(params.get('heading') ?? 0);
const dune = (x: number, z: number) => (walking ? 0.45 * Math.sin(x * 0.55) * Math.cos(z * 0.45) + 0.12 * x : 0);
const groundGeo = walking ? new THREE.PlaneGeometry(60, 60, 240, 240).rotateX(-Math.PI / 2) : new THREE.CircleGeometry(80, 64).rotateX(-Math.PI / 2);
if (walking) {
  const pos = groundGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, dune(pos.getX(i), pos.getZ(i)));
  groundGeo.computeVertexNormals();
}
const ground = new THREE.Mesh(
  groundGeo,
  new THREE.MeshStandardNodeMaterial({ color: 0xc46a24, roughness: 0.95 }),
);
ground.receiveShadow = true;
scene.add(ground);

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.05, 300);
const target = new THREE.Vector3(0, 1.0, 0);
let yaw = 0.35;
let pitch = 0.12;
let dist = 11;

const item = params.get('item');
const gear = Number(params.get('gear') ?? 0);
const aiming = params.has('aim');
const drinking = params.has('drink'); // ?item=canteen&drink: at the mouth
const aimPitch = Number(params.get('pitch') ?? 0);
const only = params.get('clip') as ScavengerClip | null;
const clips: ScavengerClip[] = only ? [only] : ['Idle', 'Walk', 'Run', 'Jump', 'Dig', 'Slide', 'Powerslide', 'Crouch', 'CrouchWalk'];
const looks = (params.get('look') ?? '').split(',').filter(Boolean).map(Number);
const colors = [0xd8452b, 0x2f8fd8, 0xe0b23a, 0x4fae5a, 0xb455c8, 0xe8e2d6];
if (only) dist = 4;
if (params.has('yaw')) yaw = Number(params.get('yaw'));
if (params.has('dist')) dist = Number(params.get('dist'));
if (params.has('target')) target.fromArray(params.get('target')!.split(',').map(Number)); // e.g. &target=0.3,0.95,0 to look at a hand

const models: { m: ScavengerModel; clip: ScavengerClip }[] = [];
clips.forEach((clip, i) => {
  const m = new ScavengerModel(colors[i % colors.length]);
  m.root.position.set((i - (clips.length - 1) / 2) * 1.6, 0, 0);
  m.root.rotation.y = Math.PI + 0.5; // face the camera, turned a little to show the profile
  if (clip === 'Jump') m.root.position.y = 0.5;
  scene.add(m.root);
  models.push({ m, clip });
  void m.ready.then(() => {
    m.play(clip, 0);
    if (item || gear) m.setOutfit(item, gear);
    if (looks.length) m.setLook(looks[i % looks.length]);
  });
});

// optional extras (first-person hands, canteen) laid out behind the characters
const loader = new GLTFLoader();
const extras = ['hands', 'canteen'];
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
const homes = new Map(models.map(({ m }, i) => [m, { x: (i % 3 - 1) * 6, z: Math.floor(i / 3) * 6 - 3, angle: i }]));

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

Object.assign(window, { lab: { models, camera, scene } });
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
      speed: clip === 'Walk' ? 1.3 : clip === 'Run' ? 6 : clip === 'CrouchWalk' ? CROUCH_SPEED : 0,
      grounded: clip !== 'Jump',
      digging: clip === 'Dig',
      sliding: clip === 'Slide',
      powerSlide: clip === 'Powerslide',
      crouching: clip === 'Crouch' || clip === 'CrouchWalk',
      pitch: aiming ? aimPitch : clip === 'Idle' && !item ? Math.sin(time / 1500) * 0.5 : 0,
      aiming,
      drinking,
      plant: walking,
      heading: walking ? heading : 0,
      ground: walking ? dune : undefined,
    };
    if (walking) {
      // walk circles of radius 2.5 around the model's own spot, turning in place for Idle/Dig
      const home = homes.get(m)!;
      const a = (home.angle += (pose.speed / 2.5 || 0.6) * dt);
      const r = pose.speed > 0 ? 2.5 : 0;
      const x = home.x + r * Math.cos(a), z = home.z + r * Math.sin(a);
      m.root.position.set(x, dune(x, z) + (clip === 'Jump' ? 0.5 : 0), z);
      m.root.rotation.y = Math.PI - a + (pose.speed > 0 ? heading : 0);
    }
    m.update(pose, dt);
  }
  for (const mx of mixers) mx.update(dt);
  if (walking && only) target.copy(models[0].m.root.position).setY(models[0].m.root.position.y + 0.6);
  camera.position.set(
    target.x + Math.sin(yaw) * Math.cos(pitch) * dist,
    target.y + Math.sin(pitch) * dist,
    target.z + Math.cos(yaw) * Math.cos(pitch) * dist,
  );
  camera.lookAt(target);
  renderer.render(scene, camera);
});
