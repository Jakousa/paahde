// Post-processing: heat haze → bloom → sun glare / lens flare → eye adaptation → grade → tone map →
// vignette + grain. One scene pass, a half-res bloom chain, and a single full-screen composite.
import * as THREE from 'three/webgpu';
import {
  Fn, abs, atan, cos, dot, exp, float, length, max, mix, mx_noise_float, pass, pow, renderOutput, saturate,
  smoothstep, step, uniform, uv, vec2, vec3, vec4, fract, sin, perspectiveDepthToViewZ,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { heightAt } from '../shared/terrain.ts';
import { heatHaze, sunDirection, sunDiscRadius, time } from './world/env.ts';

type N = Node<'vec3'>;
const TONE = new URLSearchParams(location.search).has('agx') ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
type F = Node<'float'>;

/** Sun tint used for veiling glare and flares (linear). */
const GLARE_TINT = new THREE.Color(1.0, 0.5, 0.2);

export class Post {
  private renderer: THREE.WebGPURenderer;
  private camera: THREE.PerspectiveCamera;
  private pipeline: THREE.RenderPipeline;

  // Per-frame uniforms written on the CPU.
  private sunUV = uniform(new THREE.Vector2(0.5, 0.3));
  /** 1 when the sun is in front of the camera, fading out as it leaves the screen. */
  private sunOnScreen = uniform(0);
  /** Sun disc radius in uv-y units. */
  private sunRadiusUV = uniform(0.03);
  private horizonY = uniform(0.5);
  private aspect = uniform(16 / 9);
  private exposure = uniform(1);
  /** How directly we are staring into the (unoccluded) sun, 0..1 — drives veiling glare. */
  private stare = uniform(0);
  private camNear = uniform(0.1);
  private camFar = uniform(6000);

  private lastTime = performance.now();
  private exposureValue = 1;
  private stareValue = 0;
  private ndc = new THREE.Vector3();
  private fwd = new THREE.Vector3();

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer = renderer;
    this.camera = camera as THREE.PerspectiveCamera;
    renderer.toneMapping = TONE;
    renderer.toneMappingExposure = 1;

    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const viewZ = scenePass.getViewZNode();

    const { sunUV, sunOnScreen, sunRadiusUV, horizonY, aspect, exposure, stare, camNear, camFar } = this;

    // --- Heat haze: vertically stretched, upward-scrolling noise warps the frame near the horizon,
    // only for distant ground (and a thin band of sky just above the horizon, so the sun's lower
    // edge and far crests wobble).
    const hazed = Fn(() => {
      const p = uv();
      const isSky = step(0.99999, depth.sample(p).r);
      const dist = viewZ.negate();
      const far = mix(smoothstep(20, 220, dist), float(0.45), isSky);
      const dy = p.y.sub(horizonY); // > 0 below the horizon
      const band = smoothstep(0.22, 0.0, abs(dy)).mul(mix(float(0.35), float(1), step(0, dy)));
      const mask = far.mul(band).mul(heatHaze);
      const q = vec3(p.x.mul(aspect).mul(28), p.y.mul(110).add(time.mul(2.2)), time.mul(0.6));
      const n = vec2(mx_noise_float(q), mx_noise_float(q.add(vec3(13.7, 5.1, 2.3))));
      const warped = p.add(n.mul(vec2(0.0018, 0.004)).mul(mask));
      // Don't pull nearby objects (players) into the shimmer: keep the warp only if the warped
      // sample is itself far away.
      const wDist = perspectiveDepthToViewZ(depth.sample(warped).r, camNear, camFar).negate();
      const keep = smoothstep(15, 30, wDist);
      return color.sample(mix(p, warped, keep)).rgb;
    })();

    // --- Bloom (half-res mip chain). Threshold sits just above lit sand so the sun, its halo and
    // glints bloom, and bloom bleeds over the dune crests that occlude the sun.
    const bloomPass = bloom(color, 0.4, 0.45, 2.0);

    // --- Sun visibility: fraction of depth taps around the sun that see sky (players and dunes occlude).
    const sunVis = Fn(() => {
      let acc: F = float(0);
      const taps: [number, number][] = [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6], [0.42, 0.42], [-0.42, 0.42], [0.42, -0.42], [-0.42, -0.42]];
      for (const [x, y] of taps) {
        const o = vec2(x, y).mul(sunRadiusUV).mul(vec2(float(1).div(aspect), 1));
        acc = acc.add(step(0.99999, depth.sample(sunUV.add(o)).r));
      }
      return acc.div(taps.length).mul(sunOnScreen);
    })();

    // --- Sun glare, streaks, starburst, ghosts and halo ring (all analytic, relative to sunUV).
    const flare = Fn(() => {
      const p = uv();
      const d2 = p.sub(sunUV).mul(vec2(aspect, 1));
      const dist = length(d2);
      const tint = vec3(GLARE_TINT.r, GLARE_TINT.g, GLARE_TINT.b);
      // Wide veiling glare (scales with how directly we stare) + tight hot bloom core.
      const veil = pow(saturate(float(1).sub(dist.mul(0.75))), 2.5).mul(stare.mul(0.35).add(0.05));
      const core = exp(dist.div(sunRadiusUV).mul(-1.6)).mul(0.5);
      // Anamorphic horizontal streak.
      const streak = exp(abs(d2.y).mul(-260)).mul(exp(abs(d2.x).mul(-2.2))).mul(1.6);
      // Starburst rays.
      const ang = atan(d2.y, d2.x);
      const rays = pow(abs(cos(ang.mul(7).add(0.4))), 30).add(pow(abs(cos(ang.mul(11).add(1.3))), 60).mul(0.6));
      const burst = rays.mul(exp(dist.div(sunRadiusUV).mul(-0.4))).mul(0.45);
      // Halo ring (ice-halo-ish, warm with a faint chromatic edge).
      const ringR = float(0.34);
      const ringW = float(0.018);
      const ring = vec3(
        exp(pow(dist.sub(ringR.sub(0.006)).div(ringW), 2).negate()),
        exp(pow(dist.sub(ringR).div(ringW), 2).negate()),
        exp(pow(dist.sub(ringR.add(0.008)).div(ringW), 2).negate()),
      ).mul(vec3(1.0, 0.7, 0.4)).mul(0.15);
      // Ghosts mirrored through the screen centre.
      let ghosts: N = vec3(0);
      const gs: [number, number, number, [number, number, number]][] = [
        [0.45, 0.05, 0.25, [1.0, 0.55, 0.25]],
        [0.7, 0.025, 0.4, [1.0, 0.8, 0.45]],
        [1.15, 0.09, 0.12, [0.9, 0.45, 0.2]],
        [1.45, 0.04, 0.25, [1.0, 0.65, 0.35]],
        [1.9, 0.14, 0.07, [0.8, 0.5, 0.3]],
      ];
      for (const [t, r, k, c] of gs) {
        const gp = mix(sunUV, vec2(1, 1).sub(sunUV), t);
        const gd = length(p.sub(gp).mul(vec2(aspect, 1)));
        const disc = smoothstep(r, r * 0.6, gd).add(smoothstep(r * 0.15, 0, abs(gd.sub(r))).mul(0.6));
        ghosts = ghosts.add(vec3(...c).mul(disc.mul(k)));
      }
      const local = core.add(streak).add(burst).mul(tint).add(ring).add(ghosts.mul(0.5));
      return tint.mul(veil.mul(1.4)).add(local).mul(sunVis);
    })();

    // --- Composite in linear HDR, then grade and tone map.
    const graded = Fn(() => {
      let c: N = hazed.add(bloomPass.rgb).add(flare);
      c = c.mul(exposure);
      // Warm white balance and a rust lift in the shadows (never grey/blue blacks).
      c = c.mul(vec3(1.06, 0.98, 0.86));
      const lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = c.add(vec3(0.03, 0.009, 0.002).mul(saturate(float(1).sub(lum.mul(4)))));
      // Saturation boost (AgX desaturates; push the orange back).
      c = mix(vec3(lum), c, 1.18);
      c = max(c, vec3(0));
      let o: N = renderOutput(vec4(c, 1), TONE, THREE.SRGBColorSpace).rgb;
      // Vignette.
      const p = uv();
      const v = length(p.sub(0.5).mul(vec2(aspect.mul(0.8), 1)));
      o = o.mul(mix(float(1), float(0.72), smoothstep(0.45, 1.05, v)));
      // Film grain.
      const g = fract(sin(dot(p.mul(vec2(1237.1, 913.7)).add(fract(time.mul(13.37))), vec2(12.9898, 78.233))).mul(43758.5453));
      o = o.add(g.sub(0.5).mul(0.028));
      return vec4(o, 1);
    })();

    this.pipeline = new THREE.RenderPipeline(renderer, graded);
    this.pipeline.outputColorTransform = false;
  }

  /** Project the sun and horizon to screen, run eye adaptation, render. */
  render() {
    const cam = this.camera;
    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.25);
    this.lastTime = now;
    cam.updateMatrixWorld();
    const size = this.renderer.getSize(new THREE.Vector2());
    this.aspect.value = size.x / Math.max(size.y, 1);
    this.camNear.value = cam.near;
    this.camFar.value = cam.far;

    // Sun position on screen (uv: origin top-left).
    const sd = sunDirection.value;
    this.ndc.copy(cam.position).addScaledVector(sd, 1000).project(cam);
    cam.getWorldDirection(this.fwd);
    const facing = this.fwd.dot(sd);
    this.sunUV.value.set(this.ndc.x * 0.5 + 0.5, 0.5 - this.ndc.y * 0.5);
    const off = Math.max(Math.abs(this.ndc.x), Math.abs(this.ndc.y));
    const sunUp = THREE.MathUtils.smoothstep(sd.y, -0.03, 0.02); // no glare once it has set
    this.sunOnScreen.value = facing > 0 ? (1 - THREE.MathUtils.smoothstep(off, 0.95, 1.35)) * sunUp : 0;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    this.sunRadiusUV.value = (Math.tan(sunDiscRadius.value) / tanHalf) * 0.5;

    // Horizon line straight ahead.
    const h = this.fwd.clone().setY(0);
    if (h.lengthSq() < 1e-6) h.set(0, 0, -1);
    this.ndc.copy(cam.position).addScaledVector(h.normalize(), 2000).project(cam);
    this.horizonY.value = 0.5 - this.ndc.y * 0.5;

    // Eye adaptation: CPU ray-march along the sun direction against the shared heightfield to tell
    // whether a dune hides the sun; staring into a visible sun blows exposure up, then settles.
    let visible = 1;
    for (let t = 4; t < 600; t *= 1.18) {
      const x = cam.position.x + sd.x * t;
      const z = cam.position.z + sd.z * t;
      if (heightAt(x, z) > cam.position.y + sd.y * t) {
        visible = 0;
        break;
      }
    }
    const look = THREE.MathUtils.smoothstep(facing, 0.55, 0.995) * visible * sunUp;
    const k = 1 - Math.exp(-dt * 1.5);
    this.stareValue += (look - this.stareValue) * k;
    this.exposureValue += (1 + 0.18 * look - this.exposureValue) * k;
    this.stare.value = this.stareValue;
    this.exposure.value = this.exposureValue;

    this.pipeline.render();
  }
}
