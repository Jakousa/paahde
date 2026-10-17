// Sky, sun and scene lighting: TSL sky dome (dusky zenith → hot orange horizon, huge HDR sun disc with
// Mie halo), orange aerial-perspective fog, the shadow-casting sun light and a warm rust ambient fill.
import * as THREE from 'three/webgpu';
import { cameraPosition, fog, min, normalize, positionWorld, vec3 } from 'three/tsl';
import { hazeColorFor, hazeFactor, skyRadiance, sunColor, sunDirection, sunDisc, sunLight, time } from './env.ts';

const SUN_ELEVATION = THREE.MathUtils.degToRad(10);
const SUN_AZIMUTH = THREE.MathUtils.degToRad(-14); // 0 = straight ahead of the start view (-Z)
const SHADOW_EXTENT = 70; // half-size of the shadow frustum (m)
const SHADOW_MAP = 2048;
const SHADOW_DISTANCE = 300; // light distance from focus along the sun direction

export class Sky {
  readonly sun = sunLight;
  private dome: THREE.Mesh;
  private ambient: THREE.HemisphereLight;
  private lightBasis = new THREE.Matrix4();
  private tmp = new THREE.Vector3();

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
    const cam = sun.shadow.camera;
    cam.left = -SHADOW_EXTENT;
    cam.right = SHADOW_EXTENT;
    cam.top = SHADOW_EXTENT;
    cam.bottom = -SHADOW_EXTENT;
    cam.near = 1;
    cam.far = SHADOW_DISTANCE * 2;
    cam.updateProjectionMatrix();
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
    scene.add(sun, sun.target);
  }

  /** Place the sun: elevation above the horizon and azimuth (0 = towards -Z, positive = towards +X), radians. */
  setSun(elevation: number, azimuth: number) {
    sunDirection.value.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation)).normalize();
  }

  /** Called every render frame. `focus` is the local player's position (for shadow camera follow). */
  update(dt: number, focus: THREE.Vector3) {
    time.value += dt;
    this.sun.color.copy(sunColor.value);
    this.sun.intensity = 1;

    // Snap the shadow frustum to whole shadow-map texels in light space so shadows don't shimmer
    // as the player moves.
    const d = sunDirection.value;
    this.lightBasis.lookAt(d, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
    const right = new THREE.Vector3().setFromMatrixColumn(this.lightBasis, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.lightBasis, 1);
    const texel = (2 * SHADOW_EXTENT) / SHADOW_MAP;
    const p = this.tmp.copy(focus);
    const rx = Math.round(p.dot(right) / texel) * texel - p.dot(right);
    const uy = Math.round(p.dot(up) / texel) * texel - p.dot(up);
    p.addScaledVector(right, rx).addScaledVector(up, uy);
    this.sun.target.position.copy(p);
    this.sun.position.copy(p).addScaledVector(d, SHADOW_DISTANCE);
    this.sun.target.updateMatrixWorld();
  }
}
