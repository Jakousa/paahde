// Post-processing: heat haze → sandstorm dust → bloom → sun glare / lens flare → eye adaptation → grade → tone map →
// vignette + grain. One scene pass, a half-res bloom chain, and a single full-screen composite.
import * as THREE from 'three/webgpu';
import {
  Fn, abs, atan, cos, dot, exp, float, length, max, mix, mx_noise_float, pass, pow, renderOutput, saturate,
  smoothstep, step, uniform, uv, vec2, vec3, vec4, fract, sin, perspectiveDepthToViewZ, If, normalize, sqrt, min, log, rtt,
  select, acesFilmicToneMapping, agxToneMapping,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { heightAt } from '../shared/terrain.ts';
import {
  choking, hazeColor, hazeColorFor, hazeDensity, heatHaze, heatstroke, indoorHutMax, indoorHutMin, indoorSurface, stormDiscs, stormFront, stormFrontEnv, stormGround, stormHere, stormIndoors, sunColor, sunDirection,
  sunDiscRadius, time, windDir, windDrift,
} from './world/env.ts';
import { EDGE, FRONT_TAIL, FRONT_WALL } from '../shared/storm.ts';

type N = Node<'vec3'>;
type F = Node<'float'>;

/** Hable's filmic curve, per channel (Godot's "Filmic", exposure bias 2 baked in). Keeps hue and
 *  saturation in bright oranges, where ACES and AgX wash them towards yellow-white. */
const A = 0.22 * 4, B = 0.3 * 2, C = 0.1, D = 0.2, E = 0.01, F_ = 0.3;
const hable = (x: number) => (x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F_) - E / F_;
/** 1 / hable(white point): scales the curve so the white point maps to 1. */
const filmicScale = uniform(1);
function filmic(c: N): N {
  const top = c.mul(c.mul(A).add(C * B)).add(D * E);
  const bottom = c.mul(c.mul(A).add(B)).add(D * F_);
  return top.div(bottom).sub(E / F_).mul(filmicScale);
}

export const TONE_CURVES = ['aces', 'agx', 'filmic'] as const;
export type ToneCurve = (typeof TONE_CURVES)[number];
const toneIndex = uniform(0);

/** Tone curve, switchable live (debug menu). Filmic by default; `?tone=aces|agx` (or `?agx`) starts on
 *  another, `?white=` sets the filmic white point. */
export const toneControl: { curve: ToneCurve; white: number; set(curve: ToneCurve, white?: number): void } = {
  curve: 'filmic',
  white: 2,
  set(curve, white = toneControl.white) {
    toneControl.curve = curve;
    toneControl.white = white;
    toneIndex.value = TONE_CURVES.indexOf(curve);
    filmicScale.value = 1 / hable(white);
  },
};
{
  const params = new URLSearchParams(location.search);
  const name = params.get('tone') ?? (params.has('agx') ? 'agx' : 'filmic');
  toneControl.set((TONE_CURVES as readonly string[]).includes(name) ? (name as ToneCurve) : 'filmic', Number(params.get('white') ?? 2));
}

/** Sun tint used for veiling glare and flares (linear). */
const GLARE_TINT = new THREE.Color(1.0, 0.5, 0.2);
/** Sandstorm dust: extinction per metre at full strength (~20 m to see 95% lost), how fast it thins
 *  upwards (m), and march steps through each storm. */
const STORM_K = 0.15;
const STORM_H = 60;
const STORM_STEPS = 6;
/** The dust frays out to this many storm radii (the gameplay strength ends at 1). */
const STORM_OUTER = 1.3;
/** Mega-storm front dust: how fast it thins upwards (m; the head of the wall stands up to FRONT_HEAD times
 *  taller), how far (m) its billows reach out ahead of the leading edge, how far past where a ray enters it is
 *  marched (opaque long before), and the steps (closer together near the eye). */
const FRONT_H = 55;
const FRONT_HEAD = 2.5;
const FRONT_FRAY = 60;
const FRONT_REACH = 700;
const FRONT_STEPS = 8;
/** How bright the front's dust is next to a column's. */
const FRONT_LIT = 0.6;
/** How much thicker the front's dust is than a column's: inside it you see 3–10 m. */
const FRONT_THICK = 4;
/** Ambient occlusion fades out between these view distances (m). Far off, GTAO (half resolution, normals
 *  rebuilt from depth) sees the ground at grazing angles a metre or more per pixel, and the depth step
 *  grows with distance² (near plane 5 cm: ~1 m at 1 km, as big as its 1.2 m radius): it read that as
 *  creases and peppered distant dunes and rock faces with dark dots, worst through the scope. Past
 *  ~100 m the haze has flattened any real occlusion anyway. */
const AO_FADE_START = 40;
const AO_FADE_END = 90;

/** How much sunlight gets through the sandstorms along the sun ray from `o`, 0..1: the shader's dust
 *  (dusted in Post) marched on the CPU, with the billows averaged out. */
function sunThroughDust(o: THREE.Vector3, sd: THREE.Vector3): number {
  const ground = stormGround.value;
  const gs = [ground.x, ground.y, ground.z, ground.w];
  let tau = 0;
  stormDiscs.forEach((u, i) => {
    const disc = u.value;
    if (disc.w <= 0) return;
    const R = disc.z * STORM_OUTER;
    const ox = o.x - disc.x, oz = o.z - disc.y;
    const a = Math.max(sd.x * sd.x + sd.z * sd.z, 1e-6);
    const b = ox * sd.x + oz * sd.z;
    const h = b * b - a * (ox * ox + oz * oz - R * R);
    if (h <= 0) return;
    const t0 = Math.max((-b - Math.sqrt(h)) / a, 0);
    const top = (gs[i] + STORM_H * 3 - o.y) / Math.max(sd.y, 1e-4);
    const t1 = Math.min((-b + Math.sqrt(h)) / a, top);
    if (t1 <= t0) return;
    const n = 16, dt = (t1 - t0) / n;
    for (let k = 0; k < n; k++) {
      const t = t0 + dt * (k + 0.5);
      const r = Math.hypot(ox + sd.x * t, oz + sd.z * t) / disc.z;
      const fade = 1 - THREE.MathUtils.smoothstep(r, EDGE * 0.45, STORM_OUTER);
      const hh = Math.max(o.y + sd.y * t - gs[i], 0);
      const up = Math.exp(-hh / STORM_H) * (1 - THREE.MathUtils.smoothstep(hh, STORM_H, STORM_H * 3));
      tau += disc.w * fade * fade * up * 0.7 * dt;
    }
  });
  // The front: the sun ray marched out to FRONT_REACH through the slab (billows averaged out).
  const f = stormFront.value, fe = stormFrontEnv.value;
  if (fe.x > 0) {
    const top = (fe.y + FRONT_H * FRONT_HEAD * 2.5 - o.y) / Math.max(sd.y, 1e-4);
    const n = 16, len = Math.min(FRONT_REACH, top), dt = len / n;
    for (let k = 0; k < n; k++) {
      const t = dt * (k + 0.5);
      const u = f.z - ((o.x + sd.x * t) * f.x + (o.z + sd.z * t) * f.y);
      const wall = THREE.MathUtils.smoothstep(u, -FRONT_FRAY, FRONT_WALL) * (1 - THREE.MathUtils.smoothstep(u, f.w - FRONT_TAIL, f.w));
      const H = FRONT_H * (1 + (FRONT_HEAD - 1) * Math.exp(-Math.max(u, 0) / 300));
      const hh = Math.max(o.y + sd.y * t - fe.y, 0);
      tau += fe.x * wall * Math.exp(-hh / H) * 0.7 * dt;
    }
  }
  return Math.exp(-STORM_K * tau);
}

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
  /** Ambient occlusion strength, 0 (off) .. 1; set from the Esc menu. */
  private aoIntensity = uniform(0.7);
  private camNear = uniform(0.1);
  private camFar = uniform(6000);
  private camWorld = uniform(new THREE.Matrix4());
  private projInv = uniform(new THREE.Matrix4());
  private camPos = uniform(new THREE.Vector3());

  private lastTime = performance.now();
  private exposureValue = 1;
  private stareValue = 0;
  private ndc = new THREE.Vector3();
  private fwd = new THREE.Vector3();

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer = renderer;
    this.camera = camera as THREE.PerspectiveCamera;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; // the composite tone maps itself (toneControl)
    renderer.toneMappingExposure = 1;

    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const viewZ = scenePass.getViewZNode();

    const { sunUV, sunOnScreen, sunRadiusUV, horizonY, aspect, exposure, stare, camNear, camFar, aoIntensity } = this;

    // Normals are rebuilt from depth (no MRT), at half resolution to keep it cheap. GTAO gathers from its
    // depth, which WGSL can't do on the multisampled (antialiased) depth buffer, so it reads a plain copy.
    const depthCopy = rtt(depth.r, null, null, {
      type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
    });
    const aoPass = ao(depthCopy, null as unknown as Node, camera);
    aoPass.resolutionScale = 0.5;
    aoPass.radius.value = 1.2;
    aoPass.thickness.value = 1;
    aoPass.scale.value = 1.5;
    // With the occlusion slider at 0 neither the depth copy nor the AO pass is drawn (the lookup then reads a stale texture times 0).
    for (const node of [depthCopy, aoPass] as unknown as { updateBefore(frame: unknown): void }[]) {
      const draw = node.updateBefore.bind(node);
      node.updateBefore = (frame) => (this.aoIntensity.value > 0 ? draw(frame) : undefined);
    }
    const aoTex = aoPass.getTextureNode();

    // --- Heat haze: vertically stretched, upward-scrolling noise warps the frame near the horizon,
    // only for distant ground (and a thin band of sky just above the horizon, so the sun's lower
    // edge and far crests wobble).
    const hazed = Fn(() => {
      // Heatstroke: the whole view swims, near things too: a slow, broad warp and a drunken sway.
      const p0 = uv();
      const hs = heatstroke.mul(heatstroke);
      const hq = vec3(p0.x.mul(aspect).mul(2.2), p0.y.mul(2.6).add(time.mul(0.35)), time.mul(0.45));
      const hn = vec2(mx_noise_float(hq), mx_noise_float(hq.add(vec3(7.3, 1.9, 4.1))));
      const sway = vec2(sin(time.mul(0.9)), sin(time.mul(0.67).add(1.3))).mul(0.006);
      const p = p0.add(hn.mul(0.022).add(sway).mul(hs));
      const isSky = step(0.99999, depth.sample(p).r);
      const dist = viewZ.negate();
      // Starts at 25 m: past ~150 m the haze has washed the ground flat, so there is nothing left to warp.
      const far = mix(smoothstep(25, 130, dist), float(0.45), isSky);
      const dy = p.y.sub(horizonY); // > 0 below the horizon
      const band = smoothstep(0.22, 0.0, abs(dy)).mul(mix(float(0.35), float(1), step(0, dy)));
      const mask = far.mul(band).mul(heatHaze);
      const q = vec3(p.x.mul(aspect).mul(28), p.y.mul(110).add(time.mul(2.2)), time.mul(0.6));
      const n = vec2(mx_noise_float(q), mx_noise_float(q.add(vec3(13.7, 5.1, 2.3))));
      const warped = p.add(n.mul(vec2(0.003, 0.009)).mul(mask));
      // Don't pull nearby objects (players) into the shimmer: keep the warp only if the warped
      // sample is itself far away.
      const wDist = perspectiveDepthToViewZ(depth.sample(warped).r, camNear, camFar).negate();
      const keep = smoothstep(15, 30, wDist);
      // Ambient occlusion darkens creases (GTAO from the scene depth); the slider scales it. None far
      // away (AO_FADE_END), where it only adds speckle.
      const aoNear = float(1).sub(smoothstep(AO_FADE_START, AO_FADE_END, dist));
      const occl = mix(float(1), aoTex.sample(p).r, aoIntensity.mul(aoNear));
      return color.sample(mix(p, warped, keep)).rgb.mul(occl);
    })();

    // --- Sandstorms (shared/storm.ts): each is a dust column, a vertical cylinder whose dust fades out
    // towards its rim and thins upwards. The view ray through the pixel is clipped to the cylinder and
    // to the scene depth, and marched in a few jittered steps with a billowing noise, so from outside a
    // storm reads as a thick rolling wall and from inside as dust fog ~25 m deep. Out: dust colour, and
    // how much of the scene still shows through.
    const { camWorld, projInv, camPos } = this;
    const dustLit: N = (sunColor as unknown as N).mul(vec3(0.5, 0.3, 0.16)).mul(0.17).add((hazeColor as unknown as N).mul(0.15));
    const dusted = Fn(() => {
      const p = uv();
      const ndc = vec4(p.x.mul(2).sub(1), float(1).sub(p.y.mul(2)), 1, 1);
      const v = projInv.mul(ndc);
      const dv = normalize(v.xyz.div(v.w));
      // As variables: the columns and the front both use these, and nodes first built inside one's If stay there.
      const dir = normalize(camWorld.mul(vec4(dv, 0)).xyz).toVar();
      const tScene = viewZ.div(dv.z).toVar(); // both negative: distance along the ray
      const tau = float(0).toVar();
      const lit = float(0).toVar(); // optical-depth-weighted brightness of the dust seen
      const seen = float(0).toVar(); // the optical depth those weights add up to
      const first = float(1e9).toVar(); // where the dust starts, for the haze in front of it
      const jitter = fract(sin(dot(p.mul(vec2(911.3, 577.7)), vec2(12.9898, 78.233))).mul(43758.5453)).toVar();
      const ground = [stormGround.x, stormGround.y, stormGround.z, stormGround.w];
      // In the base (or a shelter) the dust only starts where the ray gets out: up past the pad's surface (the
      // skylight, the stairwell) and out of the entrance hut (its door). Rays that end on the walls never get there.
      const ly = camPos.y.sub(indoorSurface);
      const rising = dir.y.greaterThan(1e-4);
      const tSurf = ly.greaterThanEqual(0).select(float(0), rising.select(ly.negate().div(max(dir.y, 1e-4)), float(1e9)));
      // Leaving the hut (and the stairwell under it, open below): the far side of its box along the ray.
      const inv = vec3(1).div(dir.add(vec3(dir.x.greaterThanEqual(0).select(1e-6, -1e-6), dir.y.greaterThanEqual(0).select(1e-6, -1e-6), dir.z.greaterThanEqual(0).select(1e-6, -1e-6))));
      const ta = indoorHutMin.sub(camPos).mul(inv);
      const tb = indoorHutMax.sub(camPos).mul(inv);
      const tNear = max(max(min(ta.x, tb.x), min(ta.y, tb.y)), min(ta.z, tb.z));
      const tFar = min(min(max(ta.x, tb.x), max(ta.y, tb.y)), max(ta.z, tb.z));
      const tHut = tFar.greaterThan(max(tNear, 0)).select(tFar, float(0));
      const tOut = max(tSurf, tHut).mul(stormIndoors).toVar();
      stormDiscs.forEach((disc, i) => {
        If(disc.w.greaterThan(0), () => {
          const oc = camPos.xz.sub(disc.xy);
          const a = max(dot(dir.xz, dir.xz), 1e-6);
          const b = dot(oc, dir.xz);
          const R = disc.z.mul(STORM_OUTER);
          const c = dot(oc, oc).sub(R.mul(R));
          const h = b.mul(b).sub(a.mul(c));
          If(h.greaterThan(0), () => {
            const sq = sqrt(h);
            const t0 = max(b.negate().sub(sq).div(a), tOut);
            // Rays climbing out of the dust: stop where it has thinned to ~5% (3 STORM_H up).
            const top = ground[i].add(STORM_H * 3).sub(camPos.y).div(max(dir.y, 1e-4));
            const t1 = min(min(b.negate().add(sq).div(a), tScene), top);
            If(t1.greaterThan(t0), () => {
              first.assign(min(first, t0));
              const dt = t1.sub(t0).div(STORM_STEPS);
              for (let k = 0; k < STORM_STEPS; k++) {
                const t = t0.add(dt.mul(jitter.add(k)));
                const q = camPos.add(dir.mul(t));
                const w = vec3(q.x.sub(windDrift.x.mul(1.5)), q.y.mul(1.6).sub(time.mul(4)), q.z.sub(windDrift.y.mul(1.5)));
                const n = mx_noise_float(w.mul(0.035));
                // Soft, ragged rim: density tapers from well inside the core out past the radius (the
                // billows push the edge in and out), so the column frays into the air instead of ending.
                const r = length(q.xz.sub(disc.xy)).div(disc.z).add(n.mul(0.18));
                const fade = float(1).sub(smoothstep(EDGE * 0.45, STORM_OUTER, r));
                const rim = fade.mul(fade);
                // Thins upwards, and the last of it fades out before the march stops at the top.
                const h = max(q.y.sub(ground[i]), 0);
                const up = exp(h.div(-STORM_H)).mul(float(1).sub(smoothstep(STORM_H, STORM_H * 3, h.mul(n.mul(0.25).add(1)))));
                const billow = saturate(n.mul(0.9).add(0.7));
                const d = disc.w.mul(rim).mul(up).mul(billow).mul(dt);
                tau.addAssign(d);
                // Billows catch the light; the low, thick dust at the foot of the wall is in its own shade.
                lit.addAssign(d.mul(n.mul(0.45).add(0.75)).mul(float(1.25).sub(up.mul(0.6))));
                seen.addAssign(d);
              }
            });
          });
        });
      });
      // The mega-storm front (shared/storm.ts): a slab of dust across the whole world behind its leading edge, a tall
      // rolling wall from ahead (its head stands higher than the dust behind) and dust fog inside. Marched out to
      // FRONT_REACH past where the ray enters, in steps that widen with distance.
      If(stormFrontEnv.x.greaterThan(0), () => {
        const fd = stormFront.xy;
        const a0 = dot(camPos.xz, fd);
        const ad = dot(dir.xz, fd);
        const inv = float(1).div(ad.greaterThanEqual(0).select(max(ad, 1e-5), min(ad, -1e-5)));
        const ta = stormFront.z.sub(stormFront.w).sub(a0).mul(inv);
        const tb = stormFront.z.add(FRONT_FRAY).sub(a0).mul(inv);
        const t0 = max(min(ta, tb), tOut);
        const top = stormFrontEnv.y.add(FRONT_H * FRONT_HEAD * 2.5).sub(camPos.y).div(max(dir.y, 1e-4));
        const t1 = min(min(min(max(ta, tb), tScene), top), t0.add(FRONT_REACH));
        If(t1.greaterThan(t0), () => {
          first.assign(min(first, t0));
          const len = t1.sub(t0);
          for (let k = 0; k < FRONT_STEPS; k++) {
            const f = jitter.add(k).div(FRONT_STEPS);
            const t = t0.add(len.mul(f.mul(f)));
            const dt = len.mul((2 * k + 1) / (FRONT_STEPS * FRONT_STEPS));
            const q = camPos.add(dir.mul(t));
            const w = vec3(q.x.sub(windDrift.x.mul(3)), q.y.mul(1.3).sub(time.mul(7)), q.z.sub(windDrift.y.mul(3)));
            const n = mx_noise_float(w.mul(0.011)).mul(0.6).add(mx_noise_float(w.mul(0.035)).mul(0.4));
            // How far behind the leading edge, the billows pushing it in and out.
            const u = stormFront.z.sub(dot(q.xz, fd)).add(n.mul(FRONT_FRAY));
            const wall = smoothstep(-FRONT_FRAY, FRONT_WALL, u).mul(float(1).sub(smoothstep(stormFront.w.sub(FRONT_TAIL), stormFront.w, u)));
            const H = exp(max(u, 0).div(-300)).mul(FRONT_H * (FRONT_HEAD - 1)).add(FRONT_H);
            const h = max(q.y.sub(stormFrontEnv.y), 0);
            // A crisp, billowing top: full up to its height, gone within half as much again.
            const up = exp(h.div(H).negate()).mul(float(1).sub(smoothstep(H.mul(1.6), H.mul(2.4), h.mul(n.mul(0.35).add(1)))));
            const billow = saturate(n.mul(0.9).add(0.7));
            const d = stormFrontEnv.x.mul(wall).mul(up).mul(billow).mul(dt).mul(FRONT_THICK);
            // So thick that only the dust nearest the eye shows: weighted by how much of it is seen, or what's behind
            // it (the pillars far off in the fog) would show through in its shading.
            const ds = d.mul(exp(tau.mul(-STORM_K)));
            tau.addAssign(d);
            seen.addAssign(ds);
            // Darker than the haze it rises out of: lit billow tops over a deep brown body.
            lit.addAssign(ds.mul(n.mul(0.7).add(0.45)).mul(float(1).sub(up.mul(0.55))).mul(FRONT_LIT));
          }
        });
      });
      const trans = exp(tau.mul(-STORM_K));
      // Lit dust: diffused sun on the sand colour plus the haze; far storms fade into the haze like dunes.
      const shade = lit.div(max(seen, 1e-4));
      const dust = dustLit.mul(shade);
      const far = float(1).sub(exp(first.mul(hazeDensity).negate()));
      return vec4(mix(dust, hazeColorFor(dir), far.mul(0.35)), trans);
    })();
    const storm = vec4(hazed.mul(dusted.w).add(dusted.xyz.mul(float(1).sub(dusted.w))), dusted.w);

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

    // --- In a sandstorm: grit flying past the eye, and sand caked on the edges of the view. Streaks run
    // across the screen with the crosswind and burst out from the centre when facing into it.
    const grit = Fn(() => {
      const s = stormHere;
      const p = uv();
      const q = p.sub(0.5).mul(vec2(aspect, 1));
      const right = camWorld.mul(vec4(1, 0, 0, 0)).xz;
      const back = camWorld.mul(vec4(0, 0, 1, 0)).xz;
      const side = dot(windDir, normalize(right));
      const into = saturate(dot(windDir, normalize(back)));
      // Crosswind: long thin streaks sliding sideways, two layers at different depths.
      const t = time;
      const lat = mx_noise_float(vec3(q.x.mul(2.5).sub(t.mul(side).mul(9)), q.y.mul(70), t.mul(1.5)))
        .max(mx_noise_float(vec3(q.x.mul(1.2).sub(t.mul(side).mul(5)), q.y.mul(35).add(9), t)).mul(0.8));
      // Headwind: streaks rushing outwards from the middle.
      const r = length(q).max(1e-3);
      const a = q.div(r);
      const rad = mx_noise_float(vec3(a.x.mul(32), a.y.mul(32), log(r).mul(2.5).sub(t.mul(5))));
      const radW = into.mul(smoothstep(0.1, 0.5, r));
      const streak = smoothstep(0.55, 0.9, lat).mul(abs(side).mul(0.8).add(0.2)).max(smoothstep(0.45, 0.85, rad).mul(radW));
      // Caked edges, slowly shifting.
      const v = length(p.sub(0.5).mul(vec2(aspect.mul(0.8), 1)));
      const cake = smoothstep(0.45, 1.1, v.add(mx_noise_float(vec3(q.mul(3), t.mul(0.3))).mul(0.12)));
      const w = saturate(streak.mul(0.38).add(cake.mul(0.45))).mul(s);
      return vec4(dustLit.mul(mix(float(0.7), float(1.3), streak)), w);
    })();

    // --- Composite in linear HDR, then grade and tone map.
    const graded = Fn(() => {
      // Dust in front hides what blooms or flares behind it.
      let c: N = storm.xyz.add(bloomPass.rgb.add(flare).mul(storm.w));
      c = mix(c, grit.xyz, grit.w);
      c = c.mul(exposure);
      // Warm white balance and a rust lift in the shadows (never grey/blue blacks).
      c = c.mul(vec3(1.06, 0.98, 0.86));
      const lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = c.add(vec3(0.03, 0.009, 0.002).mul(saturate(float(1).sub(lum.mul(4)))));
      // Saturation boost (AgX desaturates; push the orange back).
      c = mix(vec3(lum), c, 1.18);
      c = max(c, vec3(0));
      const toned = select(toneIndex.equal(2), saturate(filmic(c)), select(toneIndex.equal(1), agxToneMapping(c, float(1)) as N, acesFilmicToneMapping(c, float(1)) as N));
      let o: N = renderOutput(vec4(toned, 1), THREE.NoToneMapping, THREE.SRGBColorSpace).rgb;
      // Vignette.
      const p = uv();
      const v = length(p.sub(0.5).mul(vec2(aspect.mul(0.8), 1)));
      o = o.mul(mix(float(1), float(0.72), smoothstep(0.45, 1.05, v)));
      // Heatstroke: colour drains towards a hot red and a pulsing blood-red vignette closes in, the
      // pulse quickening as the meter fills.
      const hs = heatstroke;
      const beat = pow(abs(sin(time.mul(hs.mul(2.2).add(2.6)))), 6);
      const ol = dot(o, vec3(0.2126, 0.7152, 0.0722));
      o = mix(o, vec3(ol).mul(vec3(1.25, 0.72, 0.55)), hs.mul(0.4));
      const ragged = v.add(mx_noise_float(vec3(p.sub(0.5).mul(vec2(aspect, 1)).mul(2.5), time.mul(0.4))).mul(0.06));
      const edge = smoothstep(mix(float(0.62), float(0.18), hs), 1.0, ragged);
      o = mix(o, vec3(0.32, 0.015, 0.005), saturate(edge.mul(hs).mul(beat.mul(0.25).add(0.8)).mul(1.15)));
      // Choking in a storm front: the light dims and a dark, ragged dust-brown closes in from the edges, over the
      // whole view, until it goes black as you die.
      const ch = choking;
      o = o.mul(float(1).sub(ch.mul(0.35)));
      const cEdge = smoothstep(mix(float(0.7), float(-0.15), ch), mix(float(1), float(0.3), ch), ragged);
      o = mix(o, vec3(0.07, 0.04, 0.02), saturate(cEdge.mul(ch).mul(1.3)));
      o = o.mul(float(1).sub(smoothstep(0.75, 1, ch)));
      // Film grain.
      const g = fract(sin(dot(p.mul(vec2(1237.1, 913.7)).add(fract(time.mul(13.37))), vec2(12.9898, 78.233))).mul(43758.5453));
      o = o.add(g.sub(0.5).mul(stormHere.mul(0.05).add(0.028)));
      return vec4(o, 1);
    })();

    this.pipeline = new THREE.RenderPipeline(renderer, graded);
    this.pipeline.outputColorTransform = false;
  }

  setAoIntensity(v: number) {
    this.aoIntensity.value = v;
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
    this.camWorld.value.copy(cam.matrixWorld);
    this.projInv.value.copy(cam.projectionMatrixInverse);
    cam.getWorldPosition(this.camPos.value);

    // Sun position on screen (uv: origin top-left).
    const sd = sunDirection.value;
    this.ndc.copy(cam.position).addScaledVector(sd, 1000).project(cam);
    cam.getWorldDirection(this.fwd);
    const facing = this.fwd.dot(sd);
    this.sunUV.value.set(this.ndc.x * 0.5 + 0.5, 0.5 - this.ndc.y * 0.5);
    const off = Math.max(Math.abs(this.ndc.x), Math.abs(this.ndc.y));
    const sunUp = THREE.MathUtils.smoothstep(sd.y, -0.03, 0.02); // no glare once it has set
    // A sandstorm between us and the sun swallows its glare and flares like the disc itself.
    const clear = sunThroughDust(cam.position, sd);
    this.sunOnScreen.value = facing > 0 ? (1 - THREE.MathUtils.smoothstep(off, 0.95, 1.35)) * sunUp * clear : 0;
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
    const look = THREE.MathUtils.smoothstep(facing, 0.55, 0.995) * visible * sunUp * clear;
    const k = 1 - Math.exp(-dt * 1.5);
    this.stareValue += (look - this.stareValue) * k;
    this.exposureValue += (1 + 0.18 * look - this.exposureValue) * k;
    this.stare.value = this.stareValue;
    this.exposure.value = this.exposureValue;

    this.pipeline.render();
  }
}
