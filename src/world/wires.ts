// Draws the power lines (shared/wires.ts): a sagging black cable from socket to socket, and while one is being strung
// (src/wiring.ts) a loose one from the first socket to where you look: the cable's colour while it would go up, red when
// it wouldn't reach.
import * as THREE from 'three/webgpu';
import { placed } from '../../shared/placed.ts';
import { socketAt, wirePoints, type Wire } from '../../shared/wires.ts';

/** Cable radius (m). */
const R = 0.014;

type P = { x: number; y: number; z: number };

export class WireView {
  private group = new THREE.Group();
  private shown = new Map<number, { key: string; mesh: THREE.Mesh }>();
  private cable = new THREE.MeshStandardNodeMaterial({ color: 0x1c1a18, roughness: 0.55, metalness: 0.1 });
  private bad = new THREE.MeshStandardNodeMaterial({ color: 0xd2462c, roughness: 0.6, emissive: 0x401008 });
  private ghost: THREE.Mesh | null = null;
  private ghostKey = '';

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  /** Match the drawn wires to the list (call when the wires or the placed things change). */
  sync(list: Wire[]) {
    const ids = new Set(list.map((w) => w.id));
    for (const [id, s] of this.shown) {
      if (ids.has(id)) continue;
      this.drop(s.mesh);
      this.shown.delete(id);
    }
    for (const w of list) {
      const a = placed.find((p) => p.id === w.a), b = placed.find((p) => p.id === w.b);
      if (!a || !b) continue;
      const sa = socketAt(a), sb = socketAt(b);
      const key = [sa.x, sa.y, sa.z, sb.x, sb.y, sb.z].join();
      const s = this.shown.get(w.id);
      if (s?.key === key) continue;
      if (s) this.drop(s.mesh);
      const mesh = this.tube(sa, sb, this.cable);
      this.group.add(mesh);
      this.shown.set(w.id, { key, mesh });
    }
  }

  /** The wire being strung: from `a` to `b`, red if it won't go (`ok` false); null hides it. */
  preview(a: P | null, b: P | null, ok: boolean) {
    // Rebuilt only when it moved (a centimetre) or changed colour.
    const key = a && b ? [a.x, a.y, a.z, b.x, b.y, b.z].map((v) => Math.round(v * 100)).join() + ok : '';
    if (key === this.ghostKey) return;
    this.ghostKey = key;
    if (this.ghost) this.drop(this.ghost);
    this.ghost = null;
    if (!a || !b) return;
    this.ghost = this.tube(a, b, ok ? this.cable : this.bad);
    this.group.add(this.ghost);
  }

  private tube(a: P, b: P, mat: THREE.Material) {
    const pts = wirePoints(a, b, 20).map((p) => new THREE.Vector3(p.x, p.y, p.z));
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, R, 5, false), mat);
    mesh.castShadow = false;
    return mesh;
  }

  private drop(mesh: THREE.Mesh) {
    this.group.remove(mesh);
    mesh.geometry.dispose();
  }
}
