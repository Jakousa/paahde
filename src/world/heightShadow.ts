// Dune shadows from the heightfield, not from shadow maps.
//
// The terrain is a heightfield, so whether a point is in its shadow is a question about heights alone: look from the point towards
// the sun and see if the ground ever rises above the ray. For every texel of a top-down grid round the player that answer is kept as
// a "shadow ceiling" S: the highest the ray from that spot has to clear, max over every texel j up-sun of (h_j - d_j·tanθ). A point at
// height y is in the dunes' shadow when y < S. S is smooth and is filtered like any texture, so the shadow edge is the clean contour
// y = S at any distance: no shadow-map texels stretched along the ground by a low sun, no stairs, nothing that blurs out far away. It
// costs one texture read per pixel, and the terrain leaves the shadow maps (most of their draw calls) to the things that need them:
// players, wrecks, the base, bosses.
//
// S is found by doubling, on the GPU, one pass a frame: S0 looks one texel up-sun; S(k+1)(p) = max(Sk(p), Sk(p + 2^k texels) - 2^k
// texels·tanθ) looks twice as far. Every texel on the way is seen, so a thin pillar 1 km off still throws its whole shadow (a walk in
// growing steps skipped them, and their shadows came out dashed). Past the grid's edge the next, coarser grid's S takes over.
//
// Grids (levels): a fine one round the player and coarser ones out to the edge of the terrain. Each is redone when the sun has
// turned enough to move a shadow by part of a texel, or the player has moved far from its centre: the heights are drawn top-down
// (the terrain chunks with a height material), the doubling runs, and the result takes over when it is complete. Underground (the
// base's and the shelters' rooms) it says nothing: there the shadow maps, with the terrain in them near those places, decide.
import * as THREE from 'three/webgpu';
import { Fn, float, int, ivec2, max, normalWorld, positionWorld, screenCoordinate, smoothstep, step, texture, uniform, uniformArray, vec2, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { heightAt } from '../../shared/terrain.ts';

type F = Node<'float'>;

/** Dev comparison: `?hfshadow=0` puts the dunes back into the shadow maps (every cascade) and leaves the heightfield out. */
export const HEIGHT_SHADOWS = typeof location === 'undefined' || new URLSearchParams(location.search).get('hfshadow') !== '0';

/** Layer bit of the terrain chunks, for the top-down height render. */
export const TERRAIN_LAYER = 12;

export interface HeightShadowLevel {
  /** World width (m) the grid covers. */
  size: number;
  /** Texels per side. */
  res: number;
}

export interface HeightShadowSettings {
  levels: HeightShadowLevel[];
}

/** Edge softness and bias, in texels of rise along the sun (scaled by tanθ to height). */
const SOFT_TEXELS = 0.8;
const BIAS_TEXELS = 1.2;
/** Underground places the heightfield says nothing about (the base, the shelters near the player): there the shadow maps, with the
 *  terrain in them near those places, decide. */
const UNDERGROUND_SLOTS = 4;
/** The grid follows the player when they have moved this share of its width from its centre. */
const RECENTRE = 0.12;
/** How far (texels) a receiver is looked up out from a wall. */
const WALL_OFFSET_TEXELS = 2;
/** Heights are drawn again at least this often (ms) round the same centre. */
const HEIGHTS_EVERY_MS = 3000;
/** A tall dune (m), for how far a turn of the light moves a shadow: d(length) = height / sin²θ · dθ. */
const TALL = 40;
/** Fraction of each grid's edge over which it fades into the next one. */
const EDGE = 0.06;

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _frustum = new THREE.Frustum();

class Level {
  readonly size: number;
  readonly res: number;
  readonly texel: number;
  readonly height: THREE.RenderTarget;
  readonly shadow: [THREE.RenderTarget, THREE.RenderTarget];
  /** The doubling's working pair (absolute S, read texel by texel). */
  readonly ping: [THREE.RenderTarget, THREE.RenderTarget];
  /** Doubling passes: until a jump crosses the grid (after that the next grid answers). */
  readonly passes: number;
  /** Front (looked up) and back (being walked) mapping: centre xz and the height it is stored against. */
  readonly front = { centre: uniform(new THREE.Vector2(1e9, 1e9)), y0: uniform(0) };
  readonly back = { centre: uniform(new THREE.Vector2()), y0: uniform(0) };
  readonly frontTex: THREE.TextureNode;
  /** The job in progress: next pass (0 = start from one texel, 1..passes = doubling, passes + 1 = pack), or -1. */
  pass = -1;
  /** Light direction and centre the front was made for. */
  doneDir = new THREE.Vector3(0, -1, 0);
  ready = false;
  readonly readyU = uniform(0);
  /** When the heights were last drawn (ms), and round which centre. */
  heightsAt = -Infinity;
  heightsCentre = new THREE.Vector2(NaN, NaN);

  constructor(l: HeightShadowLevel) {
    this.size = l.size;
    this.res = l.res;
    this.texel = l.size / l.res;
    // Heights: exact, read texel by texel (no filtering), with depth so the top surface wins.
    this.height = new THREE.RenderTarget(l.res, l.res, { type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    // Shadow: R = S − surface, G = surface − y0. Half floats are enough (S − surface is small where it matters, at the edge) and filter.
    const make = () => new THREE.RenderTarget(l.res, l.res, { type: THREE.HalfFloatType, format: THREE.RGFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    this.shadow = [make(), make()];
    const work = () => new THREE.RenderTarget(l.res, l.res, { type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    this.ping = [work(), work()];
    this.passes = Math.ceil(Math.log2(l.res * 1.5));
    this.frontTex = texture(this.shadow[0].texture);
  }

  swap() {
    this.shadow.reverse();
    this.frontTex.value = this.shadow[0].texture;
    this.front.centre.value.copy(this.back.centre.value);
    this.front.y0.value = this.back.y0.value;
    this.ready = true;
    this.readyU.value = 1;
  }
}

export class HeightShadow {
  private levels: Level[];
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 6000);
  // (no blending: a 32-bit float target cannot blend, and a pipeline that asks for it is never ready, so nothing would be drawn)
  private heightMat = new THREE.MeshBasicNodeMaterial({ fog: false, blending: THREE.NoBlending });
  private initMat = quadMaterial();
  private stepMat = quadMaterial();
  private packMat = quadMaterial();
  private quad = new THREE.QuadMesh(this.initMat);
  /** Uniforms of the job being run. */
  private u = {
    dir: uniform(new THREE.Vector2(1, 0)),
    tan: uniform(0.2),
    centre: uniform(new THREE.Vector2()),
    size: uniform(1),
    res: uniform(1),
    y0: uniform(0),
    /** Texels of this pass's jump. */
    jump: uniform(1),
    /** The next coarser grid (its finished S), for what lies past this one's edge; `has` 0 when there is none yet. */
    outerCentre: uniform(new THREE.Vector2(1e9, 1e9)),
    outerSize: uniform(1),
    outerY0: uniform(0),
    has: uniform(0),
  };
  private heightTex: THREE.TextureNode;
  private srcTex: THREE.TextureNode;
  private outerTex: THREE.TextureNode;
  /** Underground places: (x, z, radius, the height below which it is underground); radius 0 = unused. */
  private underground = Array.from({ length: UNDERGROUND_SLOTS }, () => new THREE.Vector4(0, 0, 0, -1e9));
  private undergroundU = uniformArray(this.underground, 'vec4');
  /** Light direction (unit, towards the light), set every frame by Sky. */
  readonly light = uniform(new THREE.Vector3(0, 1, 0));

  constructor(settings: HeightShadowSettings) {
    this.levels = settings.levels.map((l) => new Level(l));
    this.cam.layers.set(TERRAIN_LAYER);
    this.cam.up.set(0, 0, -1);
    // fragmentNode, not colorNode: three clamps a material's colour output at 0 ("unsigned floats for render targets"), and heights,
    // like the shadow ceilings, go below it
    this.heightMat.fragmentNode = vec4(positionWorld.y, 0, 0, 1);
    this.heightTex = texture(this.levels[0].height.texture);
    this.srcTex = texture(this.levels[0].ping[0].texture);
    this.outerTex = texture(this.levels[0].shadow[0].texture);
    this.buildPasses();
  }

  /** The three quad passes: S0 (one texel up-sun), a doubling step, and the pack into the looked-up grid. */
  private buildPasses() {
    const u = this.u;
    // Texel (i, j) of every grid is world x = centre.x + ((i + 0.5)/res - 0.5)·size, z likewise with j. The fragment's own pixel position is
    // its texel, and the 32-bit grids (read texel by texel, not filtered) are read by texel index the same way.
    const pixel = () => screenCoordinate.xy.floor();
    const worldOf = (px: Node<'vec2'>) => u.centre.add(px.add(0.5).div(u.res).sub(0.5).mul(u.size));
    const texelOf = (q: Node<'vec2'>) => q.sub(u.centre).div(u.size).add(0.5).mul(u.res).floor();
    const load = (tex: THREE.TextureNode, t: Node<'vec2'>): F => (tex.load(ivec2(int(t.x), int(t.y))) as unknown as Node<'vec4'>).r as F;
    const inside = (t: Node<'vec2'>) => t.x.greaterThanEqual(0).and(t.y.greaterThanEqual(0)).and(t.x.lessThan(u.res)).and(t.y.lessThan(u.res));
    // past the edge: the coarser grid's whole answer from there on, or nothing
    const outerS = (q: Node<'vec2'>): F => {
      const o = this.outerTex.sample(toUv(q, u.outerCentre, u.outerSize)) as unknown as Node<'vec4'>;
      return u.has.greaterThan(0.5).select(o.r.add(o.g).add(u.outerY0), float(-1e6)) as F;
    };
    const texel = u.size.div(u.res);
    this.initMat.fragmentNode = Fn(() => {
      const q = worldOf(pixel()).add(u.dir.mul(texel)).toVar();
      const t = texelOf(q).toVar();
      const h = inside(t).select(load(this.heightTex, t.clamp(0, u.res.sub(1))), outerS(q));
      return vec4(h.sub(texel.mul(u.tan)), 0, 0, 1);
    })();
    this.stepMat.fragmentNode = Fn(() => {
      const px = pixel().toVar();
      const d = u.jump.mul(texel);
      const q = worldOf(px).add(u.dir.mul(d)).toVar();
      const t = texelOf(q).toVar();
      const far = inside(t).select(load(this.srcTex, t.clamp(0, u.res.sub(1))), outerS(q));
      return vec4(max(load(this.srcTex, px), far.sub(d.mul(u.tan))), 0, 0, 1);
    })();
    this.packMat.fragmentNode = Fn(() => {
      const px = pixel().toVar();
      const surface = load(this.heightTex, px);
      return vec4(load(this.srcTex, px).sub(surface), surface.sub(u.y0), 0, 1);
    })();
  }

  /**
   * Once, after `renderer.init()` and before anything is drawn: give every grid its GPU texture. A render target sampled before it was ever
   * drawn into gets a placeholder, which is destroyed when the target is first drawn, while the materials that sample it still hold it:
   * every frame then fails ("destroyed texture used in a submit") and the scene is not drawn at all.
   */
  init(renderer: THREE.WebGPURenderer) {
    const target = renderer.getRenderTarget();
    for (const l of this.levels) {
      for (const rt of [l.height, ...l.shadow, ...l.ping]) {
        renderer.setRenderTarget(rt);
        renderer.clear();
      }
    }
    renderer.setRenderTarget(target);
  }

  /** Every frame: start a level's job when it is due, run one pass of the one in progress. */
  update(renderer: THREE.WebGPURenderer, scene: THREE.Scene, focus: THREE.Vector3) {
    const light = this.light.value;
    if (light.y < 0.005) return; // the light is down: nothing is lit to shadow
    const horiz = Math.hypot(light.x, light.z);
    const tan = light.y / Math.max(horiz, 1e-4);
    // One job at a time: the level most overdue. A level is due when the player has left its centre, or the light has turned enough to
    // move the shadow of a tall dune by a third of its texel: at a low sun that is nearly always for the fine grid, which is then redone
    // over and over (a pass a frame), and every few seconds for the coarse ones.
    if (!this.levels.some((l) => l.pass >= 0)) {
      const sin = light.y;
      let best: Level | null = null, worst = 1;
      for (const l of this.levels) {
        const c = l.front.centre.value;
        const moved = Math.max(Math.abs(focus.x - c.x), Math.abs(focus.z - c.y)) / (l.size * RECENTRE);
        const allowed = ((l.texel / 3) * sin * sin) / TALL;
        // (a grid waits for the coarser one it reads past its edge)
        const outer = this.levels[this.levels.indexOf(l) + 1];
        const due = outer && !outer.ready ? 0 : !l.ready ? Infinity : Math.max(moved, l.doneDir.angleTo(light) / Math.max(allowed, 1e-6));
        if (due >= worst) {
          worst = due;
          best = l;
        }
      }
      if (best) this.start(best, renderer, scene, focus);
    }
    const l = this.levels.find((x) => x.pass >= 0);
    if (!l) return;
    const u = this.u;
    u.dir.value.set(light.x, light.z).normalize();
    u.tan.value = tan;
    u.centre.value.copy(l.back.centre.value);
    u.size.value = l.size;
    u.res.value = l.res;
    u.y0.value = l.back.y0.value;
    const outer = this.levels[this.levels.indexOf(l) + 1];
    u.has.value = outer?.ready ? 1 : 0;
    if (outer) {
      u.outerCentre.value.copy(outer.front.centre.value);
      u.outerSize.value = outer.size;
      u.outerY0.value = outer.front.y0.value;
      this.outerTex.value = outer.shadow[0].texture;
    }
    this.heightTex.value = l.height.texture;
    let target: THREE.RenderTarget;
    if (l.pass === 0) {
      this.quad.material = this.initMat;
      target = l.ping[0];
    } else if (l.pass <= l.passes) {
      this.quad.material = this.stepMat;
      u.jump.value = 2 ** (l.pass - 1);
      this.srcTex.value = l.ping[(l.pass - 1) % 2].texture;
      target = l.ping[l.pass % 2];
    } else {
      this.quad.material = this.packMat;
      this.srcTex.value = l.ping[l.passes % 2].texture;
      target = l.shadow[1];
    }
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
    renderer.setRenderTarget(previous);
    if (++l.pass > l.passes + 1) {
      l.pass = -1;
      l.doneDir.copy(light);
      l.swap();
    }
  }

  /** New centre (snapped to whole texels), the heights drawn top-down, and the walk set going. */
  private start(l: Level, renderer: THREE.WebGPURenderer, scene: THREE.Scene, focus: THREE.Vector3) {
    const snap = l.texel * 8;
    const c = l.front.centre.value;
    // keep the centre while the player is near it (a turn of the light only walks again, on the heights already drawn)
    const keep = l.ready && Math.max(Math.abs(focus.x - c.x), Math.abs(focus.z - c.y)) <= l.size * RECENTRE;
    const cx = keep ? c.x : Math.round(focus.x / snap) * snap, cz = keep ? c.y : Math.round(focus.z / snap) * snap;
    l.back.centre.value.set(cx, cz);
    l.back.y0.value = keep ? l.front.y0.value : heightAt(cx, cz);
    l.pass = 0;
    // the heights are drawn again for a new centre, or every few seconds (the terrain's detail changes as the player moves, sand is dug)
    const now = performance.now();
    if (l.heightsCentre.x === cx && l.heightsCentre.y === cz && now - l.heightsAt < HEIGHTS_EVERY_MS) return;
    l.heightsCentre.set(cx, cz);
    l.heightsAt = now;
    const half = l.size / 2;
    const cam = this.cam;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.position.set(cx, 3000, cz);
    cam.lookAt(cx, 0, cz);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const target = renderer.getRenderTarget();
    const override = scene.overrideMaterial;
    const clear = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha();
    const bg = scene.background;
    scene.overrideMaterial = this.heightMat;
    scene.background = null;
    renderer.setClearColor(new THREE.Color(l.back.y0.value - 200, 0, 0), 1); // (past the drawn terrain: low ground)
    // what should be drawn: the terrain chunks shown and in view (a chunk whose pipeline is still compiling is skipped by the renderer,
    // and would leave a hole of low ground in the heights: then it is all done again next frame)
    _frustum.setFromProjectionMatrix(_m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    let expected = 0;
    scene.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh && o.layers.isEnabled(TERRAIN_LAYER) && _frustum.intersectsObject(o)) expected++;
    });
    const info = renderer.info.render as unknown as { drawCalls: number };
    const before = info.drawCalls;
    renderer.setRenderTarget(l.height);
    renderer.render(scene, cam);
    renderer.setRenderTarget(target);
    const drawn = info.drawCalls - before;
    renderer.setClearColor(clear, alpha);
    scene.overrideMaterial = override;
    scene.background = bg;
    if (drawn < expected || expected === 0) {
      l.pass = -1;
      l.heightsAt = -Infinity;
    }
  }

  /** The underground places near the player (x, z, radius, top: below `top` within `radius` of x, z), at most UNDERGROUND_SLOTS. */
  setUnderground(places: { x: number; z: number; r: number; top: number }[]) {
    this.underground.forEach((v, i) => {
      const p = places[i];
      if (p) v.set(p.x, p.z, p.r, p.top);
      else v.set(0, 0, 0, -1e9);
    });
  }

  /** 0 (in the dunes' shadow) .. 1 (lit) for the fragment's world position, for every material the sun lights (CascadedShadows). */
  litNode(): F {
    return Fn(() => {
      const p = positionWorld;
      const lit = float(1).toVar();
      const covered = float(0).toVar();
      // underground (the base's rooms, a shelter's): nothing from the heightfield there
      let under: F = float(0);
      for (let i = 0; i < UNDERGROUND_SLOTS; i++) {
        const b = this.undergroundU.element(i) as unknown as Node<'vec4'>;
        under = max(under, step(p.xz.sub(b.xy).length(), b.z).mul(step(p.y, b.w))) as F;
      }
      const tan = this.light.y.div(max(vec2(this.light.x, this.light.z).length(), 1e-4));
      for (const l of this.levels) {
        // A steep wall facing the sun would find its own top a texel away and shadow itself: look it up a little out from the wall
        // (along the surface's horizontal normal; flat ground is not moved, so dune shadow edges stay where they are).
        const out = normalWorld.xz.mul(l.texel * WALL_OFFSET_TEXELS);
        const at = toUv(p.xz.add(out), l.front.centre, float(l.size)).toVar();
        const off = at.sub(0.5).abs();
        const edge = max(off.x, off.y).toVar(); // 0 at the centre, 0.5 at the edge
        const s = l.frontTex.sample(at) as unknown as Node<'vec4'>;
        const surface = s.g.add(l.front.y0);
        const ceiling = s.r.add(surface);
        const rise = tan.mul(l.texel);
        // above the ceiling (less a bias) is lit; a soft edge a texel of rise wide
        const value = smoothstep(rise.mul(-SOFT_TEXELS), rise.mul(SOFT_TEXELS), p.y.sub(ceiling).add(rise.mul(BIAS_TEXELS)));
        // this level's share: all of it inside, fading out over its edge, none if a finer level already covered the point
        const w = smoothstep(0.5, 0.5 - EDGE, edge).mul(float(1).sub(covered)).mul(l.readyU);
        lit.assign(lit.sub(w.mul(float(1).sub(value))));
        covered.addAssign(w);
      }
      return lit.max(under);
    })() as F;
  }
}

/** Grid uv of a world xz: u along x, v along z (texel rows grow with z: the camera draws with −z up the image, and row 0 is the top). */
function toUv(q: Node<'vec2'>, centre: Node<'vec2'>, size: Node<'float'>): Node<'vec2'> {
  return q.sub(centre).div(size).add(0.5);
}

/** A material for a full-screen pass into a float grid: no blending (32-bit floats cannot blend), no depth. */
function quadMaterial(): THREE.MeshBasicNodeMaterial {
  return new THREE.MeshBasicNodeMaterial({ fog: false, depthTest: false, depthWrite: false, blending: THREE.NoBlending });
}
