// Inventory icons for the parts built in code (src/teardown/parts.ts: impeller, bearing, gear, valve, relay), made to
// match the Blender ones (tools/blender/items.py render_icons): 128 × 128, transparent, an orthographic 3/4 view from
// front-right above (CAM_DIR), three sun lights and a warm uniform world, a thin dark outline, and every tier of
// a part framed the same. Opened by tools/models/part-icons.mjs, which saves window.icons as
// public/icons/items/<part>_<tier>.png.
import * as THREE from 'three/webgpu';
import { TIERS, type PartId } from '../../shared/salvage.ts';
import { EXTRA_PARTS, makeExtraPart } from '../../src/teardown/parts.ts';

const SIZE = 128;
const SS = 2; // rendered at twice the size, outlined, then scaled down
const R = SIZE * SS;

// Blender is z-up, three y-up: (x, y, z) → (x, z, -y).
const CAM_DIR = new THREE.Vector3(1.0, 0.95, 1.25).normalize();
// items.py's suns (key, fill, rim) as directions towards the light, converted the same way.
const SUNS: [number, [number, number, number]][] = [
  [3.5, [0.383, 0.643, 0.663]],
  [1.0, [-0.814, 0.342, -0.47]],
  [3.0, [0.158, -0.423, -0.892]],
];

const renderer = new THREE.WebGPURenderer({ antialias: false, alpha: true });
renderer.setSize(R, R);
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
for (const [energy, d] of SUNS) {
  const l = new THREE.DirectionalLight(0xffffff, energy * 0.75);
  l.position.set(...d);
  scene.add(l);
}
// The world: a uniform warm grey all round (items.py: (0.55, 0.45, 0.38) at 0.9).
const world = new THREE.Scene();
world.add(new THREE.Mesh(new THREE.SphereGeometry(1, 16, 16), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0.55 * 0.9, 0.45 * 0.9, 0.38 * 0.9), side: THREE.BackSide })));
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(world).texture;

const target = new THREE.RenderTarget(R, R, { type: THREE.HalfFloatType, samples: 4 });
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 20);

/** Fit the camera along CAM_DIR around all of `objs` (the same framing for every tier, like frame_ortho). */
function frame(objs: THREE.Object3D[]) {
  const box = new THREE.Box3();
  for (const o of objs) box.expandByObject(o);
  const centre = box.getCenter(new THREE.Vector3());
  cam.position.copy(centre).addScaledVector(CAM_DIR, 5);
  cam.lookAt(centre);
  cam.updateMatrixWorld();
  const inv = cam.matrixWorldInverse;
  const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const v = new THREE.Vector3();
  for (const o of objs) {
    o.updateMatrixWorld(true);
    o.traverse((m) => {
      const pos = (m as THREE.Mesh).isMesh ? (m as THREE.Mesh).geometry.attributes.position : null;
      if (!pos) return;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).applyMatrix4(inv);
        lo.min(v);
        hi.max(v);
      }
    });
  }
  const half = Math.max(hi.x - lo.x, hi.y - lo.y) * 1.12 / 2;
  const cx = (hi.x + lo.x) / 2, cy = (hi.y + lo.y) / 2;
  cam.left = cx - half; cam.right = cx + half; cam.top = cy + half; cam.bottom = cy - half;
  cam.updateProjectionMatrix();
}

const toSrgb = (c: number) => {
  c = Math.min(1, Math.max(0, c));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
};

/** Render the scene as it stands into a 128 px PNG data URL with a dark outline round the silhouette. */
async function shot(): Promise<string> {
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, cam);
  renderer.setRenderTarget(null);
  const half = (await renderer.readRenderTargetPixelsAsync(target, 0, 0, R, R)) as Uint16Array;
  const px = Float32Array.from(half, (h) => THREE.DataUtils.fromHalfFloat(h));
  const img = new ImageData(R, R);
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      const s = (y * R + x) * 4, d = s; // WebGPU reads back top row first
      const a = Math.min(1, px[s + 3]);
      for (let c = 0; c < 3; c++) img.data[d + c] = Math.round(toSrgb(a > 0 ? px[s + c] / a : 0) * 255);
      img.data[d + 3] = Math.round(a * 255);
    }
  }
  // Outline: empty pixels within OUT px of the object turn dark (items.py's freestyle line is ~1.2 px at 128).
  const OUT = 1.3 * SS;
  const alpha = Float32Array.from({ length: R * R }, (_, i) => img.data[i * 4 + 3] / 255);
  const r = Math.ceil(OUT);
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      const i = y * R + x;
      if (alpha[i] >= 1) continue;
      let near = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= R || yy >= R || dx * dx + dy * dy > OUT * OUT) continue;
          near = Math.max(near, alpha[yy * R + xx]);
        }
      }
      if (near <= alpha[i]) continue;
      // Over the dark line colour, under what is already there.
      const a0 = alpha[i], line = [13, 8, 5];
      const a = a0 + near * (1 - a0);
      for (let c = 0; c < 3; c++) img.data[i * 4 + c] = Math.round((img.data[i * 4 + c] * a0 + line[c] * near * (1 - a0)) / a);
      img.data[i * 4 + 3] = Math.round(a * 255);
    }
  }
  const big = document.createElement('canvas');
  big.width = big.height = R;
  big.getContext('2d')!.putImageData(img, 0, 0);
  const out = document.createElement('canvas');
  out.width = out.height = SIZE;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(big, 0, 0, SIZE, SIZE);
  return out.toDataURL('image/png');
}

const icons: Record<string, string> = {};
for (const part of EXTRA_PARTS as PartId[]) {
  const objs = TIERS.map((t) => makeExtraPart(part, t));
  frame(objs);
  for (let k = 0; k < objs.length; k++) {
    scene.add(objs[k]);
    icons[`${part}_${TIERS[k]}`] = await shot();
    scene.remove(objs[k]);
  }
}
// A contact sheet on the page, for a quick look.
document.body.innerHTML = '<div style="display:grid;grid-template-columns:repeat(4,128px);gap:4px;background:#3a2414;padding:8px;width:max-content">'
  + Object.values(icons).map((u) => `<img src="${u}">`).join('') + '</div>';
(window as unknown as { icons: Record<string, string> }).icons = icons;
