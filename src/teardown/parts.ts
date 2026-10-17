// The mechanical and switching parts that have no Blender model yet (PartId impeller, bearing, gear, valve,
// relay), built in code. Same four tiers as the item models: scrap is rusty, basic plain steel, quality chrome
// with brass, space white and gunmetal with cyan glow. Each has its origin at the centre of its base and its
// axis along +y, at most PART_SIZE across.
import * as THREE from 'three/webgpu';
import type { PartId, Tier } from '../../shared/salvage.ts';

export const EXTRA_PARTS: PartId[] = ['impeller', 'bearing', 'gear', 'valve', 'relay'];
/** Height of each along its axis: where its centre sits, for mounting it on a shaft. */
export const THICKNESS: Partial<Record<PartId, number>> = { bearing: 0.22, gear: 0.14, impeller: 0.34, valve: 0.5, relay: 0.3 };

const STYLE: Record<Tier, { main: number; metal: number; rough: number; accent: number; glow: number }> = {
  scrap: { main: 0x6e5238, metal: 0.55, rough: 0.92, accent: 0x4a3322, glow: 0 },
  basic: { main: 0x8d9298, metal: 0.8, rough: 0.5, accent: 0x474c52, glow: 0 },
  quality: { main: 0xd6d9dd, metal: 1, rough: 0.2, accent: 0xc9a14a, glow: 0 },
  space: { main: 0xe9e7e1, metal: 0.6, rough: 0.25, accent: 0x2c3038, glow: 0x3ff0ff },
};

export function makeExtraPart(part: PartId, tier: Tier): THREE.Object3D {
  const st = STYLE[tier];
  const mat = (color: number, metal = st.metal, rough = st.rough) => new THREE.MeshStandardNodeMaterial({ color, metalness: metal, roughness: rough });
  const main = mat(st.main);
  const accent = mat(st.accent, st.metal, st.rough);
  const glow = st.glow ? new THREE.MeshStandardNodeMaterial({ color: st.glow, emissive: st.glow, emissiveIntensity: 3, roughness: 0.3 }) : accent;
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };
  /** Ring (tube) with an open middle, axis y, from y0 to y1. */
  const tube = (rIn: number, rOut: number, y0: number, y1: number) =>
    new THREE.LatheGeometry([new THREE.Vector2(rIn, y0), new THREE.Vector2(rOut, y0), new THREE.Vector2(rOut, y1), new THREE.Vector2(rIn, y1), new THREE.Vector2(rIn, y0)], 28);

  if (part === 'bearing') {
    add(tube(0.185, 0.24, 0, 0.22), main);
    add(tube(0.085, 0.13, -0.01, 0.23), accent);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      add(new THREE.SphereGeometry(0.03, 10, 8), mat(0xdfe3e6, 1, 0.15), Math.cos(a) * 0.157, 0.11, Math.sin(a) * 0.157);
    }
    add(tube(0.15, 0.165, 0.09, 0.13), accent);
    if (st.glow) add(new THREE.TorusGeometry(0.213, 0.008, 6, 36).rotateX(Math.PI / 2), glow, 0, 0.222, 0);
  } else if (part === 'gear') {
    add(tube(0.045, 0.19, 0, 0.14), main);
    add(tube(0.045, 0.085, -0.01, 0.15), tier === 'quality' ? accent : main);
    const teeth = 14;
    for (let i = 0; i < teeth; i++) {
      const a = (i / teeth) * Math.PI * 2;
      const t = add(new THREE.BoxGeometry(0.075, 0.14, 0.055), main, Math.cos(a) * 0.215, 0.07, Math.sin(a) * 0.215);
      t.rotation.y = -a;
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      add(new THREE.CylinderGeometry(0.022, 0.022, 0.16, 8), accent, Math.cos(a) * 0.13, 0.07, Math.sin(a) * 0.13); // lightening holes' plugs
    }
    if (st.glow) add(new THREE.TorusGeometry(0.16, 0.008, 6, 36).rotateX(Math.PI / 2), glow, 0, 0.142, 0);
  } else if (part === 'impeller') {
    add(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 28), main, 0, 0.02, 0);
    add(new THREE.CylinderGeometry(0.09, 0.11, 0.34, 16), accent, 0, 0.17, 0);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const v = add(new THREE.BoxGeometry(0.19, 0.2, 0.022), main, Math.cos(a) * 0.14, 0.14, Math.sin(a) * 0.14);
      v.rotation.y = -a + 0.5; // swept back
    }
    add(new THREE.TorusGeometry(0.2, 0.014, 6, 28).rotateX(Math.PI / 2), tier === 'quality' ? accent : main, 0, 0.245, 0);
    if (st.glow) add(new THREE.TorusGeometry(0.1, 0.01, 6, 24).rotateX(Math.PI / 2), glow, 0, 0.34, 0);
  } else if (part === 'valve') {
    // Inline valve, flow along y: body, two flanges, bonnet and handwheel on the +x side.
    add(new THREE.SphereGeometry(0.17, 18, 14), main, 0, 0.25, 0);
    add(new THREE.CylinderGeometry(0.12, 0.12, 0.5, 16), main, 0, 0.25, 0);
    for (const y of [0.02, 0.48]) add(new THREE.CylinderGeometry(0.24, 0.24, 0.04, 20), accent, 0, y, 0);
    add(new THREE.CylinderGeometry(0.04, 0.04, 0.26, 10).rotateZ(Math.PI / 2), tier === 'quality' ? accent : main, 0.2, 0.25, 0);
    add(new THREE.TorusGeometry(0.11, 0.016, 6, 24).rotateY(Math.PI / 2), tier === 'scrap' ? accent : st.glow ? glow : accent, 0.34, 0.25, 0);
    for (let i = 0; i < 4; i++) {
      const spoke = add(new THREE.BoxGeometry(0.012, 0.2, 0.012), accent, 0.34, 0.25, 0);
      spoke.rotation.x = (i / 4) * Math.PI;
    }
  } else if (part === 'relay') {
    add(new THREE.BoxGeometry(0.3, 0.05, 0.3), mat(0x15100d, 0.2, 0.8), 0, 0.025, 0);
    const cover = new THREE.MeshStandardNodeMaterial({ color: st.main, metalness: 0.1, roughness: 0.3, transparent: true, opacity: 0.55 });
    add(new THREE.BoxGeometry(0.27, 0.2, 0.27), cover, 0, 0.15, 0);
    add(new THREE.CylinderGeometry(0.07, 0.07, 0.13, 14), mat(0xc87a44, 1, 0.3), 0, 0.12, 0); // coil
    add(new THREE.BoxGeometry(0.05, 0.1, 0.12), accent, 0.08, 0.12, 0); // armature
    for (const [x, z] of [[-0.1, -0.1], [0.1, -0.1], [-0.1, 0.1], [0.1, 0.1]]) {
      add(new THREE.CylinderGeometry(0.028, 0.028, 0.04, 8), mat(0xc87a44, 1, 0.3), x, 0.27, z);
      add(new THREE.BoxGeometry(0.04, 0.012, 0.012), accent, x, 0.295, z);
    }
    if (st.glow) add(new THREE.BoxGeometry(0.1, 0.02, 0.02), glow, 0, 0.255, 0.14);
    else add(new THREE.BoxGeometry(0.12, 0.02, 0.02), tier === 'quality' ? accent : mat(0xd8a820, 0, 0.6), 0, 0.255, 0.14);
  }
  return g;
}
