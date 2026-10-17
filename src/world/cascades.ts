// Cascaded sun shadows: three's CSMShadowNode (cascade fitting, light placement, texel snapping) with
// the per-pixel cascade selection replaced.
//
// The stock node looks each cascade up inside an `If` on the fragment's depth. Every cascade but the
// first then came out black at any shadow intensity (both backends, r186), so the sun vanished beyond
// cascade 0. Here every cascade is sampled unconditionally and the results are blended arithmetically,
// with a short cross-fade at each cascade's far end so the resolution change doesn't show as a seam.
import * as THREE from 'three/webgpu';
import { Fn, float, mix, positionView, saturate, step, uniform, vec3, vec4, viewZToOrthographicDepth } from 'three/tsl';
import { CSMShadowNode, type CSMShadowNodeData } from 'three/addons/csm/CSMShadowNode.js';
import type { Node, NodeBuilder } from 'three/webgpu';

type F = Node<'float'>;

/** Fraction of each cascade's depth range spent fading into the next one. */
const FADE = 0.15;

/** CSMShadowNode members that its typings leave out. */
interface CSMInternals {
  _init(builder: NodeBuilder): void;
  _cascades: THREE.Vector2[];
  _shadowNodes: F[];
  setupShadowPosition(builder: NodeBuilder): void;
}

export class CascadedShadows extends CSMShadowNode {
  constructor(light: THREE.DirectionalLight, data: CSMShadowNodeData) {
    super(light, data);
  }

  setup(builder: NodeBuilder) {
    const self = this as unknown as CSMInternals;
    if (this.camera === null) self._init(builder);
    const camera = this.camera as THREE.PerspectiveCamera;
    const near = uniform(0).onRenderUpdate(() => camera.near);
    const far = uniform(0).onRenderUpdate(() => Math.min(this.maxFar, camera.far));
    // 0 at the camera's near plane, 1 at the last cascade's end; cascade ranges are in the same units.
    const depth = viewZToOrthographicDepth(positionView.z, near, far);
    const ranges = self._cascades.map((r) => uniform(new THREE.Vector2()).onRenderUpdate(() => r));

    return Fn((b: NodeBuilder) => {
      self.setupShadowPosition(b);
      const n = ranges.length;
      let lit: F = float(0);
      let covered: F = float(0);
      for (let i = 0; i < n; i++) {
        const r = ranges[i];
        const inRange = step(r.x, depth).mul(i === n - 1 ? step(depth, r.y) : float(1).sub(step(r.y, depth)));
        // Past the last cascade there are no shadows: fade it out to fully lit.
        const next = i + 1 < n ? self._shadowNodes[i + 1] : float(1);
        const fadeStart = r.y.sub(r.y.sub(r.x).mul(FADE));
        const t = saturate(depth.sub(fadeStart).div(r.y.sub(fadeStart)));
        lit = lit.add(inRange.mul(mix(self._shadowNodes[i], next, t)));
        covered = covered.add(inRange);
      }
      const v = lit.add(float(1).sub(covered));
      return vec4(vec3(v), 1);
    })();
  }
}
