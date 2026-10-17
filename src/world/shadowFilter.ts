// Sun-shadow filter: a wider PCF than three's stock 5-tap one. At a low sun each shadow-map texel stretches
// several metres along the ground, so a 5-tap, 1-2 texel filter leaves visible stairs on dune shadow edges.
// This takes SAMPLES taps on a Vogel disk (even area coverage), rotated per pixel by interleaved gradient
// noise (Jimenez 2014) so what is left of the steps turns into fine grain instead of bands. Each tap is
// also a hardware 2x2 bilinear compare, so the effective footprint is bigger still.
import { Fn, add, float, interleavedGradientNoise, reference, renderGroup, screenCoordinate, texture, vogelDiskSample } from 'three/tsl';

const SAMPLES = 12;

type Inputs = { depthTexture: any; shadowCoord: any; shadow: any; depthLayer?: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export const wideShadowFilter = Fn(({ depthTexture, shadowCoord, shadow, depthLayer }: Inputs) => {
  const compare = (uv: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    let depth = texture(depthTexture, uv);
    if (depthTexture.isArrayTexture) depth = depth.depth(depthLayer);
    return depth.compare(shadowCoord.z);
  };
  const mapSize = (reference('mapSize', 'vec2', shadow) as any).setGroup(renderGroup) // eslint-disable-line @typescript-eslint/no-explicit-any;
  const radius = (reference('radius', 'float', shadow) as any).setGroup(renderGroup) // eslint-disable-line @typescript-eslint/no-explicit-any;
  const radiusScaled = radius.mul(float(1).div(mapSize.x));
  const phi = interleavedGradientNoise(screenCoordinate.xy).mul(6.28318530718);
  const taps = [];
  for (let i = 0; i < SAMPLES; i++) taps.push(compare(shadowCoord.xy.add(vogelDiskSample(float(i) as any, float(SAMPLES) as any, phi).mul(radiusScaled))));
  return add(...(taps as [any, any])).mul(1 / SAMPLES); // eslint-disable-line @typescript-eslint/no-explicit-any
});
