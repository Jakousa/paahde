// Desert sand surface (docs/look.md, docs/sand-rendering.md): Journey-style sand in TSL.
//
// A Lambert node material with a custom lighting model, so it still receives the scene's lights and
// shadow maps (the sky's DirectionalLight + HemisphereLight) but shades them like sand:
//   - contrast-boosted diffuse with a little Oren-Nayar back-scatter
//   - procedural wind ripples as normal perturbation (asymmetric profile, domain-warped, two octaves),
//     masked off slip faces and faded by screen footprint so they never alias
//   - ocean-like specular sheen at grazing angles (on the rippled normal) and a backlit rim on crests
//   - stable per-grain glitter (hashed microfacets in world-space cells, two scales, footprint-faded)
//   - large-scale colour variation; slip faces slightly darker and smooth
//   - shadow/ambient fill pushed towards rust/maroon whatever colour the sky light is
//
// Everything is a pure function of world position, camera and light, so it is stable when standing still.
// Tunables are exported TSL uniforms (`sand.*`): set `.value` at runtime, no recompile needed.
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  cameraWorldMatrix,
  cos,
  dot,
  float,
  floor,
  fract,
  fwidth,
  length,
  max,
  mix,
  mx_cell_noise_float,
  mx_cell_noise_vec3,
  mx_fractal_noise_float,
  mx_noise_float,
  normalize,
  normalWorldGeometry,
  positionWorld,
  pow,
  saturate,
  select,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type Node from 'three/src/nodes/core/Node.js';
import { sunColor } from './env.ts';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;
/** Colour uniforms are vec3 in the shader; the typings just don't mix them with vec3 math. */
const c3 = (u: unknown) => u as V3;

/** Runtime tunables. Colours are linear. */
export const sand = {
  /** Unit xz vector the wind blows towards. Ripple crests run perpendicular to it; slip faces face it. */
  wind: uniform(new THREE.Vector2(0.8, 0.6).normalize()),
  /** Albedo of the redder / more golden sand patches (large-scale variation mixes between them). */
  albedoRed: uniform(new THREE.Color(0.66, 0.3, 0.12)),
  albedoGold: uniform(new THREE.Color(0.8, 0.46, 0.2)),
  /** Ambient (sky irradiance) is desaturated and re-tinted by this, so shadows stay rust, never blue. */
  shadowTint: uniform(new THREE.Color(1.0, 0.42, 0.26)),
  /** Fraction of the sun colour bounced into shadows by surrounding lit dunes. */
  bounce: uniform(0.05),
  /** Diffuse terminator: I = saturate(N·L * contrast + offset). */
  contrast: uniform(2.1),
  offset: uniform(0.12),
  /** Max normal slope of the small and large ripples. */
  rippleStrength: uniform(0.28),
  megaRippleStrength: uniform(0.14),
  /** Ocean specular and rim strengths. */
  sheen: uniform(0.035),
  rim: uniform(0.18),
  /** Colour of sheen and rim (warm, so highlights read as hot sand rather than wet white). */
  sheenTint: uniform(new THREE.Color(1.0, 0.62, 0.32)),
  /** Glitter intensity (HDR; values > 1 feed bloom). */
  glitter: uniform(14),
};

const PI = Math.PI;

// --- Ripples ---------------------------------------------------------------------------------------

/** Asymmetric ripple: rises gently over `a` of a cycle (stoss), drops steeply over the rest (lee).
 *  Returns [height 0..1, slope normalised so the lee face peaks at 1]. Smooth (C1) everywhere. */
function rippleProfile(s: F, a: number): [F, F] {
  const f = fract(s);
  const stoss = f.lessThan(a);
  const g = select(stoss, f.mul(0.5 / a), f.sub(a).mul(0.5 / (1 - a)).add(0.5));
  const gp = select(stoss, float(0.5 / a), float(0.5 / (1 - a)));
  const h = float(0.5).sub(cos(g.mul(2 * PI)).mul(0.5));
  const slope = sin(g.mul(2 * PI)).mul(gp).div(0.5 / (1 - a));
  return [h, slope];
}

/** Fade for a periodic pattern whose phase (in cycles) is `s`: 1 when well resolved, 0 near Nyquist. */
function footprintFade(s: F): F {
  return float(1).sub(smoothstep(0.08, 0.3, fwidth(s)));
}

// --- Glitter ---------------------------------------------------------------------------------------

/** One scale of hashed mirror flakes in world-space cells of 1/D metres. */
function glitterLayer(p: V3, n: V3, h: V3, D: number, density: number, spread: number, eps: number, seed: number): F {
  const q = p.mul(D);
  const cell = floor(q).add(seed);
  const rPos = mx_cell_noise_vec3(cell);
  const rNrm = mx_cell_noise_vec3(cell.add(vec3(17, 59, 113)));
  const rAlive = mx_cell_noise_float(cell.add(vec3(71, 7, 31)));
  // A round flake somewhere inside the cell (the surface slices it, so apparent sizes vary).
  const shape = smoothstep(0.3, 0.08, length(fract(q).sub(rPos.mul(0.5).add(0.25))));
  const gn = normalize(n.add(rNrm.mul(2).sub(1).mul(spread)));
  const hit = smoothstep(1 - eps, 1, dot(gn, h));
  const alive = smoothstep(1 - density, 1 - density + 0.02, rAlive);
  // Cells smaller than ~a pixel turn into noise: fade them out.
  const lod = float(1).sub(smoothstep(0.35, 0.9, length(fwidth(q))));
  return hit.mul(shape).mul(alive).mul(lod);
}

// --- Material --------------------------------------------------------------------------------------

/** Per-fragment world-space quantities shared by the lighting model (built once, reused per light). */
interface SandSurface {
  p: V3; // world position
  n0: V3; // geometric (dune) normal
  n: V3; // rippled normal (diffuse)
  nSpec: V3; // rippled normal with stronger ripples (sheen)
  v: V3; // to camera
  albedo: V3;
  slip: F; // 1 on slip faces
  rippleVis: F; // how resolved the small ripples are here (0 far away / masked)
  dist: F;
}

function buildSurface(): SandSurface {
  const p = positionWorld;
  const n0 = normalize(normalWorldGeometry);
  const wind = sand.wind;
  const perp = vec2(wind.y.negate(), wind.x);
  const xz = p.xz;
  const v = normalize(cameraPosition.sub(p));
  const dist = length(cameraPosition.sub(p));

  // Slip faces: steep and facing downwind. Smooth (avalanched) and a touch darker.
  const downwind = dot(n0.xz, wind).div(max(length(n0.xz), 1e-4));
  const steep = smoothstep(0.93, 0.86, n0.y);
  const slip = steep.mul(smoothstep(0.0, 0.5, downwind));
  const flatEnough = smoothstep(0.8, 0.92, n0.y);
  const rippleMask = flatEnough.mul(float(1).sub(slip));

  // Domain warp (metres along the wind) so crests meander and bend; gradient by finite differences
  // so the ripple normal follows the bent crest direction.
  const warpAt = (c: V2): F =>
    mx_noise_float(c.mul(0.07)).mul(3.2).add(mx_noise_float(c.mul(0.31).add(19.1)).mul(0.55));
  const e = 0.3;
  const w0 = warpAt(xz);
  const wdx = warpAt(xz.add(vec2(e, 0))).sub(w0).div(e);
  const wdz = warpAt(xz.add(vec2(0, e))).sub(w0).div(e);
  const along = dot(xz, wind);
  const across = dot(xz, perp);
  const dir = normalize(vec2(wind.x.add(wdx), wind.y.add(wdz)));

  // Small ripples (~0.3 m) and megaripples (~1.2 m, warped differently).
  const s1 = along.add(w0).div(0.3);
  const [h1, d1] = rippleProfile(s1, 0.72);
  const s2 = along.add(w0.mul(1.6)).add(mx_noise_float(vec2(across.mul(0.05), along.mul(0.02))).mul(2.5)).div(1.2);
  const [, d2] = rippleProfile(s2, 0.68);
  // Crest strength varies a little so the pattern isn't mechanical.
  const vary = mx_noise_float(xz.mul(0.15).add(5.3)).mul(0.35).add(0.8);
  const f1 = footprintFade(s1).mul(rippleMask).mul(vary);
  const f2 = footprintFade(s2).mul(rippleMask);
  const slope = d1.mul(sand.rippleStrength).mul(f1).add(d2.mul(sand.megaRippleStrength).mul(f2));
  // The sheen uses a higher power, so it aliases sooner: its ripples fade out earlier (f^2).
  const slopeSpec = d1.mul(sand.rippleStrength).mul(1.4).mul(f1).mul(f1).add(d2.mul(sand.megaRippleStrength).mul(f2).mul(f2));
  // Heightfield y = h(x,z) has normal (-hx, 1, -hz); apply the ripple gradient on top of the dune normal.
  const n = normalize(n0.sub(vec3(dir.x, 0, dir.y).mul(slope)));
  const nSpec = normalize(n0.sub(vec3(dir.x, 0, dir.y).mul(slopeSpec)));

  // Albedo: large-scale red/gold patches, slip faces darker, ripple troughs a hair darker.
  const patch = saturate(mx_fractal_noise_float(vec3(p.x.mul(0.006), 0, p.z.mul(0.006)), 3).mul(0.9).add(0.5));
  // Grain speckle (~1 cm), faded once cells get near pixel size.
  const gq = p.mul(90);
  const grainFade = float(1).sub(smoothstep(0.3, 0.8, length(fwidth(gq))));
  // Second, coarser speckle (~4 cm) keeps mid-distance sand matte and gritty instead of smooth.
  const gq2 = p.mul(24);
  const grainFade2 = float(1).sub(smoothstep(0.3, 0.8, length(fwidth(gq2))));
  const grain = mx_cell_noise_float(gq).sub(0.5).mul(0.34).mul(grainFade)
    .add(mx_cell_noise_float(gq2.add(7.1)).sub(0.5).mul(0.16).mul(grainFade2))
    .add(1);
  const albedo = mix(sand.albedoRed, sand.albedoGold, patch)
    .mul(grain)
    .mul(float(1).sub(slip.mul(0.12)))
    .mul(float(1).sub(float(1).sub(h1).mul(f1).mul(0.08)));

  return { p, n0, n, nSpec, v, albedo, slip, dist, rippleVis: f1 };
}

class SandLightingModel extends THREE.LightingModel {
  private s: SandSurface;

  constructor(s: SandSurface) {
    super();
    this.s = s;
  }

  direct(input: THREE.LightingModelDirectInput) {
    const lightDirection = input.lightDirection as V3;
    const lightColor = input.lightColor as V3;
    const directDiffuse = input.reflectedLight.directDiffuse as V3;
    const directSpecular = input.reflectedLight.directSpecular as V3;
    const { p, n0, n, nSpec, v, albedo, slip, dist, rippleVis } = this.s;
    // Light direction arrives in view space; the sand works in world space.
    const l = normalize(cameraWorldMatrix.mul(vec4(lightDirection, 0)).xyz);
    const ndl = dot(n, l);

    // Journey "diffuse contrast": hard, bright terminator. Plus Fujii/Oren-Nayar back-scatter:
    // sand glows when the sun is behind the viewer and flattens when looking into it.
    const ndv = saturate(dot(n, v));
    const sON = dot(l, v).sub(saturate(ndl).mul(ndv));
    const tON = select(sON.greaterThan(0), max(max(saturate(ndl), ndv), 1e-3), float(1));
    // s/t blows up at grazing views (t -> 0); clamp it, since I is not multiplied by N·L here.
    const on = float(0.75).add(sON.div(tON).clamp(-1, 1.2).mul(0.3));
    const I = saturate(ndl.mul(sand.contrast).add(sand.offset)).mul(on);
    directDiffuse.addAssign(lightColor.mul(albedo).mul(I).mul(1 / PI));

    // Ocean specular on the rippled normal (reads when looking towards the sun), boosted at grazing.
    const h = normalize(v.add(l));
    const grazing = pow(float(1).sub(saturate(dot(n0, v))), 2).mul(0.7).add(0.3);
    // Forward-scattering: it lives on the sun side of the view.
    const sunSide = smoothstep(-0.3, 0.5, dot(v.negate(), l));
    const ocean = pow(saturate(dot(nSpec, h)), 90).mul(grazing).mul(sunSide).mul(rippleVis.mul(0.8).add(0.2)).mul(sand.sheen).mul(float(1).sub(slip.mul(0.6)));
    // Backlit rim: silhouettes/crests seen against the sun glow (forward scatter through edge grains).
    const toSun = saturate(dot(v.negate(), l));
    const rim = pow(float(1).sub(saturate(dot(n0, v))), 4)
      .mul(pow(toSun, 3))
      .mul(saturate(ndl.add(0.35)))
      .mul(sand.rim);
    const spec = c3(sand.sheenTint).mul(max(ocean, rim));

    // Glitter: only in sunlight, fades out with distance (and per-cell footprint inside the layers).
    const lit = saturate(ndl.mul(5));
    const near = float(1).sub(smoothstep(25, 70, dist));
    // Anisotropic masking (Journey): at grazing views a flake's footprint smears into a horizontal streak.
    const facing = smoothstep(0.12, 0.35, dot(n0, v));
    const g = glitterLayer(p, n0, h, 55, 0.35, 0.75, 0.012, 0)
      .add(glitterLayer(p, n0, h, 18, 0.25, 0.6, 0.006, 101).mul(0.4))
      .mul(lit)
      .mul(near)
      .mul(facing)
      .mul(float(1).sub(slip.mul(0.7)))
      .mul(sand.glitter);

    directSpecular.addAssign(lightColor.mul(spec.add(g)));
  }

  indirect(builder: THREE.NodeBuilder) {
    const ctx = builder.context as {
      irradiance: V3;
      ambientOcclusion: F;
      reflectedLight: { indirectDiffuse: V3 };
    };
    const { albedo } = this.s;
    // Keep the sky's brightness but force a warm rust hue, plus a little sun bounce from lit dunes.
    const irr = ctx.irradiance;
    const lum = dot(irr, vec3(0.2126, 0.7152, 0.0722));
    const tint = c3(sand.shadowTint);
    const fill = mix(irr, tint.mul(lum), 0.75).add(c3(sunColor).mul(tint).mul(sand.bounce));
    ctx.reflectedLight.indirectDiffuse.addAssign(fill.mul(albedo).mul(1 / PI).mul(ctx.ambientOcclusion));
  }
}

class SandNodeMaterial extends THREE.NodeMaterial {
  private surface = buildSurface();

  constructor() {
    super();
    this.lights = true;
    // Fog/shadow still come from the scene; colour is computed in the lighting model.
    this.colorNode = this.surface.albedo;
  }

  setupLightingModel() {
    return new SandLightingModel(this.surface);
  }
}

export function createSandMaterial(): THREE.NodeMaterial {
  return new SandNodeMaterial();
}
