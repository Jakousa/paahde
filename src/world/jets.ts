// Fixed-wing drones (shared/jets.ts): a long-winged unmanned plane built from primitives: a slim fuselage with a
// sensor-domed nose, an intake hump over the back feeding a jet nozzle at the tail, straight tapered wings and a V
// tail. Dark and unlit (no lamps, by day or night). Placed every frame from the flight list and the server clock,
// rolled into its turns.
import * as THREE from 'three/webgpu';
import { JET_SPAN, jetAt, type Jet, type JetPose } from '../../shared/jets.ts';

/** Hidden past this distance (m) from the camera. */
const SHOW_R = 5000;

/** A flat trapezoid in the XZ plane (thickness `t`, along -Y..+Y), from x = 0 (root chord `root`, its leading edge
 *  at z = 0) to x = `len` (tip chord `tip`, leading edge swept back `sweep`). */
function panel(len: number, root: number, tip: number, sweep: number, t: number) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(len, -sweep);
  s.lineTo(len, -sweep - tip);
  s.lineTo(0, -root);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false });
  g.translate(0, 0, -t / 2);
  g.rotateX(Math.PI / 2); // shape y → -z: the trailing edge points backwards (-Z), forward is +Z
  return g;
}

function build(): THREE.Group {
  const k = JET_SPAN / 18; // modelled for an 18 m span
  // Double sided: the left wing and fin are the right ones mirrored (negative scale).
  const hull = new THREE.MeshStandardNodeMaterial({ color: 0x3a332d, roughness: 0.55, metalness: 0.5, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardNodeMaterial({ color: 0x15110f, roughness: 0.4, metalness: 0.7, side: THREE.DoubleSide });
  const dome = new THREE.MeshStandardNodeMaterial({ color: 0x0c0b0b, roughness: 0.15, metalness: 0.2 });
  const g = new THREE.Group();

  // Fuselage: a lathe along +Z, nose at +5.6, tail at -5.4, thickest just behind the nose.
  const prof: [number, number][] = [[0, -5.4], [0.32, -5.3], [0.42, -4.6], [0.55, -2], [0.68, 0.8], [0.72, 2.6], [0.62, 4.2], [0.42, 5.1], [0.12, 5.55], [0, 5.6]];
  const body = new THREE.LatheGeometry(prof.map(([r, z]) => new THREE.Vector2(r, z)), 20);
  body.rotateX(Math.PI / 2);
  g.add(new THREE.Mesh(body, hull));
  // A sensor dome under the nose.
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.32, 14, 10), dome);
  ball.position.set(0, -0.6, 3.9);
  g.add(ball);
  // Intake hump over the back, ending in the nozzle at the tail.
  const hump = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.48, 4.6, 16), hull);
  hump.rotation.x = Math.PI / 2;
  hump.scale.set(1, 1, 0.7);
  hump.position.set(0, 0.58, -2.4);
  g.add(hump);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.07, 8, 18), dark);
  lip.position.set(0, 0.58, -0.1);
  lip.scale.set(1, 0.7, 1);
  g.add(lip);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 1.1, 16, 1, true), dark);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.set(0, 0.5, -5.1);
  g.add(nozzle);

  // Wings: straight, long and thin, a little dihedral.
  for (const side of [1, -1]) {
    const w = new THREE.Mesh(panel(8.6, 1.9, 0.75, 0.35, 0.16), hull);
    w.position.set(side * 0.4, 0.15, 0.9);
    w.scale.x = side;
    w.rotation.z = side * 0.04;
    g.add(w);
    // V tail: two fins canted 40° out from vertical.
    const f = new THREE.Mesh(panel(2.4, 1.3, 0.6, 0.6, 0.1), hull);
    f.position.set(0, 0.2, -4.0);
    f.rotation.z = side * (Math.PI / 2 - 0.7);
    f.scale.x = side;
    g.add(f);
  }
  g.scale.setScalar(k);
  return g;
}

export class Jets {
  private views = new Map<number, THREE.Object3D>();
  private pose: JetPose = { x: 0, y: 0, z: 0, yaw: 0, bank: 0, vx: 0, vz: 0 };
  private proto: THREE.Group | null = null;
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Every frame: the flights and the server time (ms); `eye` the camera. */
  update(jets: Jet[], t: number, eye: { x: number; z: number }) {
    const seen = new Set<number>();
    for (const j of jets) {
      const p = this.pose;
      if (!jetAt(j, t, p) || Math.hypot(p.x - eye.x, p.z - eye.z) > SHOW_R) continue;
      seen.add(j.id);
      let v = this.views.get(j.id);
      if (!v) {
        this.proto ??= build();
        v = this.proto.clone();
        v.rotation.order = 'YXZ';
        this.scene.add(v);
        this.views.set(j.id, v);
      }
      v.position.set(p.x, p.y, p.z);
      v.rotation.y = p.yaw;
      // Bank is + turning towards +yaw (to the left, facing +Z): the left wing (+X) goes down.
      v.rotation.z = -p.bank;
    }
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      this.scene.remove(v);
      this.views.delete(id);
    }
  }
}
