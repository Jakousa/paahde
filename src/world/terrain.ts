// Renders the shared heightfield (shared/terrain.ts). Placeholder: one plane re-centred on the player.
import * as THREE from 'three/webgpu';
import { edits, heightAt } from '../../shared/terrain.ts';
import { createSandMaterial } from './sandMaterial.ts';

const SIZE = 600;
const SEGMENTS = 200;
const SNAP = SIZE / SEGMENTS; // move in whole grid cells so vertices don't swim

export class Terrain {
  private mesh: THREE.Mesh;
  private cx = NaN;
  private cz = NaN;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, createSandMaterial());
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);
    edits.onChange = () => (this.cx = NaN); // placeholder: rebuild everything on any edit
  }

  /** Called every render frame with the local player's position. */
  update(focus: THREE.Vector3) {
    const cx = Math.round(focus.x / SNAP) * SNAP;
    const cz = Math.round(focus.z / SNAP) * SNAP;
    if (cx === this.cx && cz === this.cz) return;
    this.cx = cx;
    this.cz = cz;
    const geo = this.mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const base = (geo as THREE.PlaneGeometry).parameters;
    for (let i = 0; i < pos.count; i++) {
      const ix = i % (base.widthSegments + 1);
      const iz = Math.floor(i / (base.widthSegments + 1));
      const x = cx - SIZE / 2 + ix * SNAP;
      const z = cz - SIZE / 2 + iz * SNAP;
      pos.setXYZ(i, x, heightAt(x, z), z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }
}
