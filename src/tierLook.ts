// What gear looks like by tier (shared/gear.ts tierOf: its parts' quality rounded down), on every model of it: in your
// hands, on anyone's body or bike, lying on the sand. The same language as the parts' own models (tools/blender/items.py):
//   0 Scrap        rust blotches eating the paint and metal, dull and rough; its lamps weak
//   1 Basic        the model as made
//   2 Quality      polished: smoother, the metal brighter and warmer (brass), lamps orange
//   3 Space-grade  pale and sleek, a cold cyan sheen along its edges, lamps cyan
// applyTier() swaps each mesh's material for its tier's variant of it (made once per material and tier, shared by every
// model using it) and back; the model's own materials are kept in userData.tierBase. A mesh or material with
// userData.noTier keeps its own (a bike's headlight, the player's colour).
import * as THREE from 'three/webgpu';
import {
  abs, clamp, color, dot, float, materialColor, materialEmissive, materialMetalness, materialRoughness, max, mix, mx_noise_float,
  normalView, positionLocal, positionViewDirection, pow, smoothstep, vec3,
} from 'three/tsl';

const RUST = color(0x7a3a1a);
const RUST_DARK = color(0x3e1d0e);
const BRASS = color(0xc9a24a);
const PALE = color(0xe9ecee);
const GUNMETAL = color(0x3b4048);
/** Lamp colours by tier (shared/salvage.ts RARITY, but Basic keeps the model's own). */
const LAMP = [color(0xb0703a), null, color(0xff9a3c), color(0x3ff0ff)];
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
  m.name = `${src.name}#${tier}`;
  const glows = src.emissive.getHex() !== 0 && src.emissiveIntensity > 0;
  const lamp = LAMP[tier];
  // A lamp keeps its brightness but takes the tier's colour.
  const lampEmissive = lamp ? lamp.mul(max(materialEmissive.x, max(materialEmissive.y, materialEmissive.z))) : materialEmissive;
  const edge = pow(float(1).sub(clamp(abs(dot(normalView, positionViewDirection)), 0, 1)), 3);
  if (tier === 0) {
    const n = mx_noise_float(positionLocal.mul(RUST_SCALE)).mul(0.5).add(0.5);
    const fine = mx_noise_float(positionLocal.mul(RUST_SCALE * 5)).mul(0.5).add(0.5);
    // (Perlin noise keeps near the middle of its range: a narrow step makes blotches with edges, not a wash.)
    const rust = smoothstep(0.53, 0.6, n.add(fine.sub(0.5).mul(0.2)));
    const tired = materialColor.mul(0.8).add(vec3(0.04, 0.02, 0));
    m.colorNode = mix(tired, mix(RUST_DARK, RUST, fine), rust.mul(0.85));
    m.roughnessNode = max(materialRoughness, mix(float(0.78), float(0.95), rust));
    m.metalnessNode = materialMetalness.mul(float(1).sub(rust.mul(0.85)));
    if (glows) m.emissiveNode = lampEmissive.mul(0.45);
  } else if (tier === 2) {
    const metal = smoothstep(0.3, 0.7, materialMetalness);
    m.colorNode = mix(materialColor, materialColor.mul(BRASS).mul(1.6), metal.mul(0.45));
    m.roughnessNode = materialRoughness.mul(0.6);
    m.metalnessNode = mix(materialMetalness, float(1), metal.mul(0.5));
    m.emissiveNode = glows ? lampEmissive : vec3(1, 0.55, 0.2).mul(edge.mul(0.06));
  } else {
    // Light surfaces go pale, dark ones gunmetal; a cold sheen along the outline.
    const lum = dot(materialColor, vec3(0.3, 0.59, 0.11));
    m.colorNode = mix(GUNMETAL, PALE, smoothstep(0.08, 0.3, lum)).mul(0.6).add(materialColor.mul(0.4));
    m.roughnessNode = clamp(materialRoughness.mul(0.5).add(0.08), 0, 1);
    m.metalnessNode = mix(materialMetalness, float(0.6), 0.5);
    const sheen = vec3(0.25, 0.94, 1).mul(edge.mul(0.35));
    m.emissiveNode = glows ? lampEmissive.mul(1.3).add(sheen) : sheen;
  }
  return m;
}
