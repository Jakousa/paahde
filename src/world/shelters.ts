// The shelters (shared/shelters.ts): small empty bunkers out in the desert. Built here from concrete boxes with the
// same layout the physics collides with, one merged geometry per kind and material, shared by every shelter of that
// kind; those within DRAW_R of the camera are in the scene.
//
// Like the base (src/world/base.ts) the sand stays on top as the roof, and the hut's floor is cut out of it: the
// HOLES nearest shelters' huts go to the sand's mask (outsideTerrainHoles). Indoors only the sun (through the door,
// shadowed) and a dim fill in the nearest shelter's room light the concrete, and a faint glow keeps it from black.
import * as THREE from 'three/webgpu';
import { lights, uniform } from 'three/tsl';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  S_HALL_H, S_HUT, S_STAIRS, S_W, S_WT, SHELTER_KINDS, sheltersNear, shelterHole, stairCeiling, type Shelter, type ShelterKind,
  type ShelterLayout,
} from '../../shared/shelters.ts';
import { moonColor, sunColor, sunDirection, sunLight } from './env.ts';

/** Shelters this close to the camera are drawn (m); dropped again past DROP_R. */
const DRAW_R = 900, DROP_R = 1000;
/** How many shelters' hut floors are cut out of the sand (the nearest ones). */
export const HOLES = 4;
/** Holes in the sand over the nearest shelters' huts (world x0, z0, x1, z1); unused slots are far away. */
export const shelterHoles = Array.from({ length: HOLES }, () => uniform(new THREE.Vector4(1e9, 1e9, 1e9, 1e9)));
/** The room's fill light: intensity at full daylight and at night, reach (m). */
const FILL = { day: 2, night: 0.2, distance: 16 };
/** Never quite dark: emissive fraction of each indoor surface's own colour. */
const GLOW = 0.04;
/** The fill's colour is half this, half the daylight's. */
const FILL_COLOR = new THREE.Color(0xd8dce4);

type Mat = 'hut' | 'trim' | 'steel' | 'wall' | 'floor' | 'beam';
const MATS: Mat[] = ['hut', 'trim', 'steel', 'wall', 'floor', 'beam'];
type Box = [number, number, number, number, number, number]; // x0, x1, y0, y1, z0, z1

/** The boxes a kind is built from, by material (local frame, see shared/shelters.ts). */
function kindBoxes(L: ShelterLayout): Record<Mat, Box[]> {
  const out: Record<Mat, Box[]> = { hut: [], trim: [], steel: [], wall: [], floor: [], beam: [] };
  const { z0, z1, h, door, t, top } = S_HUT, W = S_W, WT = S_WT, F = L.floor;
  const run = S_STAIRS.run, rise = S_STAIRS.rise, sz = S_STAIRS.z, bottom = sz - L.steps * run;
  const mirror = (m: Mat, x0: number, x1: number, y0: number, y1: number, za: number, zb: number) => {
    out[m].push([x0, x1, y0, y1, za, zb], [-x1, -x0, y0, y1, za, zb]);
  };
  // The hut: thick walls, a doorway in front, the back wall down to the stairwell's ceiling, a roof slab.
  mirror('hut', W, W + t, -0.4, h, z0 - t, z1 + t);
  mirror('hut', door, W, -0.4, h, z1, z1 + t);
  out.hut.push([-W, W, stairCeiling(L, z0 - 0.01), h, z0 - t, z0]);
  out.hut.push([-W - t - 0.08, W + t + 0.08, h, top, z0 - t - 0.08, z1 + t + 0.08]);
  // Lined with indoor concrete, so the sky's fill doesn't light its inside like the outside.
  const e = 0.01;
  mirror('wall', W - e, W, -0.4, h, z0, z1);
  mirror('wall', door, W, -0.4, h, z1 - e, z1);
  out.wall.push([-W, W, stairCeiling(L, z0 - 0.01), h, z0, z0 + e]);
  out.wall.push([-W, W, h - e, h, z0, z1]);
  // A darker plinth round its foot.
  const o = 0.03, p = 0.3;
  mirror('trim', W + t, W + t + o, -0.4, p, z0 - t - o, z1 + t + o);
  out.trim.push([-W - t - o, W + t + o, -0.4, p, z0 - t - o, z0 - t]);
  mirror('trim', door, W + t + o, -0.4, p, z1 + t, z1 + t + o);
  // Steel frame round the doorway.
  mirror('steel', door, door + 0.1, 0, h, z1 + t, z1 + t + 0.05);
  out.steel.push([-door - 0.1, door + 0.1, h - 0.1, h, z1 + t, z1 + t + 0.05]);
  // Landing and steps.
  out.floor.push([-W, W, -0.3, 0, sz, z1 + t]);
  for (let i = 0; i < L.steps; i++) out.floor.push([-W, W, F - 0.3, -(i + 1) * rise, sz - (i + 1) * run, sz - i * run]);
  // Stairwell and corridor: side walls under the hut's, the stepped ceiling behind the hut, the corridor.
  mirror('wall', W, W + WT, F - 0.3, -0.4, L.hall + WT, z1 + t);
  let za = z0;
  while (za > bottom) {
    const c = stairCeiling(L, za - 0.01);
    let zb = za - run;
    while (zb > bottom && stairCeiling(L, zb - 0.01) === c) zb -= run;
    zb = Math.max(zb, bottom);
    out.wall.push([-W - WT, W + WT, c, c + 0.35, zb, za]);
    za = zb;
  }
  if (bottom > L.hall) {
    out.floor.push([-W - WT, W + WT, F - 0.3, F, L.hall, bottom]);
    out.wall.push([-W - WT, W + WT, F + S_HALL_H, F + S_HALL_H + 0.35, L.hall, bottom]);
  }
  // The room: floor, walls, the opening onto the corridor, ceiling with beams across it.
  const { w, z: rz, h: rh } = L.room;
  out.floor.push([-w - WT, w + WT, F - 0.3, F, rz - WT, L.hall]);
  out.wall.push([-w - WT, w + WT, F - 0.3, F + rh + 0.35, rz - WT, rz]);
  mirror('wall', w, w + WT, F - 0.3, F + rh + 0.35, rz - WT, L.hall + WT);
  mirror('wall', W, w, F - 0.3, F + rh + 0.35, L.hall, L.hall + WT);
  if (rh > S_HALL_H) out.wall.push([-W, W, F + S_HALL_H, F + rh, L.hall, L.hall + WT]);
  out.wall.push([-w - WT, w + WT, F + rh, F + rh + 0.35, rz - WT, L.hall + WT]);
  const beams = Math.max(1, Math.round((L.hall - rz) / 3.2) - 1);
  for (let i = 1; i <= beams; i++) {
    const bz = L.hall + ((rz - L.hall) * i) / (beams + 1);
    out.beam.push([-w, w, F + rh - 0.3, F + rh, bz - 0.15, bz + 0.15]);
  }
  return out;
}

function boxGeometry(boxes: Box[]): THREE.BufferGeometry | null {
  if (!boxes.length) return null;
  return mergeGeometries(boxes.map(([x0, x1, y0, y1, z0, z1]) =>
    new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)));
}

export class Shelters {
  private group = new THREE.Group();
  private fill = new THREE.PointLight(0xd8dce4, 0, FILL.distance, 1);
  private lit = lights([sunLight, this.fill]);
  private geos = new Map<ShelterKind, [Mat, THREE.BufferGeometry][]>();
  private mats: Record<Mat, THREE.Material>;
  private shown = new Map<number, THREE.Group>();
  private tint = new THREE.Color();
  private nearest: Shelter[] = [];
  private lastScan = new THREE.Vector3(Infinity, 0, 0);

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    const mat = (hex: number, roughness: number, metalness: number, indoor: boolean) => {
      const m = new THREE.MeshStandardNodeMaterial({ color: hex, roughness, metalness });
      if (indoor) {
        m.lightsNode = this.lit;
        m.emissive.copy(m.color).multiplyScalar(GLOW);
      }
      // Cast from both sides: the shadow pass draws back faces, and the sun must not leak down the stairwell.
      m.shadowSide = THREE.DoubleSide;
      return m;
    };
    // Colours from tools/blender/base/bunker.py (Bunker, BunkerDark, Steel, Concrete, ConcreteDark).
    this.mats = {
      hut: mat(0xb09f86, 0.97, 0, false),
      trim: mat(0x8c7c66, 0.97, 0, false),
      steel: mat(0x5c5a56, 0.5, 0.6, false),
      wall: mat(0x9a8f80, 0.92, 0, true),
      floor: mat(0x6f675d, 0.95, 0, true),
      beam: mat(0x8c7c66, 0.97, 0, true),
    };
    for (const kind of Object.keys(SHELTER_KINDS) as ShelterKind[]) {
      const boxes = kindBoxes(SHELTER_KINDS[kind]);
      const list: [Mat, THREE.BufferGeometry][] = [];
      for (const m of MATS) {
        const g = boxGeometry(boxes[m]);
        if (g) list.push([m, g]);
      }
      this.geos.set(kind, list);
    }
  }

  private build(s: Shelter): THREE.Group {
    const g = new THREE.Group();
    for (const [m, geo] of this.geos.get(s.kind)!) {
      const mesh = new THREE.Mesh(geo, this.mats[m]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
    }
    g.position.set(s.x, s.y, s.z);
    g.rotation.y = Math.atan2(s.dx, s.dz);
    g.updateMatrixWorld(true);
    g.matrixAutoUpdate = false;
    for (const c of g.children) c.matrixAutoUpdate = false;
    return g;
  }

  update(cam: THREE.Vector3) {
    // Which shelters are near: rescanned every 20 m moved.
    if (cam.distanceToSquared(this.lastScan) > 400) {
      this.lastScan.copy(cam);
      const near = sheltersNear(cam.x, cam.z, DROP_R);
      for (const s of near) {
        if (!this.shown.has(s.id) && Math.hypot(s.x - cam.x, s.z - cam.z) < DRAW_R) {
          const g = this.build(s);
          this.shown.set(s.id, g);
          this.group.add(g);
        }
      }
      for (const [id, g] of this.shown) {
        if (near.some((s) => s.id === id)) continue;
        this.group.remove(g);
        this.shown.delete(id);
      }
      near.sort((a, b) => Math.hypot(a.x - cam.x, a.z - cam.z) - Math.hypot(b.x - cam.x, b.z - cam.z));
      this.nearest = near.slice(0, HOLES);
      for (let i = 0; i < HOLES; i++) {
        const s = this.nearest[i];
        if (s) shelterHoles[i].value.set(...shelterHole(s));
        else shelterHoles[i].value.set(1e9, 1e9, 1e9, 1e9);
      }
    }
    // The fill light sits in the nearest shelter's room and follows the daylight.
    const s = this.nearest[0];
    if (s) {
      const L = s.L, mid = (L.hall + L.room.z) / 2;
      this.fill.position.set(s.x + mid * s.dx, s.y + L.floor + L.room.h * 0.6, s.z + mid * s.dz);
      this.fill.updateMatrixWorld();
    }
    const day = THREE.MathUtils.smoothstep(sunDirection.value.y, 0.0, 0.5);
    this.tint.copy(sunColor.value).multiplyScalar(day).add(moonColor.value);
    const level = Math.max(this.tint.r, this.tint.g, this.tint.b);
    this.fill.color.copy(this.tint).multiplyScalar(level > 0 ? 1 / level : 0).lerp(FILL_COLOR, 0.5);
    this.fill.intensity = FILL.night + (FILL.day - FILL.night) * day;
  }
}
