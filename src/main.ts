import * as THREE from 'three/webgpu';
import { DT, quantizeYaw } from '../shared/sim.ts';
import { quantizePitch } from '../shared/dig.ts';
import { FirstPersonCamera } from './camera';
import { DigFx } from './dig';
import { footprints } from './footprints';
import { readInput } from './input';
import { getBrowserId, Net } from './net';
import { Avatar } from './players';
import { Post } from './post';
import * as env from './world/env';
import { Sky } from './world/sky';
import { Terrain } from './world/terrain';

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
const post = new Post(renderer, scene, orbit.camera);

// Debug handle for screenshots/tuning from the console: open with ?debug.
if (location.search.includes('debug')) Object.assign(window, { dbg: { orbit, sky, post, scene, renderer, env } });

const net = new Net(getBrowserId());
const digFx = new DigFx(scene);
net.onDig = (at, pile) => digFx.puff(at, pile);
const me = new Avatar(0xffffff);
me.root.visible = false; // first person: only remote players are drawn
scene.add(me.root, footprints.mesh);
const remotes = new Map<number, Avatar>();

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

renderer.setAnimationLoop((time) => {
  timer.update(time);
  const frameDt = Math.min(timer.getDelta(), 0.25);

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
    { x: s.x + net.errorX, y: s.y + net.errorY, z: s.z + net.errorZ, facing: s.facing, speed: Math.hypot(s.vx, s.vz), grounded: s.grounded },
    frameDt,
  );

  const seen = new Set<number>();
  for (const r of others) {
    seen.add(r.id);
    let avatar = remotes.get(r.id);
    if (!avatar) {
      remotes.set(r.id, (avatar = new Avatar(r.color)));
      avatar.setLabel(`#${r.id}`, r.color);
      scene.add(avatar.root);
    }
    avatar.update(r, frameDt);
  }
  for (const [id, avatar] of remotes) {
    if (!seen.has(id)) {
      avatar.dispose();
      remotes.delete(id);
    }
  }

  focus.copy(me.root.position);
  orbit.update({ x: focus.x, y: focus.y, z: focus.z, vx: s.vx, vy: s.vy, vz: s.vz, grounded: s.grounded }, frameDt);
  terrain.update(focus);
  sky.update(frameDt, focus);
  digFx.update(frameDt, net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch), document.pointerLockElement === renderer.domElement);

  info.textContent = `${backend} · ${net.status} · ${others.length + (net.connected ? 1 : 0)} online · build ${__BUILD_SHA__}`;
  post.render();
});
