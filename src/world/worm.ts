// The worm boss (shared/bosses.ts) as drawn: a stand-in box with its weak points round it for now.
import * as THREE from 'three/webgpu';
import { BOSSES, type BossSnap } from '../../shared/bosses.ts';
import { weakPoint, type BossView } from './bossParts';

export class WormView implements BossView {
  readonly points: THREE.Object3D[] = [];
  private root = new THREE.Group();
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.root.add(new THREE.Mesh(new THREE.BoxGeometry(16, 16, 16), new THREE.MeshStandardNodeMaterial({ color: 0x3a302a })));
    for (let i = 0; i < BOSSES.worm.points; i++) {
      const p = weakPoint(1.5), a = (i / BOSSES.worm.points) * Math.PI * 2;
      p.position.set(Math.sin(a) * 8.5, 0, Math.cos(a) * 8.5);
      p.rotation.y = a;
      this.root.add(p);
      this.points.push(p);
    }
    scene.add(this.root);
  }

  update(s: BossSnap) {
    this.root.position.set(s.x, s.y, s.z);
    this.root.rotation.y = s.yaw;
  }

  dispose() {
    this.scene.remove(this.root);
  }
}
