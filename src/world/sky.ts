// Sky, sun and scene lighting: TSL sky dome (dusky zenith → hot orange horizon, huge HDR sun disc with
// Mie halo), orange aerial-perspective fog, the shadow-casting sun light and a warm rust ambient fill.
// dayNight.ts moves the sun and moon and recolours all of it through the day; at night the moon takes
// over the shadow-casting light.
//
// Sun shadows are cascaded shadow maps (parallel-split, Zhang et al. 2006; cascades.ts): the
// view out to the shadow distance is cut into slices by distance and each slice gets its own 2048² map fitted to
// it, so a player's shadow at your feet is a few cm per texel while a dune 1 km away still casts its
// 200 m shadow. Terrain casts too. Biases are set per cascade in world units, scaled to its texel size.
import * as THREE from 'three/webgpu';
import { cameraPosition, fog, min, normalize, positionWorld, vec3 } from 'three/tsl';
import { MAX_FOV } from '../camera.ts';
import { cascadeEnds, graphics, onGraphics, startup } from '../graphics.ts';
import { CascadedShadows } from './cascades.ts';
import { setShadowNoiseAxes, wideShadowFilter } from './shadowFilter.ts';
import { DayNight } from './dayNight.ts';
import { NightSky, nightSky } from './nightSky.ts';
import { hazeColorFor, hazeFactor, moonColor, moonDirection, moonDisc, sandStorm, SHADOW_ONLY_LAYER, skyRadiance, sunColor, sunDirection, sunDisc, sunLight, time } from './env.ts';

/** Sun elevation (radians) below which the moon is the shadow-casting light. Both are ~dark here. */
const MOON_TAKES_OVER = THREE.MathUtils.degToRad(-3);
/** Far end of each cascade (m from the camera), from the graphics options. Past the last one the haze is ~95%, so no shadows. */
// (Dev experiments for the GPU cost: `?cascades=1..3` uses fewer, `?shadows=0` none.)
const QUERY = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
const CASCADES = Math.min(4, Math.max(1, Number(QUERY.get('cascades')) || startup.cascades));
const CASCADE_ENDS = cascadeEnds(graphics.shadowDistance, CASCADES);
const SHADOW_MAP = startup.shadowMap; // per cascade; 2048 looked crisper but cost GPU time on every frame
/** How far sunwards of a slice casters are still drawn: a 30 m crest at 10° throws a ~170 m shadow. */
const LIGHT_MARGIN = 300;
/** Depth bias and normal offset, in texels of each cascade (normal-offset shadows, Holbert 2011). */
const DEPTH_BIAS_TEXELS = 1;
const NORMAL_BIAS_TEXELS = 2;
/** PCF filter radius in texels per cascade: at a 10° sun each texel stretches ~6x along the ground, so
 *  a dune's shadow edge is a staircase whose steps survive any filter narrower than the step length
 *  (they showed as a saw along the edge). The coarse cascades therefore blur wide; the nearest one is
 *  fine enough (~3 cm) to stay crisp. */
const PCF_RADIUS_TEXELS = [2, 6, 8, 8];

export class Sky {
  readonly sun = sunLight;
  private dome: THREE.Mesh;
  private ambient: THREE.HemisphereLight;
  private csm: CascadedShadows;
  private fittedAspect = NaN;
  readonly day: DayNight;
  readonly night = new NightSky();

  constructor(scene: THREE.Scene) {
    // Golden-hour sun (10°) through dusty air: warm, a little reddened. dayNight.ts keys the rest of the day off it.
    sunColor.value.setRGB(1.0, 0.7, 0.42).multiplyScalar(3.4);

    // Sky dome: big camera-centred sphere drawn first, without depth, so the depth buffer stays at 1
    // for sky pixels (post uses that to tell sky from ground).
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false });
    const dir = normalize(positionWorld.sub(cameraPosition));
    mat.colorNode = skyRadiance(dir).add(sunDisc(dir)).add(moonDisc(dir)).add(nightSky(dir));
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(4000, 48, 24), mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    this.dome.onBeforeRender = (_r, _s, camera) => this.dome.position.copy(camera.position);
    scene.add(this.dome);
    scene.background = null;

    // Aerial perspective for every node material with fog enabled: orange haze that glows towards the sun.
    const view = normalize(positionWorld.sub(cameraPosition));
    const flat = normalize(vec3(view.x, min(view.y, 0), view.z));
    scene.fogNode = fog(hazeColorFor(flat), hazeFactor(positionWorld));

    // Warm rust fill: shadows stay deep maroon-brown, never grey or blue.
    this.ambient = new THREE.HemisphereLight(0xd27a40, 0x5a2810, 0.55);
    scene.add(this.ambient);
    this.day = new DayNight(this.ambient);

    const sun = this.sun;
    sun.castShadow = QUERY.get('shadows') !== '0' && graphics.shadows;
    sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    // Each cascade clones this shadow, layers included: also draw shadow-only objects (own body).
    sun.shadow.camera.layers.enable(SHADOW_ONLY_LAYER);
    this.csm = new CascadedShadows(sun, {
      cascades: CASCADE_ENDS.length,
      maxFar: graphics.shadowDistance,
      mode: 'custom',
      lightMargin: LIGHT_MARGIN,
      customSplitsCallback: (_n, _near, far, breaks) => breaks.push(...CASCADE_ENDS.map((d) => d / far)),
    });
    this.csm.fade = true; // widens each cascade's map to cover the cross-fade into it
    sun.shadow.shadowNode = this.csm;
    scene.add(sun, sun.target);
    onGraphics((g, changed) => {
      if (changed === 'shadows') sun.castShadow = g.shadows;
      if (changed === 'shadowDistance') this.setShadowDistance(g.shadowDistance);
    });
  }

  /** Cut the cascades again out to this distance (m); they are refitted on the next frame. */
  private setShadowDistance(distance: number) {
    CASCADE_ENDS.splice(0, CASCADE_ENDS.length, ...cascadeEnds(distance, CASCADES));
    this.csm.maxFar = distance;
    if (!this.csm.camera) return; // not built yet: its first render reads the above
    this.csm.updateFrustums();
    this.fittedAspect = NaN;
  }

  /**
   * Called every render frame. `focus` is the local player's position, `camera` the view, `unixMs` the
   * shared wall clock (Net.worldTime) that sets the time of day.
   */
  update(dt: number, focus: THREE.Vector3, camera: THREE.PerspectiveCamera, unixMs: number) {
    time.value += dt;
    this.day.update(unixMs);
    this.night.update(unixMs);
    const moonlit = this.day.elevation < MOON_TAKES_OVER;
    this.sun.color.copy(moonlit ? moonColor.value : sunColor.value);
    this.sun.intensity = 1 - 0.3 * sandStorm.value; // dust in the air dims the sun
    // Only the direction matters: the cascades place their own shadow cameras.
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).add(moonlit ? moonDirection.value : sunDirection.value);
    this.sun.target.updateMatrixWorld();
    setShadowNoiseAxes(moonlit ? moonDirection.value : sunDirection.value);
    this.fitCascades(camera);
  }

  /**
   * Fit the cascades to the widest (sprint) FOV, so the FOV kick doesn't resize them (which would make
   * shadows swim), and set each cascade's depth range and biases from its texel size. The CSM node
   * creates its cascades on the first render; refit when the aspect changes.
   */
  private fitCascades(camera: THREE.PerspectiveCamera) {
    const csm = this.csm;
    if (!csm.camera || camera.aspect === this.fittedAspect) return;
    this.fittedAspect = camera.aspect;
    const fov = camera.fov;
    camera.fov = MAX_FOV;
    camera.updateProjectionMatrix();
    csm.updateFrustums();
    camera.fov = fov;
    camera.updateProjectionMatrix();
    csm.lights.forEach((light, i) => {
      const shadow = light.shadow!;
      const cam = shadow.camera;
      const width = cam.right - cam.left; // bounds the slice in every direction, depth included
      const texel = width / SHADOW_MAP;
      cam.near = 1;
      cam.far = LIGHT_MARGIN + width;
      cam.updateProjectionMatrix();
      shadow.bias = (-DEPTH_BIAS_TEXELS * texel) / (cam.far - cam.near); // depth bias is in [0, 1] depth units
      shadow.normalBias = NORMAL_BIAS_TEXELS * texel;
      shadow.radius = PCF_RADIUS_TEXELS[i];
      (shadow as unknown as { texelWorld: number }).texelWorld = texel; // sizes the filter's world-pinned noise
      (shadow as unknown as { filterNode: unknown }).filterNode = wideShadowFilter; // wider than the stock 5-tap PCF
    });
  }
}
