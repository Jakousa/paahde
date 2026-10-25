// Dev-only page (vite dev serves it; not in the build): flattens the models built in code (the wrench, the carried
// crash-site machines) into triangles and flat materials for tools/icons/render.py to render as icons.
// `window.dump()` resolves to { kind: { tris: number[], mats: [...], mat: number[] } } (positions in metres, Y-up).
import * as THREE from 'three/webgpu';
import { wrenchModel } from '../../src/models/wrench.ts';
import { buildJunk } from '../../src/teardown/junk.ts';
import type { JunkKind } from '../../shared/salvage.ts';

/** The carried machines (shared/items.ts), at a fixed seed and level so the icon never changes. */
const MACHINES: JunkKind[] = ['robot_arm', 'control_cabinet', 'winch', 'solenoid_valve', 'beacon'];

type Mat = { color: number; rough: number; metal: number; emit: number };

function flatten(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const mats: Mat[] = [];
  const key = new Map<string, number>();
  const tris: number[] = [];
  const mat: number[] = [];
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  root.traverseVisible((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material as THREE.MeshStandardMaterial;
    if (src.visible === false || (src.transparent && src.opacity < 0.3)) return;
    const em = src.emissive ? src.emissive.r + src.emissive.g + src.emissive.b : 0;
    const spec: Mat = { color: src.color?.getHex() ?? 0x888888, rough: src.roughness ?? 0.6, metal: src.metalness ?? 0, emit: em > 0.1 ? 1 : 0 };
    const k = JSON.stringify(spec);
    if (!key.has(k)) { key.set(k, mats.length); mats.push(spec); }
    const mi = key.get(k)!;
    const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
    const pos = g.attributes.position;
    const inst = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
    for (let n = 0; n < inst; n++) {
      m.copy(mesh.matrixWorld);
      if (inst > 1 || (mesh as THREE.InstancedMesh).isInstancedMesh) {
        const im = new THREE.Matrix4();
        (mesh as THREE.InstancedMesh).getMatrixAt(n, im);
        m.multiply(im);
      }
      for (let i = 0; i + 2 < pos.count; i += 3) {
        for (let j = 0; j < 3; j++) {
          v.fromBufferAttribute(pos, i + j).applyMatrix4(m);
          tris.push(+v.x.toFixed(5), +v.y.toFixed(5), +v.z.toFixed(5));
        }
        mat.push(mi);
      }
    }
  });
  return { tris, mats, mat };
}

(window as unknown as { dump: () => Promise<unknown> }).dump = async () => {
  const out: Record<string, unknown> = {};
  out.wrench = flatten(wrenchModel().obj);
  const junks = MACHINES.map((k) => [k, buildJunk(k, 7)] as const);
  // The parts inside are loaded glTFs: give them time to arrive.
  await new Promise((r) => setTimeout(r, 4000));
  for (const [k, j] of junks) out[k] = flatten(j.root);
  return out;
};
