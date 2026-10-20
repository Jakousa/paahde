# Sand / desert rendering: research notes and TSL recipes

Target: three r186 `three/webgpu` + TSL node materials (no GLSL), dune heightfield that is
deterministic and shared by client and server (`shared/`), game-jam time budget.
Constants below are starting points to tune by eye, not measured values.
These are the early research notes; where they differ from the art direction, `docs/look.md` wins
(shadows are deep warm rust, never blue).

## Recommended stack (do these, in this order)

| # | Technique | Payoff | Effort |
|---|-----------|--------|--------|
| 1 | Asymmetric dune heightfield in `shared/` (windward ~11°, slip face ~31°, domain-warped crests) | huge | low |
| 2 | Custom unlit sand material: Journey "diffuse contrast" + warm-sun / cool-sky shadow lerp | huge | low |
| 3 | HDR sun disc + `bloom()` + AgX tone mapping + exposure > 1 ("burning" sun) | huge | low |
| 4 | Distance haze/fog that uses the sky's horizon color, with a Mie-tinted glow toward the sun | high | low |
| 5 | Procedural wind ripples as shader normals (perpendicular to wind, masked off slip faces) | high | medium |
| 6 | Procedural glitter (hashed per-cell microfacet normals, LOD fade) | high | medium |
| 7 | Ocean specular + rim, combined with `max()` | medium | low |
| 8 | Post heat haze (scrolling-noise UV warp, depth- and horizon-masked) + fake mirage | medium | low/med |
| 9 | Physically based glints (Zirr-Kaplanyan / Deliot-Belcour) | low for a jam | high |

Architecture: build the dune mesh **on the CPU in TypeScript** from the shared height function
(same function the server uses for collision). Put **visual-only detail** (ripples, glitter, haze)
in TSL, since it doesn't need to match the server. Use one `MeshBasicNodeMaterial` whose `colorNode`
does all the lighting from your own `sunDir` uniform. That's what Journey did, and it gives full
control. Characters stay on `MeshStandardNodeMaterial`.

---

## 1. Dune heightfield (shared, deterministic)

**Reference geomorphology.** Dry sand has an angle of repose of about 30–34°, so slip faces sit
there. Windward (stoss) slopes are about 5–15°. Dune types: **transverse** dunes have crests
perpendicular to the wind and plenty of sand. **Barchans** are crescents with the horns pointing
downwind, where sand is scarce. **Seif/linear** dunes have crests roughly parallel to the net wind
(bimodal winds). **Star** dunes have arms radiating out, from multidirectional winds. Wind ripples
run perpendicular to the wind, with wavelengths of about 5–20 cm.
- Werner 1995 cellular automaton (all four types from slab transport plus avalanching):
  https://planetarygeoscience.uchicago.edu/doc/Werner_1995.pdf
- Angle values (34° slip face, ~10° windward): https://sites.math.washington.edu/~aloveles/ProjectGallery/AngleOfRepose.pdf
- Effective critical angle varies with wind and height (Pelletier et al. 2015):
  https://openaccess.city.ac.uk/12538/9/Pelletier_et_al-2015-Journal_of_Geophysical_Research-_Earth_Surface_(published)-2-25.pdf
- Real-time GPU dune simulation (avalanching scheme), if you ever want sim instead of noise:
  https://www.scitepress.org/Papers/2024/123156/123156.pdf
- Domain warping (Inigo Quilez): https://iquilezles.org/articles/warp

**Determinism gotcha (important).** ECMAScript leaves `Math.sin/cos/exp/pow/atan2` up to the
implementation, so V8 on the server and Firefox/Safari JSC on a client can return different last
bits. `+ - * /`, `Math.sqrt`, `Math.floor`, `Math.abs`, `Math.min/max` and `Math.imul` are exact
IEEE. So build the shared height function only from those: integer-hash value noise plus
polynomial smoothstep. No trig.

**Asymmetric transverse profile** (period `λ`, windward fraction `a`, height `H`):
- Slip-face slope = H/((1−a)λ) ≈ tan 31° = 0.6. Windward ≈ H/(aλ) ≈ tan 11° = 0.2.
- Solving gives **a = 0.75, H = 0.15·λ**. For λ = 40 m, H = 6 m.

```ts
// shared/dunes.ts — pure arithmetic only
const WIND = { x: 0.8, z: 0.6 };              // unit vector, wind blows toward +WIND
function hash2(ix: number, iz: number, seed: number): number { // -> [0,1)
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const ss = (t: number) => t * t * (3 - 2 * t);
function vnoise(x: number, z: number, seed: number): number { // value noise [0,1)
  const ix = Math.floor(x), iz = Math.floor(z), fx = ss(x - ix), fz = ss(z - iz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
function fbm(x: number, z: number, seed: number) { let s = 0, amp = 0.5;
  for (let i = 0; i < 4; i++) { s += amp * vnoise(x, z, seed + i); x *= 2.03; z *= 2.03; amp *= 0.5; }
  return s; }

function profile(p: number): number {          // p in [0,1) -> [0,1]
  const A = 0.75;
  if (p < A) return ss(p / A);                 // windward: max slope 1.5*H/(aλ) ≈ 0.3 (17°) — soften A or H if too steep
  return 1 - (p - A) / (1 - A);                // slip face: linear at the repose angle, sharp brink
}
export function duneHeight(x: number, z: number): number {
  const L = 40;                                // wavelength (m)
  const along = x * WIND.x + z * WIND.z;       // coordinate along the wind
  const warp = (fbm(x / 90, z / 90, 7) - 0.5) * 1.6 * L; // bends crests (domain warp)
  const t = (along + warp) / L;
  const p = t - Math.floor(t);
  const H = 0.15 * L * (0.55 + 0.9 * fbm(x / 140, z / 140, 3)); // crest height varies
  const base = (fbm(x / 300, z / 300, 11) - 0.5) * 8; // large rolling erg
  return base + H * profile(p);
}
```

Variants (all of them reuse `profile` or ridged noise):
- **Crest breakup / barchan feel.** Multiply `H` by `ss(clamp((fbm(...)-0.35)/0.3))` so dunes
  break into separate crescents. Bending the warp toward downwind at the cell ends gives horns.
- **Seif (linear).** Ridged noise along the cross-wind axis: `r = 1 - |2*vnoise(across/L, along/(6L))-1|`,
  `h = H*r*r`. Symmetric, sharp crests.
- **Star.** `max` of 3 ridged fields rotated 0°/60°/120° (rotation by precomputed constant
  cos/sin literals is fine, since it's only multiplication), times a radial falloff.
- **Repose clamp (optional polish).** After sampling into a grid, run ~20 iterations of
  thermal erosion: move `k·(Δh − tan32°·cell)` to any lower neighbour steeper than repose. This is
  deterministic if it runs in fixed order on the shared grid, which makes it safe to share.

**Mesh.** Grid around the player (for example 256×256 at 1 m, re-centred in steps of whole cells
so vertices don't swim). Get normals by central differences of `duneHeight` (CPU), or derive them
in the shader. Lower LOD rings farther out.

---

## 2. Journey's sand shading (diffuse contrast, normals, specular, glitter)

Source: John Edwards, "Sand Rendering in Journey", GDC 2013 — https://gdcvault.com/play/1017742/Sand-Rendering-in
(the talk splits into: sharpened mipmaps, anisotropic masking, glitter specular, ocean specular,
diffuse contrast, detail heightmap; summary at https://polycount.com/discussion/comment/1913443).
Best free reconstruction: Alan Zucconi's 6-part series — https://www.alanzucconi.com/2019/10/08/journey-sand-shader-1/
(parts 2–6: `...journey-sand-shader-2/` through `...-6/`). Russian write-up: https://habr.com/ru/post/476448

### 2a. Diffuse contrast (Journey's "phenomenological" diffuse) — do this first
Edwards wanted Oren-Nayar (rough, retro-reflective diffuse) but it cost too much on PS3, so he
used a hacked Lambert instead:

```
I = saturate( 4 * dot(N * vec3(1, 0.3, 1), L) )     // squash N.y → shadows go vertical, x4 → harsh terminator
diffuse = mix(shadowColor, sunColor * albedo, I)
```

The `0.3` on N.y makes the lit/shadow split follow the dune shape rather than tilt. The `4`
gives the hard, high-contrast desert terminator.

Suggested colors (linear): albedo `(0.80, 0.52, 0.30)` (warm ochre). shadowColor = a dark warm
rust (`docs/look.md`: `#4a2414` → `#2a120a`). The contrast between bright sun and deep shadow does
most of the "desert" read.

**Optional upgrade: Fujii's qualitative Oren-Nayar** (cheap on WebGPU, adds the
"sand glows with the sun behind you" opposition look). With σ ≈ 0.8 (roughness):
```
s = dot(L,V) - dot(N,L)*dot(N,V)
t = s > 0 ? max(dot(N,L), dot(N,V)) : 1
A = 1/(PI + (PI/2 - 2/3)*σ);  B = σ*A
ON = albedo * max(dot(N,L),0) * (A + B*s/t) * PI     // *PI to normalize to Lambert-ish brightness
```
(Fujii, "A tiny improvement of Oren-Nayar reflectance model", https://mimosa-pudica.net/improved-oren-nayar.html)
You can feed the ON result into the contrast `mix` in place of the plain `I`.

### TSL skeleton for the sand material
```ts
import * as THREE from 'three/webgpu';
import { Fn, uniform, vec3, vec4, float, normalWorld, positionWorld, cameraPosition,
         dot, mix, max, pow, saturate, normalize, reflect, smoothstep, clamp } from 'three/tsl';

const sunDir   = uniform(new THREE.Vector3(0.3, 0.45, -0.85).normalize()); // toward sun
const sunColor = uniform(new THREE.Color(1.0, 0.92, 0.78).multiplyScalar(3.0)); // HDR
const skyFill  = uniform(new THREE.Color(0.28, 0.27, 0.36));
const albedo   = uniform(new THREE.Color(0.80, 0.52, 0.30));

const sand = new THREE.MeshBasicNodeMaterial();
sand.colorNode = Fn(() => {
  const N = sandNormal();                         // §2b: base normal + ripples, world space
  const V = normalize(cameraPosition.sub(positionWorld));
  const L = sunDir;
  const I = saturate(dot(N.mul(vec3(1, 0.3, 1)), L).mul(4));
  let col = mix(skyFill.mul(albedo), sunColor.mul(albedo), I);
  col = col.add(specular(N, V, L).mul(I));        // §2c, only on lit side
  col = col.add(glitter(V, L, N));                // §2d
  return applyHaze(col, V);                       // §4
})();
```
(`MeshBasicNodeMaterial` is unlit and gets no shadow maps. If you want player shadows on the
sand, use a fake blob decal, or use `MeshStandardNodeMaterial` and put the custom terms into
`emissiveNode`.)

### 2b. Normals: detail + wind ripples
Journey: a detail heightmap/normal map in two variants, "shallow" for flat ground and "steep"
for slopes, blended by `pow(saturate(N.y), sharpness)`. A second pair is blended by orientation
(X vs Z facing). Zucconi blends normals with `normalize(mix(a,b,t))` ("nlerp").

Procedural is easier than authoring textures. Use an **analytic ripple height** along the wind
plus a little grain noise, and perturb the world normal with its gradient:

```
// world-space xz
s     = dot(p.xz, windDir) * k  + warpAmp * noise(p.xz * 0.15)   // k = 2π/λr, λr ≈ 0.35–0.6 m (game scale)
phase = fract(s / 2π)
// asymmetric ripple too: gentle stoss 0..0.8, steep lee 0.8..1
dhds  = phase < 0.8 ? (1/0.8) : -(1/0.2)          // derivative of a sawtooth; smooth it with a smoothstep blend
grad  = windDir * dhds * rippleAmp * mask          // rippleAmp ≈ 0.15–0.3
Nr    = normalize(N - vec3(grad.x, 0, grad.y))     // gradient-to-normal for height field y=f(x,z)
mask  = smoothstep(0.80, 0.97, N.y)                // no ripples on steep faces
      * (1 - smoothstep(0.0, 0.25, dot(N.xz, windDir)))  // slip faces face downwind → smooth avalanche surface
      * (1 - smoothstep(30., 120., viewDist))           // fade out to kill aliasing
```
Domain-warp `s` with low-frequency noise so ripples meander and fork. Real ripples have
"defects" (Y-junctions). TSL has MaterialX noise: `mx_noise_float(vec3)`, `mx_fractal_noise_float`.
Also add fine grain normal noise (`mx_noise_float(p*40)` gradient, amplitude 0.05) for close-up
texture.

**Aliasing.** Ripples shimmer badly at distance. Fade by distance (above), or better by
footprint: `fw = fwidth(s)`, then `mask *= 1 - smoothstep(0.5, 1.5, fw)`. Journey's "sharpened
mipmaps" idea was the opposite trick: keep the detail crisp in the distance, not blurred.

Convert world normal to the view space `normalNode` expects (if you use a lit material):
`sand.normalNode = cameraViewMatrix.mul(vec4(Nr, 0)).xyz.normalize()` (or `transformNormalToView`).

### 2c. Ocean specular + rim
From Zucconi part 4. Both are Blinn-Phong/Fresnel-style, combined with **max**, not a sum, so
overlaps don't blow out:
```
H        = normalize(V + L)
ocean    = pow(max(dot(Nripple, H), 0), 40..120) * 0.4..0.8 * sunColor   // uses the rippled normal → glistening "sea of sand"
rim      = pow(1 - saturate(dot(N, V)), 4..6) * 0.3..0.5 * rimColor      // silhouette shimmer separates dunes
spec     = max(ocean, rim)
```
Ocean specular reads best when looking **toward** the sun across rippled ground. Use a slightly
noisier normal for it than for diffuse.

### 2d. Glitter (Journey-style, procedural)
Journey/Zucconi version: a random-normal texture `G`, `R = reflect(L, G)`, keep only rare,
very-bright hits, and let values > 1 drive bloom:
```
G = normalize(rand3(uv) * 2 - 1);  R = reflect(-L, G);  hit = dot(R, V)
glint = hit > 1 - ε ? (1 - (1-hit)/ε) * glitterColor * 20 : 0
```
Procedural TSL version (no texture, works on any UV-less terrain):
```
D    = 60.0                                // sparkle cells per metre (≈ grain clusters)
cell = floor(p.xz * D)  (plus p.y*D to avoid smearing on slopes; or triplanar)
r    = hash3(cell)                          // 3 randoms per cell, e.g. from mx_cell_noise_vec3 or hash()
Gn   = normalize(N + (r - 0.5) * 2 * spread) // spread ≈ 0.6–1.0: microfacet normals around N
alive= step(1 - density, r2)               // only ~5–15% of cells have a mirror-like flake
h    = dot(reflect(-L, Gn), V)
glint= smoothstep(1 - ε, 1, h) * alive      // ε ≈ 0.002–0.01
// keep it inside the cell (round sparkle, not square): * smoothstep(0.5, 0.2, length(fract(p.xz*D)-0.5))
out  = glint * sunColor * 30 * I            // only in sunlight; HDR → bloom makes the star
```
Because `Gn` is fixed per cell and lit by reflection, glints twinkle as the camera or player
moves and stay put when standing still. That's correct behaviour.

**Distance / LOD (what the papers solve properly).** When a cell gets smaller than a pixel
(`fwidth(p.xz*D) > 1`), sparkles alias into noise. Cheap fix in the Zirr-Kaplanyan spirit: evaluate
at 2 scales (`D` and `D/4`), crossfade by `log2(fwidth)`. As cells shrink, scale intensity by the
coverage ratio so the *expected* brightness is preserved, which fades into a broad specular.
Journey's "anisotropic masking" handled the grazing-angle case: suppress glitter where the
footprint is stretched (grazing views), or it becomes a white smear on far dunes.

### 2e. Physically based glints (reference; probably skip for the jam)
- **Jakob et al. 2014, "Discrete Stochastic Microfacet Models"** (SIGGRAPH): a finite number of
  mirror facets, counted stochastically over the pixel footprint × cone of directions with a
  hierarchy. Offline-ish. https://www.cs.cornell.edu/projects/stochastic-sg14 · https://rgl.epfl.ch/publications/Jakob2014Discrete
- **Zirr & Kaplanyan 2016, "Real-time Rendering of Procedural Multiscale Materials"** (I3D):
  biscale NDF, procedural per-texel facet counts, footprint at multiple LODs → temporally stable
  glints. Has a Shadertoy, which is the most portable to TSL.
  https://research.nvidia.com/publication/2016-02_real-time-rendering-procedural-multiscale-materials
  · PDF https://research.nvidia.com/sites/default/files/pubs/2016-02_Real-time-Rendering-of/ZirrKaplanyan_MultiscaleI3D2016.pdf
- **Wang, Deng, Holzschuch 2020, "Real-Time Glints Rendering with Pre-Filtered Discrete Stochastic
  Microfacets"** (CGF): pre-filtered, env map + point lights, ~10 ms @1080p.
  https://diglib.eg.org/handle/10.1111/cgf14007
- **Chermain et al. 2020, "Procedural Physically based BRDF for Real-Time Rendering of Glints"**
  (PG): converges to Cook-Torrance, dictionary of 1D marginals <1 MiB.
  https://publis.icube.unistra.fr/2-CSDD20 · code https://github.com/ASTex-ICube/real_time_glint_dictgenerator
- **Deliot & Belcour 2023, "Real-Time Rendering of Glinty Appearances using Distributed Binomial
  Laws on Anisotropic Grids"** (CGF/EGSR, Unity): correct flake-count statistics for any footprint,
  1.5–5× faster than ZK16/CSDD20. Its core is the best idea to borrow: sample the flake count in a
  texel as `Binomial(N_flakes, p_reflect)`, where `p_reflect` = NDF mass in the half-vector cone.
  For large N use a normal approximation `mean = Np, var = Np(1-p)` with a per-texel hashed gaussian.
  https://arxiv.org/abs/2306.05051
- Film reference, DreamWorks "Trolls World Tour: Desert Bling" (glitter desert):
  https://history.siggraph.org/wp-content/uploads/2022/06/2021-Talks-Woo_Trolls-World-Tour.pdf

Jam takeaway: the hashed-cell glint (2d) plus intensity-preserving LOD fade gets 80% of the look.

---

## 3. Sky, sun, bloom, exposure: the "burning" sun

**Sky.** r186 ships `SkyMesh` (`three/addons/objects/SkyMesh.js`, Preetham analytic sky,
WebGPURenderer-only, TSL uniforms; set `.value`). Docs: https://threejs.org/docs/pages/SkyMesh.html
Desert-haze settings (defaults are turbidity 2, rayleigh 1, mieCoefficient 0.005, mieDirectionalG 0.8):
```ts
sky.turbidity.value = 9;        // dusty, aerosol-laden air → whiter sky, less saturated blue
sky.rayleigh.value = 0.6;       // weaker blue
sky.mieCoefficient.value = 0.02;// bigger, brighter aerosol halo
sky.mieDirectionalG.value = 0.9;// tight forward-scatter glow around the sun
sky.cloudCoverage.value = 0;    // clear desert
sky.sunPosition.value.copy(sunDir).multiplyScalar(1000);
```
**Custom alternative (more art control, cheap).** Write your own TSL sky on a big sphere, or
`scene.backgroundNode`:
```
mu      = dot(viewDir, sunDir)
grad    = mix(horizonCol(0.95,0.88,0.78), zenithCol(0.35,0.55,0.85), pow(saturate(viewDir.y), 0.45))
HG(g)   = (1 - g²) / (4π * pow(1 + g² - 2g·mu, 1.5))          // Henyey-Greenstein (Mie phase)
halo    = sunColor * (0.08*HG(0.76) + 0.02*HG(0.95))*4π        // wide washed glow + tighter aureole
disc    = sunColor * 60 * smoothstep(cos(0.6°), cos(0.4°), mu)  // HDR disc, ≫ bloom threshold
sky     = grad + halo + disc
```
Washed-out horizon: keep `horizonCol` almost white-beige and make the gradient exponent < 0.5
so the pale band is thick. Haze lifts the horizon to near the sun color's luminance.

**Bloom + tone mapping** (r186: `PostProcessing` is deprecated → `RenderPipeline`):
```ts
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
renderer.toneMapping = THREE.AgXToneMapping;   // AgX desaturates highlights gracefully toward white (great for sun)
renderer.toneMappingExposure = 1.3;            // push it: bright, harsh
const pipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);
const color = scenePass.getTextureNode('output');
pipeline.outputNode = color.add(bloom(color, 0.8 /*strength*/, 0.6 /*radius*/, 1.0 /*threshold*/));
renderer.setAnimationLoop(() => pipeline.render());
```
"Overwhelming" recipe:
- Sun disc radiance 50–200× the scene white, so bloom gives a huge soft halo, not a ring.
- Bloom threshold ~1.0 (after exposure). Sand at peak sun should sit around 0.9–1.2, so the
  brightest dunes and the glitter just touch bloom.
- **Sun-glare overlay** in the pipeline. Project the sun to screen (`sunUV`), then
  `glare = vis * (0.25*pow(saturate(1 - dist(uv,sunUV)*aspectFix), 3) + 0.6*pow(..., 12))`,
  `out = mix(out, sunTint, glare)`. `vis` = sun above the horizon and not occluded (sample depth at
  sunUV). This veiling glare washes out contrast when facing the sun, which is the "burning" feel.
- Fake eye adaptation: lerp exposure on the CPU by `dot(cameraForward, sunDir)`. Looking at the sun
  *raises* veiling glare and dims everything else slightly (exposure 1.3 → 1.0), while looking away
  brightens the sand. Lerp at ~1.5/s.
- r186 also has `GodraysNode`, `LensflareNode`, `ChromaticAberrationNode` in
  `three/addons/tsl/display/`. A faint chromatic aberration at the screen edges plus a light vignette
  sells "harsh lens".
- Color grade: a slight warm lift in shadows (not black), and a highlight shoulder that goes to
  warm white.

---

## 4. Aerosol haze / atmospheric perspective on terrain

Distant dunes should fade to the **sky's horizon color**, and turn brighter and warmer toward the
sun (Mie in-scatter). Do it in the sand shader (so ripples and glitter fade with it) or via
`scene.fogNode`:
```
d        = length(positionWorld - cameraPosition)
ext      = 1 - exp(-d * 0.0035)                          // density: ~50% at 200 m; tune to map size
ext     *= exp(-max(positionWorld.y - h0, 0) * 0.02)     // optional height falloff
mu       = dot(V_toFrag, sunDir)                          // V_toFrag = -V
inscat   = mix(horizonCol, sunColor*0.6, pow(saturate(mu), 8))   // warm glow toward the sun
col      = mix(col, inscat, ext)
```
Use exactly the same `horizonCol` and HG glow as the sky, or the horizon line will show.
Built-in alternative: `scene.fogNode = fog(colorNode, densityFogFactor(0.0035))` (TSL
`fog`/`rangeFogFactor`/`densityFogFactor`), with `colorNode` depending on the view direction.

---

## 5. Heat haze and mirage

Sources: screen-space heat distortion is the game-standard approach (perturb the UV used to read
the already-rendered frame, noise scrolling upward, masked near the ground):
https://gamedev.net/shaderlab/38-heat-haze-distortion/. Physically based reference (curved rays
through an SPH temperature field; not for a jam): Yuan et al. 2026, https://arxiv.org/abs/2603.02048

**5a. Heat shimmer (post pass, TSL).** Read the scene pass with distorted UVs:
```ts
import { screenUV, time, mx_noise_float, vec2, vec3, smoothstep, saturate } from 'three/tsl';
const depth = scenePass.getLinearDepthNode();      // 0..1 linear view depth
const n = vec2(
  mx_noise_float(vec3(screenUV.mul(vec2(18, 45)), time.mul(1.2))),
  mx_noise_float(vec3(screenUV.mul(vec2(18, 45)).add(7.3), time.mul(1.2))));
const horizonBand = smoothstep(0.25, 0.0, screenUV.y.sub(horizonUV_y).abs());   // strongest near the horizon line
const mask = smoothstep(0.05, 0.4, depth).mul(horizonBand).mul(heatAmount);       // only far stuff
const hazy = scenePass.getTextureNode('output').sample(screenUV.add(n.mul(0.003).mul(mask)));
```
- Noise is stretched vertically (higher frequency in y), scrolls upward, and has an amplitude of
  ~0.002–0.004 UV. Bigger looks like water.
- `horizonUV_y`: project a far point on the horizon in the camera direction (CPU uniform).
- Exclude the sky (depth = 1) or the sun disc wobbles, unless you like that.
- Apply bloom on the distorted color so bloom shimmers too.

**5b. Inferior mirage ("water on the horizon").** Over hot ground, rays bend upward, so at very
grazing angles the ground reflects the sky. Fake it in the sand shader:
```
g      = saturate(-V_toFrag.y)                    // how steeply we look down at this fragment
mir    = (1 - smoothstep(0.004, 0.03, g))         // only extremely grazing rays
       * smoothstep(80, 250, d)                   // only far away
       * flatness(N.y)                             // only on flat-ish ground facing the camera
skyR   = skyColor(reflect(V_toFrag, vec3(0,1,0))) // same sky function as §3
skyR  += noise wobble(time) * 0.1                 // shimmering
col    = mix(col, skyR, mir * 0.8)
```
Put a heat-shimmer post on top and you get the classic wobbling silver lake that recedes as you
approach. That's correct, because the mirage is distance-gated.

---

## 6. Other cheap wins

- **Wind-blown sand** (done: `src/world/wind.ts` for the physics, `src/blownSand.ts` for the
  particles). Sand only moves above the saltation threshold (~6.3 m/s at 10 m): as streamers near
  it, as an ankle-deep carpet well above it, and as plumes smoking off brinks in strong gusts.
  Never on slip faces (sheltered eddy). `?debug` then `dbg.wind.override = 12` pins the wind.
- **Footprint trails**: a ring-buffer render target in world xz that is stamped under players and
  read in the sand shader as a height offset (normal perturbation only). Visual-only, so it needs
  no determinism.
- **Sun angle**: a low sun (elevation 15–30°) makes the dune contrast and ripples pop. Overhead sun
  flattens everything. A sun **behind** the camera shows opposition brightening (Oren-Nayar). A sun
  **in front** shows ocean specular, glitter and glare. Pick the play direction accordingly.
- **Shadow color**: never gray or blue. Shadows are deep warm rust, and their saturation sells heat.

---

## 7. Gotchas specific to this repo

- `shared/` code runs under Node type-stripping: `.ts` imports, no enums. The height function
  must avoid `Math.sin/cos/pow/exp` (engine-dependent rounding, see §1) because players' collision
  depends on it.
- Never sample the GPU-displaced surface for gameplay. GPU noise isn't bit-identical to the
  server. Build the mesh from `duneHeight` on the CPU and keep shader detail visual-only.
- Render with `pipeline.render()` instead of `renderer.render()` once post is added. Keep
  `renderer.toneMapping` set: `RenderPipeline` applies it at its output (`outputColorTransform`).
- Heavy per-frame CPU work (re-meshing terrain chunks when the player moves) belongs in a worker,
  but only if it shows up in profiling. A 256² grid rebuild in TS is fine.

## Sources (summary)
- Journey GDC 2013: https://gdcvault.com/play/1017742/Sand-Rendering-in · Zucconi series: https://www.alanzucconi.com/2019/10/08/journey-sand-shader-1/
- UE4 Journey-sand recreation: https://iby.artstation.com/blog/lPan/landscape
- Glints: Jakob 2014 https://www.cs.cornell.edu/projects/stochastic-sg14 · Zirr-Kaplanyan 2016 https://research.nvidia.com/publication/2016-02_real-time-rendering-procedural-multiscale-materials · Wang 2020 https://diglib.eg.org/handle/10.1111/cgf14007 · Chermain 2020 https://publis.icube.unistra.fr/2-CSDD20 · Deliot-Belcour 2023 https://arxiv.org/abs/2306.05051
- Oren-Nayar (Fujii): https://mimosa-pudica.net/improved-oren-nayar.html
- Dunes: Werner 1995 https://planetarygeoscience.uchicago.edu/doc/Werner_1995.pdf · Kok et al. "Physics of wind-blown sand and dust" https://arxiv.org/abs/1201.4353 · domain warp https://iquilezles.org/articles/warp
- Sky: https://threejs.org/docs/pages/SkyMesh.html · Heat haze: https://gamedev.net/shaderlab/38-heat-haze-distortion/ · https://arxiv.org/abs/2603.02048

## Ripple shadows
At a low sun every small ripple's crest shadows the steep lee of the next one (the dark stripes of a dune photographed at dawn). `rippleSun` in
`src/world/sandMaterial.ts` works it out exactly from the ripple profile: from the point towards the sun along the ripple axis the first crest is
`toCrest` away and `gap` higher, so the point is lit when toCrest·tanθ > gap. No marching, no textures; `sand.rippleHeight` (m) sets how deep.
Where the ripples are below a pixel it turns into the average share left lit (height / (tanθ·wavelength)), so far ripple fields still darken at a
low sun instead of popping flat. Not displacement: the ripples are ~1 cm high, finer than any mesh we draw (no tessellation in WebGPU), and a
centimetre of real relief only shows in silhouette, which the shadows and normals already carry. Parallax occlusion mapping is the next step if
the ripples should also look raised at grazing views up close.
The small ripples have their own short-scale bend (crests wiggle every few tens of cm) and a phase warp stretched across the wind, so
neighbouring crests drift apart and together and seem to split and merge, with uneven spacing; their depth varies over a metre or two and
crests die out along their length (`depth` in buildSurface), for the shading and the shadows both. The shadow test is biased by its own
softness so a crest itself is never half-shadowed (that drew a thin dark line along every crest). `npm run perf -- --shot --view 4 --pitch 40`
looks down at the sand next to the player (lower than ~2 m the camera is inside the player's head).
