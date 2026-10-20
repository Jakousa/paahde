// Client-side rendering of companion bots (shared/npcs.ts).
// Renders a stylized scrap-crate robot chassis with an amber sensor lens.
import * as THREE from 'three/webgpu';
import { NPCS, type NpcSnap } from '../../shared/npcs.ts';
import { heightAt } from '../../shared/terrain.ts';
import { EYE_HEIGHT } from '../../shared/dig.ts';

const VIEW_DIST = 400;

const BODY_MAT = new THREE.MeshStandardNodeMaterial({
  color: 0x5a4838,
  roughness: 0.8,
  metalness: 0.35,
});

const ACCENT_MAT = new THREE.MeshStandardNodeMaterial({
  color: 0x332a22,
  roughness: 0.9,
  metalness: 0.1,
});

const EYE_MAT = new THREE.MeshStandardNodeMaterial({
  color: 0xffaa22,
  roughness: 0.3,
  metalness: 0.1,
});

// Chassis: width 0.65, height 0.45, length 0.85
const BODY_GEO = new THREE.BoxGeometry(0.65, 0.45, 0.85);
const EYE_GEO = new THREE.BoxGeometry(0.2, 0.14, 0.12).translate(0, 0.22, 0.38);
const RUNNER_GEO = new THREE.BoxGeometry(0.12, 0.1, 0.95);

type ShownBot = {
  group: THREE.Group;
  currentYaw: number;
};

export class NpcView {
  private group = new THREE.Group();
  private shown = new Map<number, ShownBot>();

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  update(dt: number, me: { x: number; y: number; z: number }) {
    // Remove missing bots
    for (const [id, s] of this.shown) {
      if (NPCS.has(id)) continue;
      s.group.removeFromParent();
      this.shown.delete(id);
    }

    // Add and update active bots
    for (const bot of NPCS.values()) {
      let s = this.shown.get(bot.id);
      if (!s) {
        s = this.make();
        this.shown.set(bot.id, s);
      }

      const d = Math.hypot(bot.x - me.x, bot.z - me.z);
      s.group.visible = d < VIEW_DIST;
      if (!s.group.visible) continue;

      // Position sits on the ground
      const groundY = heightAt(bot.x, bot.z);
      s.group.position.set(bot.x, groundY + 0.25, bot.z);

      // Smooth yaw rotation
      let diff = bot.yaw - s.currentYaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      s.currentYaw += diff * Math.min(1, dt * 10);
      s.group.rotation.y = s.currentYaw;
    }
  }

  private make(): ShownBot {
    const g = new THREE.Group();

    const body = new THREE.Mesh(BODY_GEO, BODY_MAT);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    const eye = new THREE.Mesh(EYE_GEO, EYE_MAT);
    g.add(eye);

    // Left and right runners
    const leftRunner = new THREE.Mesh(RUNNER_GEO, ACCENT_MAT);
    leftRunner.position.set(-0.35, -0.22, 0);
    g.add(leftRunner);

    const rightRunner = new THREE.Mesh(RUNNER_GEO, ACCENT_MAT);
    rightRunner.position.set(0.35, -0.22, 0);
    g.add(rightRunner);

    this.group.add(g);
    return { group: g, currentYaw: 0 };
  }

  /** Find the bot under the player's crosshair within reach (m). */
  botUnderCrosshair(feet: { x: number; y: number; z: number }, yaw: number, pitch: number, reach = 3.0): NpcSnap | null {
    const cp = Math.cos(pitch);
    const dx = -Math.sin(yaw) * cp;
    const dy = Math.sin(pitch);
    const dz = -Math.cos(yaw) * cp;
    const ey = feet.y + EYE_HEIGHT;

    let bestDist = reach;
    let bestBot: NpcSnap | null = null;

    for (const bot of NPCS.values()) {
      const bx = bot.x;
      const bz = bot.z;
      const by = heightAt(bx, bz) + 0.25;

      const toX = bx - feet.x;
      const toY = by - ey;
      const toZ = bz - feet.z;

      // Dot product along ray
      const proj = toX * dx + toY * dy + toZ * dz;
      if (proj <= 0 || proj > reach) continue;

      // Perpendicular distance to ray
      const perpSq = toX * toX + toY * toY + toZ * toZ - proj * proj;
      if (perpSq < 0.6 * 0.6 && proj < bestDist) {
        bestDist = proj;
        bestBot = bot;
      }
    }

    return bestBot;
  }
}
