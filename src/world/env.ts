// Shared environment state: written by the sky (sky.ts), read by any material that needs to know
// where the sun is (sand, players, post). TSL uniforms so shaders pick up changes without recompiling.
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

/** Unit vector pointing from the ground towards the sun. */
export const sunDirection = uniform(new THREE.Vector3(0.3, 0.5, -0.8).normalize());
/** Linear sun radiance colour (can exceed 1). */
export const sunColor = uniform(new THREE.Color(1, 0.95, 0.85).multiplyScalar(3));
/** Elapsed seconds, for animated shaders (heat haze, sparkle). */
export const time = uniform(0);
