// A cable in the disassembly mode (src/teardown/junk.ts Kit.wire): a Verlet rope along the wire's own curve. At rest it is
// just the modelled tube; once it is shaken, or an end has come off, it moves: the ends that are still fixed are held
// where the terminal is (the shaking pulls the held end about), the rest hangs and swings on its own weight, and a
// spring pulls it back toward its shape that is stiff while both ends hold and nearly nothing once one is off, so a
// cable with a loose end goes floppy. The tube's geometry is rebuilt from the particles while it moves.
import * as THREE from 'three/webgpu';

const N = 14;
const SUBSTEPS = 2;
const ITERATIONS = 6;
const DAMPING = 0.985;

export class Rope {
  /** Particles along the cable, in its group's own frame: now, a step ago, and as modelled. */
  readonly pts: THREE.Vector3[] = [];
  readonly prev: THREE.Vector3[] = [];
  readonly rest: THREE.Vector3[] = [];
  private len: number[] = [];
  /** Moving (else the modelled tube is shown as it is). */
  active = false;
  /** Which ends held last frame, to notice one coming off. */
  wasAttached: [boolean, boolean] = [true, true];
  /** Frames of near stillness in a row. */
  calm = 0;
  private frame = 0;
  readonly restGeo: THREE.BufferGeometry;
  readonly restHit: THREE.BufferGeometry;

  private tube: THREE.Mesh;
  private hit: THREE.Mesh;
  private radius: number;

  constructor(curve: THREE.Curve<THREE.Vector3>, tube: THREE.Mesh, hit: THREE.Mesh, radius: number) {
    this.tube = tube;
    this.hit = hit;
    this.radius = radius;
    for (let i = 0; i < N; i++) {
      const p = curve.getPoint(i / (N - 1));
      this.pts.push(p.clone());
      this.prev.push(p.clone());
      this.rest.push(p.clone());
    }
    for (let i = 0; i + 1 < N; i++) this.len.push(this.rest[i].distanceTo(this.rest[i + 1]));
    this.restGeo = tube.geometry;
    this.restHit = hit.geometry;
  }

  /** Move one frame. `pin0` / `pin1`: where the first / last particle is held, or null when that end is free. `gravity`:
   *  the pull of weight in the cable's frame (units per second squared); `k`: the spring back toward the modelled shape. */
  step(dt: number, pin0: THREE.Vector3 | null, pin1: THREE.Vector3 | null, gravity: THREE.Vector3, k: number) {
    const h = Math.min(dt, 1 / 30) / SUBSTEPS;
    const pins = [pin0, pin1];
    let moved = 0;
    for (let s = 0; s < SUBSTEPS; s++) {
      for (let i = 0; i < N; i++) {
        const pin = i === 0 ? pins[0] : i === N - 1 ? pins[1] : null;
        const p = this.pts[i], q = this.prev[i];
        if (pin) {
          p.copy(pin);
          q.copy(pin);
          continue;
        }
        const r = this.rest[i];
        const vx = (p.x - q.x) * DAMPING, vy = (p.y - q.y) * DAMPING, vz = (p.z - q.z) * DAMPING;
        q.copy(p);
        p.x += vx + (gravity.x + k * (r.x - p.x)) * h * h;
        p.y += vy + (gravity.y + k * (r.y - p.y)) * h * h;
        p.z += vz + (gravity.z + k * (r.z - p.z)) * h * h;
      }
      for (let it = 0; it < ITERATIONS; it++) {
        for (let i = 0; i + 1 < N; i++) {
          const a = this.pts[i], b = this.pts[i + 1];
          const fa = i === 0 && pins[0] !== null, fb = i + 1 === N - 1 && pins[1] !== null;
          if (fa && fb) continue;
          const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
          const l = Math.hypot(dx, dy, dz) || 1e-6;
          const diff = (l - this.len[i]) / l;
          const wa = fa ? 0 : fb ? 1 : 0.5, wb = fb ? 0 : fa ? 1 : 0.5;
          a.x += dx * diff * wa; a.y += dy * diff * wa; a.z += dz * diff * wa;
          b.x -= dx * diff * wb; b.y -= dy * diff * wb; b.z -= dz * diff * wb;
        }
      }
    }
    for (let i = 0; i < N; i++) moved += this.pts[i].distanceToSquared(this.prev[i]);
    this.calm = moved < 1e-7 ? this.calm + 1 : 0;
  }

  /** The tube follows the particles (the invisible shape the pointer picks it by every few frames only). */
  rebuild() {
    const curve = new THREE.CatmullRomCurve3(this.pts.map((p) => p.clone()));
    const geo = new THREE.TubeGeometry(curve, 20, this.radius, 6);
    if (this.tube.geometry !== this.restGeo) this.tube.geometry.dispose();
    this.tube.geometry = geo;
    if (this.frame++ % 3 === 0) {
      const hit = new THREE.TubeGeometry(curve, 8, Math.max(0.1, this.radius * 2), 5);
      if (this.hit.geometry !== this.restHit) this.hit.geometry.dispose();
      this.hit.geometry = hit;
    }
  }

  /** Back to the modelled tube. */
  reset() {
    if (this.tube.geometry !== this.restGeo) this.tube.geometry.dispose();
    if (this.hit.geometry !== this.restHit) this.hit.geometry.dispose();
    this.tube.geometry = this.restGeo;
    this.hit.geometry = this.restHit;
    for (let i = 0; i < N; i++) {
      this.pts[i].copy(this.rest[i]);
      this.prev[i].copy(this.rest[i]);
    }
    this.active = false;
    this.calm = 0;
  }

  /** A shove to particle `i` and its neighbours (an end that has just come off). */
  kick(end: 0 | 1, v: THREE.Vector3) {
    const at = end === 0 ? [0, 1, 2] : [N - 1, N - 2, N - 3];
    at.forEach((i, n) => this.pts[i].addScaledVector(v, 1 - n * 0.3));
  }

  static readonly N = N;
}
