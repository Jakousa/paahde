// The hardware of the model-built machines (tools/blender/machines/hardware.py, public/models/machines/hardware.glb): bolts, screws,
// latches, clamps, pins, fittings and the plugs and sockets of the cables. Each is a node, merged into one lit mesh
// (src/world/bossParts.ts mergePart), `at` its pivot in the file: the part that turns or slides (`<Name>_Spin`) is placed there, the
// seat (`<Name>`) at the step's own origin. Loaded once; a step is built at once and dressed when the file has arrived.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergePart } from '../world/bossParts.ts';

export interface HardwarePart {
  obj: THREE.Object3D;
  /** Where it turns or slides about, in the step's frame (metres). */
  at: THREE.Vector3;
}

const loader = new GLTFLoader();
let cache: Promise<Map<string, HardwarePart>> | null = null;

export function hardware(): Promise<Map<string, HardwarePart>> {
  cache ??= loader.loadAsync('./models/machines/hardware.glb').then((gltf) => {
    const out = new Map<string, HardwarePart>();
    for (const n of [...gltf.scene.children]) out.set(n.name, { at: n.position.clone(), obj: mergePart(n) });
    return out;
  });
  return cache;
}
