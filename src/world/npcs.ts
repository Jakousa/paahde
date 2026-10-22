// Client-side rendering and animation of companion bots (shared/npcs.ts).
// Renders an articulated bipedal scavenger robot with a pot-bellied capsule torso,
// a large monocular cyclops sensor viewport, chunky canister forearms with circular C-clamp pincers,
// and heavy bipedal walker legs with ventilated boot drums.
// Supports dynamic worklight beams, tactical threat alert eye states, and personality emotes.
import * as THREE from 'three/webgpu';
import { NPCS, type NpcSnap } from '../../shared/npcs.ts';
import { heightAt } from '../../shared/terrain.ts';
import { EYE_HEIGHT } from '../../shared/dig.ts';

const VIEW_DIST = 400;

// ------------------------------------------------------------------------------------------------
// Static Materials by Tier (0: Scrap, 1: Basic, 2: Quality, 3: Space-grade)
// Defined statically at module scope to avoid WebGPU pipeline compilation frame stalls.
// ------------------------------------------------------------------------------------------------
const CHASSIS_MATS = [
  new THREE.MeshStandardNodeMaterial({ color: 0x9c5c2d, roughness: 0.85, metalness: 0.25 }), // Scrap: rusted salvage ochre
  new THREE.MeshStandardNodeMaterial({ color: 0xd4a026, roughness: 0.55, metalness: 0.25 }), // Basic: industrial mustard yellow (reference)
  new THREE.MeshStandardNodeMaterial({ color: 0xc49a3c, roughness: 0.32, metalness: 0.82 }), // Quality: polished brass
  new THREE.MeshStandardNodeMaterial({ color: 0xdfe8f0, roughness: 0.22, metalness: 0.55 }), // Space: sleek arctic composite
];

const ACCENT_MATS = [
  new THREE.MeshStandardNodeMaterial({ color: 0x2c241e, roughness: 0.90, metalness: 0.35 }), // Scrap: dark salvage iron
  new THREE.MeshStandardNodeMaterial({ color: 0x272a2e, roughness: 0.65, metalness: 0.65 }), // Basic: dark gunmetal / cast iron
  new THREE.MeshStandardNodeMaterial({ color: 0x3d3024, roughness: 0.45, metalness: 0.80 }), // Quality: burnished bronze
  new THREE.MeshStandardNodeMaterial({ color: 0x181c22, roughness: 0.30, metalness: 0.92 }), // Space: anodized titanium
];

// Dark reflective optical glass for the cyclops viewport
const GLASS_MAT = new THREE.MeshStandardNodeMaterial({
  color: 0x101214,
  roughness: 0.12,
  metalness: 0.25,
});

// Glowing AI sensor pupil / aperture inside the optical viewport
const LENS_MATS = [
  new THREE.MeshStandardNodeMaterial({ color: 0xff5511, roughness: 0.30, metalness: 0.1, emissive: 0x992200 }), // Scrap: warm incandescent
  new THREE.MeshStandardNodeMaterial({ color: 0xffaa22, roughness: 0.20, metalness: 0.1, emissive: 0xbb5500 }), // Basic: bright amber
  new THREE.MeshStandardNodeMaterial({ color: 0xff7700, roughness: 0.15, metalness: 0.1, emissive: 0xcc4400 }), // Quality: radiant orange
  new THREE.MeshStandardNodeMaterial({ color: 0x2bf0ff, roughness: 0.10, metalness: 0.1, emissive: 0x10a0cc }), // Space: cyan laser
];

// Pulsing alert pupil material when threat is detected
const ALERT_LENS_MAT = new THREE.MeshStandardNodeMaterial({
  color: 0xff1020,
  roughness: 0.15,
  metalness: 0.2,
  emissive: 0xff0020,
});

// Translucent glowing worklight beam cone
const WORKLIGHT_MAT = new THREE.MeshBasicNodeMaterial({
  color: 0xffecb8,
  transparent: true,
  opacity: 0.22,
  depthWrite: false,
  side: THREE.DoubleSide,
});

// ------------------------------------------------------------------------------------------------
// Static Shared Geometries (Zero allocation during render)
// ------------------------------------------------------------------------------------------------
// 1. Torso & Hull
const TORSO_BASE_GEO = new THREE.CylinderGeometry(0.28, 0.22, 0.16, 16);
const TORSO_WAIST_GEO = new THREE.CylinderGeometry(0.295, 0.295, 0.08, 16);
const TORSO_MID_GEO = new THREE.CylinderGeometry(0.26, 0.28, 0.22, 16);
const TORSO_DOME_GEO = new THREE.SphereGeometry(0.258, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5);
const CREST_GEO = new THREE.BoxGeometry(0.09, 0.045, 0.32);
const ANTENNA_ROD_GEO = new THREE.CylinderGeometry(0.008, 0.008, 0.09, 6);
const ANTENNA_CAP_GEO = new THREE.CylinderGeometry(0.014, 0.014, 0.02, 6);

// 2. Monocular Cyclops Sensor (Center Chest)
const EYE_BEZEL_GEO = new THREE.CylinderGeometry(0.13, 0.165, 0.10, 18).rotateX(Math.PI / 2);
const EYE_RIM_GEO = new THREE.CylinderGeometry(0.115, 0.125, 0.11, 18).rotateX(Math.PI / 2);
const EYE_LENS_GEO = new THREE.SphereGeometry(0.112, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5).rotateX(Math.PI / 2);
const EYE_PUPIL_GEO = new THREE.SphereGeometry(0.045, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5).rotateX(Math.PI / 2);

// Worklight cone geometry
const WORKLIGHT_GEO = (() => {
  const g = new THREE.CylinderGeometry(0.06, 0.95, 4.2, 16, 1, true);
  g.translate(0, 2.1, 0);
  g.rotateX(Math.PI / 2);
  return g;
})();

// 3. Arms & Hands
const SHOULDER_GEO = new THREE.CylinderGeometry(0.038, 0.038, 0.06, 10).rotateZ(Math.PI / 2);
const UPPER_ARM_ROD_GEO = new THREE.CylinderGeometry(0.018, 0.018, 0.18, 8);
const UPPER_ARM_PISTON_GEO = new THREE.CylinderGeometry(0.012, 0.012, 0.13, 6);
const ELBOW_GEO = new THREE.CylinderGeometry(0.034, 0.034, 0.065, 10).rotateZ(Math.PI / 2);

// Chunky Forearm Canister
const FOREARM_DRUM_GEO = new THREE.CylinderGeometry(0.092, 0.098, 0.22, 14);
const FOREARM_BAND_GEO = new THREE.CylinderGeometry(0.103, 0.103, 0.035, 14);
const FOREARM_VENT_GEO = new THREE.BoxGeometry(0.05, 0.12, 0.02);

// Wrist & C-Clamp Claw Hand
const WRIST_GEO = new THREE.CylinderGeometry(0.032, 0.032, 0.04, 10);
const CLAW_RING_GEO = new THREE.TorusGeometry(0.075, 0.013, 8, 20, Math.PI * 1.65).rotateX(Math.PI / 2);

// 4. Bipedal Walker Legs
const HIP_GEO = new THREE.CylinderGeometry(0.042, 0.042, 0.07, 10).rotateZ(Math.PI / 2);
const THIGH_ROD_GEO = new THREE.CylinderGeometry(0.024, 0.024, 0.20, 8);
const THIGH_SLEEVE_GEO = new THREE.CylinderGeometry(0.034, 0.034, 0.12, 8);
const KNEE_GEO = new THREE.CylinderGeometry(0.038, 0.038, 0.065, 10).rotateZ(Math.PI / 2);

// Chunky Lower Leg Boot Drum
const SHIN_DRUM_GEO = new THREE.CylinderGeometry(0.086, 0.094, 0.20, 14);
const SHIN_COLLAR_GEO = new THREE.CylinderGeometry(0.099, 0.099, 0.032, 14);
const SHIN_VENT_GEO = new THREE.BoxGeometry(0.045, 0.12, 0.02);

// Foot & Rocker Sole
const ANKLE_GEO = new THREE.CylinderGeometry(0.028, 0.028, 0.055, 8).rotateZ(Math.PI / 2);
const FOOT_SOLE_GEO = new THREE.BoxGeometry(0.11, 0.045, 0.19);
const FOOT_HEEL_GEO = new THREE.CylinderGeometry(0.055, 0.055, 0.045, 10);
const TOE_CAP_GEO = new THREE.BoxGeometry(0.095, 0.035, 0.09);

type ShownBot = {
  group: THREE.Group;
  yawGroup: THREE.Group;
  torsoGroup: THREE.Group;
  eyeGroup: THREE.Group;
  pupilMesh: THREE.Mesh;
  workLightBeam: THREE.Mesh;
  workLightSpot: THREE.PointLight;
  leftArmGroup: THREE.Group;
  leftForearmGroup: THREE.Group;
  leftClawGroup: THREE.Group;
  rightArmGroup: THREE.Group;
  rightForearmGroup: THREE.Group;
  rightClawGroup: THREE.Group;
  leftLegGroup: THREE.Group;
  leftKneeGroup: THREE.Group;
  leftAnkleGroup: THREE.Group;
  rightLegGroup: THREE.Group;
  rightKneeGroup: THREE.Group;
  rightAnkleGroup: THREE.Group;
  currentYaw: number;
  eyeYaw: number;
  eyePitch: number;
  walkPhase: number;
  spinAngle: number;
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
      // Worklight State
      // --------------------------------------------------------------------------------------------
      const lightOn = !!bot.light;
      s.workLightBeam.visible = lightOn;
      s.workLightSpot.intensity = lightOn ? 2.4 : 0;

      // --------------------------------------------------------------------------------------------
      // Alert Warning State (Pulsing Red Cyclops Sensor)
      // --------------------------------------------------------------------------------------------
      if (bot.alert) {
        s.pupilMesh.material = ALERT_LENS_MAT;
        ALERT_LENS_MAT.emissive.setHex(Math.sin(performance.now() * 0.016) > 0 ? 0xff0020 : 0x880010);
      } else {
        s.pupilMesh.material = LENS_MATS[s.tier];
      }

      // --------------------------------------------------------------------------------------------
      // Personality Emotes (Celebratory Victory Spin / Nod)
      // --------------------------------------------------------------------------------------------
      if (bot.emote === 'spin') {
        s.spinAngle += dt * 14;
        s.torsoGroup.rotation.y = s.spinAngle;
        s.torsoGroup.position.y = 0.44 + Math.abs(Math.sin(s.spinAngle * 2)) * 0.05;
        s.leftArmGroup.rotation.x = Math.sin(s.spinAngle * 3) * 0.45;
        s.rightArmGroup.rotation.x = -Math.sin(s.spinAngle * 3) * 0.45;
      } else if (bot.emote === 'nod') {
        s.torsoGroup.rotation.y *= 0.85;
        const nod = Math.sin(performance.now() * 0.012) * 0.22;
        s.eyeGroup.rotation.x = -s.eyePitch + nod;
      } else {
        s.torsoGroup.rotation.y *= 0.85;
      }

      // --------------------------------------------------------------------------------------------
      // Bipedal Locomotion & Gait Animation
      // --------------------------------------------------------------------------------------------
      if (speed > 0.15 && bot.emote !== 'spin') {
        s.walkPhase += dt * (speed * 6.5);

        // Alternating bipedal strides
        const leftStride = Math.sin(s.walkPhase) * 0.44;
        const rightStride = Math.sin(s.walkPhase + Math.PI) * 0.44;

        s.leftLegGroup.rotation.x = leftStride;
        s.leftKneeGroup.rotation.x = Math.max(0, leftStride * 0.55);
        s.leftAnkleGroup.rotation.x = -leftStride * 0.45;

        s.rightLegGroup.rotation.x = rightStride;
        s.rightKneeGroup.rotation.x = Math.max(0, rightStride * 0.55);
        s.rightAnkleGroup.rotation.x = -rightStride * 0.45;

        // Natural arm swing in opposition to legs
        s.leftArmGroup.rotation.x = -leftStride * 0.75;
        s.rightArmGroup.rotation.x = -rightStride * 0.75;

        s.leftArmGroup.rotation.z = 0.22;
        s.rightArmGroup.rotation.z = -0.22;

        s.leftForearmGroup.rotation.x = -0.28 + Math.sin(s.walkPhase) * 0.08;
        s.rightForearmGroup.rotation.x = -0.28 - Math.sin(s.walkPhase) * 0.08;

        // Torso bobs vertically and sways with step cadence
        s.torsoGroup.position.y = 0.44 + Math.abs(Math.sin(s.walkPhase * 2)) * 0.028;
        s.torsoGroup.rotation.z = Math.sin(s.walkPhase) * 0.035;
        s.torsoGroup.rotation.x = 0.05;
      } else if (bot.emote !== 'spin') {
        // Idle standing rest stance & gentle mechanical breathing
        s.leftLegGroup.rotation.x *= 0.82;
        s.leftKneeGroup.rotation.x *= 0.82;
        s.leftAnkleGroup.rotation.x *= 0.82;

        s.rightLegGroup.rotation.x *= 0.82;
        s.rightKneeGroup.rotation.x *= 0.82;
        s.rightAnkleGroup.rotation.x *= 0.82;

        const idleTime = performance.now() * 0.002;
        s.torsoGroup.position.y = 0.44 + Math.sin(idleTime) * 0.008;
        s.torsoGroup.rotation.z *= 0.85;
        s.torsoGroup.rotation.x *= 0.85;

        // Arms hang naturally angled outwards
        s.leftArmGroup.rotation.x = THREE.MathUtils.lerp(s.leftArmGroup.rotation.x, 0.08, 0.1);
        s.rightArmGroup.rotation.x = THREE.MathUtils.lerp(s.rightArmGroup.rotation.x, 0.08, 0.1);
        s.leftArmGroup.rotation.z = THREE.MathUtils.lerp(s.leftArmGroup.rotation.z, 0.24, 0.1);
        s.rightArmGroup.rotation.z = THREE.MathUtils.lerp(s.rightArmGroup.rotation.z, -0.24, 0.1);

        s.leftForearmGroup.rotation.x = THREE.MathUtils.lerp(s.leftForearmGroup.rotation.x, -0.32, 0.1);
        s.rightForearmGroup.rotation.x = THREE.MathUtils.lerp(s.rightForearmGroup.rotation.x, -0.32, 0.1);
      }

      // --------------------------------------------------------------------------------------------
      // Cyclops Eye Tracking
      // --------------------------------------------------------------------------------------------
      const toPlayerX = me.x - bot.x;
      const toPlayerY = (me.y + EYE_HEIGHT) - (groundY + 0.72);
      const toPlayerZ = me.z - bot.z;
      const distToPlayer = Math.hypot(toPlayerX, toPlayerZ);

      let targetEyeYaw = 0;
      let targetEyePitch = 0;

      if (bot.alert) {
        // Tactical alert sweep when danger detected
        targetEyeYaw = Math.sin(performance.now() * 0.004) * 0.6;
        targetEyePitch = 0.1;
      } else if (distToPlayer < 7.5) {
        const worldAngle = Math.atan2(toPlayerX, toPlayerZ);
        let relAngle = worldAngle - s.currentYaw;
        while (relAngle > Math.PI) relAngle -= Math.PI * 2;
        while (relAngle < -Math.PI) relAngle += Math.PI * 2;

        targetEyeYaw = Math.max(-1.1, Math.min(1.1, relAngle));
        targetEyePitch = Math.max(-0.45, Math.min(0.55, Math.atan2(toPlayerY, distToPlayer)));
      } else if (bot.task === 'gather') {
        // Scanning downwards for scrap
        targetEyePitch = -0.25;
      }

      s.eyeYaw += (targetEyeYaw - s.eyeYaw) * Math.min(1, dt * 7);
      s.eyePitch += (targetEyePitch - s.eyePitch) * Math.min(1, dt * 7);

      s.eyeGroup.rotation.y = s.eyeYaw;
      if (bot.emote !== 'nod') {
        s.eyeGroup.rotation.x = -s.eyePitch;
      }
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
    // 1. Pot-Bellied Capsule Torso & Hull
    // --------------------------------------------------------------------------------------------
    const torsoGroup = new THREE.Group();
    torsoGroup.position.y = 0.44;
    yawGroup.add(torsoGroup);

    // Lower belly curving to hips
    const pelvis = mesh(TORSO_BASE_GEO, cMat, chassisMeshes, torsoGroup);
    pelvis.position.y = 0.08;

    // Dark waist belt collar
    const waist = mesh(TORSO_WAIST_GEO, aMat, accentMeshes, torsoGroup);
    waist.position.y = 0.17;

    // Mid barrel chest
    const midHull = mesh(TORSO_MID_GEO, cMat, chassisMeshes, torsoGroup);
    midHull.position.y = 0.28;

    // Top dome head
    const dome = mesh(TORSO_DOME_GEO, cMat, chassisMeshes, torsoGroup);
    dome.position.y = 0.39;

    // Dark dorsal cowl strip running along top dome
    const crest = mesh(CREST_GEO, aMat, accentMeshes, torsoGroup);
    crest.position.set(0, 0.63, -0.02);
    crest.rotation.x = -0.15;

    // Top shoulder antenna pegs
    const antennaL = mesh(ANTENNA_ROD_GEO, aMat, accentMeshes, torsoGroup);
    antennaL.position.set(-0.15, 0.62, -0.05);
    const antennaCapL = mesh(ANTENNA_CAP_GEO, cMat, chassisMeshes, torsoGroup);
    antennaCapL.position.set(-0.15, 0.67, -0.05);

    const antennaR = mesh(ANTENNA_ROD_GEO, aMat, accentMeshes, torsoGroup);
    antennaR.position.set(0.15, 0.62, -0.05);
    const antennaCapR = mesh(ANTENNA_CAP_GEO, cMat, chassisMeshes, torsoGroup);
    antennaCapR.position.set(0.15, 0.67, -0.05);

    // --------------------------------------------------------------------------------------------
    // 2. Monocular Cyclops Sensor Viewport (Center Chest)
    // --------------------------------------------------------------------------------------------
    const eyeGroup = new THREE.Group();
    eyeGroup.position.set(0, 0.34, 0.21);
    torsoGroup.add(eyeGroup);

    // Deep angled visor bezel
    const bezel = mesh(EYE_BEZEL_GEO, aMat, accentMeshes, eyeGroup);
    bezel.position.set(0, 0, 0.04);

    // Inner dark metallic rim
    const rim = mesh(EYE_RIM_GEO, aMat, accentMeshes, eyeGroup);
    rim.position.set(0, 0, 0.07);

    // Glossy convex dark glass dome
    const lens = mesh(EYE_LENS_GEO, GLASS_MAT, [], eyeGroup, false);
    lens.position.set(0, 0, 0.06);

    // Inner glowing sensor pupil
    const pupil = mesh(EYE_PUPIL_GEO, lMat, lensMeshes, eyeGroup, false);
    pupil.position.set(0, 0, 0.08);

    // Forward worklight spotlight & conical beam
    const workLightBeam = mesh(WORKLIGHT_GEO, WORKLIGHT_MAT, [], eyeGroup, false);
    workLightBeam.position.set(0, 0, 0.08);
    workLightBeam.visible = false;

    const workLightSpot = new THREE.PointLight(0xfff0c0, 0, 14, 1.4);
    workLightSpot.position.set(0, 0, 0.5);
    eyeGroup.add(workLightSpot);

    // --------------------------------------------------------------------------------------------
    // 3. Articulated Arms & Chunky Canister Forearms
    // --------------------------------------------------------------------------------------------
    // Left Arm
    const leftArmGroup = new THREE.Group();
    leftArmGroup.position.set(-0.28, 0.35, 0.0);
    leftArmGroup.rotation.z = 0.24;
    torsoGroup.add(leftArmGroup);

    mesh(SHOULDER_GEO, aMat, accentMeshes, leftArmGroup);
    const upperArmRodL = mesh(UPPER_ARM_ROD_GEO, aMat, accentMeshes, leftArmGroup);
    upperArmRodL.position.set(0, -0.09, 0);
    const upperArmPistonL = mesh(UPPER_ARM_PISTON_GEO, aMat, accentMeshes, leftArmGroup);
    upperArmPistonL.position.set(0, -0.08, 0.02);

    const leftForearmGroup = new THREE.Group();
    leftForearmGroup.position.set(0, -0.18, 0);
    leftForearmGroup.rotation.x = -0.32;
    leftArmGroup.add(leftForearmGroup);

    mesh(ELBOW_GEO, aMat, accentMeshes, leftForearmGroup);
    const forearmDrumL = mesh(FOREARM_DRUM_GEO, cMat, chassisMeshes, leftForearmGroup);
    forearmDrumL.position.set(0, -0.11, 0);

    const forearmBandTopL = mesh(FOREARM_BAND_GEO, aMat, accentMeshes, leftForearmGroup);
    forearmBandTopL.position.set(0, -0.02, 0);
    const forearmBandBtmL = mesh(FOREARM_BAND_GEO, aMat, accentMeshes, leftForearmGroup);
    forearmBandBtmL.position.set(0, -0.20, 0);

    const forearmVentL = mesh(FOREARM_VENT_GEO, aMat, accentMeshes, leftForearmGroup);
    forearmVentL.position.set(0, -0.11, 0.092);

    const wristL = mesh(WRIST_GEO, aMat, accentMeshes, leftForearmGroup);
    wristL.position.set(0, -0.23, 0);

    const leftClawGroup = new THREE.Group();
    leftClawGroup.position.set(0, -0.27, 0);
    leftClawGroup.rotation.y = Math.PI * 0.2;
    leftForearmGroup.add(leftClawGroup);
    mesh(CLAW_RING_GEO, aMat, accentMeshes, leftClawGroup);

    // Right Arm
    const rightArmGroup = new THREE.Group();
    rightArmGroup.position.set(0.28, 0.35, 0.0);
    rightArmGroup.rotation.z = -0.24;
    torsoGroup.add(rightArmGroup);

    mesh(SHOULDER_GEO, aMat, accentMeshes, rightArmGroup);
    const upperArmRodR = mesh(UPPER_ARM_ROD_GEO, aMat, accentMeshes, rightArmGroup);
    upperArmRodR.position.set(0, -0.09, 0);
    const upperArmPistonR = mesh(UPPER_ARM_PISTON_GEO, aMat, accentMeshes, rightArmGroup);
    upperArmPistonR.position.set(0, -0.08, 0.02);

    const rightForearmGroup = new THREE.Group();
    rightForearmGroup.position.set(0, -0.18, 0);
    rightForearmGroup.rotation.x = -0.32;
    rightArmGroup.add(rightForearmGroup);

    mesh(ELBOW_GEO, aMat, accentMeshes, rightForearmGroup);
    const forearmDrumR = mesh(FOREARM_DRUM_GEO, cMat, chassisMeshes, rightForearmGroup);
    forearmDrumR.position.set(0, -0.11, 0);

    const forearmBandTopR = mesh(FOREARM_BAND_GEO, aMat, accentMeshes, rightForearmGroup);
    forearmBandTopR.position.set(0, -0.02, 0);
    const forearmBandBtmR = mesh(FOREARM_BAND_GEO, aMat, accentMeshes, rightForearmGroup);
    forearmBandBtmR.position.set(0, -0.20, 0);

    const forearmVentR = mesh(FOREARM_VENT_GEO, aMat, accentMeshes, rightForearmGroup);
    forearmVentR.position.set(0, -0.11, 0.092);

    const wristR = mesh(WRIST_GEO, aMat, accentMeshes, rightForearmGroup);
    wristR.position.set(0, -0.23, 0);

    const rightClawGroup = new THREE.Group();
    rightClawGroup.position.set(0, -0.27, 0);
    rightClawGroup.rotation.y = -Math.PI * 0.2;
    rightForearmGroup.add(rightClawGroup);
    mesh(CLAW_RING_GEO, aMat, accentMeshes, rightClawGroup);

    // --------------------------------------------------------------------------------------------
    // 4. Bipedal Walker Legs & Ventilated Boot Drums
    // --------------------------------------------------------------------------------------------
    // Left Leg
    const leftLegGroup = new THREE.Group();
    leftLegGroup.position.set(-0.16, 0.44, 0.0);
    yawGroup.add(leftLegGroup);

    mesh(HIP_GEO, aMat, accentMeshes, leftLegGroup);
    const thighRodL = mesh(THIGH_ROD_GEO, aMat, accentMeshes, leftLegGroup);
    thighRodL.position.set(0, -0.10, 0);
    const thighSleeveL = mesh(THIGH_SLEEVE_GEO, aMat, accentMeshes, leftLegGroup);
    thighSleeveL.position.set(0, -0.07, 0);

    const leftKneeGroup = new THREE.Group();
    leftKneeGroup.position.set(0, -0.20, 0);
    leftLegGroup.add(leftKneeGroup);

    mesh(KNEE_GEO, aMat, accentMeshes, leftKneeGroup);
    const shinDrumL = mesh(SHIN_DRUM_GEO, cMat, chassisMeshes, leftKneeGroup);
    shinDrumL.position.set(0, -0.10, 0);

    const shinCollarTopL = mesh(SHIN_COLLAR_GEO, aMat, accentMeshes, leftKneeGroup);
    shinCollarTopL.position.set(0, -0.01, 0);
    const shinCollarBtmL = mesh(SHIN_COLLAR_GEO, aMat, accentMeshes, leftKneeGroup);
    shinCollarBtmL.position.set(0, -0.19, 0);

    const shinVentL = mesh(SHIN_VENT_GEO, aMat, accentMeshes, leftKneeGroup);
    shinVentL.position.set(0, -0.10, 0.088);

    const leftAnkleGroup = new THREE.Group();
    leftAnkleGroup.position.set(0, -0.20, 0);
    leftKneeGroup.add(leftAnkleGroup);

    mesh(ANKLE_GEO, aMat, accentMeshes, leftAnkleGroup);
    const footSoleL = mesh(FOOT_SOLE_GEO, aMat, accentMeshes, leftAnkleGroup);
    footSoleL.position.set(0, -0.025, 0.03);
    const footHeelL = mesh(FOOT_HEEL_GEO, aMat, accentMeshes, leftAnkleGroup);
    footHeelL.position.set(0, -0.025, -0.05);
    const toeCapL = mesh(TOE_CAP_GEO, cMat, chassisMeshes, leftAnkleGroup);
    toeCapL.position.set(0, 0.005, 0.07);
    toeCapL.rotation.x = 0.15;

    // Right Leg
    const rightLegGroup = new THREE.Group();
    rightLegGroup.position.set(0.16, 0.44, 0.0);
    yawGroup.add(rightLegGroup);

    mesh(HIP_GEO, aMat, accentMeshes, rightLegGroup);
    const thighRodR = mesh(THIGH_ROD_GEO, aMat, accentMeshes, rightLegGroup);
    thighRodR.position.set(0, -0.10, 0);
    const thighSleeveR = mesh(THIGH_SLEEVE_GEO, aMat, accentMeshes, rightLegGroup);
    thighSleeveR.position.set(0, -0.07, 0);

    const rightKneeGroup = new THREE.Group();
    rightKneeGroup.position.set(0, -0.20, 0);
    rightLegGroup.add(rightKneeGroup);

    mesh(KNEE_GEO, aMat, accentMeshes, rightKneeGroup);
    const shinDrumR = mesh(SHIN_DRUM_GEO, cMat, chassisMeshes, rightKneeGroup);
    shinDrumR.position.set(0, -0.10, 0);

    const shinCollarTopR = mesh(SHIN_COLLAR_GEO, aMat, accentMeshes, rightKneeGroup);
    shinCollarTopR.position.set(0, -0.01, 0);
    const shinCollarBtmR = mesh(SHIN_COLLAR_GEO, aMat, accentMeshes, rightKneeGroup);
    shinCollarBtmR.position.set(0, -0.19, 0);

    const shinVentR = mesh(SHIN_VENT_GEO, aMat, accentMeshes, rightKneeGroup);
    shinVentR.position.set(0, -0.10, 0.088);

    const rightAnkleGroup = new THREE.Group();
    rightAnkleGroup.position.set(0, -0.20, 0);
    rightKneeGroup.add(rightAnkleGroup);

    mesh(ANKLE_GEO, aMat, accentMeshes, rightAnkleGroup);
    const footSoleR = mesh(FOOT_SOLE_GEO, aMat, accentMeshes, rightAnkleGroup);
    footSoleR.position.set(0, -0.025, 0.03);
    const footHeelR = mesh(FOOT_HEEL_GEO, aMat, accentMeshes, rightAnkleGroup);
    footHeelR.position.set(0, -0.025, -0.05);
    const toeCapR = mesh(TOE_CAP_GEO, cMat, chassisMeshes, rightAnkleGroup);
    toeCapR.position.set(0, 0.005, 0.07);
    toeCapR.rotation.x = 0.15;

    this.group.add(root);

    return {
      group: root,
      yawGroup,
      torsoGroup,
      eyeGroup,
      pupilMesh: pupil,
      workLightBeam,
      workLightSpot,
      leftArmGroup,
      leftForearmGroup,
      leftClawGroup,
      rightArmGroup,
      rightForearmGroup,
      rightClawGroup,
      leftLegGroup,
      leftKneeGroup,
      leftAnkleGroup,
      rightLegGroup,
      rightKneeGroup,
      rightAnkleGroup,
      currentYaw: 0,
      eyeYaw: 0,
      eyePitch: 0,
      walkPhase: 0,
      spinAngle: 0,
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
      const by = heightAt(bx, bz) + 0.65; // center of torso / eye height

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
