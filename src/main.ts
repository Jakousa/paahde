import { viewCull } from './world/viewCull';
import { buildingBox, cargoBox, vehicleBox } from '../shared/boxes.ts';
import * as THREE from 'three/webgpu';
import { BACK, DT, FORWARD, isSlipFace, quantizeYaw } from '../shared/sim.ts';
import { EYE_HEIGHT, quantizePitch } from '../shared/dig.ts';
import { scrapTarget } from '../shared/scrap.ts';
import { allBeaten } from '../shared/bosses.ts';
import { BENCH, CALM, LAB, WORLD_ID } from '../shared/world.ts';
import { bedTarget, EMPTY, GROWN, SPROUTS } from '../shared/garden.ts';
import { bedLit, placed } from '../shared/placed.ts';
import { stationTarget } from '../shared/stations.ts';
import { isTableId, tableId } from '../shared/crash.ts';
import { FirstPersonCamera } from './camera';
import { BlownSand } from './blownSand';
import { Shelters } from './world/shelters';
import { addCrosshair } from './crosshair';
import { ShieldFx } from './shieldFx';
import { footprints, streaks, tyreprints } from './footprints';
import { InventoryHud, itemLabel } from './inventory';
import { stormAt } from '../shared/storm.ts';
import { addItem, debrisItem, SCRAP } from '../shared/items.ts';
import { kbd } from './bindings';
import { readInput, takePickup } from './input';
import { pollPad } from './gamepad';
import { LocatorBar } from './locator';
import { Menu } from './menu';
import { StatsGraph } from './statsGraph';
import { getBrowserId, Net } from './net';
import { Lives } from './lives';
import { landing, rememberWorld, victory } from './landing';
import { refused } from './lobby';
import { myLook as storedLook } from './profile';
import { loadScavenger, ScavengerModel } from './models/scavenger';
import { Avatar } from './players';
import { addHeadlights, Bike } from './bike';
import { tyreDust } from './tyreDust';
import { Post } from './post';
import * as env from './world/env';
import { glbMaterial } from './world/glbMaterial';
import { PlacedView } from './world/placed';
import { WireView } from './world/wires';
import { Wiring } from './wiring';
import { wires } from '../shared/wires.ts';
import { Placer } from './placing';
import { Scrap } from './world/scrap';
import { CrashSites } from './world/crashsites';
import { CrashSound } from './crashSound';
import { listen } from './echo';
import { tickEchoBus } from './acoustics';
import { coreCrashSites, crashSitesNear, debrisTarget } from '../shared/crashsites.ts';
import { CRASH_KINDS } from '../shared/crashKinds.ts';
import { Dust } from './world/dust';
import { clockText } from './world/dayNight';
import { DebugMenu } from './debugMenu.ts';
import { FlyCam } from './flyCam';
import { ArtBench } from './artBench';
import { BossFx } from './bosses';
import { Sky } from './world/sky';
import { Terrain } from './world/terrain';
import { wind } from './world/wind';
import { WindSound } from './windSound';
import { EngineSound } from './engineSound';
import { drinkSound } from './drinkSound';
import { grinderSound } from './grinderSound';
import { footsteps } from './footsteps';
import { bikeLandSound } from './bikeLandSound';
import { music } from './music';
import { uiSound } from './uiSound';
import { breathing } from './breathing';
import { slideSound } from './slideSound';
import { audio } from './audio';
import { heightAt } from '../shared/terrain.ts';
import { biome } from '../shared/biomes.ts';
import { indoors, inShelter, overShelter, sheltersNear } from '../shared/shelters.ts';
import { waterAt, WELL, wellAt, wellSpec } from '../shared/wells.ts';
import { wellSound } from './wellSound';
import { pickupSound } from './pickupSound';
import { DynamicResolution } from './resolution';
import { graphics, onGraphics } from './graphics';
import { autoGraphicsFrame } from './autoGraphics';
import { PERF_RUN, perf } from './perf';
import { statsPref } from './options';
import { playerHands, Survival } from './water';
import { StormFx } from './storm';
import { GasFx } from './gas';
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
import { MachineSites } from './world/crash';
import { BenchMenu } from './benchMenu';
import { BuildMenu } from './buildMenu';
import { machinesAt } from '../shared/crash.ts';
import { LAB_LOOK } from '../shared/lab.ts';
import { addLabPlates } from './world/labPlates';
import { labFloor } from './world/sandMaterial';
import { junkSpec, SALVAGE } from '../shared/salvage.ts';
import { bagShape, equipped, isBuilding, locatorRange, quality, repaired, spyglassZoom, stormWarnS } from '../shared/gear.ts';
import { carriedGear, gearTiers, wornGear } from '../shared/gearBits.ts';
import { LootView, lootPrompt } from './world/loot';
import { ownVehicleTargets, VehicleView } from './world/vehicles';
import { vehicles, vehicleTarget } from '../shared/vehicles.ts';
import { CorpseView, corpseTargets } from './world/corpses';
import { corpsesNear } from '../shared/corpse.ts';
import { openBoxes } from '../shared/storage.ts';
import { Chat } from './chat';
import { nameGate } from './name';
import { prologue } from './prologue';
import { tools } from './input';
import { Wrecks } from './world/wrecks';
import { Trophies } from './world/trophies';
import { ShipView } from './world/ship';
import { nearShip } from '../shared/ship.ts';
import { setTrophies } from '../shared/trophies.ts';
import { GuardianFx } from './guardians';
import { update } from './update';
import { LOADING_FRAME_MS, slice } from './yield';
import { Warmup } from './warmup';
import { TEXT } from '../shared/text.ts';

// WebGPURenderer uses WebGPU when available and falls back to WebGL2 otherwise.
// powerPreference asks for the discrete GPU (eGPU, laptop dGPU) over the integrated one when there is a choice.
perf.milestone('main-start');
// GPU timestamp queries (src/perf.ts) are only set up when stats were on at load, or for a benchmark run: they cost a readback a frame.
const gpuTimes = statsPref() || PERF_RUN;
const renderer = new THREE.WebGPURenderer({ antialias: graphics.antialias, powerPreference: 'high-performance', trackTimestamp: gpuTimes });
// (the stats line counts a whole frame: the shadow passes, the scene and the post passes, not just the last render call, which is a full-screen quad)
renderer.info.autoReset = false;
const resolution = new DynamicResolution(renderer); // sets the pixel ratio, then keeps it near 60 fps
resolution.setScale(graphics.resScale);
resolution.setDynamic(graphics.dynamicRes);
resolution.setTargetFps(graphics.fpsLimit || 60);
resolution.setMin(graphics.minRes);
onGraphics((g, changed) => {
  if (changed === 'resScale') resolution.setScale(g.resScale);
  if (changed === 'dynamicRes') resolution.setDynamic(g.dynamicRes);
  if (changed === 'minRes') resolution.setMin(g.minRes);
  if (changed === 'fpsLimit') resolution.setTargetFps(g.fpsLimit || 60);
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const orbit = new FirstPersonCamera(renderer.domElement);
await slice();
const fly = new FlyCam(renderer.domElement); // F3 → Fly camera, for shooting video
const sky = new Sky(scene);
sky.renderer = renderer;
await slice();
const terrain = new Terrain(scene);
if (LAB) {
  labFloor(); // the dev test lab (shared/lab.ts): a plain floor with name plates
  addLabPlates(scene);
}
await slice();
const trophies = new Trophies(scene); // a big piece of each beaten boss round the ship
await slice();
const ship = new ShipView(scene); // the crashed ship players arrive at
await slice();
const shelters = new Shelters(scene); // small empty bunkers out in the desert
await slice();
// Plant beds, UV lamps, the buildings, the work stations and the chests: in the shelters and out on the sand.
const placedView = new PlacedView(scene, (mt, where) => glbMaterial(mt, where === 'out' ? null : shelters.lit));
const wireView = new WireView(scene); // the power lines between them (shared/wires.ts)
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
const viewmodel = new ViewModel(orbit, scene); // first-person hands, parented to the camera
await slice();

const windSound = new WindSound();
await slice();
const engineSound = new EngineSound();
await slice();
const storm = new StormFx();
const gas = new GasFx();
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
// Debug handle for screenshots/tuning from the console: open with ?debug.
if (location.search.includes('debug')) {
  // crash: every crash site's id, centre, wreck kind and its machines (shared/crashsites.ts, shared/crash.ts).
  const crash = coreCrashSites().map((s) => ({ id: s.id, x: Math.round(s.x), z: Math.round(s.z), kind: s.pieces[0].kind, pieces: s.pieces.length, machines: machinesAt(s).map((m) => m.kind) }));
  Object.assign(window, { dbg: { orbit, sky, post, scene, renderer, env, terrain, scrap, wind, blownSand, dust, windSound, storm, gas, fly, viewmodel, crashSites, crashSound, crash, playerHands, machines, wrecks, teardown, placedView, guardianFx, bossFx } });
}

const net = new Net(getBrowserId());
const lives = new Lives();
net.onLives = (n, beaten) => {
  if (!CALM) rememberWorld(WORLD_ID);
  lives.set(n, beaten);
  trophies.set(beaten);
  setTrophies(beaten);
  if (allBeaten(beaten)) victory(WORLD_ID);
};
net.onEnded = (why) => (why === 'over' || why === 'missing' ? landing(why) : refused(why));
net.onScrapGot = (n, dropped) => teardown.gotScrap(n, dropped);
if (location.search.includes('debug')) Object.assign((window as unknown as { dbg: object }).dbg, { net });
// Machine progress (large sites and the disassembly table), from the server: every machine is kept up to date,
// and the one being worked on gets it through the disassembly mode, animated.
net.onSite = (m) => {
  const cur = teardown.current;
  machines.apply(m, cur?.id ?? null);
  // Someone scrapped the table's machine while we work on it (a finished one stays open until we leave).
  if (m.t === 'bench' && !m.job && cur?.id === m.id) teardown.end();
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
// Scrap the machine on the disassembly table, finished or not (what is still on it is destroyed and pays more), if the scrap fits in the bag.
const scrapBench = (at: string) => {
  const n = machines.tableMenu(at, net.boxes.bag).scrap;
  if (!addItem([...(net.boxes.bag ?? [])], SCRAP, n, () => 0, bagShape(net.boxes.equip))) return false;
  net.benchScrap(at);
  pickupSound.play();
  hud.toast(TEXT.notice.got(n, itemLabel(SCRAP)));
  return true;
};
const benchMenu = new BenchMenu(renderer.domElement);
const buildMenu = new BuildMenu(renderer.domElement); // the wrench's (src/placing.ts)
new DebugMenu(() => sky.day.tod, (tod) => net.shareTimeOfDay(tod), () => net.resetSharedTime(), (front) => net.summonStorm(front), (tier) => net.debugGear(tier), () => net.debugHit(), (what) => net.summonBot(what),
  (mode) => trophies.show(mode),
  (all) => (all ? net.labReset() : net.labReset(machines.nearestLab(net.me.x, net.me.z)?.site.id)),
  (off) => net.debugHeat(off),
  (off) => net.debugWeather(off),
  fly, () => fly.start(orbit.camera, orbit.yaw, orbit.pitch),
  (kind, n, tier) => net.debugGive(kind, n, tier));
// The art-style bench (?w=bench, dev only): fixed shots and the look panel (src/artBench.ts).
const artBench = BENCH ? new ArtBench({ fly, camera: orbit.camera, day: sky.day, post, blownSand, startFly: () => fly.start(orbit.camera, orbit.yaw, orbit.pitch) }) : null;
new Chat(net);
const names = nameGate(net, renderer.domElement);
// New builds wait for a quiet moment to reload (src/update.ts).
update.busy = () => fly.active || guardianFx.combat || bossFx.combat || net.me.riding || teardown.active || !!net.down;
const lootView = new LootView(scene);
const vehicleView = new VehicleView(scene); // motorcycles standing or lying in the world, nobody on them
const shieldFx = new ShieldFx(scene, () => orbit.camera.position, () => net.id, (m) => guardianFx.jolt(m));
net.onShieldBreak = (m) => shieldFx.play(m);
const corpseView = new CorpseView(scene);
addCrosshair();
loadScavenger().catch((e) => console.warn('scavenger model failed to load; keeping placeholders', e));
// Dark until the player model has loaded, so the first frames show no placeholder bodies; after 30 s, whatever has loaded.
const cover = document.getElementById('cover')!; // in index.html, so it is up before this script has loaded
// The bar: every model and texture through three's default loading manager (never runs backwards as more loads
// are queued), then the shaders being built (src/warmup.ts) for the last stretch.
const LOADS_SHARE = 0.6;
let coverP = 0;
let warmP = 0;
const coverProgress = () => prologue.progress(LOADS_SHARE * coverP + (1 - LOADS_SHARE) * warmP);
THREE.DefaultLoadingManager.onProgress = (_url, done, total) => {
  coverP = Math.max(coverP, done / total);
  coverProgress();
};
let loaded = false;
let coverFrames = 0; // frames drawn behind the cover once loaded (lets shaders compile)
let bodyLoaded = false;
let coverTimedOut = false;
loadScavenger().then(() => (bodyLoaded = true), () => (bodyLoaded = true));
setTimeout(() => (coverTimedOut = true), 30_000);
// What you wear (shared/look.ts), chosen on the main menu (src/lookView.ts); others get it with your 'hello'.
const myLook = storedLook();
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
guardianFx.onAggro = (kind) => speech.event('aggro', kind);
guardianFx.onKill = (kind) => speech.event('killed', kind);
bossFx.onKill = () => speech.event('killed', 'boss');
/** The find last looked at, so the character remarks on it once per look (src/speechLines.ts 'see'). */
let seenFind: number | null = null;
/** The vehicle (id and whether it works) we last looked at, for the speech. */
let seenVehicle: string | null = null;
/** The machine or wreck last in reach ('near'), and the item ids in the bag at the last frame ('got'; null until the
 *  bag first arrives: what we log in with is old news). */
let seenSite: string | null = null;
let bagIds: Set<number> | null = null;
const menu = new Menu(renderer.domElement, (v) => post.setAoIntensity(v));
const telescope = new Telescope(orbit);
if (location.search.includes('debug')) Object.assign((window as unknown as { dbg: object }).dbg, { telescope });
const grinder = new Grinder(scene, orbit.camera, [me.root]);
const jammer = new Jammer(orbit, net, guardianFx.jets, guardianFx.drones);
const receiver = new Receiver(orbit, net);
const bossBar = new BossBar();
if (location.search.includes('debug')) Object.assign((window as unknown as { dbg: object }).dbg, { jammer });
// The beam starts at the drawn gun: the first-person one, or in third person the one in the body's hand.
const rifle = new Rifle(orbit, net, guardianFx.guardians, guardianFx.drones, guardianFx.jets, guardianFx.harvesters,
  (out) => viewmodel.muzzle(out) ?? (orbit.showBody && me.muzzle(out) ? out : null));
rifle.remoteMuzzle = (id, out) => (remotes.get(id)?.muzzle(out) ? out : null);
scene.add(zaps.root);
zaps.setCamera(orbit.camera);
const thrower = new Thrower(scene, orbit, net, scrap);
thrower.piece = () => viewmodel.scrapPiece(); // the piece in flight is the one drawn in the hand
if (location.search.includes('debug')) Object.assign((window as unknown as { dbg: object }).dbg, { rifle, zaps });
net.onPlaced = () => {
  placedView.sync(placed, net.garden);
  wireView.sync(wires);
};
net.onVehicles = () => hud.vehiclesChanged();
net.onPower = () => {
  placedView.setPower(net.power);
  hud.powerChanged();
};
net.onNotice = (text) => {
  if (text === TEXT.notice.bagFull) { // the server refused a find (server/world.ts)
    uiSound.full();
    speech.event('bagFull', undefined);
  }
  hud.toast(text);
};
/** At an electric well that doesn't run (shared/wells.ts), and why: its pump's parts, or its power. */
function dryWell(m: { x: number; y: number; z: number }): 'parts' | 'power' | null {
  if (waterAt(m.x, m.y, m.z)) return null;
  const w = wellAt(m.x, m.y, m.z, 0, placed, true);
  return w ? (wellSpec(w.parts) ? 'power' : 'parts') : null;
}

function bagFull() {
  hud.toast(TEXT.notice.bagFull);
  uiSound.full();
  speech.event('bagFull', undefined);
}
const placer = new Placer(net, placedView, buildMenu);
const wiring = new Wiring(net, wireView);

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
perf.gpuTracked = gpuTimes && !!(renderer.backend as { trackTimestamp?: boolean }).trackTimestamp;
perf.describe({ backend, gpu: gpuName, gpuTimestamps: perf.gpuTracked, world: WORLD_ID });
sky.heights.init(renderer); // (before any material samples the dune-shadow grids: src/world/heightShadow.ts)
perf.milestone('renderer-ready');
perf.scene = scene;
if (PERF_RUN) Object.assign(window, { __dbg: { renderer, sky, net, terrain, scene, THREE, heightAt } }); // (tools/perf.ts --eval)
perf.onDone = () => {
  // (for the pictures tools/perf.ts takes: look away from the sun, a little down, where the shadows fall; `&pview=<m>` lifts the camera
  // that high above the player, on the fly camera, without the HUD, to see the shadows over a wide stretch)
  const l = sky.heights.light.value;
  orbit.yaw = Math.atan2(l.x, l.z) + (new URLSearchParams(location.search).get('pface') === 'sun' ? Math.PI : 0); // (`&pface=sun`: into the sun)
  orbit.pitch = -0.12;
  const lift = Number(new URLSearchParams(location.search).get('pview'));
  if (lift > 0) {
    fly.start(orbit.camera, orbit.yaw, orbit.pitch);
    fly.setClean(true);
    const pitch = Number(new URLSearchParams(location.search).get('ppitch')); // (degrees down; default a gentle look over the land)
    fly.place(new THREE.Vector3(net.me.x, net.me.y + lift, net.me.z), orbit.yaw, pitch ? (-pitch * Math.PI) / 180 : -Math.atan2(lift, lift * 6));
  }
};
perf.setTod = (tod) => net.shareTimeOfDay(tod);
perf.player = () => ({ x: net.me.x, z: net.me.z, down: survival.dead || net.down !== null, heat: survival.heatLevel });
perf.cascades = () => sky.csm.lights.map((l) => l.shadow!.camera);

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

/** When the next frame is due, with the FPS target (Options → Graphics): frames before it are skipped. */
let nextFrameAt = 0;
let undergroundFrame = 0;
renderer.setAnimationLoop((time) => {
  if (graphics.fpsLimit) {
    const every = 1000 / graphics.fpsLimit;
    if (time < nextFrameAt - 1) return;
    nextFrameAt = time - nextFrameAt > every ? time + every : nextFrameAt + every; // keeps the average on target; no catching up after a stall
  }
  perf.frameStart();
  net.telemetry.frame(performance.now());
  timer.update(time);
  const frameDt = Math.min(timer.getDelta(), 0.25);
  if (!joined && !net.connected) {
    return;
  }
  if (!joined) prologue.joined();
  joined = true;
  artBench?.frame(frameDt); // (from the first frame on, so the world streams in round the shot behind the loading screen)
  perf.milestone('joined');
  // Once the models and terrain are in, draw real frames a few materials at a time (src/warmup.ts): the first full
  // frame would take seconds to build every shader and freeze the page. Nothing else is drawn until that is done.
  const modelsIn = bodyLoaded && terrain.built;
  if (modelsIn) perf.milestone('models-in');
  loaded ||= coverTimedOut || warmed;
  if (loaded) perf.milestone('loaded');
  // Behind the loading screen, draw at about 15 fps so the page has time for the game on it (src/yield.ts).
  if (!loaded && time - lastLoadFrame < LOADING_FRAME_MS) return;
  lastLoadFrame = time;
  if (loaded && prologue.told() && coverFrames < 3 && ++coverFrames === 3) {
    cover.style.opacity = '0';
    setTimeout(() => (prologue.stop(), cover.remove(), perf.milestone('cover-gone')), 500);
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
  pollPad(frameDt, orbit, renderer.domElement, net.boxes.bag);
  const input = !net.isReady || fly.active ? 0 : readInput(); // standing still until named
  while (accumulator >= DT) {
    net.tick(input, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch));
    accumulator -= DT;
  }

  const others = net.frame(frameDt);
  // The gun raised (or just fired), or the spyglass: others see it shouldered, or at the eye (src/models/scavenger.ts).
  const aiming = playerHands.aim > 0.5 || playerHands.looking;
  net.setHands(playerHands.held, playerHands.drinking, playerHands.filling, aiming, playerHands.grinding);

  me.setColor(net.color);
  me.setLook(myLook);
  const s = net.me;
  // Drawn between the last two ticks (the leftover accumulator), so motion is even at any frame rate.
  const v = net.view(accumulator / DT);
  // On the bike the camera turns with it; the mouse still looks around on top.
  if (s.riding && Number.isFinite(lastHeading)) orbit.yaw += Math.atan2(Math.sin(v.heading - lastHeading), Math.cos(v.heading - lastHeading));
  lastHeading = s.riding ? v.heading : NaN;
  // What's in hand (the selected hotbar slot) and worn (shared/gear.ts): drawn on the body, and sets what the tools can do.
  const inHand = tools.slot >= 0 ? net.boxes.bag?.[tools.slot] : null;
  me.setOutfit(inHand?.kind ?? null, wornGear(net.boxes.equip) | carriedGear(net.boxes.bag, tools.slot), gearTiers(net.boxes.equip, net.boxes.bag, tools.slot));
  const riding = ride(0, me, { ...s, x: v.x, y: v.y, z: v.z, heading: v.heading, nose: v.nose, pitch: orbit.pitch }, frameDt);
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
    avatar.setLook(r.look);
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
    if (!orbit.down) {
      speech.event('respawn', undefined);
      gas.respawned();
    }
  }
  telescope.update(frameDt, spyglassZoom(Math.max(0, quality(inHand))));
  const hands = !s.riding && !net.down && !fly.active; // the tools work
  const fire = rifle.update(frameDt, { speed: Math.hypot(s.vx, s.vz), grounded: s.grounded, crouching: !!(s.crouching || s.sliding) }, hands);
  viewCull.begin();
  lootView.update(frameDt, net.loot, focus);
  vehicleView.update(vehicles, net.myVehicles, focus, (id) => (id === net.id ? net.me.riding : others.find((o) => o.id === id)?.riding ?? false));
  shieldFx.update(frameDt, (id) => (id === net.id ? me.root.position : others.find((o) => o.id === id) ?? null));
  corpseView.update(frameDt, focus);
  orbit.update({ x: focus.x, y: focus.y, z: focus.z, vx: s.vx, vy: s.vy, vz: s.vz, grounded: s.grounded, sliding: s.sliding, crouching: s.crouching, riding: s.riding, heading: v.heading, lean: bikes.get(0)?.leanAngle }, frameDt);
  bossFx.update(net, frameDt, orbit.camera);
  bossBar.update(frameDt, bossFx.bar);
  guardianFx.update(net, frameDt, orbit.camera, focus);
  rifle.afterCamera(fire); // the aim's sway and recoil on the view, and the shot, against the walkers as just drawn
  telescope.afterCamera(frameDt, others);
  // Flying, the camera leaves the body and the world streams in around it instead.
  if (fly.active) {
    fly.update(frameDt, orbit.camera);
    focus.copy(fly.pos);
  }
  thrower.update(frameDt, hands);
  grinder.update(frameDt, hands);
  jammer.update(frameDt, hands && !storm.toolsDown); // dead in a storm's static (storm.update is later: last frame's)
  jammer.others(others, orbit.camera.position); // others' jammers: their static
  receiver.update(frameDt, inHand, hands, storm.toolsDown);
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
  storm.update(frameDt, net.storms, net.serverTime(), orbit.camera.position, net.me, belt ? stormWarnS(quality(belt)) : 0, survival.dead || net.down !== null);
  gas.update(frameDt, net.gas, net.serverTime(), orbit.camera.position, net.me, survival.dead || net.down !== null);
  // The locator comes with the wrist computer; a better one shows players further away.
  const wrist = equipped(net.boxes.equip, 'wrist');
  const range = wrist ? locatorRange(quality(wrist)) : 0;
  locator.lost = storm.toolsDown || !wrist;
  locator.bedroll = net.bedroll;
  survival.toolsDown = storm.toolsDown;
  locator.update(orbit.camera, orbit.viewYaw, orbit.pitch + orbit.freePitch, focus, [...others.filter((o) => Math.hypot(o.x - focus.x, o.z - focus.z) < range), ...wrecks.targets(focus.x, focus.z), ...corpseTargets(), ...ownVehicleTargets(net.myVehicles, net.color)]);
  terrain.update(focus);
  scrap.update(focus);
  crashSites.update(focus);
  ship.update(time / 1000);
  machines.update(focus);
  wrecks.update(focus);
  // The terrain casts into the shadow maps only near the underground places it roofs (src/world/heightShadow.ts does the dunes).
  terrain.setCasting(overShelter(focus.x, focus.z, 60));
  if (++undergroundFrame % 60 === 1) {
    // the rooms the dune shadows must not reach (src/world/heightShadow.ts): the nearest shelters, below their huts' floors
    const near = sheltersNear(focus.x, focus.z, 800).sort((a, b) => Math.hypot(a.x - focus.x, a.z - focus.z) - Math.hypot(b.x - focus.x, b.z - focus.z));
    sky.heights.setUnderground(near.slice(0, 4).map((s) => ({ x: s.x, z: s.z, r: 32, top: s.y - 0.3 })));
  }
  sky.update(frameDt, focus, orbit.camera, net.worldTime());
  wind.update(net.serverTime() / 1000);
  if (!LAB) {
    blownSand.update(frameDt, focus);
    dust.update(frameDt, orbit.camera.position);
  }
  tyreDust.update(frameDt);
  shelters.update(orbit.camera.position);
  windSound.update(frameDt, orbit.camera.position, orbit.viewYaw, s);
  // Sand hissing under you: a speed slide, or (softer) slipping down a slip face on your feet.
  const ownSpeed = Math.hypot(s.vx, s.vz);
  slideSound.update(frameDt, !s.grounded || s.riding || net.down ? 0 : s.sliding ? 1 : ownSpeed > 2 && isSlipFace(s.x, s.z) ? 0.5 : 0, ownSpeed);
  engineSound.update(frameDt, s.riding, s.grounded, Math.hypot(s.vx, s.vz), s.riding && (input & (FORWARD | BACK)) !== 0, s.bike);
  engineSound.updateRemotes(frameDt, others, orbit.camera.position, s);
  drinkSound.remotes(others, orbit.camera.position);
  grinderSound.remotes(frameDt, others, orbit.camera.position);
  footsteps.listener(orbit.camera.position, orbit.viewYaw);
  bikeLandSound.listener(orbit.camera.position, orbit.viewYaw);
  breathing.update(survival.heatLevel, survival.dead);
  audio.setMuffled(survival.dead); // the world goes dull while you lie dead; the music doesn't
  const cam = orbit.camera.position;
  music.update(frameDt, {
    indoors: indoors(cam.x, cam.y, cam.z),
    sandstorm: storm.level > 0.3,
    epic: guardianFx.epic || bossFx.combat,
    combat: guardianFx.combat,
    dead: survival.dead,
    // The sun coming up: from 2° under the horizon to 8° over it (about a minute).
    sunrise: sky.day.tod < 0.5 && sky.day.elevation > -0.035 && sky.day.elevation < 0.14,
  });
  crashSound.update(orbit.camera.position, orbit.viewYaw);
  listen(orbit.camera.position);
  tickEchoBus();
  placedView.update(frameDt, net.worldTime(), (x, z) => stormAt(net.storms, x, z, net.serverTime()), survival.fillingWell);
  const ear = orbit.camera.position;
  wellSound.update(placedView.nearestWell(ear, 30), ear, survival.fillingWell !== null);
  // F: use the work station in view, else tend the plant bed in view (planted beds can't be touched
  // while they grow), else pick up scrap, else (canteen out, at the pump) fill the canteen.
  const station = net.connected ? stationTarget(net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch)) : null;
  // Placing from the hotbar, building with the wrench and G to pick placed things up (src/placing.ts); its prompt goes after F's.
  const placing = placer.update(survival.slot, net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch), true, (t) => hud.toast(t));
  // A building in view (the windmill, the battery station): F opens it next to the bag, to swap its parts. At a running
  // well's tap with the water bottle out, F fills the bottle instead (src/water.ts).
  const atTap = playerHands.held === 'canteen' && placing.target?.kind === WELL && !!waterAt(net.me.x, net.me.y, net.me.z);
  const building = !station && placing.target && isBuilding(placing.target.kind) && !atTap ? placing.target : null;
  const buildingPrompt = building ? TEXT.prompt.open(itemLabel(building.kind)) : null;
  // A motorcycle in view (shared/vehicles.ts): F repairs a broken one (its part slots next to the bag), gets on a
  // working one, or opens its cargo from the back. On the bike, F gets off.
  const onBike = s.riding;
  const vehicle = net.connected && !net.down && !onBike && !station && !building
    ? vehicleTarget(net.me, orbit.yaw, orbit.pitch) : null;
  const ridePrompt = !vehicle ? null : !vehicle.v.up ? TEXT.prompt.repair(itemLabel(vehicle.v.kind))
    : vehicle.rear ? TEXT.prompt.open(TEXT.boxes.cargo) : TEXT.prompt.getOn;
  const bed = net.connected && !station ? bedTarget(net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch), placed) : null;
  const bedState = bed ? net.garden.get(bed.id) : undefined;
  const stage = bed ? (bedState?.stage ?? EMPTY) : -1;
  const tend = stage === EMPTY ? TEXT.prompt.plantSeeds : stage === GROWN ? TEXT.prompt.harvest : null;
  // Sprouts grow only under a UV lamp (shared/garden.ts).
  const growing = stage === SPROUTS && bed ? (bedLit(bed) ? `<span>${Math.round((bedState?.grow ?? 0) * 100)}%</span>` : `<span class="bad">${TEXT.prompt.needsUvLamp}</span>`) : null;
  const target = net.connected && !station && !bed ? scrapTarget(net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch)) : null;
  // Debris at the crash sites (hull plates, pipes, ...) is picked up as what it gives: scrap or cloth (shared/items.ts debrisItem).
  const debris = net.connected && !station && !bed && !target ? debrisTarget(net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch)) : null;
  const debrisPrompt = debris ? TEXT.prompt.pickUp(itemLabel(debrisItem(CRASH_KINDS[debris.kind].node))) : null;
  const find = net.connected && !station && !bed && !target && !debris ? lootView.target(net.me, orbit.yaw) : null;
  const findPrompt = find ? lootPrompt(find, itemLabel) : null;
  // Machines at the crash sites: a small one is picked up (it goes in the bag); a large one is taken apart where
  // it lies. A carried one is taken apart on a dismantling bench.
  const nearSite = net.connected && !station && !bed && !target && !debris && !find ? machines.nearest(net.me.x, net.me.z) : null;
  const small = nearSite ? junkSpec(nearSite.site.kind).carry && !nearSite.site.lab : false;
  // A small one is picked up with F; a big one starts its disassembly by itself when you come close (src/teardown).
  const site = small ? nearSite : null;
  if (nearSite && !small && !teardown.active) teardown.begin(machines.workSite(nearSite, net.siteLink(nearSite.site.id)));
  // A machine on the disassembly table is worked like a big one: it starts by itself when you stand at the table.
  if (!teardown.active && !benchMenu.isOpen && net.connected) {
    const b = machines.benchNear(net.me.x, net.me.z, 3.5);
    const job = b?.site(net.siteLink(b.id), () => scrapBench(b.id));
    if (job) teardown.begin(job);
  }
  // Its frame was scrapped (by us or someone else) while we work on it: it is gone.
  if (teardown.current && !isTableId(teardown.current.id) && machines.isSpent(teardown.current.id)) teardown.end();
  // Close to a machine that is not being worked (a small one to carry home): its steps and parts, as when working it.
  teardown.setNear(site?.junk ? { label: junkSpec(site.site.kind).label, steps: site.junk.steps.filter((s) => !s.done).length, parts: site.junk.slots.filter((s) => !s.taken).length, scrap: false } : null);
  // Salvage wrecks (src/world/wrecks.ts) are always carried home.
  const wreck = net.connected && !station && !bed && !target && !debris && !site ? wrecks.nearest(net.me.x, net.me.z) : null;
  const sitePrompt = site ? (small ? TEXT.prompt.pickUp(junkSpec(site.site.kind).label) : TEXT.prompt.disassemble(junkSpec(site.site.kind).label))
    : wreck ? TEXT.prompt.pickUp(SALVAGE[wreck.kind].label) : null;
  const tableAt = station?.kind === 'disassembly' ? tableId(station.placed) : null;
  const table = tableAt ? machines.tableMenu(tableAt, net.boxes.bag) : null;
  const use = !station ? null : station.kind === 'workbench' ? TEXT.prompt.useWorkbench : TEXT.prompt.useTable;
  // A dead player's pack (shared/corpse.ts) lying here: F opens it next to the bag, like a chest.
  const pack = net.connected && !net.down && !station && !bed && !target && !debris && !find && !site && !wreck
    && corpsesNear(net.me).some((b) => net.boxes[b]);
  // A chest in reach (shared/storage.ts): F opens it next to the bag.
  const chest = net.connected && !net.down && !station && !bed && !target && !debris && !find && !site && !wreck && !pack
    && openBoxes(net.me).some((b) => b.startsWith('store') && net.boxes[b]);
  const packPrompt = pack ? TEXT.prompt.openPack : chest ? TEXT.prompt.openChest : null;
  // A piece that came off a machine and lies by you can be picked up to be turned and taken apart in the hands; F again sets it down.
  const pieceHere = teardown.active && !teardown.holding ? teardown.pieceNear(net.me) : null;
  const piecePrompt = teardown.holding ? TEXT.prompt.putDown : pieceHere ? TEXT.prompt.pickUp(pieceHere.label) : null;
  const fPrompt = piecePrompt ?? use ?? buildingPrompt ?? ridePrompt ?? tend ?? target ?? debrisPrompt ?? findPrompt ?? sitePrompt ?? packPrompt;
  // A wiring coil in hand: stringing power lines between connectors (src/wiring.ts).
  const wirePrompt = wiring.update(survival.slot, net.me, quantizeYaw(orbit.yaw), quantizePitch(orbit.pitch), !net.down && !fly.active, (t) => hud.toast(t));
  const extra = [growing, wirePrompt, placing.prompt].filter(Boolean).join(' ');
  hud.setTarget(fPrompt && extra && typeof fPrompt === 'string' ? `${kbd('interact')}${fPrompt} ${extra}` : (fPrompt ?? (extra || null)));
  const interact = takePickup() && !fly.active;
  if (interact && onBike) tools.getOff = true; // (src/input.ts: the bike key's input, one tick)
  else if (interact && piecePrompt) {
    if (teardown.holding) teardown.putDown();
    else teardown.hold(pieceHere!.piece);
  } else if (interact) {
    if (use) {
      if (station!.kind === 'workbench') hud.open();
      else if (table && (table.job || table.kinds.length)) {
        benchMenu.open({
          job: table.job,
          kinds: table.kinds,
          place: (kind) => net.crashUse(tableAt!, kind),
          scrap: () => (teardown.current?.id === tableAt ? teardown.scrap() : scrapBench(tableAt!)),
        });
      } else hud.toast(TEXT.notice.nothingToTakeApart);
    } else if (building) hud.open(buildingBox(building.id));
    else if (vehicle) {
      if (!vehicle.v.up) hud.open(vehicleBox(vehicle.v.id));
      else if (vehicle.rear) hud.open(cargoBox(vehicle.v.id));
      else net.mount(vehicle.v.id);
    }
    else if (tend && bed) net.tend(bed.id);
    else if (target) {
      if (net.pickup(target)) pickupSound.play();
      else bagFull();
    } else if (debris) {
      if (net.debrisTake(debris)) pickupSound.play();
      else bagFull();
    } else if (find) {
      if (net.lootTake(find.id)) pickupSound.play();
      else bagFull();
    } else if (site) {
      net.crashTake(site.site.id);
    } else if (wreck) net.crashTake(wreck.id);
    else if (pack || chest) hud.open();
  }
  const targeted = piecePrompt !== null || use !== null || buildingPrompt !== null || ridePrompt !== null || tend !== null || target !== null || debrisPrompt !== null || findPrompt !== null || sitePrompt !== null || packPrompt !== null;
  survival.update(frameDt, net.me, targeted, interact && !targeted, clockText(sky.day.tod));
  const w = net.water;
  const m = net.me;
  speech.update(frameDt, { day: sky.day.elevation > 0, indoors: indoors(m.x, m.y, m.z), shelter: inShelter(m.x, m.y, m.z),
    atPump: !!waterAt(m.x, m.y, m.z), dryWell: dryWell(m), mudflat: biome('mudflat', m.x, m.z) > 0.7, heat: survival.heatLevel, rising: w.rising, shade: w.shade, sips: w.sips, maxSips: w.maxSips,
    storm: storm.level, stormWarning: storm.warning, frontComing: storm.frontComing, choking: storm.choking, lee: storm.lee, gasComing: gas.coming, gassed: gas.gassing, riding: s.riding, boss: bossFx.combat,
    bag: net.boxes.bag ?? [], dead: survival.dead || net.down !== null, atShip: nearShip(m.x, m.z, 6) });
  const vehicleKey = vehicle ? `${vehicle.v.id}:${vehicle.v.up}` : null;
  if (vehicleKey !== seenVehicle) {
    seenVehicle = vehicleKey;
    if (vehicle) speech.event('vehicle', vehicle.v);
  }
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
  perf.collect = menu.statsOn || PERF_RUN;
  statsGraph.frame(ri.drawCalls ?? ri.calls ?? 0, ri.triangles / 1000, graphics.dynamicRes ? resolution.ratio : undefined, perf.last.cpu, perf.gpuTracked ? (perf.last.gpu ?? undefined) : undefined);
  if (menu.statsOn) {
    statsGraph.info([
      ...(graphics.dynamicRes ? [] : [`${resolution.ratio.toFixed(2)}x`]), // (adaptive: the scale line shows it)
      clockText(sky.day.tod), backendText, net.status, net.telemetry.text(), `${others.length + (net.connected ? 1 : 0)} online`, `build ${__BUILD_SHA__}`,
    ]);
  }
  teardown.update(frameDt);
  if (loaded) {
    warm.finish();
    terrain.loading = false;
    renderer.info.reset();
    perf.submitStart();
    post.render();
    perf.submitEnd(renderer);
  } else if (warming) {
    warmP = warm.progress;
    coverProgress();
  } else if (modelsIn) {
    // Everything sliceable is in: build the first frame's shaders, post passes included, a few materials per round
    // (src/warmup.ts) while the prologue on the loading screen keeps going.
    warming = true;
    perf.milestone('warmup-start');
    warm.run(gpuIdle).then(() => {
      coverP = warmP = 1;
      coverProgress();
      warmed = true;
      perf.milestone('warmed');
    });
  }
  if (PERF_RUN || BENCH) document.getElementById('name')?.querySelector<HTMLElement>('.skip')?.click(); // (a benchmark, or the art bench, answers the name box itself)
  perf.frameEnd(ri.drawCalls ?? ri.calls ?? 0, ri.triangles / 1000, resolution.ratio, loaded && coverFrames >= 3 && !document.getElementById('cover') && !document.getElementById('name'), frameDt, (rad) => (orbit.yaw += rad));
  autoGraphicsFrame(frameDt, perf.last.cpu, resolution.ratio / Math.min(devicePixelRatio, graphics.resScale), resolution.pixelBound,
    loaded && coverFrames >= 3 && !document.hidden && !menu.open && !net.down && net.isReady && !document.getElementById('cover'));
});
