// Selective GPU texture budgeting: preserve data maps and cap only oversized color atlases before the first upload.
import type { Material, Mesh, MeshStandardMaterial, Object3D, Texture } from 'three/webgpu';

export async function limitColorTextures(root: Object3D, maxSize: number) {
  if (typeof createImageBitmap !== 'function') return;
  const textures = new Set<Texture>();
  root.traverse(object => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const materials: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const map = (material as MeshStandardMaterial).map;
      if (map) textures.add(map);
    }
  });
  // Multiple material instances can share the same Source; replace it once so all keep sharing one GPU image.
  const sources = new Set([...textures].map(texture => texture.source));
  for (const source of sources) {
    const image = source.data as ImageBitmap;
    if (!image?.width || !image.height || Math.max(image.width, image.height) <= maxSize) continue;
    const scale = maxSize / Math.max(image.width, image.height);
    try {
      const resized = await createImageBitmap(image, {
        resizeWidth: Math.max(1, Math.round(image.width * scale)),
        resizeHeight: Math.max(1, Math.round(image.height * scale)),
        resizeQuality: 'high',
      });
      source.data = resized;
      for (const texture of textures) if (texture.source === source) texture.needsUpdate = true;
      image.close?.();
    } catch {
      // ImageBitmap resizing is optional on older backends: retain the original valid image if unsupported.
    }
  }
}
