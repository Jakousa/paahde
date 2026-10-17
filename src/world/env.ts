// Shared environment state: written by the sky (sky.ts), read by any material that needs to know
// where the sun is (sand, players, post). TSL uniforms so shaders pick up changes without recompiling.
//
// Also exports the atmosphere functions (skyRadiance, hazeColorFor, applyHaze) so the sky dome, the
// scene fog and any custom material (e.g. a sand mirage reflecting the sky) all agree on colours —
// if they don't, the horizon line shows.
import * as THREE from 'three/webgpu';
import { Fn, cameraPosition, dot, exp, float, max, min, mix, normalize, positionWorld, pow, saturate, smoothstep, sqrt, uniform, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';

type N = Node<'vec3'>;
type F = Node<'float'>;

/** Unit vector pointing from the ground towards the sun. */
export const sunDirection = uniform(new THREE.Vector3(0.3, 0.5, -0.8).normalize());
/** Linear sun radiance colour (can exceed 1). This is what lights the ground. */
export const sunColor = uniform(new THREE.Color(1, 0.95, 0.85).multiplyScalar(3));
/** Elapsed seconds, for animated shaders (heat haze, sparkle). */
export const time = uniform(0);

// --- Atmosphere palette (linear; THREE.Color converts the sRGB hex values from docs/look.md) ---
/** Sky straight up: dusky brown-purple. */
export const zenithColor = uniform(new THREE.Color(0x2a2438).multiplyScalar(0.8));
/** Sky a little above the horizon (between the hot band and the zenith). */
export const midSkyColor = uniform(new THREE.Color(0x5a3a3e));
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
const mieHalo = (mu: F): F => hg(mu, 0.7).mul(0.015).add(hg(mu, 0.9).mul(0.005));
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
  const bandWidth = mix(float(0.12), float(0.3), toward);
  // Exponential-ish falloff out of the band reads softer than a smoothstep edge.
  const t = float(1).sub(exp(yUp.div(bandWidth).mul(-2.2)));
  const dusty = mix(band, midSkyColor, 0.55).mul(0.8);
  const lower = mix(mix(band, dusty, smoothstep(0, 0.5, t)), midSkyColor, smoothstep(0.4, 1, t));
  const upper = mix(lower, zenithColor, smoothstep(bandWidth.mul(0.8), 0.9, yUp));
  // Blend from the haze colour right at the horizon so fogged terrain meets the sky seamlessly.
  const hazeBase = mix(hazeColor, horizonSunColor, toward.mul(0.7));
  const sky = mix(hazeBase, upper, smoothstep(0.0, 0.06, y));
  return sky.add(HALO_TINT.mul(sunColor).mul(mieHalo(mu)));
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
  return disc.add(corona.mul(smoothstep(0.97, 1.02, r)));
});

/**
 * Fog factor (0 = clear, 1 = fully hazed) for a world position seen from the camera. Valleys are
 * hazier than crests (height falloff), which makes far dunes read as layered silhouettes.
 */
export const hazeFactor = Fn(([worldPos]: [N]) => {
  const d = worldPos.sub(cameraPosition).length();
  const heightFall = exp(max(worldPos.y, 0).mul(-0.012));
  const f = float(1).sub(exp(d.mul(hazeDensity).mul(heightFall).negate()));
  return max(f, smoothstep(hazeFar.mul(0.7), hazeFar, d));
});

/** Apply the aerial perspective to a lit colour at `worldPos` (for materials with fog disabled). */
export const applyHaze = Fn(([color, worldPos]: [N, N]) => {
  const dir = normalize(worldPos.sub(cameraPosition));
  const flat = normalize(vec3(dir.x, min(dir.y, 0), dir.z));
  return mix(color, hazeColorFor(flat), hazeFactor(worldPos));
});

/** Default world position for haze (the fragment's). */
export const hazeAtFragment = (color: N) => applyHaze(color, positionWorld);
