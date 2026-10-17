import * as THREE from 'three/webgpu';
import { DT, quantizeYaw } from '../shared/sim.ts';
import { EYE_HEIGHT, quantizePitch } from '../shared/dig.ts';
import { scrapTarget } from '../shared/scrap.ts';
import { bedTarget, EMPTY, GROWN } from '../shared/garden.ts';
import { FirstPersonCamera } from './camera';
import { BlownSand } from './blownSand';
import { DigFx } from './dig';
import { footprints, streaks } from './footprints';
import { InventoryHud } from './inventory';
import { readInput, takePickup } from './input';
import { LocatorBar } from './locator';
import { getBrowserId, Net } from './net';
import { loadScavenger, ScavengerModel } from './models/scavenger';
import { Avatar } from './players';
import { Bike } from './bike';
import { tyreDust } from './tyreDust';
import { Post } from './post';
import * as env from './world/env';
import { Base } from './world/base';
import { Scrap } from './world/scrap';
import { Dust } from './world/dust';
import { clockText } from './world/dayNight';
import { DebugMenu } from './debugMenu.ts';
import { Sky } from './world/sky';
import { Terrain } from './world/terrain';
import { wind } from './world/wind';
import { WindSound } from './windSound';
import { footsteps } from './footsteps';
import { DynamicResolution } from './resolution';

// WebGPURenderer uses WebGPU when available and falls back to WebGL2 otherwise.
const renderer = new THREE.WebGPURenderer({ antialias: true });
const resolution = new DynamicResolution(renderer); // sets the pixel ratio, then keeps it near 60 fps
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const orbit = new FirstPersonCamera(renderer.domElement);
const sky = new Sky(scene);
const terrain = new Terrain(scene);
const base = new Base(scene);
const scrap = new Scrap(scene);
const dust = new Dust(scene);
const post = new Post(renderer, scene, orbit.camera);
const blownSand = new BlownSand(scene);

const windSound = new WindSound();
// Debug handle for screenshots/tuning from the console: open with ?debug.
if (location.search.includes('debug')) Object.assign(window, { dbg: { orbit, sky, post, scene, renderer, env, terrain, scrap, base, wind, blownSand, dust, windSound } });

const net = new Net(getBrowserId());
new DebugMenu(() => sky.day.tod, (tod) => net.shareTimeOfDay(tod));
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
let bodyHidden = true;
const myModel = new ScavengerModel();
myModel.ready.then(() => me.setModel(myModel, net.color), () => myModel.dispose());
scene.add(me.root, footprints.mesh, streaks.mesh, tyreDust.mesh);
const remotes = new Map<number, Avatar>();
// Sand bikes (9, dev helper), one per riding player: drawn here, simulated in shared/sim.ts.
const bikes = new Map<number, Bike>();
let lastHeading = NaN;
/** Draw player `id`'s bike while they ride, with `avatar` seated on it, and drop it when they get off.
 *  False when not riding: then the caller updates the avatar on foot. */
function ride(id: number, avatar: Avatar, p: { riding: boolean; pitch?: number } & Parameters<Bike['update']>[0], dt: number): boolean {
  let bike = bikes.get(id);
  if (!p.riding) {
    if (bike) {
      bike.dispose();
      bikes.delete(id);
      avatar.root.rotation.set(0, avatar.root.rotation.y, 0);
    }
    return false;
  }
  if (!bike) bikes.set(id, (bike = new Bike(scene)));
  bike.update(p, dt);
  bike.seat(avatar.root);
  avatar.update({ x: p.x, y: p.y, z: p.z, facing: p.heading, speed: 0, grounded: true, pitch: p.pitch, ride: bike.rider() }, dt);
  return true;
}
const eye = new THREE.Vector3();
const RIDE_EYE_AHEAD = 0.15;
const locator = new LocatorBar();
const hud = new InventoryHud();
net.onInventory = (items) => hud.setItems(items);
net.onGarden = (beds) => base.setBeds(beds);
net.onTended = (what) => hud.toast(what === 'planted' ? 'Seeds planted' : 'Harvested the greens');

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
// FPS for the info line: frames counted over half-second windows.
let fps = 0;
let fpsFrames = 0;
let fpsSince = performance.now();

renderer.setAnimationLoop((time) => {
  fpsFrames++;
  if (time - fpsSince >= 500) {
    fps = Math.round((fpsFrames * 1000) / (time - fpsSince));
    fpsFrames = 0;
    fpsSince = time;
  }
  timer.update(time);
  const frameDt = Math.min(timer.getDelta(), 0.25);
  if (!joined && !net.connected) {
    info.textContent = `${backend} · ${net.status} · build ${__BUILD_SHA__}`;
    return;
  }
  joined = true;
  resolution.update(frameDt);

  // Fixed-step simulation: identical DT on client and server keeps prediction in agreement.
  accumulator += frameDt;
  while (accumulator >= DT) {
    net.tick(readInput(), quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch));
    accumulator -= DT;
  }

  const others = net.frame(frameDt);

  me.setColor(net.color);
  const s = net.me;
  // Drawn between the last two ticks (the leftover accumulator), so motion is even at any frame rate.
  const v = net.view(accumulator / DT);
  // On the bike the camera turns with it; the mouse still looks around on top.
  if (s.riding && Number.isFinite(lastHeading)) orbit.yaw += Math.atan2(Math.sin(v.heading - lastHeading), Math.cos(v.heading - lastHeading));
  lastHeading = s.riding ? v.heading : NaN;
  const riding = ride(0, me, { ...s, x: v.x, y: v.y, z: v.z, heading: v.heading, pitch: orbit.pitch }, frameDt);
  if (!riding) {
    me.update(
      { x: v.x, y: v.y, z: v.z, facing: v.facing, speed: Math.hypot(s.vx, s.vz), vx: s.vx, vz: s.vz, grounded: s.grounded, powerSlide: s.sliding, crouching: s.crouching,
      digging: (digUntil.get(net.id) ?? 0) > performance.now(), pitch: orbit.pitch },
      frameDt,
    );
  }

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
    if (!ride(r.id, avatar, { ...r, heading: r.facing }, frameDt)) {
      avatar.update({ ...r, sliding: undefined, powerSlide: r.sliding, crouching: r.crouching, digging: (digUntil.get(r.id) ?? 0) > performance.now() }, frameDt);
    }
  }
  for (const [id, avatar] of remotes) {
    if (!seen.has(id)) {
      avatar.dispose();
      remotes.delete(id);
      bikes.get(id)?.dispose();
      bikes.delete(id);
      digUntil.delete(id);
    }
  }

  // Riding, the eye is the rider's (it leans and tucks with them), moved forward over the bars so the
  // shoulders and hood are behind it in first person: you see your hands on the grips. The camera adds EYE_HEIGHT.
  if (riding && me.eye(eye)) focus.set(eye.x - Math.sin(v.heading) * RIDE_EYE_AHEAD, eye.y - EYE_HEIGHT, eye.z - Math.cos(v.heading) * RIDE_EYE_AHEAD);
  else if (riding) focus.set(v.x, v.y, v.z);
  else focus.copy(me.root.position);
  orbit.update({ x: focus.x, y: focus.y, z: focus.z, vx: s.vx, vy: s.vy, vz: s.vz, grounded: s.grounded, sliding: s.sliding, crouching: s.crouching, riding: s.riding, lean: bikes.get(0)?.leanAngle }, frameDt);
  // T: third person. On the bike the body is drawn in first person too (hands on the bars), minus the head.
  if ((orbit.showBody || riding) === bodyHidden) me.setShadowOnly((bodyHidden = !(orbit.showBody || riding)));
  me.setHeadless(riding && !orbit.showBody);
  locator.update(orbit.camera, orbit.yaw, orbit.pitch, focus, others);
  terrain.update(focus);
  scrap.update(focus);
  sky.update(frameDt, focus, orbit.camera, net.worldTime());
  wind.update(net.serverTime() / 1000);
  blownSand.update(frameDt, focus);
  dust.update(frameDt, orbit.camera.position);
  tyreDust.update(frameDt);
  base.update(frameDt, wind.storm);
  windSound.update(frameDt, orbit.camera.position, orbit.yaw);
  footsteps.listener(orbit.camera.position, orbit.yaw);
  digFx.update(frameDt, net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch), document.pointerLockElement === renderer.domElement);
  // F: tend the greenhouse bed in view (planted beds can't be touched while they grow), else pick up scrap.
  const bed = net.connected ? bedTarget(net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch)) : -1;
  const stage = net.garden[bed];
  const tend = stage === EMPTY ? 'Plant seeds' : stage === GROWN ? 'Harvest' : null;
  const target = net.connected && bed < 0 ? scrapTarget(net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch)) : null;
  hud.setTarget(tend ?? target);
  if (takePickup()) {
    if (tend) net.tend(bed);
    else if (target) net.pickup(target);
  }

  info.textContent = `${fps} fps @ ${resolution.ratio.toFixed(2)}x · ${clockText(sky.day.tod)} · ${backend} · ${net.status} · ${others.length + (net.connected ? 1 : 0)} online · build ${__BUILD_SHA__}`;
  post.render();
});
