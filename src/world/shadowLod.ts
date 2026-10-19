// Casters too small for a far cascade are not drawn into it. A cascade's texel is metres wide out there (about 1.8 m in the third,
// 7 m in the last), so a barrel's or a player's shadow is a fraction of a texel: nothing visible, but a draw call in every redraw of
// the cascade. Each caster gets a layer bit per cascade it is big enough for (by the world radius of its bounding sphere), and those
// cascades' shadow cameras only see their own bit (src/world/sky.ts). Bits are set by a scan of the scene every few frames, and
// cached on the object; things that are always big (terrain chunks) are tagged where they are made (`tagBig`).
import * as THREE from 'three/webgpu';

/** The layer bit of casters big enough for cascade `i`, for the cascades that cull (the first two take everything). */
export const SHADOW_LOD_FIRST = 2;
export const lodLayer = (i: number) => 4 + i;

const SCAN_EVERY = 8;
const _s = new THREE.Vector3();

/** Always big: in every culling cascade. */
export function tagBig(o: THREE.Object3D, cascades = 4) {
  for (let i = SHADOW_LOD_FIRST; i < cascades; i++) o.layers.enable(lodLayer(i));
  o.userData.lodBig = true;
}

export class ShadowLod {
  private frame = 0;

  /** `minRadius[i]`: the smallest bounding-sphere radius (m) drawn into cascade i (undefined below SHADOW_LOD_FIRST). */
  update(scene: THREE.Object3D, minRadius: number[]) {
    if (++this.frame % SCAN_EVERY) return;
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.castShadow || o.userData.lodBig) return;
      let r = o.userData.lodR as number | undefined;
      if (r === undefined || (m as THREE.InstancedMesh).isInstancedMesh) {
        const im = m as THREE.InstancedMesh;
        let sphere: THREE.Sphere | null;
        if (im.isInstancedMesh) {
          if (!im.boundingSphere) im.computeBoundingSphere();
          sphere = im.boundingSphere;
        } else {
          if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
          sphere = m.geometry.boundingSphere;
        }
        _s.setFromMatrixScale(m.matrixWorld);
        r = (sphere?.radius ?? 0) * Math.max(_s.x, _s.y, _s.z);
        o.userData.lodR = r;
      }
      for (let i = SHADOW_LOD_FIRST; i < minRadius.length; i++) {
        if (r >= minRadius[i]) o.layers.enable(lodLayer(i));
        else o.layers.disable(lodLayer(i));
      }
    });
  }
}
