// Guardian missiles (shared/missiles.ts): each one flies its arc on the server clock from the 'missile' message, a
// hot glowing head trailing smoke, and its impact point is marked on the sand from launch: a red ring the size of
// the blast whose inner disc fills as the missile comes down. The burst itself is drawn by GuardianFx (the bolt
// burst, dust, shake). Visual only: the server decides who is caught.
import * as THREE from 'three/webgpu';
import { float, instancedBufferAttribute, length, mix, smoothstep, uniform, uv, vec2, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { BLAST_R, missileAt, type MissilePath } from '../../shared/missiles.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import { heightAt } from '../../shared/terrain.ts';

type Launch = Extract<ServerMsg, { t: 'missile' }>;

/** The head: a hot core and a glow sprite (m, HDR before bloom). */
const HEAD_R = 0.5;
const HEAD = new THREE.Color(5, 1.6, 0.5);
const GLOW_SIZE = 7;
const GLOW = new THREE.Color(2.4, 0.7, 0.2);
/** Smoke puffs: one every PUFF_M metres of flight, living PUFF_LIFE s, growing from PUFF_SIZE. */
const PUFF_M = 2;
const PUFF_LIFE = 3.5;
const PUFF_SIZE = 1.4;
const MAX_PUFFS = 1024;
/** The marker: grid cells across, lift off the sand (m), ring brightness. */
const MARK_N = 16;
const MARK_LIFT = 0.1;
const MARK_GAIN = 2.2;

const headGeo = new THREE.SphereGeometry(HEAD_R, 10, 8);
const headMat = new THREE.MeshBasicNodeMaterial({ color: HEAD });

type Flying = { m: Launch; head: THREE.Group; mark: THREE.Mesh; fill: { value: number }; last: THREE.Vector3; started: boolean };

const _p = new THREE.Vector3();

class Smoke {
  readonly mesh: THREE.Sprite;
  private pos = new Float32Array(MAX_PUFFS * 3);
  private data = new Float32Array(MAX_PUFFS * 3); // alpha, size, heat
  private posAttr = new THREE.InstancedBufferAttribute(this.pos, 3);
  private dataAttr = new THREE.InstancedBufferAttribute(this.data, 3);
  private age = new Float32Array(MAX_PUFFS).fill(1);
  private next = 0;
  private live = 0;

  constructor() {
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    m.positionNode = instancedBufferAttribute(this.posAttr);
    const d = instancedBufferAttribute(this.dataAttr, 'vec3') as unknown as Node<'vec3'>;
    // Fresh puffs glow with the exhaust, then cool to a faint grey smoke.
    m.colorNode = mix(vec3(0.05, 0.045, 0.04), vec3(2.0, 0.6, 0.15), d.z);
    const soft = float(1).sub(smoothstep(0.0, 0.5, length(uv().sub(0.5))));
    m.opacityNode = soft.mul(soft).mul(d.x);
    m.scaleNode = vec2(d.y, d.y);
    this.mesh = new THREE.Sprite(m);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  emit(x: number, y: number, z: number) {
    const i = this.next;
    this.next = (i + 1) % MAX_PUFFS;
    this.pos.set([x + (Math.random() - 0.5) * 0.4, y + (Math.random() - 0.5) * 0.4, z + (Math.random() - 0.5) * 0.4], i * 3);
    this.age[i] = 0;
    this.live = Math.max(this.live, i + 1);
  }

  update(dt: number) {
    if (this.live === 0) return;
    let last = 0;
    for (let i = 0; i < this.live; i++) {
      const t = (this.age[i] += dt / PUFF_LIFE);
      if (t >= 1) {
        this.data[i * 3] = 0;
        continue;
      }
      last = i + 1;
      this.pos[i * 3 + 1] += 0.4 * dt; // drifting up a little
      this.data[i * 3] = 0.75 * (1 - t) * (1 - t);
      this.data[i * 3 + 1] = PUFF_SIZE * (1 + 4 * Math.sqrt(t));
      this.data[i * 3 + 2] = Math.max(0, 1 - t * 12);
    }
    this.live = last;
    this.mesh.count = last;
    this.posAttr.needsUpdate = true;
    this.dataAttr.needsUpdate = true;
  }
}

function markerMesh(p: MissilePath): { mesh: THREE.Mesh; fill: { value: number } } {
  const geo = new THREE.PlaneGeometry(2, 2, MARK_N, MARK_N);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const r = BLAST_R * 1.1;
  for (let i = 0; i < pos.count; i++) {
    const x = p.x1 + pos.getX(i) * r, z = p.z1 - pos.getY(i) * r;
    pos.setXYZ(i, x, heightAt(x, z) + MARK_LIFT, z);
  }
  geo.computeBoundingSphere();
  const fill = uniform(0);
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4,
  });
  const d = length(uv().sub(0.5)).mul(2); // 0 centre, 1 rim
  const ring = smoothstep(0.78, 0.9, d).mul(float(1).sub(smoothstep(0.92, 1.0, d)));
  const disc = float(1).sub(smoothstep(fill.sub(0.04), fill, d)).mul(0.35);
  m.colorNode = vec3(1, 0.12, 0.04).mul(MARK_GAIN);
  m.opacityNode = ring.add(disc).mul(fill.mul(0.6).add(0.4));
  return { mesh: new THREE.Mesh(geo, m), fill };
}

export class Missiles {
  private flying = new Map<number, Flying>();
  private smoke = new Smoke();
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    scene.add(this.smoke.mesh);
  }

  launch(m: Launch) {
    const head = new THREE.Group();
    const glowMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const g = float(1).sub(smoothstep(0, 1, length(uv().sub(0.5)).mul(2)));
    glowMat.colorNode = vec3(GLOW.r, GLOW.g, GLOW.b);
    glowMat.opacityNode = g.mul(g);
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(GLOW_SIZE);
    head.add(new THREE.Mesh(headGeo, headMat), glow);
    head.visible = false;
    const { mesh: mark, fill } = markerMesh(m);
    this.scene.add(head, mark);
    this.flying.set(m.id, { m, head, mark, fill, last: new THREE.Vector3(m.x0, m.y0, m.z0), started: false });
  }

  /** Missile `id` landed: gone (the burst is drawn by the caller). */
  land(id: number) {
    const f = this.flying.get(id);
    if (!f) return;
    this.drop(f);
    this.flying.delete(id);
  }

  /** Seconds until each missile landing within `r` m of (x, z) comes down (none: empty). */
  incoming(x: number, z: number, r: number, now: number): number[] {
    const out: number[] = [];
    for (const f of this.flying.values()) {
      if (Math.hypot(f.m.x1 - x, f.m.z1 - z) < r) out.push(f.m.flight - (now - f.m.time) / 1000);
    }
    return out;
  }

  /** The missiles in the air at server time `now` (ms): where each is and its velocity (m/s), for their roar. */
  heads(now: number): { id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }[] {
    const out = [];
    for (const [id, f] of this.flying) {
      const t = (now - f.m.time) / 1000;
      if (t < 0 || t >= f.m.flight) continue;
      const a = missileAt(f.m, t, { x: 0, y: 0, z: 0 }), b = missileAt(f.m, Math.min(f.m.flight, t + 0.05), { x: 0, y: 0, z: 0 });
      const k = 1 / (Math.min(f.m.flight, t + 0.05) - t || 1);
      out.push({ id, ...a, vx: (b.x - a.x) * k, vy: (b.y - a.y) * k, vz: (b.z - a.z) * k });
    }
    return out;
  }

  /** Every frame, at server time `now` (ms). */
  update(dt: number, now: number) {
    for (const [id, f] of this.flying) {
      const t = (now - f.m.time) / 1000;
      // Overdue by a while: the 'blast' never came (out of range by then); let it go.
      if (t > f.m.flight + 2) {
        this.land(id);
        continue;
      }
      f.fill.value = Math.min(1, Math.max(0, t / f.m.flight));
      if (t < 0) continue;
      missileAt(f.m, t, _p);
      f.head.position.copy(_p);
      f.head.visible = true;
      if (!f.started) {
        f.last.copy(_p);
        f.started = true;
      }
      // Smoke every PUFF_M metres along the way since last frame.
      const seg = _p.distanceTo(f.last), n = Math.floor(seg / PUFF_M);
      for (let i = 1; i <= n; i++) {
        f.last.lerp(_p, PUFF_M / Math.max(PUFF_M, f.last.distanceTo(_p)));
        this.smoke.emit(f.last.x, f.last.y, f.last.z);
      }
    }
    this.smoke.update(dt);
  }

  private drop(f: Flying) {
    f.head.removeFromParent();
    f.mark.removeFromParent();
    ((f.head.children[1] as THREE.Sprite).material as THREE.Material).dispose();
    (f.mark.material as THREE.Material).dispose();
    f.mark.geometry.dispose();
  }
}
