// The dev test lab's name plates (shared/lab.ts labPlates): dark boards with the name of what lies or stands there, flat
// on the floor, readable from the spawn side. Dev-only, so their words are composed here (docs/text.md).
import * as THREE from 'three/webgpu';
import { heightAt } from '../../shared/terrain.ts';
import { labPlates } from '../../shared/lab.ts';

function plate(text: string, w: number): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(24, 28, 34, 0.9)';
  g.beginPath();
  g.roundRect(4, 4, 504, 120, 16);
  g.fill();
  g.fillStyle = '#e8eef5';
  g.font = '600 52px ui-monospace, Menlo, Consolas, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // Long names (the jet engines' seeds) shrink to fit.
  const fit = Math.min(1, 480 / Math.max(1, g.measureText(text).width));
  g.font = `600 ${Math.floor(52 * fit)}px ui-monospace, Menlo, Consolas, monospace`;
  g.fillText(text, 256, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  m.rotation.x = -Math.PI / 2; // lying flat, its top toward the machines, readable from the spawn side
  return m;
}

/** Puts every plate of the lab in the scene (none outside it). */
export function addLabPlates(scene: THREE.Scene) {
  for (const p of labPlates()) {
    const m = plate(p.text, p.w);
    m.position.set(p.x, heightAt(p.x, p.z) + 0.06, p.z);
    scene.add(m);
  }
}
