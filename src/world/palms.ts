// Decorative palm trees near spawn: one of each growth stage (models from tools/blender/palm.py).
// Client-side only — no collision, nothing synced. Placed at the initial terrain height; if someone
// digs underneath, they float (fine for decoration).
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SPAWN } from '../../shared/sim.ts';
import { heightAt } from '../../shared/terrain.ts';

/** Offsets from spawn (the start view looks towards -Z), yaw in radians. */
const PALMS = [
  { url: './models/palm_full.glb', dx: -8, dz: -9, yaw: 0.6 },
  { url: './models/palm_young.glb', dx: 6, dz: -7.5, yaw: 2.1 },
  { url: './models/palm_sapling.glb', dx: 1.8, dz: -6, yaw: 4.0 },
];

/** Sink the trunk base a little so it never hovers on a slope. */
const SINK = 0.08;

export function addPalms(scene: THREE.Scene) {
  const loader = new GLTFLoader();
  for (const p of PALMS) {
    loader.load(
      p.url,
      (gltf) => {
        const root = gltf.scene;
        const x = SPAWN.x + p.dx, z = SPAWN.z + p.dz;
        root.position.set(x, heightAt(x, z) - SINK, z);
        root.rotation.y = p.yaw;
        root.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
        });
        scene.add(root);
      },
      undefined,
      (err) => console.warn(`palm: failed to load ${p.url}`, err),
    );
  }
}
