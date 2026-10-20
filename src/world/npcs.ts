// Client-side rendering and animation of companion bots (shared/npcs.ts).
// Renders an articulated scavenger robot: an R2-D2 barrel dome combined with a
// WALL-E utility hopper belly and binocular optical eyes, mounted on a 3-legged tripod walker rig.
// The aesthetic and materials automatically adapt to the crafted material tier (0 Scrap .. 3 Space).
import * as THREE from 'three/webgpu';
import { NPCS, type NpcSnap } from '../../shared/npcs.ts';
import { heightAt } from '../../shared/terrain.ts';
import { EYE_HEIGHT } from '../../shared/dig.ts';

const VIEW_DIST = 400;

// ------------------------------------------------------------------------------------------------
// Static Materials by Tier (0: Scrap, 1: Basic, 2: Quality, 3: Space-grade)
// ------------------------------------------------------------------------------------------------
const CHASSIS_MATS = [
  new THREE.MeshStandardNodeMaterial({ color: 0x6e4834, roughness: 0.9, metalness: 0.25 }), // Scrap: oxidised metal
  new THREE.MeshStandardNodeMaterial({ color: 0x7c6e56, roughness: 0.7, metalness: 0.35 }), // Basic: desert khaki
  new THREE.MeshStandardNodeMaterial({ color: 0xb89040, roughness: 0.32, metalness: 0.78 }), // Quality: polished brass
  new THREE.MeshStandardNodeMaterial({ color: 0xd8e4ed, roughness: 0.22, metalness: 0.65 }), // Space: sleek composite
];

const ACCENT_MATS = [
  new THREE.MeshStandardNodeMaterial({ color: 0x2e2822, roughness: 0.95, metalness: 0.15 }), // Scrap: dark salvage iron
  new THREE.MeshStandardNodeMaterial({ color: 0x3d434a, roughness: 0.65, metalness: 0.55 }), // Basic: stamped steel
  new THREE.MeshStandardNodeMaterial({ color: 0x3a3024, roughness: 0.42, metalness: 0.8 }),  // Quality: burnished bronze
  new THREE.MeshStandardNodeMaterial({ color: 0x1b2024, roughness: 0.3, metalness: 0.9 }),   // Space: anodized titanium
];

const LENS_MATS = [
  new THREE.MeshStandardNodeMaterial({ color: 0xff7020, roughness: 0.3, metalness: 0.1, emissive: 0x882800 }), // Scrap: warm incandescent
  new THREE.MeshStandardNodeMaterial({ color: 0xffaa22, roughness: 0.25, metalness: 0.1, emissive: 0xaa5500 }), // Basic: bright amber
  new THREE.MeshStandardNodeMaterial({ color: 0xff8810, roughness: 0.15, metalness: 0.1, emissive: 0xcc4400 }), // Quality: radiant orange
  new THREE.MeshStandardNodeMaterial({ color: 0x2bf0ff, roughness: 0.1, metalness: 0.1, emissive: 0x10a0cc }),  // Space: cyan laser
];

// ------------------------------------------------------------------------------------------------
// Static Shared Geometries (Zero allocation during render)
// ------------------------------------------------------------------------------------------------
// Torso & Chassis
const BARREL_GEO = new THREE.CylinderGeometry(0.24, 0.25, 0.34, 16);
const DOME_GEO = new THREE.SphereGeometry(0.238, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.45);
const BELLY_GEO = new THREE.BoxGeometry(0.44, 0.22, 0.42);
const GRILLE_GEO = new THREE.BoxGeometry(0.3, 0.14, 0.04);
const BATTERY_GEO = new THREE.CylinderGeometry(0.06, 0.06, 0.24, 10);
const ANTENNA_GEO = new THREE.CylinderGeometry(0.012, 0.012, 0.15, 6);
const ANTENNA_TIP_GEO = new THREE.SphereGeometry(0.024, 8, 6);

// Articulated Head & Binocular Optical Eyes (WALL-E style)
const NECK_GEO = new THREE.CylinderGeometry(0.035, 0.045, 0.08, 10);
const EYE_CROSSBAR_GEO = new THREE.BoxGeometry(0.22, 0.04, 0.05);
const EYE_TUBE_GEO = new THREE.CylinderGeometry(0.062, 0.068, 0.11, 14).rotateX(Math.PI / 2);
const EYE_LENS_GEO = new THREE.SphereGeometry(0.048, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5).rotateX(Math.PI / 2);

// Tripod Walker Legs
const HIP_GEO = new THREE.CylinderGeometry(0.048, 0.048, 0.08, 10).rotateZ(Math.PI / 2);
const THIGH_GEO = new THREE.BoxGeometry(0.065, 0.24, 0.07);
const KNEE_GEO = new THREE.CylinderGeometry(0.038, 0.038, 0.075, 10).rotateZ(Math.PI / 2);
const CALF_GEO = new THREE.CylinderGeometry(0.026, 0.026, 0.22, 8);
const FOOT_PAD_GEO = new THREE.BoxGeometry(0.14, 0.035, 0.2);
const REAR_STRUT_GEO = new THREE.BoxGeometry(0.07, 0.26, 0.065);
const REAR_SKID_GEO = new THREE.BoxGeometry(0.14, 0.04, 0.18);

type ShownBot = {
  group: THREE.Group;
  yawGroup: THREE.Group;
  torsoGroup: THREE.Group;
  headGroup: THREE.Group;
  leftLegGroup: THREE.Group;
  leftCalfGroup: THREE.Group;
  rightLegGroup: THREE.Group;
  rightCalfGroup: THREE.Group;
  rearLegGroup: THREE.Group;
  currentYaw: number;
  headYaw: number;
  headPitch: number;
  walkPhase: number;
  tier: number;
  chassisMeshes: THREE.Mesh[];
  accentMeshes: THREE.Mesh[];
  lensMeshes: THREE.Mesh[];
  prevX: number;
  prevZ: number;
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
        s = this.make(bot.tier ?? 0);
        this.shown.set(bot.id, s);
      }

      // Update tier materials if changed
      const currentTier = Math.max(0, Math.min(3, bot.tier ?? 0));
      if (s.tier !== currentTier) {
        s.tier = currentTier;
        const cMat = CHASSIS_MATS[currentTier];
        const aMat = ACCENT_MATS[currentTier];
        const lMat = LENS_MATS[currentTier];
        for (const m of s.chassisMeshes) m.material = cMat;
        for (const m of s.accentMeshes) m.material = aMat;
        for (const m of s.lensMeshes) m.material = lMat;
      }

      const d = Math.hypot(bot.x - me.x, bot.z - me.z);
      s.group.visible = d < VIEW_DIST;
      if (!s.group.visible) continue;

      // Position on ground
      const groundY = heightAt(bot.x, bot.z);
      s.group.position.set(bot.x, groundY, bot.z);

      // Smooth yaw rotation
      let diff = bot.yaw - s.currentYaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      s.currentYaw += diff * Math.min(1, dt * 10);
      s.yawGroup.rotation.y = s.currentYaw;

      // Measure actual movement speed
      const moveDist = Math.hypot(bot.x - s.prevX, bot.z - s.prevZ);
      const speed = dt > 0 ? Math.min(6.0, moveDist / dt) : 0;
      s.prevX = bot.x;
      s.prevZ = bot.z;

      // --------------------------------------------------------------------------------------------
      // Locomotion & Gait Animation
      // --------------------------------------------------------------------------------------------
      if (speed > 0.15) {
        s.walkPhase += dt * (speed * 6.5);

        // Tripod alternating gait
        const stride = Math.sin(s.walkPhase) * 0.42;
        const oppStride = Math.sin(s.walkPhase + Math.PI) * 0.42;

        s.leftLegGroup.rotation.x = stride;
        s.leftCalfGroup.rotation.x = Math.max(0, -stride * 0.6);

        s.rightLegGroup.rotation.x = oppStride;
        s.rightCalfGroup.rotation.x = Math.max(0, -oppStride * 0.6);

        // Trailing rear leg balances the chassis
        s.rearLegGroup.rotation.x = -0.22 + Math.sin(s.walkPhase * 2) * 0.06;

        // Torso bobs with walking rhythm
        s.torsoGroup.position.y = 0.32 + Math.abs(Math.sin(s.walkPhase)) * 0.035;
        s.torsoGroup.rotation.z = Math.sin(s.walkPhase) * 0.03;
        s.torsoGroup.rotation.x = 0.04;
      } else {
        // Idle rest stance & breathing
        s.leftLegGroup.rotation.x *= 0.82;
        s.leftCalfGroup.rotation.x *= 0.82;
        s.rightLegGroup.rotation.x *= 0.82;
        s.rightCalfGroup.rotation.x *= 0.82;
        s.rearLegGroup.rotation.x = THREE.MathUtils.lerp(s.rearLegGroup.rotation.x, -0.22, 0.1);

        const idleTime = performance.now() * 0.002;
        s.torsoGroup.position.y = 0.32 + Math.sin(idleTime) * 0.01;
        s.torsoGroup.rotation.z *= 0.85;
        s.torsoGroup.rotation.x *= 0.85;
      }

      // --------------------------------------------------------------------------------------------
      // Head Tracking (Looks inquisitively at owner when nearby, like WALL-E)
      // --------------------------------------------------------------------------------------------
      const toPlayerX = me.x - bot.x;
      const toPlayerY = (me.y + EYE_HEIGHT) - (groundY + 0.65);
      const toPlayerZ = me.z - bot.z;
      const distToPlayer = Math.hypot(toPlayerX, toPlayerZ);

      let targetHeadYaw = 0;
      let targetHeadPitch = 0;

      if (distToPlayer < 7.0) {
        // Look at player's eyes
        const worldAngle = Math.atan2(toPlayerX, toPlayerZ);
        let relAngle = worldAngle - s.currentYaw;
        while (relAngle > Math.PI) relAngle -= Math.PI * 2;
        while (relAngle < -Math.PI) relAngle += Math.PI * 2;

        targetHeadYaw = Math.max(-1.1, Math.min(1.1, relAngle));
        targetHeadPitch = Math.max(-0.4, Math.min(0.6, Math.atan2(toPlayerY, distToPlayer)));

        // Inquisitive head tilt
        s.headGroup.rotation.z = Math.sin(performance.now() * 0.0015) * 0.08;
      } else {
        s.headGroup.rotation.z *= 0.9;
      }

      s.headYaw += (targetHeadYaw - s.headYaw) * Math.min(1, dt * 6);
      s.headPitch += (targetHeadPitch - s.headPitch) * Math.min(1, dt * 6);

      s.headGroup.rotation.y = s.headYaw;
      s.headGroup.rotation.x = -s.headPitch;
    }
  }

  private make(tier: number): ShownBot {
    const root = new THREE.Group();
    const yawGroup = new THREE.Group();
    root.add(yawGroup);

    const safeTier = Math.max(0, Math.min(3, tier));
    const cMat = CHASSIS_MATS[safeTier];
    const aMat = ACCENT_MATS[safeTier];
    const lMat = LENS_MATS[safeTier];

    const chassisMeshes: THREE.Mesh[] = [];
    const accentMeshes: THREE.Mesh[] = [];
    const lensMeshes: THREE.Mesh[] = [];

    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Mesh[], parent: THREE.Group, shadow = true): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = shadow;
      m.receiveShadow = shadow;
      list.push(m);
      parent.add(m);
      return m;
    };

    // --------------------------------------------------------------------------------------------
    // 1. Torso & Chassis
    // --------------------------------------------------------------------------------------------
    const torsoGroup = new THREE.Group();
    torsoGroup.position.y = 0.32;
    yawGroup.add(torsoGroup);

    // Central cylindrical drum (R2-D2 silhouette)
    const barrel = mesh(BARREL_GEO, cMat, chassisMeshes, torsoGroup);
    barrel.position.y = 0.18;

    // Top dome
    const dome = mesh(DOME_GEO, cMat, chassisMeshes, torsoGroup);
    dome.position.y = 0.35;

    // Communications antenna
    const antenna = mesh(ANTENNA_GEO, aMat, accentMeshes, torsoGroup);
    antenna.position.set(0.12, 0.48, -0.06);
    const antennaTip = mesh(ANTENNA_TIP_GEO, cMat, chassisMeshes, torsoGroup);
    antennaTip.position.set(0.12, 0.56, -0.06);

    // Lower utility cargo belly (WALL-E compactor silhouette)
    const belly = mesh(BELLY_GEO, aMat, accentMeshes, torsoGroup);
    belly.position.set(0, 0.05, 0);

    // Front intake/hopper grille
    const grille = mesh(GRILLE_GEO, cMat, chassisMeshes, torsoGroup);
    grille.position.set(0, 0.05, 0.22);

    // Rear battery canisters
    const batL = mesh(BATTERY_GEO, aMat, accentMeshes, torsoGroup);
    batL.position.set(-0.13, 0.16, -0.22);
    const batR = mesh(BATTERY_GEO, aMat, accentMeshes, torsoGroup);
    batR.position.set(0.13, 0.16, -0.22);

    // --------------------------------------------------------------------------------------------
    // 2. Articulated Head & Binocular Optical Sensor (WALL-E Eyes)
    // --------------------------------------------------------------------------------------------
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.42, 0.1);
    torsoGroup.add(headGroup);

    // Neck stalk
    const neck = mesh(NECK_GEO, aMat, accentMeshes, headGroup);
    neck.position.y = 0.04;

    // Eyepod crossbar
    const crossbar = mesh(EYE_CROSSBAR_GEO, aMat, accentMeshes, headGroup);
    crossbar.position.set(0, 0.09, 0);

    // Left optical eye tube & glowing sensor lens
    const leftTube = mesh(EYE_TUBE_GEO, cMat, chassisMeshes, headGroup);
    leftTube.position.set(-0.08, 0.1, 0.03);
    const leftLens = mesh(EYE_LENS_GEO, lMat, lensMeshes, headGroup, false);
    leftLens.position.set(-0.08, 0.1, 0.085);

    // Right optical eye tube & glowing sensor lens
    const rightTube = mesh(EYE_TUBE_GEO, cMat, chassisMeshes, headGroup);
    rightTube.position.set(0.08, 0.1, 0.03);
    const rightLens = mesh(EYE_LENS_GEO, lMat, lensMeshes, headGroup, false);
    rightLens.position.set(0.08, 0.1, 0.085);

    // --------------------------------------------------------------------------------------------
    // 3. Tripod Walker Legs
    // --------------------------------------------------------------------------------------------
    // Left Leg
    const leftLegGroup = new THREE.Group();
    leftLegGroup.position.set(-0.25, 0.24, 0.04);
    yawGroup.add(leftLegGroup);

    mesh(HIP_GEO, aMat, accentMeshes, leftLegGroup);
    const leftThigh = mesh(THIGH_GEO, cMat, chassisMeshes, leftLegGroup);
    leftThigh.position.set(0, -0.1, 0.02);
    leftThigh.rotation.x = 0.15;

    const leftCalfGroup = new THREE.Group();
    leftCalfGroup.position.set(0, -0.21, 0.05);
    leftLegGroup.add(leftCalfGroup);

    mesh(KNEE_GEO, aMat, accentMeshes, leftCalfGroup);
    const leftCalf = mesh(CALF_GEO, aMat, accentMeshes, leftCalfGroup);
    leftCalf.position.set(0, -0.1, -0.02);
    leftCalf.rotation.x = -0.15;

    const leftFoot = mesh(FOOT_PAD_GEO, cMat, chassisMeshes, leftCalfGroup);
    leftFoot.position.set(0, -0.22, 0.02);

    // Right Leg
    const rightLegGroup = new THREE.Group();
    rightLegGroup.position.set(0.25, 0.24, 0.04);
    yawGroup.add(rightLegGroup);

    mesh(HIP_GEO, aMat, accentMeshes, rightLegGroup);
    const rightThigh = mesh(THIGH_GEO, cMat, chassisMeshes, rightLegGroup);
    rightThigh.position.set(0, -0.1, 0.02);
    rightThigh.rotation.x = 0.15;

    const rightCalfGroup = new THREE.Group();
    rightCalfGroup.position.set(0, -0.21, 0.05);
    rightLegGroup.add(rightCalfGroup);

    mesh(KNEE_GEO, aMat, accentMeshes, rightCalfGroup);
    const rightCalf = mesh(CALF_GEO, aMat, accentMeshes, rightCalfGroup);
    rightCalf.position.set(0, -0.1, -0.02);
    rightCalf.rotation.x = -0.15;

    const rightFoot = mesh(FOOT_PAD_GEO, cMat, chassisMeshes, rightCalfGroup);
    rightFoot.position.set(0, -0.22, 0.02);

    // Rear Stabilizer Leg (Tripod Stance)
    const rearLegGroup = new THREE.Group();
    rearLegGroup.position.set(0, 0.2, -0.2);
    rearLegGroup.rotation.x = -0.22;
    yawGroup.add(rearLegGroup);

    const rearStrut = mesh(REAR_STRUT_GEO, aMat, accentMeshes, rearLegGroup);
    rearStrut.position.set(0, -0.12, 0);

    const rearSkid = mesh(REAR_SKID_GEO, cMat, chassisMeshes, rearLegGroup);
    rearSkid.position.set(0, -0.24, 0.04);

    this.group.add(root);

    return {
      group: root,
      yawGroup,
      torsoGroup,
      headGroup,
      leftLegGroup,
      leftCalfGroup,
      rightLegGroup,
      rightCalfGroup,
      rearLegGroup,
      currentYaw: 0,
      headYaw: 0,
      headPitch: 0,
      walkPhase: 0,
      tier: safeTier,
      chassisMeshes,
      accentMeshes,
      lensMeshes,
      prevX: 0,
      prevZ: 0,
    };
  }

  /** Find the bot under the player's crosshair within reach (m). */
  botUnderCrosshair(feet: { x: number; y: number; z: number }, yaw: number, pitch: number, reach = 3.2): NpcSnap | null {
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
      const by = heightAt(bx, bz) + 0.35;

      const toX = bx - feet.x;
      const toY = by - ey;
      const toZ = bz - feet.z;

      // Dot product along look ray
      const proj = toX * dx + toY * dy + toZ * dz;
      if (proj <= 0 || proj > reach) continue;

      // Perpendicular distance to ray
      const perpSq = toX * toX + toY * toY + toZ * toZ - proj * proj;
      if (perpSq < 0.65 * 0.65 && proj < bestDist) {
        bestDist = proj;
        bestBot = bot;
      }
    }

    return bestBot;
  }
}
