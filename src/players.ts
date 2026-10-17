// Player avatars (local + remote). Placeholder capsule + nose; replaced by the scavenger model.
import * as THREE from 'three/webgpu';
import { PLAYER_HEIGHT } from '../shared/sim.ts';

export type AvatarPose = { x: number; y: number; z: number; facing: number; speed: number; grounded: boolean };

export class Avatar {
  readonly root = new THREE.Group();
  private body: THREE.MeshStandardNodeMaterial;

  constructor(color: number) {
    this.body = new THREE.MeshStandardNodeMaterial({ color, roughness: 0.8 });
    const r = 0.35;
    const capsule = new THREE.Mesh(new THREE.CapsuleGeometry(r, PLAYER_HEIGHT - 2 * r, 4, 12), this.body);
    capsule.position.y = PLAYER_HEIGHT / 2;
    capsule.castShadow = true;
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.15, 0.3), new THREE.MeshStandardNodeMaterial({ color: 0x222222 }));
    nose.position.set(0, PLAYER_HEIGHT - 0.35, -0.35); // facing 0 looks down -Z
    this.root.add(capsule, nose);
  }

  setColor(color: number) {
    this.body.color.setHex(color);
  }

  /** Called every render frame. */
  update(pose: AvatarPose, _dt: number) {
    this.root.position.set(pose.x, pose.y, pose.z);
    this.root.rotation.y = pose.facing;
  }

  dispose() {
    this.root.removeFromParent();
  }
}
