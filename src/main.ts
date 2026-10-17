import * as THREE from 'three/webgpu';
import { DT, quantizeYaw } from '../shared/sim.ts';
import { quantizePitch } from '../shared/dig.ts';
import { scrapTarget } from '../shared/scrap.ts';
import { FirstPersonCamera } from './camera';
import { BlownSand } from './blownSand';
import { DigFx } from './dig';
import { footprints } from './footprints';
import { InventoryHud } from './inventory';
import { readInput, takePickup } from './input';
import { LocatorBar } from './locator';
import { getBrowserId, Net } from './net';
import { loadScavenger, ScavengerModel } from './models/scavenger';
import { Avatar } from './players';
import { Post } from './post';
import * as env from './world/env';
import { addPalms } from './world/palms';
import { Scrap } from './world/scrap';
import { Dust } from './world/dust';
import { clockText } from './world/dayNight';
import { Sky } from './world/sky';
import { Terrain } from './world/terrain';
import { wind } from './world/wind';
import { WindSound } from './windSound';

// WebGPURenderer uses WebGPU when available and falls back to WebGL2 otherwise.
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const orbit = new FirstPersonCamera(renderer.domElement);
const sky = new Sky(scene);
const terrain = new Terrain(scene);
addPalms(scene);
const scrap = new Scrap(scene);
const dust = new Dust(scene);
const post = new Post(renderer, scene, orbit.camera);
const blownSand = new BlownSand(scene);

const windSound = new WindSound();
// Debug handle for screenshots/tuning from the console: open with ?debug.
if (location.search.includes('debug')) Object.assign(window, { dbg: { orbit, sky, post, scene, renderer, env, terrain, scrap, wind, blownSand, dust, windSound } });

const net = new Net(getBrowserId());
const digFx = new DigFx(scene);
// Remote players play their dig clip for a moment after each stroke the server reports.
const DIG_ANIM_S = 0.5;
const digUntil = new Map<number, number>();
net.onDig = (at, pile, _mine, id) => {
  digFx.puff(at, pile);
  digUntil.set(id, performance.now() + DIG_ANIM_S * 1000);
};
loadScavenger().catch((e) => console.warn('scavenger model failed to load; keeping placeholders', e));
const me = new Avatar(0xffffff);
me.setShadowOnly(true); // first person: your body casts a shadow but is not drawn
const myModel = new ScavengerModel();
myModel.ready.then(() => me.setModel(myModel, net.color), () => myModel.dispose());
scene.add(me.root, footprints.mesh);
const remotes = new Map<number, Avatar>();
const locator = new LocatorBar();
const hud = new InventoryHud();
net.onInventory = (items) => hud.setItems(items);

window.addEventListener('resize', () => {
  orbit.resize();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
const info = document.getElementById('info')!;

const timer = new THREE.Timer();
const focus = new THREE.Vector3();
let accumulator = 0;
let joined = false; // until the first welcome, net.me is the default spawn, not our saved position

renderer.setAnimationLoop((time) => {
  timer.update(time);
  const frameDt = Math.min(timer.getDelta(), 0.25);
  if (!joined && !net.connected) {
    info.textContent = `${backend} · ${net.status} · build ${__BUILD_SHA__}`;
    return;
  }
  joined = true;

  // Fixed-step simulation: identical DT on client and server keeps prediction in agreement.
  accumulator += frameDt;
  while (accumulator >= DT) {
    net.tick(readInput(), quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch));
    accumulator -= DT;
  }

  const others = net.frame(frameDt);

  me.setColor(net.color);
  const s = net.me;
  me.update(
    { x: s.x + net.errorX, y: s.y + net.errorY, z: s.z + net.errorZ, facing: s.facing, speed: Math.hypot(s.vx, s.vz), vx: s.vx, vz: s.vz, grounded: s.grounded,
    digging: (digUntil.get(net.id) ?? 0) > performance.now(), pitch: orbit.pitch },
    frameDt,
  );

  const seen = new Set<number>();
  for (const r of others) {
    seen.add(r.id);
    let avatar = remotes.get(r.id);
    if (!avatar) {
      const a = (avatar = new Avatar(r.color));
      remotes.set(r.id, a);
      a.setLabel(`#${r.id}`, r.color);
      scene.add(a.root);
      // Placeholder until the rigged scavenger has loaded, then swap it in.
      const model = new ScavengerModel(r.color);
      model.ready.then(
        () => (remotes.get(r.id) === a ? a.setModel(model, r.color) : model.dispose()),
        () => model.dispose(),
      );
    }
    avatar.update({ ...r, digging: (digUntil.get(r.id) ?? 0) > performance.now() }, frameDt);
  }
  for (const [id, avatar] of remotes) {
    if (!seen.has(id)) {
      avatar.dispose();
      remotes.delete(id);
      digUntil.delete(id);
    }
  }

  focus.copy(me.root.position);
  orbit.update({ x: focus.x, y: focus.y, z: focus.z, vx: s.vx, vy: s.vy, vz: s.vz, grounded: s.grounded }, frameDt);
  locator.update(orbit.camera, orbit.yaw, orbit.pitch, focus, others);
  terrain.update(focus);
  scrap.update(focus);
  sky.update(frameDt, focus, orbit.camera, net.worldTime());
  wind.update(net.serverTime() / 1000);
  blownSand.update(frameDt, focus);
  dust.update(frameDt, orbit.camera.position);
  windSound.update(frameDt, orbit.camera.position, orbit.yaw);
  digFx.update(frameDt, net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch), document.pointerLockElement === renderer.domElement);
  const target = net.connected ? scrapTarget(net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch)) : null;
  hud.setTarget(target);
  if (takePickup() && target) net.pickup(target);

  info.textContent = `${clockText(sky.day.tod)} · ${backend} · ${net.status} · ${others.length + (net.connected ? 1 : 0)} online · build ${__BUILD_SHA__}`;
  post.render();
});
