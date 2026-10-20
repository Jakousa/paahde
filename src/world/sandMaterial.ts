// Desert sand surface (docs/look.md, docs/sand-rendering.md): Journey-style sand in TSL.
//
// A Lambert node material with a custom lighting model, so it still receives the scene's lights and
// shadow maps (the sky's DirectionalLight + HemisphereLight) but shades them like sand:
//   - contrast-boosted diffuse with a little Oren-Nayar back-scatter
//   - procedural wind ripples as normal perturbation (asymmetric profile, domain-warped, two octaves),
//     masked off slip faces and faded by screen footprint so they never alias
//   - ocean-like specular sheen at grazing angles (on the rippled normal) and a backlit rim on crests
//   - faint per-grain glitter (hashed microfacets in world-space cells, two scales, footprint-faded),
//     dulled by wind and dust
//   - a smooth, paler crest band (per-vertex `crest` from terrain.ts) where the ripples die out
//   - large-scale colour variation; slip faces slightly darker and smooth
//   - shadow/ambient fill pushed towards rust/maroon whatever colour the sky light is
//   - bare rock (per-vertex `rock` from terrain.ts, shared/rocks.ts): rust sandstone in beds, with dark
//     desert-varnish streaks down the faces, bumped by the same noise, and sand settled on its ledges;
//     no ripples, sheen or glitter there
//   - mud flats (per-vertex `mud` from terrain.ts, shared/biomes.ts): pale baked clay cracked into polygons at two
//     scales, plate edges curled up, cracks fading into their average darkening with distance; no ripples, sheen
//     or glitter there either. The cracks are only worked out where there is mud.
//
// Everything is a pure function of world position, camera and light, so it is stable when standing still.
// Tunables are exported TSL uniforms (`sand.*`): set `.value` at runtime, no recompile needed.
import * as THREE from 'three/webgpu';
import { graphics, onGraphics } from '../graphics.ts';
import {
  abs,
  attribute,
  cameraPosition,
  cameraWorldMatrix,
  cos,
  cross,
  dot,
  float,
  floor,
  Fn,
  fract,
  If,
  dFdx,
  dFdy,
  fwidth,
  length,
  max,
  mix,
  mx_cell_noise_float,
  mx_cell_noise_vec3,
  mx_fractal_noise_float,
  mx_noise_float,
  mx_worley_noise_vec2,
  normalize,
  normalLocal,
  normalWorldGeometry,
  positionLocal,
  positionWorld,
  pow,
  saturate,
  select,
  sign,
  sin,
  smoothstep,
  sqrt,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type Node from 'three/src/nodes/core/Node.js';
import { sandStorm, sunColor, windStrength } from './env.ts';
import { outsideTerrainHoles } from './base.ts';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;
/** Colour uniforms are vec3 in the shader; the typings just don't mix them with vec3 math. */
const c3 = (u: unknown) => u as V3;

/** How far (m) the dunes sink along their normal when drawn into the shadow map. The 0.5 m mesh's flat
 *  facets put the brink's self-shadow edge on triangle edges, which a 10° sun stretches into big saw
 *  teeth; sunk this far, a crest only shadows slope already past the smooth diffuse terminator, so that
 *  terminator draws the edge. Costs cast dune shadows ~0.15 / tan(10°) ≈ 0.9 m of length. */
const CASTER_SINK = 0.15;

/** Runtime tunables. Colours are linear. */
export const sand = {
  /** Unit xz vector the wind blows towards. Ripple crests run perpendicular to it; slip faces face it. */
  wind: uniform(new THREE.Vector2(0.8, 0.6).normalize()),
  /** Albedo of the redder / more golden sand patches (large-scale variation mixes between them). */
  albedoRed: uniform(new THREE.Color(0.66, 0.3, 0.12)),
  albedoGold: uniform(new THREE.Color(0.8, 0.46, 0.2)),
  /** Ambient (sky irradiance) is desaturated and re-tinted by this, so shadows stay rust, never blue. */
  shadowTint: uniform(new THREE.Color(1.0, 0.42, 0.26)),
  /** Fraction of the sun colour bounced into shadows by surrounding lit dunes. */
  bounce: uniform(0.05),
  /** Diffuse terminator: I = saturate(N·L * contrast + offset). */
  contrast: uniform(1.6),
  offset: uniform(0.2),
  /** Max normal slope of the small and large ripples. */
  rippleStrength: uniform(0.13),
  megaRippleStrength: uniform(0.03),
  /** Crest height (m) of the small ripples, for their self-shadowing: at a low sun each crest shadows the steep lee behind it. */
  rippleHeight: uniform(0.006),
  /** Footprint (ripple cycles per pixel) over which the small ripples fade out: the Sand detail option (RIPPLE_FADES). */
  rippleFade: uniform(new THREE.Vector2(0.2, 0.45)),
  /** Ocean specular and rim strengths. */
  sheen: uniform(0.02),
  rim: uniform(0.18),
  /** Colour of sheen and rim (warm, so highlights read as hot sand rather than wet white). */
  sheenTint: uniform(new THREE.Color(1.0, 0.62, 0.32)),
  /** Glitter intensity (HDR; values > 1 feed bloom). Dust in the air dulls it further. */
  glitter: uniform(2.5),
  /** Glitter colour: warm, so grains read as quartz in low sun rather than metal flakes. */
  glitterTint: uniform(new THREE.Color(1.0, 0.72, 0.42)),
  /** Rock albedo: the darker and paler sandstone beds, and the desert varnish streaking the faces. */
  rockDark: uniform(new THREE.Color(0.3, 0.12, 0.055)),
  rockLight: uniform(new THREE.Color(0.56, 0.28, 0.13)),
  varnish: uniform(new THREE.Color(0.12, 0.05, 0.03)),
  /** Height of one sandstone bed (m). */
  rockBed: uniform(1.4),
  /** Bump depth (m) of the rock's streaks and bed joints. */
  rockBump: uniform(0.25),
  /** Mud flat clay: the paler and darker baked crust, and the shadow down in its cracks. */
  mudLight: uniform(new THREE.Color(0.8, 0.67, 0.53)),
  mudDark: uniform(new THREE.Color(0.64, 0.51, 0.39)),
  mudCrack: uniform(new THREE.Color(0.16, 0.1, 0.06)),
};

// --- Mud flat cracks ------------------------------------------------------------------------------

/** Desiccation plates: small polygons (MUD_SMALL m across) inside big ones (MUD_BIG m) split by wider cracks. */
const MUD_SMALL = 0.5, MUD_BIG = 2.6;
/** Half-widths (m) of the small and big cracks. */
const MUD_SMALL_W = 0.008, MUD_BIG_W = 0.022;
/** How much of the ground each kind of crack covers on average (crack length per m² of a hexagonal-ish net,
 *  1.86 / cell size, times its full width): what a crack fades into once it is thinner than a pixel. */
const MUD_SMALL_COVER = (1.86 / MUD_SMALL) * 2 * MUD_SMALL_W, MUD_BIG_COVER = (1.86 / MUD_BIG) * 2 * MUD_BIG_W;

/** Distance (m) from a point to the nearest crack of a Voronoi net of `size` m cells: half the gap between the
 *  distances to the nearest two cell centres (exact on the line between them, a little short near corners). */
function crackDistance(q: V2, size: number, jitter: number): F {
  const f = mx_worley_noise_vec2(q.div(size), jitter) as V2; // squared distances, in cells
  return sqrt(f.y).sub(sqrt(f.x)).mul(size * 0.5);
}

/** Mud at (xz) with `fw` (m) the pixel footprint: x = crack cover (0..1, antialiased), y = bump height (m).
 *  Zero off the mud (`m` 0), where it skips the work. No derivatives in here: it runs in a branch. */
const mudCracks = Fn(([xz, fw, m]: [V2, F, F]) => {
  const out = vec2(0, 0).toVar();
  If(m.greaterThan(0.001), () => {
    // Wobble the net a few cm so the cracks wander instead of running ruler-straight.
    const warp = vec2(mx_noise_float(xz.mul(1.9)), mx_noise_float(xz.mul(1.9).add(31.7))).mul(0.05);
    const q = xz.add(warp);
    const eS = crackDistance(q, MUD_SMALL, 0.85);
    const eB = crackDistance(q.add(vec2(7.3, -3.1)), MUD_BIG, 1);
    // Big cracks open and close along their length.
    const wB = mx_noise_float(xz.mul(0.35).add(11.3)).mul(0.5).add(1).mul(MUD_BIG_W);
    // Antialiased crack, blended into its average cover once it is under a pixel wide.
    const aa = fw.mul(0.7).max(0.001);
    const cS = mix(float(1).sub(smoothstep(aa.negate(), aa, eS.sub(MUD_SMALL_W))), float(MUD_SMALL_COVER),
      smoothstep(MUD_SMALL_W, MUD_SMALL_W * 6, fw));
    const cB = mix(float(1).sub(smoothstep(aa.negate(), aa, eB.sub(wB))), float(MUD_BIG_COVER),
      smoothstep(MUD_BIG_W, MUD_BIG_W * 6, fw));
    // Plates curl up at their edges as they dry, then drop into the crack.
    const curl = smoothstep(0.07, 0.01, eS).mul(0.004).add(smoothstep(0.25, 0.02, eB).mul(0.012));
    const h = curl.sub(cS.mul(0.01)).sub(cB.mul(0.03));
    out.assign(vec2(max(cS, cB), h));
  });
  return out;
});

/** Sand detail (Options → Graphics): where the small ripples fade out, by footprint (cycles per pixel), Low / Medium / High / Ultra. */
export const RIPPLE_FADES: [number, number][] = [[0.08, 0.2], [0.15, 0.35], [0.22, 0.5], [0.32, 0.75]];
sand.rippleFade.value.set(...RIPPLE_FADES[graphics.sandDetail]);
onGraphics((g, changed) => changed === 'sandDetail' && sand.rippleFade.value.set(...RIPPLE_FADES[g.sandDetail]));

/** The dev test lab's floor (shared/lab.ts): a plain light grey, no ripples, glitter or sheen. */
export function labFloor() {
  sand.albedoRed.value.set(0.58, 0.58, 0.56);
  sand.albedoGold.value.set(0.62, 0.62, 0.6);
  sand.shadowTint.value.set(0.85, 0.88, 0.95);
  sand.sheenTint.value.set(1, 1, 1);
  sand.glitterTint.value.set(1, 1, 1);
  sand.rippleStrength.value = 0;
  sand.megaRippleStrength.value = 0;
  sand.sheen.value = 0;
  sand.rim.value = 0;
  sand.glitter.value = 0;
}

const PI = Math.PI;

// --- Ripples ---------------------------------------------------------------------------------------

/** Asymmetric ripple: rises gently over `a` of a cycle (stoss), drops steeply over the rest (lee).
 *  Returns [height 0..1, slope normalised so the lee face peaks at 1]. Smooth (C1) everywhere. */
function rippleProfile(s: F, a: number): [F, F] {
  const f = fract(s);
  const stoss = f.lessThan(a);
  const g = select(stoss, f.mul(0.5 / a), f.sub(a).mul(0.5 / (1 - a)).add(0.5));
  const gp = select(stoss, float(0.5 / a), float(0.5 / (1 - a)));
  const h = float(0.5).sub(cos(g.mul(2 * PI)).mul(0.5));
  const slope = sin(g.mul(2 * PI)).mul(gp).div(0.5 / (1 - a));
  return [h, slope];
}

/**
 * The ripple's slope (normalised like rippleProfile's) averaged over a pixel's footprint `fw` (cycles): the height difference across the
 * footprint over its width. Exact when the pixel is small, and it goes to 0 by itself once a pixel spans a whole ripple, so the ripples
 * can be drawn down to a few pixels each without shimmering (a plain slope aliases into moiré and dashes long before that).
 */
function filteredSlope(s: F, fw: F, a: number): F {
  const e = max(fw.mul(0.5), 1e-4);
  const [hp] = rippleProfile(s.add(e), a);
  const [hm] = rippleProfile(s.sub(e), a);
  return hp.sub(hm).div(e.mul(2)).mul((2 * (1 - a)) / PI);
}

/** Small ripples: wavelength (m) and the share of a cycle the gentle stoss side takes (the crest is at that phase). */
const RIPPLE_LENGTH = 0.11;
const RIPPLE_STOSS = 0.66;
/** Phases the far (unresolved) ripple shadow is averaged over. */
const MEAN_PHASES = 8;

/**
 * Sunlight left on the small ripples (0..1), from their own profile: walking from the point towards the sun along the ripple axis,
 * the first crest is `toCrest` away and `gap` higher; the point is shadowed when the sun ray rises less than that over the distance.
 * Exact for this profile, no marching. Unresolved (far) it becomes the share of a ripple left lit on average, so ripple fields still
 * darken and streak at a low sun far away. Where there are no ripples (rock, slip faces, crests) it is 1.
 */
/**
 * The sand's diffuse light averaged over one small-ripple cycle (eight phases), each phase with its own ripple normal and its own ripple
 * shadow: what a pixel spanning many ripples should show. The diffuse response (a hard terminator) is far from linear, so lighting the
 * averaged, flat normal instead came out darker than the ripples it stands for at a low sun, by how deep they were and how their crests
 * faced the sun: patches far away that faded as you came closer.
 */
function rippleMeanDiffuse(s: SandSurface, l: V3): F {
  const lAlong = dot(l.xz, s.rippleDir);
  const up = max(dot(l, s.n0), 1e-3);
  const tanE = up.div(max(abs(lAlong), 1e-3));
  const height = sand.rippleHeight.mul(s.rippleAmp);
  const toSun = lAlong.greaterThan(0);
  const crisp = sand.rippleHeight.mul(0.12);
  const dir3 = vec3(s.rippleDir.x, 0, s.rippleDir.y);
  const scale = sand.rippleStrength.mul(s.rippleAmp);
  let sum: F = float(0);
  for (let k = 0; k < MEAN_PHASES; k++) {
    const f = float((k + 0.5) / MEAN_PHASES);
    const [h, slope] = rippleProfile(f, RIPPLE_STOSS);
    const toCrest = select(toSun, fract(float(RIPPLE_STOSS).sub(f)), fract(f.sub(RIPPLE_STOSS))).mul(RIPPLE_LENGTH);
    const lit = smoothstep(crisp.negate(), crisp, toCrest.mul(tanE).sub(height.mul(float(1).sub(h))).add(crisp));
    const nk = normalize(s.nBase.sub(dir3.mul(slope.mul(scale))));
    sum = sum.add(saturate(dot(nk, l).mul(sand.contrast).add(sand.offset)).mul(lit)) as F;
  }
  return sum.div(MEAN_PHASES);
}

function rippleSun(s: SandSurface, l: V3): F {
  const lAlong = dot(l.xz, s.rippleDir);
  const up = max(dot(l, s.n0), 1e-3);
  const tanE = up.div(max(abs(lAlong), 1e-3)); // the sun's rise per metre along the ripple axis
  const height = sand.rippleHeight.mul(s.rippleAmp);
  const toSun = lAlong.greaterThan(0);
  // lit (0..1) at phase `f` (0..1 in the cycle) with an edge `pen` wide
  const litAt = (f: F, pen: F): F => {
    const [h] = rippleProfile(f, RIPPLE_STOSS);
    const toCrest = select(toSun, fract(float(RIPPLE_STOSS).sub(f)), fract(f.sub(RIPPLE_STOSS))).mul(RIPPLE_LENGTH);
    const gap = height.mul(float(1).sub(h));
    // (+ pen: on the crest itself toCrest and gap are both 0; without it the crest drew a thin half-shadowed line)
    return smoothstep(pen.negate(), pen, toCrest.mul(tanE).sub(gap).add(pen));
  };
  const crisp = sand.rippleHeight.mul(0.12);
  // the edge widens with the pixel's footprint (in height along the sun ray), so far shadows soften instead of breaking into dashes
  const foot = fwidth(s.ripplePhase).mul(RIPPLE_LENGTH);
  const sharp = litAt(fract(s.ripplePhase), max(crisp, foot.mul(tanE.add(height.mul(6 / RIPPLE_LENGTH))).mul(0.5)));
  // Unresolved, the same test averaged over the cycle (eight phases), so the far look is exactly what the near one averages to: an
  // estimate here darkened far ripple fields into blotches that faded as you walked up to them.
  let sum: F = float(0);
  for (let k = 0; k < MEAN_PHASES; k++) sum = sum.add(litAt(float((k + 0.5) / MEAN_PHASES), crisp)) as F;
  const mean = sum.div(MEAN_PHASES);
  return float(1).sub(s.rippleField.mul(float(1).sub(mix(mean, sharp, s.rippleRes))));
}

/** Fade for a periodic pattern whose phase (in cycles) is `s`: 1 when well resolved, 0 near Nyquist. Where it starts and ends (cycles
 *  per pixel) is the Sand detail option (`sand.rippleFade`): the ripples are filtered (filteredSlope), so it can go late. */
function footprintFade(s: F): F {
  return float(1).sub(smoothstep(sand.rippleFade.x, sand.rippleFade.y, fwidth(s)));
}

// --- Glitter ---------------------------------------------------------------------------------------

/** One scale of hashed mirror flakes in world-space cells of 1/D metres. */
function glitterLayer(p: V3, n: V3, h: V3, D: number, density: number, spread: number, eps: number, seed: number): F {
  const q = p.mul(D);
  const cell = floor(q).add(seed);
  const rPos = mx_cell_noise_vec3(cell);
  const rNrm = mx_cell_noise_vec3(cell.add(vec3(17, 59, 113)));
  const rAlive = mx_cell_noise_float(cell.add(vec3(71, 7, 31)));
  // A round flake somewhere inside the cell (the surface slices it, so apparent sizes vary).
  const shape = smoothstep(0.3, 0.08, length(fract(q).sub(rPos.mul(0.5).add(0.25))));
  const gn = normalize(n.add(rNrm.mul(2).sub(1).mul(spread)));
  const hit = smoothstep(1 - eps, 1, dot(gn, h));
  const alive = smoothstep(1 - density, 1 - density + 0.02, rAlive);
  // Cells smaller than ~a pixel turn into noise: fade them out.
  const lod = float(1).sub(smoothstep(0.35, 0.9, length(fwidth(q))));
  return hit.mul(shape).mul(alive).mul(lod);
}

// --- Material --------------------------------------------------------------------------------------

/** Per-fragment world-space quantities shared by the lighting model (built once, reused per light). */
interface SandSurface {
  p: V3; // world position
  n0: V3; // geometric (dune) normal
  n: V3; // rippled normal (diffuse)
  nSpec: V3; // rippled normal with stronger ripples (sheen)
  v: V3; // to camera
  albedo: V3;
  slip: F; // 1 on slip faces
  rock: F; // 1 on bare rock
  mud: F; // 1 on a mud flat
  dust: F; // 0..1 dust in the air (wind + storm): dulls glitter and sheen
  rippleVis: F; // how resolved the small ripples are here (0 far away / masked)
  dist: F;
  ripplePhase: F; // small ripples: phase in cycles along the wind
  rippleDir: V2; // the direction the phase grows in (the wind, bent with the crests)
  rippleField: F; // 0..1: whether there are small ripples here (not on rock, slip faces, crests)
  rippleAmp: F; // their depth here, 0..~1.3 of sand.rippleHeight
  nBase: V3; // the sand's normal without the small ripples
  rippleRes: F; // 0..1: how well the small ripples are resolved by the pixel
}

function buildSurface(): SandSurface {
  const p = positionWorld;
  const n0 = normalize(normalWorldGeometry);
  const wind = sand.wind;
  const perp = vec2(wind.y.negate(), wind.x);
  const xz = p.xz;
  const v = normalize(cameraPosition.sub(p));
  const dist = length(cameraPosition.sub(p));

  // Slip faces: steep and facing downwind. Smooth (avalanched) and a touch darker.
  const downwind = dot(n0.xz, wind).div(max(length(n0.xz), 1e-4));
  const steep = smoothstep(0.93, 0.86, n0.y);
  const slip = steep.mul(smoothstep(0.0, 0.5, downwind));
  const flatEnough = smoothstep(0.8, 0.92, n0.y);
  // Crest band: the brink and the few metres behind it are wind-scoured smooth, no ripples.
  const crest = attribute('crest', 'float') as F;
  const crestBand = smoothstep(0.35, 0.85, crest);
  const rock = attribute('rock', 'float') as F;
  const mud = attribute('mud', 'float') as F;

  const rippleMask = flatEnough.mul(float(1).sub(slip)).mul(float(1).sub(crestBand)).mul(float(1).sub(rock)).mul(float(1).sub(mud));

  // Domain warp (metres along the wind) so crests meander and bend. Its gradient makes the ripple
  // normal follow the bent crest direction: taken from screen-space derivatives (the warp varies over
  // metres, so it is linear across a pixel quad) instead of two more warp evaluations, which cost four
  // noise calls per pixel and were the bulk of the sand shader.
  const w0 = mx_noise_float(xz.mul(0.07)).mul(3.2).add(mx_noise_float(xz.mul(0.31).add(19.1)).mul(0.55));
  const along = dot(xz, wind);
  const across = dot(xz, perp);
  // The small ripples bend at a shorter scale too (crests wiggle every few tens of cm), and their phase slips along the crest
  // (a warp stretched across the wind): neighbouring crests drift apart and together, look as if they split and merge, and the
  // spacing varies, as on real sand.
  const wS = w0
    .add(mx_noise_float(xz.mul(1.4).add(41.3)).mul(0.035))
    .add(mx_noise_float(vec2(across.mul(1.6), along.mul(0.45)).add(8.9)).mul(0.1));
  const px = dFdx(xz);
  const py = dFdy(xz);
  const wx = dFdx(wS);
  const wy = dFdy(wS);
  // Solve [px; py]·∇w = [wx; wy] for the world-space gradient; edge-on (det ≈ 0) falls back to flat.
  const det = px.x.mul(py.y).sub(px.y.mul(py.x));
  const safe = select(abs(det).greaterThan(1e-10), det, float(1e10));
  const wdx = wx.mul(py.y).sub(wy.mul(px.y)).div(safe).clamp(-1, 1);
  const wdz = px.x.mul(wy).sub(py.x.mul(wx)).div(safe).clamp(-1, 1);
  const dir = normalize(vec2(wind.x.add(wdx), wind.y.add(wdz)));

  // Small ripples (~10 cm) and faint megaripples (~0.9 m, warped differently).
  const s1 = along.add(wS).div(RIPPLE_LENGTH);
  const [h1] = rippleProfile(s1, RIPPLE_STOSS);
  const d1 = filteredSlope(s1, fwidth(s1), RIPPLE_STOSS);
  const s2 = along.add(w0.mul(1.6)).add(mx_noise_float(vec2(across.mul(0.05), along.mul(0.02))).mul(2.5)).div(0.9);
  const [, d2] = rippleProfile(s2, 0.68);
  // Crest strength varies, so ripple fields fade in and out instead of tiling the whole dune.
  const vary = saturate(mx_noise_float(xz.mul(0.12).add(5.3)).mul(0.9).add(0.65))
    .mul(mx_noise_float(xz.mul(0.9).add(2.1)).mul(0.25).add(0.85));
  // Depth varies: deeper and shallower stretches over a metre or two, and crests that die out along their length.
  const depth = mx_noise_float(xz.mul(0.7).add(13.1)).mul(0.45).add(1).clamp(0.6, 1.35)
    .mul(smoothstep(-0.85, -0.1, mx_noise_float(vec2(across.mul(1.9), along.mul(0.5)).add(3.7))).mul(0.6).add(0.4));
  const amp = vary.mul(depth);
  const f1 = footprintFade(s1).mul(rippleMask).mul(amp);
  const f2 = footprintFade(s2).mul(rippleMask);
  const slope = d1.mul(sand.rippleStrength).mul(f1).add(d2.mul(sand.megaRippleStrength).mul(f2));
  // The sheen uses a higher power, so it aliases sooner: its ripples fade out earlier (f^2).
  const slopeSpec = d1.mul(sand.rippleStrength).mul(1.4).mul(f1).mul(f1).add(d2.mul(sand.megaRippleStrength).mul(f2).mul(f2));
  // Heightfield y = h(x,z) has normal (-hx, 1, -hz); apply the ripple gradient on top of the dune normal.
  const nSand = normalize(n0.sub(vec3(dir.x, 0, dir.y).mul(slope)));
  // without the small ripples (for averaging their light over a cycle where they are under a pixel)
  const nBase = normalize(n0.sub(vec3(dir.x, 0, dir.y).mul(d2.mul(sand.megaRippleStrength).mul(f2))));
  const nSpec = normalize(n0.sub(vec3(dir.x, 0, dir.y).mul(slopeSpec)));

  // Rock: one noise, stretched vertically, gives both the varnish streaks and (as a bump) the flutes
  // that weathering cuts down the faces; it also wobbles the beds so they don't read as ruled lines.
  const streak = mx_noise_float(vec3(p.x.mul(0.45), p.y.mul(0.09), p.z.mul(0.45)));
  const bedPos = p.y.div(sand.rockBed).add(streak.mul(0.45));
  const bed = fract(bedPos);
  const joint = smoothstep(0.14, 0.0, bed).add(smoothstep(0.88, 1.0, bed)); // groove between beds
  const layer = mx_cell_noise_float(vec3(floor(bedPos), 0, 0));
  const face = smoothstep(0.85, 0.5, n0.y); // steep rock
  // Bump map from screen-space derivatives (Mikkelsen), faded once the pattern nears pixel size.
  const bump = streak.mul(0.8).sub(joint.mul(0.25)).mul(sand.rockBump);
  const dpx = dFdx(p), dpy = dFdy(p);
  const r1 = cross(dpy, n0), r2 = cross(n0, dpx);
  const bdet = dot(dpx, r1);
  const bumped = (h: F, fade: F) => normalize(abs(bdet).mul(n0).sub(r1.mul(dFdx(h)).add(r2.mul(dFdy(h))).mul(sign(bdet)).mul(fade)));
  const footprint = length(fwidth(p));
  const nRock = bumped(bump, float(1).sub(smoothstep(0.15, 0.6, footprint)));

  // Mud flat: cracks and curled plates (bumped the same way, faded sooner: they are finer).
  const mudFx = mudCracks(xz, footprint, mud) as V2;
  const nMud = bumped(mudFx.y, float(1).sub(smoothstep(0.04, 0.2, footprint)));
  const n = normalize(mix(mix(nSand, nMud, mud), nRock, rock));

  // Albedo: large-scale red/gold patches, slip faces darker, ripple troughs a hair darker.
  const patch = saturate(mx_fractal_noise_float(vec3(p.x.mul(0.006), 0, p.z.mul(0.006)), 3).mul(0.9).add(0.5));
  // Grain speckle (~4 cm) keeps nearby sand matte and gritty instead of smooth, faded once cells get
  // near pixel size. (A finer ~1 cm layer was dropped: a noise call per pixel for detail few notice.)
  const gq2 = p.mul(24);
  const grainFade2 = float(1).sub(smoothstep(0.3, 0.8, length(fwidth(gq2))));
  // Smooth value noise rather than cell noise: cell noise reads as square pixels up close.
  const grain = mx_noise_float(gq2.add(7.1)).mul(0.16).mul(grainFade2).add(1);
  const albedo = mix(sand.albedoRed, sand.albedoGold, patch)
    .mul(grain)
    .mul(float(1).sub(slip.mul(0.12)))
    .mul(float(1).sub(float(1).sub(h1).mul(f1).mul(0.03)))
    .mul(float(1).add(crestBand.mul(0.06))); // fine, sorted sand on the crest is a touch paler
  const dust = windStrength.mul(0.35).add(sandStorm.mul(0.65)).min(1);

  const rockAlbedo = mix(c3(sand.rockDark), c3(sand.rockLight), layer.mul(0.65).add(streak.mul(0.2)).add(0.25).clamp(0, 1))
    .mul(float(1).sub(joint.mul(0.18)))
    .mul(grain);
  const varnished = mix(rockAlbedo, c3(sand.varnish), smoothstep(0.05, 0.6, streak).mul(face).mul(0.55));
  // Wind-blown sand settles on ledges and flat tops.
  const dusted = mix(varnished, albedo, smoothstep(0.86, 0.97, n0.y).mul(0.7));

  // Baked clay, blotchy over metres, darker down the cracks.
  const mudAlbedo = mix(c3(sand.mudDark), c3(sand.mudLight), saturate(patch.mul(0.7).add(mx_noise_float(xz.mul(0.4).add(3.3)).mul(0.35)).add(0.15)))
    .mul(grain.sub(1).mul(0.5).add(1))
    .mul(float(1).sub(mudFx.x));
  const ground = mix(albedo, mudAlbedo.add(c3(sand.mudCrack).mul(mudFx.x)), mud);

  return {
    p, n0, n, nSpec, v, albedo: mix(ground, dusted, rock), slip, rock, mud, dust, dist, rippleVis: f1,
    ripplePhase: s1, rippleDir: dir, rippleField: rippleMask, rippleAmp: amp, rippleRes: footprintFade(s1), nBase,
  };
}

class SandLightingModel extends THREE.LightingModel {
  private s: SandSurface;

  constructor(s: SandSurface) {
    super();
    this.s = s;
  }

  direct(input: THREE.LightingModelDirectInput) {
    const lightDirection = input.lightDirection as V3;
    const lightColor = input.lightColor as V3;
    const directDiffuse = input.reflectedLight.directDiffuse as V3;
    const directSpecular = input.reflectedLight.directSpecular as V3;
    const { p, n0, n, nSpec, v, albedo, slip, rock, mud, dust, dist, rippleVis } = this.s;
    const bare = float(1).sub(max(rock, mud)); // sand, not rock or clay: sheen and glitter
    // Light direction arrives in view space; the sand works in world space.
    const l = normalize(cameraWorldMatrix.mul(vec4(lightDirection, 0)).xyz);
    const ndl = dot(n, l);

    // Journey "diffuse contrast": hard, bright terminator. Plus Fujii/Oren-Nayar back-scatter:
    // sand glows when the sun is behind the viewer and flattens when looking into it.
    const ndv = saturate(dot(n, v));
    const sON = dot(l, v).sub(saturate(ndl).mul(ndv));
    const tON = select(sON.greaterThan(0), max(max(saturate(ndl), ndv), 1e-3), float(1));
    // s/t blows up at grazing views (t -> 0); clamp it, since I is not multiplied by N·L here.
    const on = float(0.75).add(sON.div(tON).clamp(-1, 1.2).mul(0.3));
    // the ripples' own shadows (the sun ray grazes over one crest onto the lee of the next)
    const ripSun = rippleSun(this.s, l);
    // Resolved ripples are lit pixel by pixel; unresolved, by their light averaged over a cycle (rippleMeanDiffuse), so the sand looks the
    // same from near and far. (Off the ripples, rock, slip faces, crests: just the pixel.)
    const nearI = saturate(ndl.mul(sand.contrast).add(sand.offset)).mul(ripSun);
    const farI = rippleMeanDiffuse(this.s, l);
    const I = mix(nearI, farI, this.s.rippleField.mul(float(1).sub(this.s.rippleRes))).mul(on);
    directDiffuse.addAssign(lightColor.mul(albedo).mul(I).mul(1 / PI));

    // Ocean specular on the rippled normal (reads when looking towards the sun), boosted at grazing.
    const h = normalize(v.add(l));
    const grazing = pow(float(1).sub(saturate(dot(n0, v))), 2).mul(0.7).add(0.3);
    // Forward-scattering: it lives on the sun side of the view.
    const sunSide = smoothstep(-0.3, 0.5, dot(v.negate(), l));
    const ocean = pow(saturate(dot(nSpec, h)), 90).mul(grazing).mul(sunSide).mul(rippleVis.mul(0.8).add(0.2)).mul(sand.sheen).mul(float(1).sub(slip.mul(0.6)));
    // Backlit rim: silhouettes/crests seen against the sun glow (forward scatter through edge grains).
    const toSun = saturate(dot(v.negate(), l));
    const rim = pow(float(1).sub(saturate(dot(n0, v))), 4)
      .mul(pow(toSun, 3))
      .mul(saturate(ndl.add(0.35)))
      .mul(sand.rim);
    const spec = c3(sand.sheenTint).mul(max(ocean.mul(float(1).sub(dust.mul(0.6))).mul(bare), rim));

    // Glitter: only in sunlight, fades out with distance (and per-cell footprint inside the layers).
    const lit = saturate(ndl.mul(5));
    const near = float(1).sub(smoothstep(6, 25, dist));
    // Anisotropic masking (Journey): at grazing views a flake's footprint smears into a horizontal streak.
    const facing = smoothstep(0.12, 0.35, dot(n0, v));
    const g = glitterLayer(p, n0, h, 55, 0.1, 0.75, 0.008, 0)
      .add(glitterLayer(p, n0, h, 18, 0.06, 0.6, 0.005, 101).mul(0.3))
      .mul(lit)
      .mul(near)
      .mul(facing)
      .mul(float(1).sub(slip.mul(0.7)))
      .mul(bare)
      .mul(float(1).sub(dust.mul(0.7)))
      .mul(sand.glitter);

    directSpecular.addAssign(lightColor.mul(spec.add(c3(sand.glitterTint).mul(g)).mul(ripSun)));
  }

  indirect(builder: THREE.NodeBuilder) {
    const ctx = builder.context as {
      irradiance: V3;
      ambientOcclusion: F;
      reflectedLight: { indirectDiffuse: V3 };
    };
    const { albedo } = this.s;
    // Keep the sky's brightness but force a warm rust hue, plus a little sun bounce from lit dunes.
    const irr = ctx.irradiance;
    const lum = dot(irr, vec3(0.2126, 0.7152, 0.0722));
    const tint = c3(sand.shadowTint);
    const fill = mix(irr, tint.mul(lum), 0.75).add(c3(sunColor).mul(tint).mul(sand.bounce));
    ctx.reflectedLight.indirectDiffuse.addAssign(fill.mul(albedo).mul(1 / PI).mul(ctx.ambientOcclusion));
  }
}

class SandNodeMaterial extends THREE.NodeMaterial {
  private surface = buildSurface();

  constructor() {
    super();
    this.lights = true;
    // Fog/shadow still come from the scene; colour is computed in the lighting model. vec4: the shadow
    // pass takes the caster's alpha from colorNode.a, and a vec3 there keeps the dunes out of the map.
    this.colorNode = vec4(this.surface.albedo, 1);
    this.castShadowPositionNode = positionLocal.sub(normalLocal.mul(CASTER_SINK));
    // No sand (nor its shadow) over the base's entrance and skylight.
    this.maskNode = outsideTerrainHoles();
  }

  setupLightingModel() {
    return new SandLightingModel(this.surface);
  }
}

export function createSandMaterial(): THREE.NodeMaterial {
  return new SandNodeMaterial();
}
