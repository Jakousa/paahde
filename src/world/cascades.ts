// Cascaded sun shadows: three's CSMShadowNode (cascade fitting, light placement, texel snapping) with
// the per-pixel cascade selection replaced.
//
// The stock node looks each cascade up inside an `If` on the fragment's depth. Every cascade but the
// first then came out black at any shadow intensity (both backends, r186), so the sun vanished beyond
// cascade 0. Here every cascade is sampled unconditionally and the results are blended arithmetically,
// with a short cross-fade at each cascade's far end so the resolution change doesn't show as a seam.
//
// The stock node also snaps each cascade's shadow camera to whole texels in light space measured from
// the world origin. That stops swimming when the camera moves, but the sun turns a little every frame,
// and a turn about the origin slides everything ~200 m out (the base) by a third of a texel per frame
// across the grid, so every shadow edge re-rasterised each frame: the edges crawled and flickered. Here
// the grid is re-snapped about an anchor near the camera (moved in coarse steps), so a turn slides
// nearby casters by only (distance from the anchor) x angle.
import * as THREE from 'three/webgpu';
import { Fn, float, mix, positionView, saturate, step, uniform, vec3, vec4, viewZToOrthographicDepth } from 'three/tsl';
import { CSMShadowNode, type CSMShadowNodeData } from 'three/addons/csm/CSMShadowNode.js';
import type { Node, NodeBuilder, NodeFrame } from 'three/webgpu';

type F = Node<'float'>;

/** Fraction of each cascade's depth range spent fading into the next one. */
const FADE = 0.15;
/** Spacing (m) of the world grid the snapping anchor sits on. */
const ANCHOR_STEP = 32;

const _orient = new THREE.Matrix4();
const _orientInv = new THREE.Matrix4();
const _anchor = new THREE.Vector3();
const _p = new THREE.Vector3();
const _dir = new THREE.Vector3();

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

  updateBefore(frame: NodeFrame): boolean | undefined {
    super.updateBefore(frame);
    const light = this.light as THREE.DirectionalLight;
    const camera = this.camera as THREE.Camera;
    _orient.lookAt(light.position, light.target.position, THREE.Object3D.DEFAULT_UP);
    _orientInv.copy(_orient).invert();
    _dir.subVectors(light.target.position, light.position).normalize();
    camera.getWorldPosition(_anchor);
    _anchor.set(Math.round(_anchor.x / ANCHOR_STEP), Math.round(_anchor.y / ANCHOR_STEP), Math.round(_anchor.z / ANCHOR_STEP));
    _anchor.multiplyScalar(ANCHOR_STEP).applyMatrix4(_orientInv);
    for (const lw of this.lights) {
      const cam = lw.shadow!.camera as THREE.OrthographicCamera;
      const tw = (cam.right - cam.left) / lw.shadow!.mapSize.width;
      const th = (cam.top - cam.bottom) / lw.shadow!.mapSize.height;
      _p.copy(lw.position).applyMatrix4(_orientInv);
      _p.x = _anchor.x + Math.floor((_p.x - _anchor.x) / tw) * tw;
      _p.y = _anchor.y + Math.floor((_p.y - _anchor.y) / th) * th;
      lw.position.copy(_p.applyMatrix4(_orient));
      lw.target.position.copy(lw.position).add(_dir);
      lw.updateMatrixWorld();
      lw.target.updateMatrixWorld();
    }
    return undefined;
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
