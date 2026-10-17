// Sky, sun and scene lighting: TSL sky dome (dusky zenith → hot orange horizon, huge HDR sun disc with
// Mie halo), orange aerial-perspective fog, the shadow-casting sun light and a warm rust ambient fill.
//
// Sun shadows are cascaded shadow maps (parallel-split, Zhang et al. 2006; cascades.ts): the
// view out to SHADOW_FAR is cut into slices by distance and each slice gets its own 2048² map fitted to
// it, so a player's shadow at your feet is a few cm per texel while a dune 1 km away still casts its
// 200 m shadow. Terrain casts too. Biases are set per cascade in world units, scaled to its texel size.
import * as THREE from 'three/webgpu';
import { cameraPosition, fog, min, normalize, positionWorld, vec3 } from 'three/tsl';
import { MAX_FOV } from '../camera.ts';
import { CascadedShadows } from './cascades.ts';
import { hazeColorFor, hazeFactor, SHADOW_ONLY_LAYER, skyRadiance, sunColor, sunDirection, sunDisc, sunLight, time } from './env.ts';

const SUN_ELEVATION = THREE.MathUtils.degToRad(10);
const SUN_AZIMUTH = THREE.MathUtils.degToRad(-14); // 0 = straight ahead of the start view (-Z)
/** Far end of each cascade (m from the camera). Past the last one the haze is ~95%, so no shadows. */
const CASCADE_ENDS = [20, 80, 320, 1600];
const SHADOW_FAR = CASCADE_ENDS[CASCADE_ENDS.length - 1];
const SHADOW_MAP = 2048;
/** How far sunwards of a slice casters are still drawn: a 30 m crest at 10° throws a ~170 m shadow. */
const LIGHT_MARGIN = 300;
/** Depth bias and normal offset, in texels of each cascade (normal-offset shadows, Holbert 2011). */
const DEPTH_BIAS_TEXELS = 1;
const NORMAL_BIAS_TEXELS = 2;
/** PCF filter radius in texels per cascade: at a 10° sun each texel stretches ~6x along the ground, so
 *  soften the coarse cascades' steps; the nearest one is fine enough (~3 cm) to stay crisp. */
const PCF_RADIUS_TEXELS = [1, 2, 2, 2];

export class Sky {
  readonly sun = sunLight;
  private dome: THREE.Mesh;
  private ambient: THREE.HemisphereLight;
  private csm: CascadedShadows;
  private fittedAspect = NaN;

  constructor(scene: THREE.Scene) {
    this.setSun(SUN_ELEVATION, SUN_AZIMUTH);
    // Low sun through dusty air: warm, a little reddened.
    sunColor.value.setRGB(1.0, 0.7, 0.42).multiplyScalar(3.4);

    // Sky dome: big camera-centred sphere drawn first, without depth, so the depth buffer stays at 1
    // for sky pixels (post uses that to tell sky from ground).
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false });
    const dir = normalize(positionWorld.sub(cameraPosition));
    mat.colorNode = skyRadiance(dir).add(sunDisc(dir));
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

    const sun = this.sun;
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    // Each cascade clones this shadow, layers included: also draw shadow-only objects (own body).
    sun.shadow.camera.layers.enable(SHADOW_ONLY_LAYER);
    this.csm = new CascadedShadows(sun, {
      cascades: CASCADE_ENDS.length,
      maxFar: SHADOW_FAR,
      mode: 'custom',
      lightMargin: LIGHT_MARGIN,
      customSplitsCallback: (_n, _near, far, breaks) => breaks.push(...CASCADE_ENDS.map((d) => d / far)),
    });
    this.csm.fade = true; // widens each cascade's map to cover the cross-fade into it
    sun.shadow.shadowNode = this.csm;
    scene.add(sun, sun.target);
  }

  /** Place the sun: elevation above the horizon and azimuth (0 = towards -Z, positive = towards +X), radians. */
  setSun(elevation: number, azimuth: number) {
    sunDirection.value.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation)).normalize();
  }

  /** Called every render frame. `focus` is the local player's position, `camera` the view. */
  update(dt: number, focus: THREE.Vector3, camera: THREE.PerspectiveCamera) {
    time.value += dt;
    this.sun.color.copy(sunColor.value);
    this.sun.intensity = 1;
    // Only the direction matters: the cascades place their own shadow cameras.
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).add(sunDirection.value);
    this.sun.target.updateMatrixWorld();
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
    });
  }
}
