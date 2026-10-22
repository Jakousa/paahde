// Sun-shadow filter: a wider PCF than three's stock 5-tap one. At a low sun each shadow-map texel stretches
// several metres along the ground, so a 5-tap, 1-2 texel filter leaves visible stairs on dune shadow edges.
// This takes SAMPLES taps on a Vogel disk (even area coverage), rotated per pixel by interleaved gradient
// noise (Jimenez 2014) so what is left of the steps turns into fine grain instead of bands. Each tap is
// also a hardware 2x2 bilinear compare, so the effective footprint is bigger still.
//
// The noise is pinned to the world, one cell per shadow texel on a plane facing the light, not to screen
// pixels: screen-space grain reshuffled along every shadow edge whenever the camera moved (or the dynamic
// resolution changed), which read as the shadows jittering. The plane only turns when the light has
// turned well away from it: the sun moves every frame, and turning the axes with it slid the noise
// under every pixel (by ~ distance from the origin x angle), reshuffling the grain each frame.
import * as THREE from 'three/webgpu';
import { SHADOW_QUALITY, startup } from '../graphics.ts';
import { Fn, add, dot, float, interleavedGradientNoise, positionWorld, reference, renderGroup, texture, uniform, vec2, vogelDiskSample } from 'three/tsl';


/** Two axes across the shadow-casting light's direction (sky.ts sets them from the sun or moon). */
export const shadowAxisX = uniform(new THREE.Vector3(1, 0, 0));
export const shadowAxisY = uniform(new THREE.Vector3(0, 0, 1));
const _up = new THREE.Vector3();
const _normal = new THREE.Vector3(0, 1, 0);
/** Cosine of how far (~10°) the light may turn before the noise plane follows it. */
const REORIENT_COS = Math.cos(THREE.MathUtils.degToRad(10));

/** Point the noise plane's axes across `lightDir` (unit, towards the light). */
export function setShadowNoiseAxes(lightDir: THREE.Vector3) {
  if (_normal.dot(lightDir) > REORIENT_COS) return;
  _normal.copy(lightDir);
  _up.set(0, Math.abs(lightDir.y) > 0.99 ? 0 : 1, Math.abs(lightDir.y) > 0.99 ? 1 : 0);
  shadowAxisX.value.crossVectors(_up, lightDir).normalize();
  shadowAxisY.value.crossVectors(lightDir, shadowAxisX.value);
}

type Inputs = { depthTexture: any; shadowCoord: any; shadow: any; depthLayer?: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The filter with `samples` taps (the first cascade takes more than the others, which only hold big things). */
export const makeShadowFilter = (SAMPLES: number) => Fn(({ depthTexture, shadowCoord, shadow, depthLayer }: Inputs) => {
  const compare = (uv: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    let depth = texture(depthTexture, uv);
    if (depthTexture.isArrayTexture) depth = depth.depth(depthLayer);
    return depth.compare(shadowCoord.z);
  };
  const mapSize = (reference('mapSize', 'vec2', shadow) as any).setGroup(renderGroup) // eslint-disable-line @typescript-eslint/no-explicit-any;
  const radius = (reference('radius', 'float', shadow) as any).setGroup(renderGroup) // eslint-disable-line @typescript-eslint/no-explicit-any;
  const radiusScaled = radius.mul(float(1).div(mapSize.x));
  // World size of one of this cascade's texels; sky.ts stores it on the shadow as `texelWorld`.
  const texel = (reference('texelWorld', 'float', shadow) as any).setGroup(renderGroup); // eslint-disable-line @typescript-eslint/no-explicit-any
  const cell = vec2(dot(positionWorld, shadowAxisX), dot(positionWorld, shadowAxisY)).div(texel);
  const phi = interleavedGradientNoise(cell).mul(6.28318530718);
  const taps = [];
  for (let i = 0; i < SAMPLES; i++) taps.push(compare(shadowCoord.xy.add(vogelDiskSample(float(i) as any, float(SAMPLES) as any, phi).mul(radiusScaled))));
  return add(...(taps as [any, any])).mul(1 / SAMPLES); // eslint-disable-line @typescript-eslint/no-explicit-any
});

export const nearShadowFilter = makeShadowFilter(SHADOW_QUALITY[startup.shadowQuality].filter);
export const farShadowFilter = makeShadowFilter(SHADOW_QUALITY[startup.shadowQuality].farFilter);
