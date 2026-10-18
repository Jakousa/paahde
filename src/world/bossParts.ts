// What every boss view (src/world/<kind>.ts, drawn by src/bosses.ts) is made of: the interface it implements and
// the glowing weak point lens they all carry, the same red glass in a dark rim as the walkers' (src/world/guardians.ts).
import * as THREE from 'three/webgpu';
import type { BossSnap } from '../../shared/bosses.ts';
import type { ServerMsg } from '../../shared/protocol.ts';

export type BossFxMsg = Extract<ServerMsg, { t: 'bossFx' }>;

/** What a view gets every frame besides its snapshot. */
export type BossCtx = {
  scene: THREE.Scene;
  /** The camera (the listener). */
  ear: THREE.Vector3;
  /** Us (feet), or null before we've spawned. */
  me: { x: number; y: number; z: number } | null;
  /** Server time the snapshot is for (ms, drawn a little in the past, src/world/botFrames.ts BOT_DELAY_MS). */
  time: number;
  dt: number;
  /** Shake and dust for something heavy at (x, y, z) (src/guardians.ts). */
  thump(x: number, y: number, z: number, weight: number, puffs: number, speed: number, size: number): void;
  /** Shake the camera this much (m) at least. */
  shake(amount: number): void;
};

export interface BossView {
  /** Weak point i is points[i], a weakPoint() group placed on the model (its world scale is the lens radius, m);
   *  src/bosses.ts shatters it and tests shots against it. A hidden one (or one under the sand) can't be hit. */
  readonly points: THREE.Object3D[];
  /** Don't interpolate BossSnap.s between messages (take the newer one's). */
  readonly snapS?: boolean;
  /** Every frame, with the interpolated snapshot. */
  update(s: BossSnap, ctx: BossCtx): void;
  /** A one-off from the server (shared/protocol.ts 'bossFx'). */
  fx?(m: BossFxMsg, ctx: BossCtx): void;
  /** Where the shot from o along unit d first meets its metal within max (m), or null: sparks, no harm. */
  hull?(o: THREE.Vector3, d: THREE.Vector3, max: number): number | null;
  /** Where the shot from o along unit d first meets one of its minions within max (m), and which (its id or slot:
   *  sent as weak point MINION + index), or null. */
  minion?(o: THREE.Vector3, d: THREE.Vector3, max: number): { index: number; dist: number } | null;
  /** Gone from view: take everything out of the scene. */
  dispose(): void;
}

export const lensGeo = new THREE.SphereGeometry(1, 16, 12);
const rimGeo = new THREE.TorusGeometry(1.02, 0.22, 6, 16);
export const lensMat = new THREE.MeshStandardNodeMaterial({ color: 0x500000, roughness: 0.2, metalness: 0.1, emissive: 0xff0800, emissiveIntensity: 2.4 });
export const brokenLensMat = new THREE.MeshStandardNodeMaterial({ color: 0x140c0a, roughness: 0.9, metalness: 0.3 });
const rimMat = new THREE.MeshStandardNodeMaterial({ color: 0x2a2624, roughness: 0.5, metalness: 0.8 });

/** A weak point of radius r (m) facing +Z of its group: the lens and its rim. Place the group on the model. */
export function weakPoint(r: number): THREE.Group {
  const g = new THREE.Group();
  const lens = new THREE.Mesh(lensGeo, lensMat);
  lens.name = 'lens';
  g.add(lens, new THREE.Mesh(rimGeo, rimMat));
  g.scale.setScalar(r);
  return g;
}
