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
import { MAX_FOV } from '../camera.ts';
import { graphics } from '../graphics.ts';
import { Fn, float, mix, positionView, saturate, step, uniform, vec3, vec4, viewZToOrthographicDepth } from 'three/tsl';
import { CSMShadowNode, type CSMShadowNodeData } from 'three/addons/csm/CSMShadowNode.js';
import type { Node, NodeBuilder, NodeFrame } from 'three/webgpu';

type F = Node<'float'>;
type Lw = CSMShadowNode['lights'][number];

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

/** From this cascade on, the map is a world-fixed box round the camera (not fitted to the view, so turning doesn't change it) that is drawn again
 *  only when something calls for it: the camera has moved out of its slack, the sun has turned enough to move a shadow by half a texel, or it has been
 *  MAX_AGE seconds (for the things in it that move). Most frames these cascades are not drawn at all: they hold the terrain, rocks and wrecks,
 *  which is most of the draw calls of the shadow passes. */
export const FIRST_CACHED = 1;
/** The box reaches this share of the cascade's far end past what the view needs: how far the camera can move before a redraw. */
const SLACK = [0, 0.08, 0.06, 0.05];
/** Seconds a cached cascade may go undrawn, by Shadow refresh level, for each cached cascade in turn. */
const MAX_AGE = [[0, 0, 0], [0.066, 0.25, 0.6], [0.15, 0.8, 2]];
/** Tall things in the shadow maps (m): a sun turn of dθ moves the shadow of one by this × dθ. */
const CASTER_HEIGHT = 120;

/** What a cascade's shadow camera looked like when its map was last drawn (the shadows are looked up by it). */
interface Kept {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  box: [number, number, number, number, number, number];
  /** Cached cascades: where the camera was and which way the light pointed when the map was drawn, and when. */
  cam?: THREE.Vector3;
  dir?: THREE.Vector3;
  at?: number;
}

export class CascadedShadows extends CSMShadowNode {
  private kept: Kept[] = [];
  /** Fits a cascade's shadow settings (depth range, biases, filter) to its box; set by Sky. */
  onFit: ((i: number) => void) | null = null;

  /** Width of one texel of cascade `i` (m), from the box it is drawn with. */
  texel(i: number): number {
    return (2 * this.halfWidth(i)) / this.lights[i].shadow!.mapSize.width;
  }

  /** The cached cascades are drawn again next frame (the view or the distances changed). */
  invalidate() {
    for (let i = FIRST_CACHED; i < this.kept.length; i++) delete this.kept[i];
  }

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
    // The nearest cascade follows the view and is drawn every frame; the others are cached.
    // Frames a cascade isn't drawn it keeps the camera its map was drawn with, which the lookups read (the stock node refits every cascade to the view each frame).
    this.lights.forEach((lw, i) => {
      const shadow = lw.shadow!, cam = shadow.camera as THREE.OrthographicCamera;
      shadow.autoUpdate = false;
      const k = this.kept[i];
      if (i >= FIRST_CACHED) {
        if (this.cachedDue(i, k)) this.redrawCached(i, lw);
        else this.restore(lw, k!);
        return;
      }
      // the nearest cascade (the player's own shadow, what is at their feet) is drawn every frame
      shadow.needsUpdate = true;
      this.kept[i] = { pos: lw.position.clone(), target: lw.target.position.clone(), box: [cam.left, cam.right, cam.top, cam.bottom, cam.near, cam.far] };
    });
    return undefined;
  }

  private restore(lw: Lw, k: Kept) {
    const cam = lw.shadow!.camera as THREE.OrthographicCamera;
    lw.position.copy(k.pos);
    lw.target.position.copy(k.target);
    [cam.left, cam.right, cam.top, cam.bottom, cam.near, cam.far] = k.box;
    cam.updateProjectionMatrix();
    lw.updateMatrixWorld();
    lw.target.updateMatrixWorld();
  }

  /** Half the width of cascade `i`'s box (m): the far end of its slice reaches this far from the camera along the widest view ray, plus the slack. */
  halfWidth(i: number): number {
    const camera = this.camera as THREE.PerspectiveCamera;
    const far = Math.min(this.maxFar, camera.far);
    const end = this.breaks[i] * far;
    const v = Math.tan(THREE.MathUtils.degToRad(MAX_FOV) / 2);
    const reach = Math.sqrt(1 + v * v + v * v * camera.aspect * camera.aspect);
    return end * (reach + SLACK[i]);
  }

  /** Does cached cascade `i` need drawing: never drawn, too old, the camera out of its slack, or the sun turned. */
  private cachedDue(i: number, k: Kept | undefined): boolean {
    if (!k || !k.cam || !k.dir) return true;
    const age = (performance.now() - (k.at ?? 0)) / 1000;
    if (age >= (MAX_AGE[graphics.shadowRefresh][i - FIRST_CACHED] ?? 1)) return true;
    const camera = this.camera as THREE.Camera;
    camera.getWorldPosition(_p);
    const far = Math.min(this.maxFar, (this.camera as THREE.PerspectiveCamera).far);
    if (_p.distanceTo(k.cam) > SLACK[i] * this.breaks[i] * far * 0.9) return true;
    const texel = (2 * this.halfWidth(i)) / this.lights[i].shadow!.mapSize.width;
    const turn = THREE.MathUtils.clamp((0.5 * texel) / CASTER_HEIGHT, 0.0008, 0.02);
    return k.dir.dot(_dir) < Math.cos(turn);
  }

  /** Put cascade `i`'s box round the camera and draw its map. */
  private redrawCached(i: number, lw: Lw) {
    const shadow = lw.shadow!, cam = shadow.camera as THREE.OrthographicCamera;
    const half = this.halfWidth(i);
    const texel = (2 * half) / shadow.mapSize.width;
    const camera = this.camera as THREE.Camera;
    camera.getWorldPosition(_p);
    const at = _p.clone();
    _p.applyMatrix4(_orientInv);
    const x = _anchor.x + Math.floor((_p.x - _anchor.x) / texel) * texel;
    const y = _anchor.y + Math.floor((_p.y - _anchor.y) / texel) * texel;
    lw.position.set(x, y, _p.z + half + this.lightMargin).applyMatrix4(_orient);
    lw.target.position.copy(lw.position).add(_dir);
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.updateProjectionMatrix();
    lw.updateMatrixWorld();
    lw.target.updateMatrixWorld();
    this.onFit?.(i); // depth range and biases for this width (they change the projection: the box is kept after it)
    shadow.needsUpdate = true;
    this.kept[i] = {
      pos: lw.position.clone(), target: lw.target.position.clone(), box: [cam.left, cam.right, cam.top, cam.bottom, cam.near, cam.far],
      cam: at, dir: _dir.clone(), at: performance.now(),
    };
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
