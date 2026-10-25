// glTF materials as node materials, for the models put up in the world (the placed things, src/world/placed.ts; the
// shelters' pumps, src/world/shelters.ts): out on the sand lit by the scene, indoors by a set of lights of their own.
import * as THREE from 'three/webgpu';
import type { LightsNode } from 'three/webgpu';

/** Indoors, never quite dark: emissive fraction of each surface's own colour. */
const GLOW = 0.03;

/** A node copy of a glTF material, lit by `lit` (indoor lights) if given, else by the scene; glass (a name starting
 *  'Glass') see-through, emissive bits ('Emit...') glowing. */
export function glbMaterial(src: THREE.Material, lit: LightsNode | null = null): THREE.Material {
  const s = src as THREE.MeshStandardMaterial;
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = s.name;
  m.color.copy(s.color);
  m.roughness = s.roughness;
  m.metalness = s.metalness;
  m.side = s.side;
  m.vertexColors = s.vertexColors;
  if (lit) {
    m.lightsNode = lit;
    m.emissive.copy(s.color).multiplyScalar(GLOW);
  }
  if (s.name.startsWith('Glass')) {
    m.transparent = true;
    m.opacity = 0.22;
    m.depthWrite = false;
    m.side = THREE.DoubleSide;
    m.roughness = 0.05;
    m.metalness = 0;
  } else if (s.name.startsWith('Emit')) {
    m.emissive.copy(s.emissive);
    m.emissiveIntensity = Math.max(s.emissiveIntensity, 2);
  }
  return m;
}
