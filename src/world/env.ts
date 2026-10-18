// Shared environment state: written by the sky (sky.ts), read by any material that needs to know
// where the sun is (sand, players, post). TSL uniforms so shaders pick up changes without recompiling.
//
// Also exports the atmosphere functions (skyRadiance, hazeColorFor, applyHaze) so the sky dome, the
// scene fog and any custom material (e.g. a sand mirage reflecting the sky) all agree on colours —
// if they don't, the horizon line shows.
import * as THREE from 'three/webgpu';
import { Fn, cameraPosition, dot, floor, fract, length, mx_cell_noise_float, exp, float, max, min, mix, mx_noise_float, normalize, positionWorld, pow, saturate, smoothstep, sqrt, uniform, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';

type N = Node<'vec3'>;
type F = Node<'float'>;

/** Unit vector pointing from the ground towards the sun. */
export const sunDirection = uniform(new THREE.Vector3(0.3, 0.5, -0.8).normalize());
/** Linear sun radiance colour (can exceed 1). This is what lights the ground. */
export const sunColor = uniform(new THREE.Color(1, 0.95, 0.85).multiplyScalar(3));
/** Unit vector pointing from the ground towards the (full) moon. dayNight.ts moves it with the sun. */
export const moonDirection = uniform(new THREE.Vector3(-0.3, -0.5, 0.8).normalize());
/** Linear moonlight on the ground (0 by day). sky.ts swaps the shadow-casting light to it at night. */
export const moonColor = uniform(new THREE.Color(0, 0, 0));
/** 0 by day, 1 at full night: stars and the moon disc come out. */
export const nightLevel = uniform(0);
/** Elapsed seconds, for animated shaders (heat haze, sparkle). */
export const time = uniform(0);

// --- Atmosphere palette (linear; THREE.Color converts the sRGB hex values from docs/look.md) ---
/** Sky straight up: dusky brown-purple. */
export const zenithColor = uniform(new THREE.Color(0x4a3a3a));
/** Sky a little above the horizon (between the hot band and the zenith). */
export const midSkyColor = uniform(new THREE.Color(0x8a5040));
/** Overall gain on the sky above the horizon (the horizon itself stays at the haze colour). `?sky=` overrides. */
export const skyGain = uniform(Number(new URLSearchParams(location.search).get('sky') ?? 1.6));
/** Hot horizon band away from the sun. */
export const horizonColor = uniform(new THREE.Color(0xe07b28));
/** Horizon band towards the sun. */
export const horizonSunColor = uniform(new THREE.Color(0xf08a1c).multiplyScalar(1.0));
/** Distant haze colour (what far dunes fade into, away from the sun). */
export const hazeColor = uniform(new THREE.Color(0xd98a45).multiplyScalar(0.85));
/** Haze extinction per metre. ~0.006 → ~80% haze at 270 m. */
export const hazeDensity = uniform(0.006);
/** Distance (m) at which the haze becomes total — hides the terrain edge. Set to the terrain radius. */
export const hazeFar = uniform(290);
/** Heat-haze shimmer strength (post). 0 disables, 1 default, >3 looks like water. */
export const heatHaze = uniform(1);
/** Heatstroke coming on, 0 (heat meter at 60% or less) .. 1 (full); set by the HUD (water.ts), drawn by post. */
export const heatstroke = uniform(0);
/** Freezing, 0 (warm) .. 1 (about to die of cold); set by the HUD (water.ts) from the hidden chill, drawn by post as frost. */
export const frost = uniform(0);
// --- Wind, for shaders (fed from wind.ts by dust.ts every frame) ---
/** Unit xz vector the wind currently blows towards (wobbles a little around the dunes' wind). */
export const windDir = uniform(new THREE.Vector2(0.3162, 0.9487));
/** Regional wind, 0 (still) .. 1 (wind.ts at its strongest). */
export const windStrength = uniform(0.5);
/** Sandstorm envelope, 0 .. 1: dust in the air, haze, sand lifting off the ground. */
export const sandStorm = uniform(0);
/** Up to STORM_SLOTS local sandstorms for the post pass's dust volume (post.ts): centre x, z, radius (m)
 *  and strength envelope 0..1 (0 = not drawn). Written by src/storm.ts every frame. */
export const STORM_SLOTS = 4;
export const stormDiscs = Array.from({ length: STORM_SLOTS }, () => uniform(new THREE.Vector4()));
/** Ground height (m) under each storm's centre: its dust thins out upwards from there. */
export const stormGround = uniform(new THREE.Vector4());
/** How deep in a sandstorm the camera is, 0..1 (eased; 0 in the base): the grit on the view (post.ts). */
export const stormHere = uniform(0);
/** 1 while the camera is in the base: the post pass's dust starts only where the view ray leaves the
 *  bunker (up through the skylight, out of the hut's door), so the storm shows outside but the rooms stay clear. */
export const stormIndoors = uniform(0);
/** Integrated wind travel (m, xz): advects streaks and dust so they move with the wind. */
export const windDrift = uniform(new THREE.Vector2());
/** Apparent angular radius of the sun disc, radians (cheated huge: real sun is 0.0045). */
export const sunDiscRadius = uniform(0.06);

/**
 * The sun's directional light (shadow-casting). Created here so custom materials can reference it,
 * e.g. for TSL shadow lookups; sky.ts adds it to the scene and moves it.
 */
export const sunLight = new THREE.DirectionalLight(0xffffff, 1);

/** Layer for objects that cast sun shadows but are not drawn (the local first-person body). */
export const SHADOW_ONLY_LAYER = 1;

/** Henyey-Greenstein phase, normalised so that 4π·HG integrates to 1 → returns 4π·HG. */
const hg = (mu: F, g: number): F => {
  const g2 = g * g;
  return float(1 - g2).div(pow(max(float(1 + g2).sub(mu.mul(2 * g)), 1e-4), 1.5));
};

/** Mie halo around the sun (wide washed glow + tight aureole), in units of sunColor. */
const mieHalo = (mu: F): F => hg(mu, 0.7).mul(0.03).add(hg(mu, 0.9).mul(0.005));
/** Halo tint relative to sunColor: more saturated orange than the light itself (docs/look.md). */
const HALO_TINT = vec3(1.0, 0.4, 0.13);

/** Haze in-scatter colour for a view direction (no disc). Same as the sky at the horizon. */
export const hazeColorFor = Fn(([dir]: [N]) => {
  const mu = dot(dir, sunDirection);
  const toward = pow(saturate(mu.mul(0.5).add(0.5)), 3);
  const base = mix(hazeColor, horizonSunColor, toward.mul(0.7));
  return base.add(HALO_TINT.mul(sunColor).mul(mieHalo(mu)));
});

/** Sky radiance for a world-space view direction, without the sun disc. Linear HDR. */
export const skyRadiance = Fn(([dirIn]: [N]) => {
  const dir = normalize(dirIn);
  const y = dir.y;
  const mu = dot(dir, sunDirection);
  const toward = pow(saturate(mu.mul(0.5).add(0.5)), 3);
  // Upper sky: hot band → mid → zenith, the band thicker towards the sun.
  const band = mix(horizonColor, horizonSunColor, toward);
  const yUp = max(y, 0);
  const bandWidth = mix(float(0.2), float(0.45), toward);
  // Exponential-ish falloff out of the band reads softer than a smoothstep edge.
  const t = float(1).sub(exp(yUp.div(bandWidth).mul(-2.2)));
  const dusty = mix(band, midSkyColor, 0.55);
  const lower = mix(mix(band, dusty, smoothstep(0, 0.5, t)), midSkyColor, smoothstep(0.4, 1, t));
  const upper = mix(lower, zenithColor, smoothstep(bandWidth.mul(0.8), 0.9, yUp)).mul(skyGain);
  // Blend from the haze colour right at the horizon so fogged terrain meets the sky seamlessly.
  const hazeBase = mix(hazeColor, horizonSunColor, toward.mul(0.7));
  const clear = mix(hazeBase, upper, smoothstep(0.0, 0.06, y));
  // Dust raised by a sandstorm thickens the lower sky towards the haze colour.
  const sky = mix(clear, hazeBase, sandStorm.mul(0.55).mul(smoothstep(0.5, 0.0, y)));
  return sky.add(HALO_TINT.mul(sunColor).mul(mieHalo(mu))).add(stars(dir)).add(moonGlow(dir));
});

/** Star field: one star in a few hundred direction cells, varied brightness and a slow twinkle. */
const stars = Fn(([dir]: [N]) => {
  const p = dir.mul(260);
  const cell = floor(p);
  const pick = mx_cell_noise_float(cell);
  const spot = float(1).sub(smoothstep(0.08, 0.28, length(fract(p).sub(0.5))));
  const bright = pick.sub(0.985).div(0.015).max(0).pow(2).mul(3);
  const twinkle = mx_noise_float(cell.add(time.mul(0.7))).mul(0.35).add(0.75);
  // Thin out towards the horizon, where the dust hides them.
  return vec3(1.0, 0.93, 0.85).mul(bright.mul(spot).mul(twinkle).mul(nightLevel).mul(smoothstep(0.02, 0.3, dir.y)));
});

/** Faint pale glow around the moon, in the sky everywhere it is up. */
const moonGlow = Fn(([dir]: [N]) => {
  const mu = dot(dir, moonDirection);
  return vec3(0.5, 0.48, 0.55).mul(hg(mu, 0.85).mul(0.004)).mul(nightLevel).mul(smoothstep(-0.05, 0.05, moonDirection.y));
});

/** Moon disc for a view direction (sky dome only): pale, mottled with maria, bright enough to bloom a little. */
export const moonDisc = Fn(([dirIn]: [N]) => {
  const dir = normalize(dirIn);
  const mu = dot(dir, moonDirection);
  const ang = sqrt(max(float(2).mul(float(1).sub(mu)), 0));
  const r = ang.div(0.035);
  const maria = mx_noise_float(dir.mul(90)).mul(0.5).add(mx_noise_float(dir.mul(220)).mul(0.2)).add(0.5);
  const albedo = mix(float(0.62), float(1), smoothstep(0.35, 0.7, maria));
  const disc = vec3(1.0, 0.97, 0.9).mul(albedo).mul(2.2).mul(smoothstep(1.0, 0.94, r));
  // Hidden under the horizon and washed out by daylight.
  const vis = mix(float(0.15), float(1), nightLevel).mul(smoothstep(-0.02, 0.02, dir.y));
  return disc.mul(vis).mul(float(1).sub(sandStorm.mul(0.6)));
});

/** HDR sun disc + corona for a view direction (sky dome only). */
export const sunDisc = Fn(([dir]: [N]) => {
  const mu = dot(normalize(dir), sunDirection);
  const ang = sqrt(max(float(2).mul(float(1).sub(mu)), 0)); // ≈ angle from the sun centre
  const r = ang.div(sunDiscRadius);
  const core = vec3(1.0, 0.96, 0.82).mul(25); // far above bloom threshold → always blown out
  const rim = vec3(1.0, 0.7, 0.35).mul(10);
  const disc = mix(core, rim, smoothstep(0.55, 1.0, r)).mul(smoothstep(1.02, 0.97, r));
  const corona = vec3(1.0, 0.5, 0.16).mul(exp(r.sub(1).max(0).mul(-2.5)).mul(1.8));
  // Sets behind the horizon (the terrain doesn't reach it everywhere) and fades as it goes down.
  const up = smoothstep(-0.06, 0.0, sunDirection.y).mul(smoothstep(-0.03, 0.01, normalize(dir).y));
  return disc.add(corona.mul(smoothstep(0.97, 1.02, r))).mul(float(1).sub(sandStorm.mul(0.45))).mul(up);
});

/**
 * Fog factor (0 = clear, 1 = fully hazed) for a world position seen from the camera. Valleys are
 * hazier than crests (height falloff), which makes far dunes read as layered silhouettes.
 *
 * In a sandstorm the dust is patchy, in plumes that drift downwind, with a thin veil close to the viewer.
 */
export const hazeFactor = Fn(([worldPos]: [N]) => {
  const d = worldPos.sub(cameraPosition).length();
  const heightFall = exp(max(worldPos.y, 0).mul(-0.012));
  // blownSand.ts thickens hazeDensity itself in strong wind; here a storm makes it patchy.
  const plume = mx_noise_float(worldPos.xz.sub(windDrift).mul(0.008)).mul(0.5).add(0.5);
  const dusty = float(1).add(sandStorm.mul(plume.sub(0.5)).mul(1.2));
  const f = float(1).sub(exp(d.mul(hazeDensity).mul(dusty).mul(heightFall).negate()));
  const veil = sandStorm.mul(0.3).mul(plume).mul(float(1).sub(exp(d.mul(-1 / 60))));
  return max(f.add(veil).min(1), smoothstep(hazeFar.mul(0.7), hazeFar, d));
});

/** Apply the aerial perspective to a lit colour at `worldPos` (for materials with fog disabled). */
export const applyHaze = Fn(([color, worldPos]: [N, N]) => {
  const dir = normalize(worldPos.sub(cameraPosition));
  const flat = normalize(vec3(dir.x, min(dir.y, 0), dir.z));
  return mix(color, hazeColorFor(flat), hazeFactor(worldPos));
});

/** Default world position for haze (the fragment's). */
export const hazeAtFragment = (color: N) => applyHaze(color, positionWorld);
