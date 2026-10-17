// Post-processing (tone mapping, bloom, heat haze). Placeholder: plain render.
import * as THREE from 'three/webgpu';

export class Post {
  private renderer: THREE.WebGPURenderer;
  private scene: THREE.Scene;
  private camera: THREE.Camera;

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
