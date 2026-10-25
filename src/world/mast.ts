// The flag mast by the home base (layout and collision in shared/base.ts MAST): a tall tapered concrete
// pole on a plinth with big buttress fins, and a striped windsock that swings round to the wind and lifts and flutters with it (src/world/wind.ts).
// Built from primitives here; small enough not to need a Blender model.
import * as THREE from 'three/webgpu';
import { MAST } from '../../shared/base.ts';
import { ORIGIN } from '../../shared/origin.ts';
import { uAt, wind, type WindSample } from './wind.ts';

const CONCRETE = 0x9a8f80, CONCRETE_DARK = 0x6f675d, STEEL = 0x3a3430;
/** Windsock: mouth and tail radius, length, stripes (one segment each, orange first). */
const SOCK = { r0: 0.36, r1: 0.14, len: 2.6, n: 5, orange: 0xc8501e, white: 0xe6e0d2 };
/** Swivel arm from the pole's axis out to the sock's hoop. */
const ARM = 0.38;
/** Wind (m/s at the sock) that holds it straight out; below this it hangs down. */
const FULL_WIND = 8;
/** How far the fins reach below the sand surface. */
const FIN_DEPTH = 3;

function material(color: number, roughness: number, metalness = 0): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.color.setHex(color);
  m.roughness = roughness;
  m.metalness = metalness;
  return m;
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export class Mast {
  readonly group = new THREE.Group();
  /** Yaws to the wind at the pole top. */
  private swivel = new THREE.Group();
  /** The hoop (droops) and one joint per stripe after it (sag and flutter). */
  private joints: THREE.Group[] = [];
  private yaw = 0;
  private yawVel = 0;
  private lift = 0;
  private sample: WindSample = { dx: 0, dz: 0, ustar: 0, q: 0, emit: 0 };

  constructor(scene: THREE.Scene) {
    this.group.position.set(ORIGIN.x + MAST.x, ORIGIN.y, ORIGIN.z + MAST.z);
    scene.add(this.group);
    const concrete = material(CONCRETE, 0.92), dark = material(CONCRETE_DARK, 0.95), steel = material(STEEL, 0.6, 0.6);
    const { plinth, fins } = MAST;

    // Plinth, sunk a little into the sand, with a chamfered cap.
    const base = mesh(new THREE.CylinderGeometry(plinth.r, plinth.r + 0.05, plinth.h + 0.3, 12), dark);
    base.position.y = (plinth.h - 0.3) / 2;
    this.group.add(base);
    const cap = mesh(new THREE.CylinderGeometry(plinth.r - 0.12, plinth.r, 0.08, 12), dark);
    cap.position.y = plinth.h + 0.04;
    this.group.add(cap);

    // Pole: tapered, cast in lifts with a joint every 3 m.
    const pole = mesh(new THREE.CylinderGeometry(MAST.r1, MAST.r0, MAST.h - plinth.h, 14), concrete);
    pole.position.y = plinth.h + (MAST.h - plinth.h) / 2;
    this.group.add(pole);
    const radiusAt = (y: number) => MAST.r0 + (MAST.r1 - MAST.r0) * (y - plinth.h) / (MAST.h - plinth.h);
    for (let y = plinth.h + 3; y < MAST.h - 1; y += 3) {
      const r = radiusAt(y) + 0.012;
      const ring = mesh(new THREE.CylinderGeometry(r, r, 0.05, 14), dark);
      ring.position.y = y;
      this.group.add(ring);
    }

    // Buttress fins: right triangles against the pole, sloping out past the plinth, sunk into the sand.
    const tri = new THREE.Shape();
    tri.moveTo(0, -FIN_DEPTH);
    tri.lineTo(fins.reach, -FIN_DEPTH);
    tri.lineTo(fins.reach, 0.25);
    tri.lineTo(0, fins.h);
    const finGeo = new THREE.ExtrudeGeometry(tri, { depth: fins.t, bevelEnabled: false });
    finGeo.translate(0, 0, -fins.t / 2);
    for (let i = 0; i < fins.n; i++) {
      const f = mesh(finGeo, concrete);
      f.position.y = 0;
      f.rotation.y = (i / fins.n) * Math.PI * 2;
      this.group.add(f);
    }

    // Top: a steel cap, and the swivel with the windsock.
    const top = mesh(new THREE.CylinderGeometry(MAST.r1 + 0.03, MAST.r1 + 0.03, 0.12, 14), steel);
    top.position.y = MAST.h;
    this.group.add(top);

    this.swivel.position.y = MAST.h - 0.5;
    this.group.add(this.swivel);
    const pin = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.35, 6), steel);
    this.swivel.add(pin);
    const arm = mesh(new THREE.CylinderGeometry(0.022, 0.022, ARM, 6), steel);
    arm.rotation.z = Math.PI / 2;
    arm.position.x = ARM / 2;
    this.swivel.add(arm);

    // The sock runs along +X from the hoop; each stripe hangs from the joint at the end of the one before.
    const hoop = new THREE.Group();
    hoop.position.x = ARM + SOCK.r0;
    this.swivel.add(hoop);
    const ring = mesh(new THREE.TorusGeometry(SOCK.r0, 0.015, 6, 20), steel);
    ring.rotation.y = Math.PI / 2;
    hoop.add(ring);
    const cloth = [material(SOCK.orange, 0.85), material(SOCK.white, 0.85)];
    // Double-sided cloth must cast its shadow from one side, or it breaks the shadow pass.
  for (const c of cloth) {
    c.side = THREE.DoubleSide;
    c.shadowSide = THREE.FrontSide;
  }
    const seg = SOCK.len / SOCK.n;
    let parent = hoop;
    this.joints.push(hoop);
    for (let i = 0; i < SOCK.n; i++) {
      const r0 = SOCK.r0 + (SOCK.r1 - SOCK.r0) * (i / SOCK.n);
      const r1 = SOCK.r0 + (SOCK.r1 - SOCK.r0) * ((i + 1) / SOCK.n);
      const geo = new THREE.CylinderGeometry(r1, r0, seg, 16, 1, true);
      geo.rotateZ(-Math.PI / 2); // +Y (top, r1) to +X
      geo.translate(seg / 2, 0, 0);
      const stripe = mesh(geo, cloth[i % 2]);
      parent.add(stripe);
      if (i === SOCK.n - 1) break;
      const j = new THREE.Group();
      j.position.x = seg;
      parent.add(j);
      this.joints.push(j);
      parent = j;
    }
  }

  /** Swing the sock to the wind at the top of the pole. `dt` in seconds. */
  update(dt: number) {
    dt = Math.min(dt, 0.1);
    const t = wind.t;
    const s = wind.sample(this.group.position.x, this.group.position.z, this.sample);
    const u = uAt(s.ustar, MAST.h);
    // Point downwind: yaw maps the sock's +X onto (dx, dz). A damped spring, wrapped to the short way round.
    const target = Math.atan2(-s.dz, s.dx) + (Math.sin(t * 1.3) + Math.sin(t * 2.9 + 1)) * 0.06 * Math.min(1, u / 4);
    let err = target - this.yaw;
    err -= Math.round(err / (Math.PI * 2)) * Math.PI * 2;
    const k = 2 + u * 0.6;
    this.yawVel += (err * k * k - this.yawVel * 2 * k * 0.5) * dt;
    this.yaw += this.yawVel * dt;
    this.swivel.rotation.y = this.yaw;
    // Lift: limp below a breath of wind, straight out at FULL_WIND; it fills and empties over a second.
    const want = THREE.MathUtils.smoothstep(u, 0.8, FULL_WIND);
    this.lift += (want - this.lift) * Math.min(1, dt * 1.5);
    const limp = 1 - this.lift;
    // Droop at the hoop, sag down the tail; flutter grows with the wind and runs down the cloth.
    this.joints[0].rotation.z = -limp * 1.25;
    const freq = 3 + u * 0.9, amp = 0.04 + 0.12 * this.lift;
    for (let i = 0; i < this.joints.length; i++) {
      const j = this.joints[i], ph = t * freq - i * 1.1;
      if (i > 0) j.rotation.z = -limp * 0.12 + Math.sin(ph * 0.7) * amp * 0.5;
      j.rotation.y = Math.sin(ph) * amp * (0.4 + i * 0.3);
    }
  }
}
