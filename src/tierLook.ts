// What gear looks like by tier (shared/gear.ts tierOf: its parts' quality rounded down), on every model of it: in your
// hands, on anyone's body or bike, lying on the sand. The same language as the parts' own models (tools/blender/items.py):
//   0 Scrap        rust blotches eating the paint and metal, cloth sun-bleached and stained; its lamps weak
//   1 Basic        the model as made
//   2 Quality      polished: smoother, the metal brighter and warmer (brass), cloth richer; lamps orange
//   3 Space-grade  pale and sleek (cloth an off-white weave), a cold cyan sheen along its edges, lamps cyan
// applyTier() swaps each mesh's material for its tier's variant of it (made once per material and tier, shared by every
// model using it) and back; the model's own materials are kept in userData.tierBase. A mesh or material with
// userData.noTier keeps its own (a bike's headlight, the player's colour).
import * as THREE from 'three/webgpu';
import {
  abs, clamp, color, dot, float, materialColor, materialEmissive, materialMetalness, materialRoughness, max, mix, mx_noise_float,
  normalView, positionGeometry, positionViewDirection, pow, smoothstep, vec3,
} from 'three/tsl';

const RUST = color(0x7a3a1a);
const RUST_DARK = color(0x3e1d0e);
const BRASS = color(0xc9a24a);
const BRASS_LUM = (() => {
  const c = new THREE.Color(0xc9a24a);
  return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b;
})();
const PALE = color(0xe9ecee);
const GUNMETAL = color(0x3b4048);
/** Lamp colours by tier (shared/salvage.ts RARITY, but Basic keeps the model's own). */
const LAMP = [color(0xb0703a), null, color(0xff9a3c), color(0x3ff0ff)];
/** The model's own colour: colour × map (a vec4 when there's a map: everything here wants its rgb). */
const BASE = materialColor.rgb;
/** How far each tier's look goes from the model as made (colour, roughness, metalness, edge sheen; lamps take their
 *  tier's colour whatever this is): 1 the full look, 0 none. */
const STRENGTH = 0.6;
/** Rust patches per metre of the model. */
const RUST_SCALE = 11;

type Std = THREE.MeshStandardMaterial;
const variants = new WeakMap<THREE.Material, (THREE.Material | null)[]>();

/** Give every mesh under `root` the look of `tier` (0..3). Cheap when nothing changed, so it can run every frame (and
 *  catches meshes of a model that loaded since). */
export function applyTier(root: THREE.Object3D, tier: number) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.rim || mesh.userData.noTier || mesh.userData.tierShown === tier) return;
    mesh.userData.tierShown = tier;
    const base = (mesh.userData.tierBase ??= mesh.material) as THREE.Material | THREE.Material[];
    mesh.material = Array.isArray(base) ? base.map((m) => variant(m, tier)) : variant(base, tier);
  });
}

function variant(m: THREE.Material, tier: number): THREE.Material {
  if (tier === 1 || m.userData.noTier || !((m as Std).isMeshStandardMaterial || (m as { isMeshStandardNodeMaterial?: boolean }).isMeshStandardNodeMaterial)) return m;
  let v = variants.get(m);
  if (!v) variants.set(m, (v = [null, null, null, null]));
  return (v[tier] ??= make(m as Std, tier));
}

function make(src: Std, tier: number): THREE.Material {
  const m = new THREE.MeshStandardNodeMaterial();
  for (const k of ['color', 'emissive'] as const) m[k].copy(src[k]);
  for (const k of ['roughness', 'metalness', 'emissiveIntensity', 'opacity', 'alphaTest', 'transparent', 'side', 'vertexColors',
    'flatShading', 'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'depthWrite'] as const) {
    (m as unknown as Record<string, unknown>)[k] = src[k];
  }
  m.normalScale.copy(src.normalMap ? src.normalScale : m.normalScale);
  // Lit like the original (a thing in the bunker by its indoor lights, src/world/base.ts).
  const lights = (src as unknown as THREE.MeshStandardNodeMaterial).lightsNode;
  if (lights) m.lightsNode = lights;
  m.name = `${src.name}#${tier}`;
  const glows = src.emissive.getHex() !== 0 && src.emissiveIntensity > 0;
  const lamp = LAMP[tier];
  // A lamp keeps its brightness but takes the tier's colour.
  const lampEmissive = lamp ? lamp.mul(max(materialEmissive.x, max(materialEmissive.y, materialEmissive.z))) : materialEmissive;
  const edge = pow(float(1).sub(clamp(abs(dot(normalView, positionViewDirection)), 0, 1)), 3);
  // Hard (metal, or smooth: plastic, paint on metal) wears and shines like metal; soft (cloth, leather, rubber) like
  // fabric: rust and brass only go on the hard parts.
  // (Baked atlases, like the player's, carry in-between metalness over cloth: only clear metal counts.)
  const metal = smoothstep(0.5, 0.85, materialMetalness);
  const hard = max(metal, smoothstep(0.75, 0.45, materialRoughness));
  const lum = dot(BASE, vec3(0.3, 0.59, 0.11));
  if (tier === 0) {
    // The mesh's own vertex positions, before skinning: on a worn backpack the wear rides with the cloth instead of
    // the cloth sliding through it as the bones move.
    const n = mx_noise_float(positionGeometry.mul(RUST_SCALE)).mul(0.5).add(0.5);
    const fine = mx_noise_float(positionGeometry.mul(RUST_SCALE * 5)).mul(0.5).add(0.5);
    // (Perlin noise keeps near the middle of its range: a narrow step makes blotches with edges, not a wash.)
    const blotch = smoothstep(0.53, 0.6, n.add(fine.sub(0.5).mul(0.2)));
    // Metal: rust eating through the paint.
    const rusty = mix(BASE.mul(0.8).add(vec3(0.04, 0.02, 0)), mix(RUST_DARK, RUST, fine), blotch.mul(0.85));
    // Cloth: faded towards a drab grey-tan, with grimy stains.
    const drab = mix(BASE, vec3(lum).mul(vec3(1.05, 1.0, 0.88)), 0.45).mul(0.85);
    const grimy = mix(drab, drab.mul(0.55), smoothstep(0.54, 0.6, n.add(fine.sub(0.5).mul(0.3))).mul(0.7));
    m.colorNode = mix(BASE, mix(grimy, rusty, hard), STRENGTH);
    const wear = blotch.mul(hard);
    m.roughnessNode = mix(materialRoughness, max(materialRoughness, mix(float(0.78), float(0.95), wear)), STRENGTH);
    m.metalnessNode = mix(materialMetalness, materialMetalness.mul(float(1).sub(wear.mul(0.85))), STRENGTH);
    if (glows) m.emissiveNode = lampEmissive.mul(0.45);
  } else if (tier === 2) {
    // Metal polished and brass-warm; cloth a little richer and darker (new, oiled leather, dyed canvas).
    const rich = mix(vec3(lum), BASE, 1.3).mul(1.05);
    const brassy = BRASS.mul(lum.div(BRASS_LUM)); // brass at the surface's own brightness
    m.colorNode = mix(BASE, mix(mix(rich, BASE, hard), brassy, metal.mul(0.5)), STRENGTH);
    m.roughnessNode = mix(materialRoughness, mix(materialRoughness.mul(0.92), materialRoughness.mul(0.6), hard), STRENGTH);
    m.metalnessNode = mix(materialMetalness, mix(materialMetalness, float(1), metal.mul(0.5)), STRENGTH);
    m.emissiveNode = glows ? lampEmissive : vec3(1, 0.55, 0.2).mul(edge.mul(hard).mul(0.1 * STRENGTH));
  } else {
    // Hard parts: light ones pale, dark ones gunmetal. Cloth: an off-white technical weave. A cold sheen along it all.
    const panel = mix(GUNMETAL, PALE, smoothstep(0.08, 0.3, lum)).mul(0.6).add(BASE.mul(0.4));
    const weave = mix(BASE, PALE.mul(0.8), 0.4);
    m.colorNode = mix(BASE, mix(weave, panel, hard), STRENGTH);
    m.roughnessNode = mix(materialRoughness, mix(materialRoughness.mul(0.85), clamp(materialRoughness.mul(0.5).add(0.08), 0, 1), hard), STRENGTH);
    m.metalnessNode = mix(materialMetalness, mix(materialMetalness, float(0.6), hard.mul(0.5)), STRENGTH);
    const sheen = vec3(0.25, 0.94, 1).mul(edge.mul(0.35 * STRENGTH));
    m.emissiveNode = glows ? lampEmissive.mul(1.3).add(sheen) : sheen;
  }
  return m;
}
