// Guardians' laser bolts (shared/guardians.ts, server/guardians.ts): big glowing slugs flying straight from the
// cannon at BOLT_SPEED, drawn on the server clock from each 'shot' (starting at the drawn muzzle, easing onto the
// server's line), and a burst of light and sand at each 'boom'. Visual only: the server decides who is hit.
import * as THREE from 'three/webgpu';
import { abs, dot, float, length, normalView, positionViewDirection, pow, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import { BOLT_RANGE, BOLT_SPEED } from '../../shared/guardians.ts';
import type { ServerMsg } from '../../shared/protocol.ts';

type Shot = Extract<ServerMsg, { t: 'shot' }>;

/** Bolt core and glow shell (m), HDR colours (bloom does the rest). */
const LENGTH = 4.5, CORE_R = 0.35, GLOW_R = 0.9;
const CORE = new THREE.Color(4, 1.1, 0.35);
const GLOW = new THREE.Color(1.1, 0.16, 0.04);
/** The drawn muzzle and the server's line meet over this long (s). */
const EASE_S = 0.35;
/** A burst: grows to this size (m) over its life (s). */
const BURST_SIZE = 11, BURST_LIFE = 0.7;

const coreGeo = new THREE.CapsuleGeometry(CORE_R, LENGTH, 4, 10).rotateX(Math.PI / 2);
const glowGeo = new THREE.CapsuleGeometry(GLOW_R, LENGTH + 0.8, 4, 12).rotateX(Math.PI / 2);
const coreMat = new THREE.MeshBasicNodeMaterial({ color: CORE });
const glowMat = new THREE.MeshBasicNodeMaterial({ color: GLOW, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
glowMat.opacityNode = pow(abs(dot(normalView, positionViewDirection)), float(2)).mul(0.8); // soft edges

type Bolt = { shot: Shot; mesh: THREE.Group; off: THREE.Vector3; age: number };
type Burst = { sprite: THREE.Sprite; fade: { value: number }; age: number };

const _p = new THREE.Vector3(), _d = new THREE.Vector3();

export class Bolts {
  private bolts = new Map<number, Bolt>();
  private bursts: Burst[] = [];
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** A bolt fired; `muzzle` is where the drawn gun's muzzle is (null: not drawn). */
  fire(shot: Shot, muzzle: THREE.Vector3 | null) {
    const mesh = new THREE.Group();
    mesh.add(new THREE.Mesh(coreGeo, coreMat), new THREE.Mesh(glowGeo, glowMat));
    mesh.lookAt(shot.dx, shot.dy, shot.dz); // +Z along the flight (from the origin)
    const off = muzzle ? muzzle.clone().sub(_p.set(shot.x, shot.y, shot.z)) : new THREE.Vector3();
    this.scene.add(mesh);
    this.bolts.set(shot.id, { shot, mesh, off, age: 0 });
  }

  /** A bolt burst at (x, y, z). */
  boom(id: number, x: number, y: number, z: number) {
    const b = this.bolts.get(id);
    if (b) {
      b.mesh.removeFromParent();
      this.bolts.delete(id);
    }
    const fade = uniform(1);
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const r = length(uv().sub(0.5)).mul(2);
    m.colorNode = vec3(2.2, 0.55, 0.16).mul(fade);
    m.opacityNode = float(1).sub(smoothstep(0.0, 1, r)).mul(fade).mul(0.8);
    const sprite = new THREE.Sprite(m);
    sprite.position.set(x, y + 1, z);
    this.scene.add(sprite);
    this.bursts.push({ sprite, fade, age: 0 });
  }

  /** Every frame, at server time `now` (ms). */
  update(dt: number, now: number) {
    for (const [id, b] of this.bolts) {
      const s = b.shot;
      const d = (BOLT_SPEED * Math.max(0, now - s.time)) / 1000;
      if (d > BOLT_RANGE + 20) {
        b.mesh.removeFromParent();
        this.bolts.delete(id);
        continue;
      }
      b.age += dt;
      const ease = Math.max(0, 1 - b.age / EASE_S);
      _d.set(s.dx, s.dy, s.dz);
      _p.set(s.x, s.y, s.z).addScaledVector(_d, d).addScaledVector(b.off, ease * ease);
      b.mesh.position.copy(_p).addScaledVector(_d, -LENGTH / 2);
    }
    this.bursts = this.bursts.filter((b) => {
      b.age += dt;
      const t = b.age / BURST_LIFE;
      if (t >= 1) {
        b.sprite.removeFromParent();
        (b.sprite.material as THREE.Material).dispose();
        return false;
      }
      b.sprite.scale.setScalar(BURST_SIZE * (0.3 + 0.7 * Math.sqrt(t)));
      b.fade.value = (1 - t) * (1 - t);
      return true;
    });
  }
}
