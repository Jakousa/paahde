// A low-frequency sky/ground environment gives metal a reflected world without cubemap renders or a PMREM refresh.
import * as THREE from 'three/webgpu';
import { Fn, float, mix, normalWorld, uniform } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { inSun } from '../../shared/shade.ts';
import { indoors } from '../../shared/shelters.ts';

const sky = uniform(new THREE.Color());
const ground = uniform(new THREE.Color());
export const handShade = uniform(1);
let tod = 0.4;
let daylight = true;
let shadeClock = 0;
let shadeTarget = 1;

/** Three supplies the roughness-adjusted reflection direction (and the surface normal for diffuse IBL). */
export const desertEnvironment = Fn((builder: THREE.NodeBuilder) => {
  const context = builder.context as { getUV?: () => Node<'vec3'>; getTextureLevel?: () => Node<'float'> };
  const direction = context.getUV?.() ?? normalWorld;
  const blur = context.getTextureLevel?.() ?? float(1);
  // A broad hemispheric gradient needs no high-frequency convolution. Flatten its contrast with roughness.
  const up = mix(direction.y.mul(0.5).add(0.5), float(0.5), blur.mul(0.35));
  return mix(ground, sky, up);
})();

export function updateMaterialLighting(ambient: THREE.HemisphereLight, timeOfDay: number, sunUp: boolean) {
  sky.value.copy(ambient.color).multiplyScalar(ambient.intensity * 0.28);
  ground.value.copy(ambient.groundColor).multiplyScalar(ambient.intensity * 0.28);
  tod = timeOfDay;
  daylight = sunUp;
}

/** Exclude the player's own body: use the shared environment shade ray, only six times a second, and smooth doorway changes. */
export function updateHandShade(position: THREE.Vector3, dt: number) {
  shadeClock -= dt;
  if (shadeClock <= 0) {
    shadeClock = 1 / 6;
    const sheltered = indoors(position.x, position.y, position.z);
    shadeTarget = sheltered ? 0.38 : daylight && !inSun(position.x, position.y, position.z, tod) ? 0.55 : 1;
  }
  handShade.value += (shadeTarget - handShade.value) * (1 - Math.exp(-dt * 9));
}
