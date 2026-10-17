// Dig feedback, client-side only: crosshair, a ground ring where the next stroke would land,
// and a sand puff whenever a stroke lands (ours predicted, or another player's from the server).
import * as THREE from 'three/webgpu';
import { DIG_RADIUS, digTarget, type Point } from '../shared/dig.ts';
import { heightAt } from '../shared/terrain.ts';
import { uAt, ustarFrom10, wind } from './world/wind.ts';

const MAX_PARTICLES = 160;
const PER_PUFF = 18;
const LIFE = 0.9;
const GRAVITY = -9;
// The target ring: a thin faint line draped on the sand (a flat disc would cut into curved dunes).
const RING_SEGS = 48;
const RING_IN = DIG_RADIUS * 0.95;
const RING_LIFT = 0.025;

type Particle = { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; size: number };

export class DigFx {
  private ring: THREE.Mesh;
  private grains: THREE.InstancedMesh;
  private particles: Particle[] = [];
  private dummy = new THREE.Object3D();
  private ringPos: Float32Array;

  constructor(scene: THREE.Scene) {
    const ringMat = new THREE.MeshBasicNodeMaterial({
      color: 0xfff2d0, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4,
    });
    const ringGeo = new THREE.BufferGeometry();
    this.ringPos = new Float32Array((RING_SEGS + 1) * 2 * 3);
    ringGeo.setAttribute('position', new THREE.BufferAttribute(this.ringPos, 3).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let i = 0; i < RING_SEGS; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    ringGeo.setIndex(idx);
    this.ring = new THREE.Mesh(ringGeo, ringMat);
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    this.ring.renderOrder = 2;
    scene.add(this.ring);

    const grainMat = new THREE.MeshStandardNodeMaterial({ color: 0xd9b27c, roughness: 1 });
    this.grains = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), grainMat, MAX_PARTICLES);
    this.grains.count = 0;
    this.grains.frustumCulled = false;
    scene.add(this.grains);

    const style = document.createElement('style');
    style.textContent = `
      #crosshair { position: fixed; left: 50%; top: 50%; width: 6px; height: 6px; margin: -3px 0 0 -3px;
        border-radius: 50%; background: rgba(255,255,255,.85); box-shadow: 0 0 0 1px rgba(0,0,0,.35);
        pointer-events: none; }
      body.third-person #crosshair, body.down #crosshair { display: none; }`;
    document.head.appendChild(style);
    const cross = document.createElement('div');
    cross.id = 'crosshair';
    document.body.append(cross);
  }

  /** A stroke landed at `at`. */
  puff(at: Point, pile: boolean) {
    for (let i = 0; i < PER_PUFF; i++) {
      if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
      const a = Math.random() * Math.PI * 2;
      const s = (pile ? 1 : 2) * (0.5 + Math.random());
      this.particles.push({
        x: at.x + Math.cos(a) * 0.3, y: at.y + 0.05, z: at.z + Math.sin(a) * 0.3,
        vx: Math.cos(a) * s, vy: (pile ? 1.5 : 3) + Math.random() * 2.5, vz: Math.sin(a) * s,
        age: Math.random() * 0.2, size: 0.03 + Math.random() * 0.05,
      });
    }
  }

  /**
   * Per render frame: `feet` is the local player's position, yaw/pitch the quantized camera angles,
   * `locked` whether the pointer is captured (digging enabled).
   */
  update(dt: number, feet: { x: number; y: number; z: number }, yawQ: number, pitchQ: number, locked: boolean) {
    const target = locked ? digTarget(feet, yawQ, pitchQ) : null;
    this.ring.visible = target !== null;
    if (target) {
      const pos = this.ringPos;
      for (let i = 0; i <= RING_SEGS; i++) {
        const a = (i / RING_SEGS) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        for (let k = 0; k < 2; k++) {
          const r = k ? DIG_RADIUS : RING_IN;
          const x = target.x + c * r, z = target.z + s * r, o = (i * 2 + k) * 3;
          pos[o] = x; pos[o + 1] = heightAt(x, z) + RING_LIFT; pos[o + 2] = z;
        }
      }
      this.ring.geometry.attributes.position.needsUpdate = true;
    }

    let n = 0;
    this.particles = this.particles.filter((p) => (p.age += dt) < LIFE);
    // Thrown sand drifts downwind (wind at ~0.5 m, picked up over ~0.5 s).
    const carry = uAt(ustarFrom10(wind.u10), 0.5);
    for (const p of this.particles) {
      p.vx += (carry * wind.dx - p.vx) * 2 * dt;
      p.vz += (carry * wind.dz - p.vz) * 2 * dt;
      p.vy += GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const s = p.size * (1 - p.age / LIFE);
      this.dummy.position.set(p.x, p.y, p.z);
      this.dummy.scale.setScalar(s);
      this.dummy.updateMatrix();
      this.grains.setMatrixAt(n++, this.dummy.matrix);
    }
    this.grains.count = n;
    this.grains.instanceMatrix.needsUpdate = true;
  }
}
