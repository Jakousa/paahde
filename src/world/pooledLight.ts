// Fixed light pools avoid pipeline recompilation. A zero-intensity light must also skip its shader work:
// multiplying the final colour by zero still evaluates shadows and the sand's per-light ripple integration.
import * as THREE from 'three/webgpu';
import { If, uniform } from 'three/tsl';

export class PooledSpotLight extends THREE.SpotLight {}

class PooledSpotLightNode extends THREE.SpotLightNode {
  private active = uniform(0).onRenderUpdate(() => (this.light?.intensity ?? 0) > 0 ? 1 : 0);

  override setup(builder: THREE.NodeBuilder) {
    // This condition is uniform across the draw: derivatives in the lit branch remain well-defined.
    // Keep the node and shadow map alive while inactive, so switching a lamp never changes shader structure.
    If(this.active.greaterThan(0), () => { super.setup(builder); });
    return null;
  }
}

/** Register before the first scene render, on both WebGPU and the WebGL2 fallback. */
export function registerPooledLights(renderer: THREE.WebGPURenderer) {
  renderer.library.addLight(PooledSpotLightNode, PooledSpotLight);
}
