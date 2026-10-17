// Sky, sun and scene lighting. Placeholder: flat background, one directional light.
import * as THREE from 'three/webgpu';
import { sunColor, sunDirection, time } from './env.ts';

export class Sky {
  private sun: THREE.DirectionalLight;

  constructor(scene: THREE.Scene) {
    scene.background = new THREE.Color(0xbfd4e6);
    scene.fog = new THREE.Fog(0xe8dcc4, 200, 1800);
    scene.add(new THREE.HemisphereLight(0xcfe3ff, 0xd9a066, 1.0));
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    scene.add(this.sun, this.sun.target);
  }

  /** Called every render frame. `focus` is the local player's position (for shadow camera follow). */
  update(dt: number, focus: THREE.Vector3) {
    time.value += dt;
    this.sun.color.copy(sunColor.value);
    this.sun.position.copy(focus).addScaledVector(sunDirection.value, 100);
    this.sun.target.position.copy(focus);
  }
}
