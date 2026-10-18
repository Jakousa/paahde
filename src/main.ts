import * as THREE from 'three/webgpu';
import { BACK, DT, FORWARD, isSlipFace, quantizeYaw } from '../shared/sim.ts';
import { EYE_HEIGHT, quantizePitch } from '../shared/dig.ts';
import { scrapTarget } from '../shared/scrap.ts';
import { allBeaten } from '../shared/bosses.ts';
import { WORLD_ID } from '../shared/world.ts';
import { bedTarget, EMPTY, GROWN, SPROUTS } from '../shared/garden.ts';
import { bedLit, placed } from '../shared/placed.ts';
import { STATIONS, stationTarget } from '../shared/stations.ts';
import { FirstPersonCamera } from './camera';
import { BlownSand } from './blownSand';
import { BaseSand } from './world/baseSand';
import { Shelters } from './world/shelters';
import { addCrosshair } from './crosshair';
import { footprints, streaks, tyreprints } from './footprints';
import { InventoryHud, itemLabel } from './inventory';
import { addItem, debrisItem, SCRAP } from '../shared/items.ts';
import { readInput, takePickup } from './input';
import { LocatorBar } from './locator';
import { Menu } from './menu';
import { getBrowserId, Net } from './net';
import { Lives } from './lives';
import { landing, victory } from './landing';
import { loadScavenger, ScavengerModel } from './models/scavenger';
import { Avatar } from './players';
import { addHeadlights, Bike } from './bike';
import { tyreDust } from './tyreDust';
import { Post } from './post';
import * as env from './world/env';
import { Base } from './world/base';
import { PlacedView } from './world/placed';
import { Placer } from './placing';
import { Scrap } from './world/scrap';
import { CrashSites } from './world/crashsites';
import { CrashSound } from './crashSound';
import { allCrashSites, crashSitesNear, debrisTarget } from '../shared/crashsites.ts';
import { CRASH_KINDS } from '../shared/crashKinds.ts';
import { Dust } from './world/dust';
import { clockText } from './world/dayNight';
import { DebugMenu } from './debugMenu.ts';
import { BossFx } from './bosses';
import { Sky } from './world/sky';
import { Terrain } from './world/terrain';
import { wind } from './world/wind';
import { WindSound } from './windSound';
import { EngineSound } from './engineSound';
import { drinkSound } from './drinkSound';
import { footsteps } from './footsteps';
import { music } from './music';
import { uiSound } from './uiSound';
import { breathing } from './breathing';
import { slideSound } from './slideSound';
import { audio } from './audio';
import { inBase } from '../shared/base.ts';
import { indoors } from '../shared/shelters.ts';
import { pickupSound } from './pickupSound';
import { DynamicResolution } from './resolution';
import { playerHands, Survival } from './water';
import { StormFx } from './storm';
import { ViewModel } from './viewmodel';
import { Telescope } from './telescope';
import { Rifle } from './rifle';
import { Jammer } from './jammer';
import { Receiver } from './receiver';
import { BossBar } from './bossBar';
import { Thrower } from './throw';
import { zaps } from './world/zaps';
import { TeardownView } from './teardown/teardown';
import { BENCH_ID, MachineSites } from './world/crash';
import { machinesAt } from '../shared/crash.ts';
import { COMPONENTS, SALVAGE } from '../shared/salvage.ts';
import { bagShape, carriedGear, equipped, locatorRange, quality, repaired, spyglassZoom, stormWarnS, wornGear } from '../shared/gear.ts';
import { LootView, lootName } from './world/loot';
import { CorpseView } from './world/corpses';
import { corpsesNear } from '../shared/corpse.ts';
import { Chat } from './chat';
import { askName } from './name';
import { tools } from './input';
import { Wrecks } from './world/wrecks';
import { Trophies } from './world/trophies';
import { setTrophies } from '../shared/trophies.ts';
import { Mast } from './world/mast';
import { GuardianFx } from './guardians';
import { update } from './update';

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
const mast = new Mast(scene); // flag mast with a windsock by the entrance
const trophies = new Trophies(scene); // a big piece of each beaten boss round the base
const shelters = new Shelters(scene); // small empty bunkers out in the desert
const placedView = new PlacedView(scene, base); // plant beds and UV lamps on the bunker floor
const scrap = new Scrap(scene);
const crashSites = new CrashSites(scene);
const crashSound = new CrashSound();
const dust = new Dust(scene);
const post = new Post(renderer, scene, orbit.camera);
const blownSand = new BlownSand(scene);
const baseSand = new BaseSand(scene);
const viewmodel = new ViewModel(orbit, scene); // first-person hands, parented to the camera

const windSound = new WindSound();
const engineSound = new EngineSound();
const storm = new StormFx();
const machines = new MachineSites(scene); // wrecked machinery to take apart (not the crashed spacecraft above), and the disassembly table job
const wrecks = new Wrecks(scene); // salvage wrecks out in the desert, carried home to the disassembly table
const guardianFx = new GuardianFx(scene); // the giant walkers around the crash sites, and the night drones
const bossFx = new BossFx(scene, (...a) => guardianFx.thump(...a), (s) => guardianFx.jolt(s)); // the worm, carrier, colossus and queen (shared/bosses.ts)
const teardown = new TeardownView(scene, orbit.camera, renderer.domElement); // F at a machine site: the character walks up and the disassembly controls take over
machines.busy = () => teardown.current?.id;
machines.bench.indoors = (root) => base.lightIndoors(root);
// Debug handle for screenshots/tuning from the console: open with ?debug.
if (location.search.includes('debug')) {
  // crash: every crash site's id, centre, wreck kind and its machines (shared/crashsites.ts, shared/crash.ts).
  const crash = allCrashSites().map((s) => ({ id: s.id, x: Math.round(s.x), z: Math.round(s.z), kind: s.pieces[0].kind, pieces: s.pieces.length, machines: machinesAt(s).map((m) => m.kind) }));
  Object.assign(window, { dbg: { orbit, sky, post, scene, renderer, env, terrain, scrap, base, mast, wind, blownSand, dust, windSound, storm, viewmodel, crashSites, crashSound, crash, playerHands, machines, wrecks, teardown, placedView, guardianFx, bossFx } });
}

const net = new Net(getBrowserId());
const lives = new Lives();
net.onLives = (n, beaten) => {
  lives.set(n, beaten);
  trophies.set(beaten);
  setTrophies(beaten);
  if (allBeaten(beaten)) victory(WORLD_ID);
};
net.onEnded = (why) => landing(why);
if (location.search.includes('debug')) Object.assign((window as unknown as { dbg: object }).dbg, { net });
// Machine progress (large sites and the disassembly table), from the server: every machine is kept up to date,
// and the one being worked on gets it through the disassembly mode, animated.
net.onSite = (m) => {
  const cur = teardown.current;
  machines.apply(m, cur?.id ?? null);
  // Someone scrapped the table's machine while we work on it (a finished one stays open until we leave).
  if (m.t === 'bench' && !m.job && cur?.id === BENCH_ID && cur.junk.slots.some((s) => !s.taken)) teardown.end();
  if (m.t === 'siteTook' && cur?.id === m.id) {
    teardown.applyTook(m.i, m.ok, m.reason);
  }
  if (!cur || m.t === 'sites' || m.t === 'bench' || m.t === 'siteReset' || m.t === 'siteTook' || cur.id !== m.id) return;
  if (m.t === 'siteState') {
    for (const i of m.done) teardown.applyDone(i, true);
    for (const i of m.taken) teardown.applyTake(i, false);
  } else if (m.t === 'siteDone') teardown.applyDone(m.i);
  else teardown.applyTake(m.i, m.by === net.id);
};
// Scrap the machine on the disassembly table: one scrap per part still on it, if they all fit in the bag.
const scrapBench = () => {
  const n = Math.max(1, teardown.current?.junk.slots.filter((s) => !s.taken).length ?? 1);
  if (!addItem([...(net.boxes.bag ?? [])], SCRAP, n, () => 0, bagShape(net.boxes.equip))) return false;
  net.benchScrap();
  pickupSound.play();
  hud.toast(`+${n} ${itemLabel(SCRAP)}`);
  return true;
};
// A machine we put on the disassembly table is there (the server picked its seed): start taking it apart.
machines.bench.onReady = () => {
  const job = machines.bench.site(net.siteLink(BENCH_ID), scrapBench);
  if (job && !teardown.active && Math.hypot(job.x - net.me.x, job.z - net.me.z) < 5) teardown.begin(job);
};
new DebugMenu(() => sky.day.tod, (tod) => net.shareTimeOfDay(tod), () => net.resetSharedTime(), () => net.summonStorm(), () => net.debugGear(), (what) => net.summonBot(what),
  (mode) => trophies.show(mode));
new Chat(net);
askName(net, renderer.domElement);
// New builds wait for a quiet moment to reload (src/update.ts).
update.busy = () => guardianFx.combat || bossFx.combat || net.me.riding || teardown.active || !!net.down;
const lootView = new LootView(scene);
const corpseView = new CorpseView(scene);
addCrosshair();
loadScavenger().catch((e) => console.warn('scavenger model failed to load; keeping placeholders', e));
// Dark until the player model has loaded, and the bunker too if you spawn in it, so the first frames show
// neither a half-built room nor placeholder bodies; after 20 s, whatever has loaded.
const cover = document.getElementById('cover')!; // in index.html, so it is up before this script has loaded
// The bar counts every model and texture through three's default loading manager; never runs backwards as
// more loads are queued.
let coverP = 0;
THREE.DefaultLoadingManager.onProgress = (_url, done, total) => {
  coverP = Math.max(coverP, done / total);
  cover.style.setProperty('--p', String(coverP));
};
let loaded = false;
let coverFrames = 0; // frames drawn behind the cover once loaded (lets shaders compile)
let baseLoaded = false;
let bodyLoaded = false;
let coverTimedOut = false;
base.ready.then(() => (baseLoaded = true), () => (baseLoaded = true));
loadScavenger().then(() => (bodyLoaded = true), () => (bodyLoaded = true));
setTimeout(() => (coverTimedOut = true), 20_000);
const me = new Avatar(0xffffff);
me.setShadowOnly(true); // first person: your body casts a shadow but is not drawn
let bodyHidden = true;
const myModel = new ScavengerModel();
myModel.ready.then(() => me.setModel(myModel, net.color), () => myModel.dispose());
scene.add(me.root, footprints.mesh, tyreprints.mesh, streaks.mesh, tyreDust.mesh);
const remotes = new Map<number, Avatar>();
// Sand bikes (9, dev helper), one per riding player: drawn here, simulated in shared/sim.ts.
const bikes = new Map<number, Bike>();
addHeadlights(scene);
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
const hud = new InventoryHud(net, renderer.domElement);
const survival = new Survival(net);
const menu = new Menu(renderer.domElement, (v) => post.setAoIntensity(v));
const telescope = new Telescope(orbit);
const jammer = new Jammer(orbit, net, guardianFx.jets, guardianFx.drones);
const receiver = new Receiver(orbit, net);
const bossBar = new BossBar();
if (location.search.includes('debug')) Object.assign((window as unknown as { dbg: object }).dbg, { jammer });
// The beam starts at the drawn gun: the first-person one, or in third person the one in the body's hand.
const rifle = new Rifle(orbit, net, guardianFx.guardians, guardianFx.drones, guardianFx.jets,
  (out) => viewmodel.muzzle(out) ?? (orbit.showBody && me.muzzle(out) ? out : null));
rifle.remoteMuzzle = (id, out) => (remotes.get(id)?.muzzle(out) ? out : null);
scene.add(zaps.root);
zaps.setCamera(orbit.camera);
const thrower = new Thrower(scene, orbit, net, scrap);
thrower.piece = () => viewmodel.scrapPiece(); // the piece in flight is the one drawn in the hand
if (location.search.includes('debug')) Object.assign((window as unknown as { dbg: object }).dbg, { rifle, zaps });
net.onPlaced = () => placedView.sync(placed, net.garden);
net.onNotice = (text) => {
  if (text === 'Bag full') uiSound.full(); // the server refused a find (server/world.ts)
  hud.toast(text);
};
function bagFull() {
  hud.toast('Bag full');
  uiSound.full();
}
const placer = new Placer(net, placedView);

window.addEventListener('resize', () => {
  orbit.resize();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';

const timer = new THREE.Timer();
const focus = new THREE.Vector3();
let accumulator = 0;
let joined = false; // until the first welcome, net.me is the default spawn, not our saved position
// ?spawn=crash / field: once joined, turn to face the machine or the scrap field we were put next to.
const spawnAt = new URLSearchParams(location.search).get('spawn');
let faceCrash = spawnAt === 'crash' || spawnAt === 'field';
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
    menu.setInfo(`${backend} · ${net.status} · build ${__BUILD_SHA__}`);
    return;
  }
  joined = true;
  loaded ||= coverTimedOut || (bodyLoaded && (baseLoaded || !inBase(net.me.x, net.me.y, net.me.z, 2)));
  if (loaded && coverFrames < 3 && ++coverFrames === 3) {
    cover.style.opacity = '0';
    setTimeout(() => cover.remove(), 500);
  }
  if (faceCrash) {
    faceCrash = false;
    const near = crashSitesNear(net.me.x, net.me.z, 200);
    const site = spawnAt === 'field' ? near.find((s) => s.level === 0) : near.find((s) => s.level > 0)?.machines[0];
    if (site) orbit.yaw = Math.atan2(-(site.x - net.me.x), -(site.z - net.me.z));
  }
  resolution.update(frameDt);

  // Fixed-step simulation: identical DT on client and server keeps prediction in agreement.
  accumulator += frameDt;
  // Disassembly walks the character up to the machine with the normal input bits, then the keyboard goes quiet.
  const walk = teardown.drive(orbit, net.me, frameDt);
  const input = teardown.active ? walk : readInput();
  while (accumulator >= DT) {
    net.tick(input, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch));
    accumulator -= DT;
  }

  const others = net.frame(frameDt);
  // The gun raised (or just fired), or the spyglass: others see it shouldered, or at the eye (src/models/scavenger.ts).
  const aiming = playerHands.aim > 0.5 || playerHands.looking;
  net.setHands(playerHands.held, playerHands.drinking, playerHands.filling, aiming);

  me.setColor(net.color);
  const s = net.me;
  // Drawn between the last two ticks (the leftover accumulator), so motion is even at any frame rate.
  const v = net.view(accumulator / DT);
  // On the bike the camera turns with it; the mouse still looks around on top.
  if (s.riding && Number.isFinite(lastHeading)) orbit.yaw += Math.atan2(Math.sin(v.heading - lastHeading), Math.cos(v.heading - lastHeading));
  lastHeading = s.riding ? v.heading : NaN;
  // What's in hand (the selected hotbar slot) and worn (shared/gear.ts): drawn on the body, and sets what the tools can do.
  const inHand = tools.slot >= 0 ? net.boxes.bag?.[tools.slot] : null;
  me.setOutfit(inHand?.kind ?? null, wornGear(net.boxes.equip) | carriedGear(net.boxes.bag, tools.slot));
  const riding = ride(0, me, { ...s, x: v.x, y: v.y, z: v.z, heading: v.heading, pitch: orbit.pitch }, frameDt);
  if (!riding) {
    me.update(
      { x: v.x, y: v.y, z: v.z, facing: v.facing, speed: Math.hypot(s.vx, s.vz), vx: s.vx, vz: s.vz, grounded: s.grounded, powerSlide: s.sliding, crouching: s.crouching,
      pitch: orbit.pitch, drinking: playerHands.drinking, aiming: aiming || net.justFired(net.id), down: net.down,
      look: orbit.freeYaw },
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
    avatar.setOutfit(r.item, r.gear);
    if (!ride(r.id, avatar, { ...r, heading: r.facing }, frameDt)) {
      avatar.update({ ...r, sliding: undefined, powerSlide: r.sliding, crouching: r.crouching }, frameDt);
    }
  }
  for (const [id, avatar] of remotes) {
    if (!seen.has(id)) {
      avatar.dispose();
      remotes.delete(id);
      bikes.get(id)?.dispose();
      bikes.delete(id);
    }
  }

  // Riding, the eye is the rider's (it leans and tucks with them), moved forward over the bars so the
  // shoulders and hood are behind it in first person: you see your hands on the grips. The camera adds EYE_HEIGHT.
  if (riding && me.eye(eye)) focus.set(eye.x - Math.sin(v.heading) * RIDE_EYE_AHEAD, eye.y - EYE_HEIGHT, eye.z - Math.cos(v.heading) * RIDE_EYE_AHEAD);
  else if (riding) focus.set(v.x, v.y, v.z);
  // Dead: the camera backs off to third person and follows the body as it falls (the pivot a little above it).
  else if (me.downAt(focus)) focus.y += 0.5 - EYE_HEIGHT;
  else focus.copy(me.root.position);
  if (orbit.down !== (net.down !== null)) document.body.classList.toggle('down', (orbit.down = net.down !== null));
  telescope.update(frameDt, spyglassZoom(Math.max(0, quality(inHand))));
  const fire = rifle.update(frameDt, { speed: Math.hypot(s.vx, s.vz), grounded: s.grounded, crouching: !!(s.crouching || s.sliding) }, !s.riding && !teardown.active && !net.down);
  lootView.update(frameDt, net.loot, focus);
  corpseView.update(frameDt, focus);
  orbit.update({ x: focus.x, y: focus.y, z: focus.z, vx: s.vx, vy: s.vy, vz: s.vz, grounded: s.grounded, sliding: s.sliding, crouching: s.crouching, riding: s.riding, heading: v.heading, lean: bikes.get(0)?.leanAngle }, frameDt);
  teardown.placeCamera(frameDt); // at the disassembly table: a fixed view above it
  bossFx.update(net, frameDt, orbit.camera);
  bossBar.update(frameDt, bossFx.bar);
  guardianFx.update(net, frameDt, orbit.camera, focus);
  rifle.afterCamera(fire); // the aim's sway and recoil on the view, and the shot, against the walkers as just drawn
  thrower.update(frameDt, !s.riding && !teardown.active && !net.down);
  jammer.update(frameDt, !s.riding && !teardown.active && !net.down);
  jammer.others(others, orbit.camera.position); // others' jammers: their static
  receiver.update(frameDt, inHand, !s.riding && !teardown.active && !net.down);
  // T: third person. On the bike the body is drawn in first person too (hands on the bars), minus the head.
  if ((orbit.showBody || riding) === bodyHidden) me.setShadowOnly((bodyHidden = !(orbit.showBody || riding)));
  me.setHeadless(riding && !orbit.showBody);
  viewmodel.root.visible = bodyHidden && !teardown.active;
  viewmodel.setColor(net.color);
  viewmodel.update(frameDt, { speed: Math.hypot(s.vx, s.vz), grounded: s.grounded, sliding: s.sliding });
  zaps.update(frameDt); // after the gun is drawn: your beam starts at its muzzle
  // Before the wind: the storm sets how hard it blows here.
  const belt = equipped(net.boxes.equip, 'belt');
  storm.update(frameDt, net.storms, net.serverTime(), orbit.camera.position, net.me, belt ? stormWarnS(quality(belt)) : 0);
  // The locator comes with the wrist computer; a better one shows players further away (the base always).
  const wrist = equipped(net.boxes.equip, 'wrist');
  const range = wrist ? locatorRange(quality(wrist)) : 0;
  locator.lost = storm.lost || !wrist;
  locator.update(orbit.camera, orbit.viewYaw, orbit.pitch + orbit.freePitch, focus, [...others.filter((o) => Math.hypot(o.x - focus.x, o.z - focus.z) < range), ...wrecks.targets(focus.x, focus.z)]);
  terrain.update(focus);
  scrap.update(focus);
  crashSites.update(focus);
  machines.update(focus);
  wrecks.update(focus);
  sky.update(frameDt, focus, orbit.camera, net.worldTime());
  wind.update(net.serverTime() / 1000);
  blownSand.update(frameDt, focus);
  dust.update(frameDt, orbit.camera.position);
baseSand.update(frameDt, storm.atBase);
  tyreDust.update(frameDt);
  base.update();
  base.viewFrom(teardown.current?.id === BENCH_ID ? orbit.camera.position : null);
  shelters.update(orbit.camera.position);
  mast.update(frameDt);
  windSound.update(frameDt, orbit.camera.position, orbit.viewYaw, s);
  // Sand hissing under you: a speed slide, or (softer) slipping down a slip face on your feet.
  const ownSpeed = Math.hypot(s.vx, s.vz);
  slideSound.update(frameDt, !s.grounded || s.riding || net.down ? 0 : s.sliding ? 1 : ownSpeed > 2 && isSlipFace(s.x, s.z) ? 0.5 : 0, ownSpeed);
  engineSound.update(frameDt, s.riding, s.grounded, Math.hypot(s.vx, s.vz), s.riding && (input & (FORWARD | BACK)) !== 0);
  engineSound.updateRemotes(frameDt, others, orbit.camera.position, s);
  drinkSound.remotes(others, orbit.camera.position);
  footsteps.listener(orbit.camera.position, orbit.viewYaw);
  breathing.update(survival.heatLevel, survival.dead);
  audio.setMuffled(survival.dead); // the world goes dull while you lie dead; the music doesn't
  const cam = orbit.camera.position;
  music.update(frameDt, {
    riding: s.riding && Math.hypot(s.vx, s.vz) > 3,
    indoors: indoors(cam.x, cam.y, cam.z),
    sandstorm: storm.level > 0.3,
    epic: guardianFx.epic || bossFx.combat,
    combat: guardianFx.combat,
    dead: survival.dead,
  });
  crashSound.update(orbit.camera.position, orbit.viewYaw);
  // F: use the work station in view, else tend the plant bed in view (planted beds can't be touched
  // while they grow), else pick up scrap, else (canteen out, at the pump) fill the canteen.
  const station = net.connected ? stationTarget(net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch)) : -1;
  // Placing from the hotbar and G to pick placed things up (src/placing.ts); its prompt goes after F's.
  const placing = placer.update(survival.slot, net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch), !teardown.active, (t) => hud.toast(t));
  const bed = net.connected && station < 0 ? bedTarget(net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch), placed) : null;
  const bedState = bed ? net.garden.get(bed.id) : undefined;
  const stage = bed ? (bedState?.stage ?? EMPTY) : -1;
  const tend = stage === EMPTY ? 'Plant seeds' : stage === GROWN ? 'Harvest' : null;
  // Sprouts grow only under a UV lamp (shared/garden.ts).
  const growing = stage === SPROUTS && bed ? (bedLit(bed) ? `<span>${Math.round((bedState?.grow ?? 0) * 100)}%</span>` : '<span class="bad">Needs UV lamp</span>') : null;
  const target = net.connected && station < 0 && !bed ? scrapTarget(net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch)) : null;
  // Debris at the crash sites (hull plates, pipes, ...) is picked up as what it gives: scrap or cloth (shared/items.ts debrisItem).
  const debris = net.connected && station < 0 && !bed && !target && !teardown.active ? debrisTarget(net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch)) : null;
  const debrisPrompt = debris ? `Pick up ${itemLabel(debrisItem(CRASH_KINDS[debris.kind].node))}` : null;
  const find = net.connected && station < 0 && !bed && !target && !debris && !teardown.active ? lootView.target(net.me, orbit.yaw) : null;
  const findPrompt = find ? `Pick up ${lootName(find, itemLabel)}` : null;
  // Machines at the crash sites: a small one is picked up (it goes in the bag); a large one is taken apart where
  // it lies. A carried one is taken apart on the base's disassembly table.
  const site = net.connected && !teardown.active && station < 0 && !bed && !target && !debris && !find ? machines.nearest(net.me.x, net.me.z) : null;
  const small = site ? COMPONENTS[site.site.kind].carry : false;
  // Salvage wrecks (src/world/wrecks.ts) are always carried home.
  const wreck = net.connected && !teardown.active && station < 0 && !bed && !target && !debris && !site ? wrecks.nearest(net.me.x, net.me.z) : null;
  const sitePrompt = site ? (small ? `Pick up ${COMPONENTS[site.site.kind].label.toLowerCase()}` : `Disassemble ${COMPONENTS[site.site.kind].label.toLowerCase()}`)
    : wreck ? `Pick up ${SALVAGE[wreck.kind].label.toLowerCase()}` : null;
  const table = station >= 0 && STATIONS[station].kind === 'disassembly' ? machines.bench.offer(net.boxes.bag) : null;
  const use = station < 0 ? null : STATIONS[station].kind === 'workbench' ? 'Use workbench' : (table?.label ?? 'Use table');
  // A dead player's pack (shared/corpse.ts) lying here: F opens it next to the bag, like a chest.
  const pack = net.connected && !net.down && !teardown.active && station < 0 && !bed && !target && !debris && !find && !site && !wreck
    && corpsesNear(net.me).some((b) => net.boxes[b]);
  const packPrompt = pack ? 'Open pack' : null;
  const fPrompt = use ?? tend ?? target ?? debrisPrompt ?? findPrompt ?? sitePrompt ?? packPrompt;
  const extra = [growing, placing.prompt].filter(Boolean).join(' ');
  hud.setTarget(teardown.active ? null : fPrompt && extra && typeof fPrompt === 'string' ? `<kbd>F</kbd>${fPrompt} ${extra}` : (fPrompt ?? (extra || null)));
  const interact = takePickup();
  if (interact && !teardown.active) {
    if (use) {
      if (STATIONS[station].kind === 'workbench') hud.open();
      else if (table) {
        const job = table.resume ? machines.bench.site(net.siteLink(BENCH_ID), scrapBench) : null;
        if (job) teardown.begin(job);
        else {
          // The server picks the machine's seed; its 'bench' answer starts the mode (onReady below).
          machines.bench.ask();
          net.crashUse(table.kind);
        }
      } else hud.toast('Nothing to take apart');
    } else if (tend && bed) net.tend(bed.id);
    else if (target) {
      if (net.pickup(target)) pickupSound.play();
      else bagFull();
    } else if (debris) {
      if (net.debrisTake(debris)) pickupSound.play();
      else bagFull();
    } else if (find) {
      net.lootTake(find.id);
      pickupSound.play();
    } else if (site) {
      if (small) net.crashTake(site.site.id);
      else teardown.begin(machines.workSite(site, net.siteLink(site.site.id)));
    } else if (wreck) net.crashTake(wreck.id);
    else if (pack) hud.open();
  }
  const targeted = use !== null || tend !== null || target !== null || debrisPrompt !== null || findPrompt !== null || sitePrompt !== null || packPrompt !== null;
  survival.update(frameDt, net.me, targeted, interact && !targeted, clockText(sky.day.tod));
  hud.update(net.me);

  menu.setInfo(`${fps} fps @ ${resolution.ratio.toFixed(2)}x · ${clockText(sky.day.tod)} · ${backend} · ${net.status} · ${others.length + (net.connected ? 1 : 0)} online · build ${__BUILD_SHA__}`);
  teardown.update(frameDt);
  post.render();
});
