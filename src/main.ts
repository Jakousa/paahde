import { viewCull } from './world/viewCull';
import * as THREE from 'three/webgpu';
import { BACK, DT, FORWARD, isSlipFace, MOUNT_TICKS, quantizeYaw } from '../shared/sim.ts';
import { EYE_HEIGHT, quantizePitch } from '../shared/dig.ts';
import { scrapTarget } from '../shared/scrap.ts';
import { allBeaten } from '../shared/bosses.ts';
import { LAB, WORLD_ID } from '../shared/world.ts';
import { bedTarget, EMPTY, GROWN, SPROUTS } from '../shared/garden.ts';
import { bedLit, placed } from '../shared/placed.ts';
import { STATIONS, stationTarget } from '../shared/stations.ts';
import { FirstPersonCamera } from './camera';
import { BlownSand } from './blownSand';
import { BaseSand } from './world/baseSand';
import { Shelters } from './world/shelters';
import { addCrosshair, crosshairRing } from './crosshair';
import { ShieldFx } from './shieldFx';
import { footprints, streaks, tyreprints } from './footprints';
import { InventoryHud, itemLabel } from './inventory';
import { addItem, debrisItem, SCRAP } from '../shared/items.ts';
import { kbd } from './bindings';
import { readInput, takePickup } from './input';
import { LocatorBar } from './locator';
import { Menu } from './menu';
import { StatsGraph } from './statsGraph';
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
import { coreCrashSites, crashSitesNear, debrisTarget } from '../shared/crashsites.ts';
import { CRASH_KINDS } from '../shared/crashKinds.ts';
import { Dust } from './world/dust';
import { clockText } from './world/dayNight';
import { DebugMenu } from './debugMenu.ts';
import { FlyCam } from './flyCam';
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
import { atWater, indoors, inShelter } from '../shared/shelters.ts';
import { pickupSound } from './pickupSound';
import { DynamicResolution } from './resolution';
import { playerHands, Survival } from './water';
import { StormFx } from './storm';
import { Speech } from './speech';
import { ViewModel } from './viewmodel';
import { Telescope } from './telescope';
import { Rifle } from './rifle';
import { Jammer } from './jammer';
import { Grinder } from './grinder';
import { Receiver } from './receiver';
import { BossBar } from './bossBar';
import { Thrower } from './throw';
import { zaps } from './world/zaps';
import { TeardownView } from './teardown/teardown';
import { BENCH_ID, MachineSites } from './world/crash';
import { machinesAt } from '../shared/crash.ts';
import { LAB_LOOK } from '../shared/lab.ts';
import { addLabPlates } from './world/labPlates';
import { labFloor } from './world/sandMaterial';
import { junkSpec, SALVAGE } from '../shared/salvage.ts';
import { bagShape, carriedGear, equipped, gearTiers, locatorRange, quality, repaired, spyglassZoom, stormWarnS, wornGear } from '../shared/gear.ts';
import { LootView, lootPrompt } from './world/loot';
import { CorpseView } from './world/corpses';
import { corpsesNear } from '../shared/corpse.ts';
import { openBoxes } from '../shared/storage.ts';
import { Chat } from './chat';
import { nameGate } from './name';
import { prologue } from './prologue';
import { tools } from './input';
import { Wrecks } from './world/wrecks';
import { Trophies } from './world/trophies';
import { setTrophies } from '../shared/trophies.ts';
import { Mast } from './world/mast';
import { GuardianFx } from './guardians';
import { update } from './update';
import { LOADING_FRAME_MS, slice } from './yield';
import { Warmup } from './warmup';
import { TEXT } from '../shared/text.ts';

// WebGPURenderer uses WebGPU when available and falls back to WebGL2 otherwise.
// powerPreference asks for the discrete GPU (eGPU, laptop dGPU) over the integrated one when there is a choice.
const renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance' });
// (the stats line counts a whole frame: the shadow passes, the scene and the post passes, not just the last render call, which is a full-screen quad)
renderer.info.autoReset = false;
const resolution = new DynamicResolution(renderer); // sets the pixel ratio, then keeps it near 60 fps
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const orbit = new FirstPersonCamera(renderer.domElement);
await slice();
const fly = new FlyCam(renderer.domElement); // F3 → Fly camera, for shooting video
const sky = new Sky(scene);
await slice();
const terrain = new Terrain(scene);
if (LAB) {
  labFloor(); // the dev test lab (shared/lab.ts): a plain floor with name plates
  addLabPlates(scene);
}
await slice();
const base = new Base(scene);
await slice();
const mast = new Mast(scene); // flag mast with a windsock by the entrance
await slice();
const trophies = new Trophies(scene); // a big piece of each beaten boss round the base
await slice();
const shelters = new Shelters(scene); // small empty bunkers out in the desert
await slice();
const placedView = new PlacedView(scene, base); // plant beds and UV lamps on the bunker floor
await slice();
const scrap = new Scrap(scene);
await slice();
const crashSites = new CrashSites(scene);
await slice();
const crashSound = new CrashSound();
await slice();
const dust = new Dust(scene);
await slice();
const post = new Post(renderer, scene, orbit.camera);
await slice();
const blownSand = new BlownSand(scene);
await slice();
const baseSand = new BaseSand(scene);
await slice();
const viewmodel = new ViewModel(orbit, scene); // first-person hands, parented to the camera
await slice();

const windSound = new WindSound();
await slice();
const engineSound = new EngineSound();
await slice();
const storm = new StormFx();
await slice();
const machines = new MachineSites(scene); // wrecked machinery to take apart (not the crashed spacecraft above), and the disassembly table job
await slice();
const wrecks = new Wrecks(scene); // salvage wrecks out in the desert, carried home to the disassembly table
await slice();
const guardianFx = new GuardianFx(scene); // the giant walkers around the crash sites, and the night drones
await slice();
const bossFx = new BossFx(scene, (...a) => guardianFx.thump(...a), (s) => guardianFx.jolt(s)); // the worm, carrier, colossus and queen (shared/bosses.ts)
await slice();
const teardown = new TeardownView(scene, orbit.camera, renderer.domElement); // F at a machine site: the character walks up and the disassembly controls take over
await slice();
machines.busy = () => teardown.current?.id;
viewCull.camera = orbit.camera;
machines.bench.indoors = (root) => base.lightIndoors(root);
// Debug handle for screenshots/tuning from the console: open with ?debug.
if (location.search.includes('debug')) {
  // crash: every crash site's id, centre, wreck kind and its machines (shared/crashsites.ts, shared/crash.ts).
  const crash = coreCrashSites().map((s) => ({ id: s.id, x: Math.round(s.x), z: Math.round(s.z), kind: s.pieces[0].kind, pieces: s.pieces.length, machines: machinesAt(s).map((m) => m.kind) }));
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
net.onScrapGot = (n, dropped) => teardown.gotScrap(n, dropped);
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
  if (!cur || m.t === 'sites' || m.t === 'bench' || m.t === 'siteReset' || m.t === 'siteTook' || m.t === 'siteRolls' || cur.id !== m.id) return;
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
  hud.toast(TEXT.notice.got(n, itemLabel(SCRAP)));
  return true;
};
// A machine we put on the disassembly table is there (the server picked its seed): start taking it apart.
machines.bench.onReady = () => {
  const job = machines.bench.site(net.siteLink(BENCH_ID), scrapBench);
  if (job && !teardown.active && Math.hypot(job.x - net.me.x, job.z - net.me.z) < 5) teardown.begin(job);
};
new DebugMenu(() => sky.day.tod, (tod) => net.shareTimeOfDay(tod), () => net.resetSharedTime(), () => net.summonStorm(), (tier) => net.debugGear(tier), () => net.debugHit(), (what) => net.summonBot(what),
  (mode) => trophies.show(mode),
  (all) => (all ? net.labReset() : net.labReset(machines.nearestLab(net.me.x, net.me.z)?.site.id)),
  (off) => net.debugHeat(off),
  (off) => net.debugWeather(off),
  fly, () => fly.start(orbit.camera, orbit.yaw, orbit.pitch));
new Chat(net);
const names = nameGate(net, renderer.domElement);
// New builds wait for a quiet moment to reload (src/update.ts).
update.busy = () => fly.active || guardianFx.combat || bossFx.combat || net.me.riding || teardown.active || !!net.down;
const lootView = new LootView(scene);
const shieldFx = new ShieldFx(scene, () => orbit.camera.position, () => net.id, (m) => guardianFx.jolt(m));
net.onShieldBreak = (m) => shieldFx.play(m);
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
  prologue.progress(coverP);
};
let loaded = false;
let coverFrames = 0; // frames drawn behind the cover once loaded (lets shaders compile)
let baseLoaded = false;
let bodyLoaded = false;
let coverTimedOut = false;
base.ready.then(() => (baseLoaded = true), () => (baseLoaded = true));
loadScavenger().then(() => (bodyLoaded = true), () => (bodyLoaded = true));
setTimeout(() => (coverTimedOut = true), 30_000);
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
function ride(id: number, avatar: Avatar, p: { riding: boolean; pitch?: number; bike: number } & Parameters<Bike['update']>[0], dt: number): boolean {
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
  bike.setTier(Math.max(0, Math.min(3, Math.floor(p.bike - 1 + 1e-6)))); // PlayerState.bike: 1 + its quality
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
const speech = new Speech();
/** The find last looked at, so the character remarks on it once per look (src/speechLines.ts 'see'). */
let seenFind: number | null = null;
/** The machine or wreck last in reach ('near'), and the item ids in the bag at the last frame ('got'; null until the
 *  bag first arrives: what we log in with is old news). */
let seenSite: string | null = null;
let bagIds: Set<number> | null = null;
const menu = new Menu(renderer.domElement, (v) => post.setAoIntensity(v));
const telescope = new Telescope(orbit);
const grinder = new Grinder(scene, orbit.camera, [me.root]);
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
  if (text === TEXT.notice.bagFull) { // the server refused a find (server/world.ts)
    uiSound.full();
    speech.event('bagFull', undefined);
  }
  hud.toast(text);
};
function bagFull() {
  hud.toast(TEXT.notice.bagFull);
  uiSound.full();
  speech.event('bagFull', undefined);
}
const placer = new Placer(net, placedView);

window.addEventListener('resize', () => {
  orbit.resize();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
// which GPU the browser actually gave us (shown in the stats line, so "integrated or not" can be read off it)
const gpuInfo = (renderer.backend as unknown as { device?: { adapterInfo?: { vendor?: string; architecture?: string; description?: string } } }).device?.adapterInfo;
const gpuName = gpuInfo ? (gpuInfo.description || [gpuInfo.vendor, gpuInfo.architecture].filter(Boolean).join(' ')) : '';
const backendText = gpuName ? `${backend} ${gpuName}` : backend;

const timer = new THREE.Timer();
const focus = new THREE.Vector3();
let accumulator = 0;
let lastLoadFrame = 0;
let warmed = false;
let warming = false;
/** Resolves when the GPU has finished what was sent so far (WebGPU), else after a moment. */
const gpuIdle = (): Promise<void> => {
  const queue = (renderer.backend as unknown as { device?: GPUDevice }).device?.queue;
  return queue ? queue.onSubmittedWorkDone() : new Promise((r) => setTimeout(r, 40));
};
const warm = new Warmup([scene, orbit.camera], () => post.render(), renderer.backend);
terrain.loading = true;
let joined = false; // until the first welcome, net.me is the default spawn, not our saved position
// ?spawn=crash / field: once joined, turn to face the machine or the scrap field we were put next to.
const spawnAt = new URLSearchParams(location.search).get('spawn');
let faceCrash = spawnAt === 'crash' || spawnAt === 'field' || LAB;
const statsGraph = new StatsGraph();

renderer.setAnimationLoop((time) => {
  net.telemetry.frame(performance.now());
  timer.update(time);
  const frameDt = Math.min(timer.getDelta(), 0.25);
  if (!joined && !net.connected) {
    menu.setInfo(`${backendText} · ${net.status} · build ${__BUILD_SHA__}`);
    return;
  }
  joined = true;
  // Once the models and terrain are in, draw real frames a few materials at a time (src/warmup.ts): the first full
  // frame would take seconds to build every shader and freeze the page. Nothing else is drawn until that is done.
  const modelsIn = bodyLoaded && (baseLoaded || !inBase(net.me.x, net.me.y, net.me.z, 2)) && terrain.built;
  loaded ||= coverTimedOut || warmed;
  // Behind the loading screen, draw at about 15 fps so the page has time for the game on it (src/yield.ts).
  if (!loaded && time - lastLoadFrame < LOADING_FRAME_MS) return;
  lastLoadFrame = time;
  if (loaded && prologue.told() && coverFrames < 3 && ++coverFrames === 3) {
    cover.style.opacity = '0';
    setTimeout(() => (prologue.stop(), cover.remove()), 500);
    names.loaded();
  }
  if (faceCrash) {
    faceCrash = false;
    const near = crashSitesNear(net.me.x, net.me.z, 200);
    const site = LAB ? LAB_LOOK : spawnAt === 'field' ? near.find((s) => s.level === 0) : near.find((s) => s.level > 0)?.machines[0];
    if (site) orbit.yaw = Math.atan2(-(site.x - net.me.x), -(site.z - net.me.z));
  }
  resolution.update(frameDt);

  // Fixed-step simulation: identical DT on client and server keeps prediction in agreement.
  accumulator += frameDt;
  teardown.watch(net.me); // walking far enough away from a machine ends the disassembly
  // Flying the camera, the body stands where it was, facing the way it did.
  if (fly.active) {
    orbit.yaw = fly.heldYaw;
    orbit.pitch = fly.heldPitch;
  }
  const input = !net.isReady || fly.active ? 0 : readInput(); // standing still until named
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
  me.setOutfit(inHand?.kind ?? null, wornGear(net.boxes.equip) | carriedGear(net.boxes.bag, tools.slot), gearTiers(net.boxes.equip, net.boxes.bag, tools.slot));
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
      scene.add(a.root);
      // Placeholder until the rigged scavenger has loaded, then swap it in.
      const model = new ScavengerModel(r.color);
      model.ready.then(
        () => (remotes.get(r.id) === a ? a.setModel(model, r.color) : model.dispose()),
        () => model.dispose(),
      );
    }
    avatar.setLabel(net.names.get(r.id) || `#${r.id}`, r.color);
    avatar.showLabel(!(fly.active && fly.clean));
    avatar.setOutfit(r.item, r.gear, r.tiers);
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
  if (orbit.down !== (net.down !== null)) {
    document.body.classList.toggle('down', (orbit.down = net.down !== null));
    if (!orbit.down) speech.event('respawn', undefined);
  }
  telescope.update(frameDt, spyglassZoom(Math.max(0, quality(inHand))));
  const hands = !s.riding && !net.down && !fly.active; // the tools work
  const fire = rifle.update(frameDt, { speed: Math.hypot(s.vx, s.vz), grounded: s.grounded, crouching: !!(s.crouching || s.sliding) }, hands);
  viewCull.begin();
  lootView.update(frameDt, net.loot, focus);
  shieldFx.update(frameDt, (id) => (id === net.id ? me.root.position : others.find((o) => o.id === id) ?? null));
  corpseView.update(frameDt, focus);
  orbit.update({ x: focus.x, y: focus.y, z: focus.z, vx: s.vx, vy: s.vy, vz: s.vz, grounded: s.grounded, sliding: s.sliding, crouching: s.crouching, riding: s.riding, heading: v.heading, lean: bikes.get(0)?.leanAngle }, frameDt);
  bossFx.update(net, frameDt, orbit.camera);
  bossBar.update(frameDt, bossFx.bar);
  guardianFx.update(net, frameDt, orbit.camera, focus);
  rifle.afterCamera(fire); // the aim's sway and recoil on the view, and the shot, against the walkers as just drawn
  // Flying, the camera leaves the body and the world streams in around it instead.
  if (fly.active) {
    fly.update(frameDt, orbit.camera);
    focus.copy(fly.pos);
  }
  thrower.update(frameDt, hands);
  grinder.update(frameDt, hands);
  jammer.update(frameDt, hands);
  jammer.others(others, orbit.camera.position); // others' jammers: their static
  receiver.update(frameDt, inHand, hands);
  // T: third person. On the bike the body is drawn in first person too (hands on the bars), minus the head.
  const bodyShown = orbit.showBody || riding || fly.active;
  if (bodyShown === bodyHidden) me.setShadowOnly((bodyHidden = !bodyShown));
  me.setHeadless(riding && !orbit.showBody && !fly.active);
  viewmodel.root.visible = bodyHidden;
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
  if (!LAB) {
    blownSand.update(frameDt, focus);
    dust.update(frameDt, orbit.camera.position);
  }
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
  crosshairRing(s.mounting > 0 && !net.down ? 1 - s.mounting / MOUNT_TICKS : null);
  engineSound.update(frameDt, s.riding || s.mounting > 0, s.grounded, Math.hypot(s.vx, s.vz), s.riding && (input & (FORWARD | BACK)) !== 0);
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
  const placing = placer.update(survival.slot, net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch), true, (t) => hud.toast(t));
  const bed = net.connected && station < 0 ? bedTarget(net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch), placed) : null;
  const bedState = bed ? net.garden.get(bed.id) : undefined;
  const stage = bed ? (bedState?.stage ?? EMPTY) : -1;
  const tend = stage === EMPTY ? TEXT.prompt.plantSeeds : stage === GROWN ? TEXT.prompt.harvest : null;
  // Sprouts grow only under a UV lamp (shared/garden.ts).
  const growing = stage === SPROUTS && bed ? (bedLit(bed) ? `<span>${Math.round((bedState?.grow ?? 0) * 100)}%</span>` : `<span class="bad">${TEXT.prompt.needsUvLamp}</span>`) : null;
  const target = net.connected && station < 0 && !bed ? scrapTarget(net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch)) : null;
  // Debris at the crash sites (hull plates, pipes, ...) is picked up as what it gives: scrap or cloth (shared/items.ts debrisItem).
  const debris = net.connected && station < 0 && !bed && !target ? debrisTarget(net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch)) : null;
  const debrisPrompt = debris ? TEXT.prompt.pickUp(itemLabel(debrisItem(CRASH_KINDS[debris.kind].node))) : null;
  const find = net.connected && station < 0 && !bed && !target && !debris ? lootView.target(net.me, orbit.yaw) : null;
  const findPrompt = find ? lootPrompt(find, itemLabel) : null;
  // Machines at the crash sites: a small one is picked up (it goes in the bag); a large one is taken apart where
  // it lies. A carried one is taken apart on the base's disassembly table.
  const nearSite = net.connected && station < 0 && !bed && !target && !debris && !find ? machines.nearest(net.me.x, net.me.z) : null;
  const small = nearSite ? junkSpec(nearSite.site.kind).carry && !nearSite.site.lab : false;
  // A small one is picked up with F; a big one starts its disassembly by itself when you come close (src/teardown).
  const site = small ? nearSite : null;
  if (nearSite && !small && !teardown.active) teardown.begin(machines.workSite(nearSite, net.siteLink(nearSite.site.id)));
  // Salvage wrecks (src/world/wrecks.ts) are always carried home.
  const wreck = net.connected && station < 0 && !bed && !target && !debris && !site ? wrecks.nearest(net.me.x, net.me.z) : null;
  const sitePrompt = site ? (small ? TEXT.prompt.pickUp(junkSpec(site.site.kind).label) : TEXT.prompt.disassemble(junkSpec(site.site.kind).label))
    : wreck ? TEXT.prompt.pickUp(SALVAGE[wreck.kind].label) : null;
  const table = station >= 0 && STATIONS[station].kind === 'disassembly' ? machines.bench.offer(net.boxes.bag) : null;
  const use = station < 0 ? null : STATIONS[station].kind === 'workbench' ? TEXT.prompt.useWorkbench : (table?.label ?? TEXT.prompt.useTable);
  // A dead player's pack (shared/corpse.ts) lying here: F opens it next to the bag, like a chest.
  const pack = net.connected && !net.down && station < 0 && !bed && !target && !debris && !find && !site && !wreck
    && corpsesNear(net.me).some((b) => net.boxes[b]);
  // The base's chest in reach (shared/storage.ts): F opens it next to the bag.
  const chest = net.connected && !net.down && station < 0 && !bed && !target && !debris && !find && !site && !wreck && !pack
    && openBoxes(net.me).some((b) => b.startsWith('chest') && net.boxes[b]);
  const packPrompt = pack ? TEXT.prompt.openPack : chest ? TEXT.prompt.openChest : null;
  // A piece that came off a machine and lies by you can be picked up to be turned and taken apart in the hands; F again sets it down.
  const pieceHere = teardown.active && !teardown.holding ? teardown.pieceNear(net.me) : null;
  const piecePrompt = teardown.holding ? TEXT.prompt.putDown : pieceHere ? TEXT.prompt.pickUp(pieceHere.label) : null;
  const fPrompt = piecePrompt ?? use ?? tend ?? target ?? debrisPrompt ?? findPrompt ?? sitePrompt ?? packPrompt;
  const extra = [growing, placing.prompt].filter(Boolean).join(' ');
  hud.setTarget(fPrompt && extra && typeof fPrompt === 'string' ? `${kbd('interact')}${fPrompt} ${extra}` : (fPrompt ?? (extra || null)));
  const interact = takePickup() && !fly.active;
  if (interact && piecePrompt) {
    if (teardown.holding) teardown.putDown();
    else teardown.hold(pieceHere!.piece);
  } else if (interact && teardown.current?.id !== BENCH_ID) {
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
      } else hud.toast(TEXT.notice.nothingToTakeApart);
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
      net.crashTake(site.site.id);
    } else if (wreck) net.crashTake(wreck.id);
    else if (pack || chest) hud.open();
  }
  const targeted = piecePrompt !== null || use !== null || tend !== null || target !== null || debrisPrompt !== null || findPrompt !== null || sitePrompt !== null || packPrompt !== null;
  survival.update(frameDt, net.me, targeted, interact && !targeted, clockText(sky.day.tod));
  const w = net.water;
  const m = net.me;
  speech.update(frameDt, { day: sky.day.elevation > 0, indoors: indoors(m.x, m.y, m.z), shelter: inShelter(m.x, m.y, m.z),
    atPump: atWater(m.x, m.y, m.z), heat: survival.heatLevel, rising: w.rising, shade: w.shade, sips: w.sips, maxSips: w.maxSips,
    storm: storm.level, stormWarning: storm.warning, riding: s.riding, combat: guardianFx.combat, boss: bossFx.combat,
    bag: net.boxes.bag ?? [], dead: survival.dead || net.down !== null });
  if ((find?.id ?? null) !== seenFind) {
    seenFind = find?.id ?? null;
    if (find) speech.event('see', find);
  }
  const nearKey = site ? `m${site.site.id}` : wreck ? `w${wreck.id}` : null;
  if (nearKey !== seenSite) {
    seenSite = nearKey;
    if (site) speech.event('near', { kind: site.site.kind, carry: small });
    else if (wreck) speech.event('near', { kind: wreck.kind, carry: true });
  }
  if (net.boxes.bag) {
    for (const it of net.boxes.bag) if (it && bagIds && !bagIds.has(it.id)) speech.event('got', it);
    bagIds = new Set(net.boxes.bag.flatMap((it) => (it ? [it.id] : [])));
  }
  hud.update(net.me);

  const ri = renderer.info.render as { drawCalls?: number; calls?: number; triangles: number };
  statsGraph.visible = menu.statsOn;
  statsGraph.frame(ri.drawCalls ?? ri.calls ?? 0, ri.triangles / 1000);
  menu.setInfo(`${resolution.ratio.toFixed(2)}x · ${clockText(sky.day.tod)} · ${backendText} · ${net.status} · ${net.telemetry.text()} · ${others.length + (net.connected ? 1 : 0)} online · build ${__BUILD_SHA__}`);
  teardown.update(frameDt);
  if (loaded) {
    warm.finish();
    terrain.loading = false;
    renderer.info.reset();
    post.render();
  } else if (modelsIn && !warming) {
    // Everything sliceable is in: build the first frame's shaders, post passes included, a few materials per round
    // (src/warmup.ts) while the prologue on the loading screen keeps going.
    warming = true;
    warm.run(gpuIdle).then(() => {
      prologue.progress(1);
      warmed = true;
    });
  }
});
