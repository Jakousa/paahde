// Machines built from a Blender model (tools/blender/machines/<model>.py, layout in shared/machines/<kind>.ts).
// The steps, covers and part mounts come from the layout and are built at once (the markers and fasteners are the same Kit
// pieces the code-built machines use, only smaller); the model's meshes arrive when the file has loaded: `Shell`
// stay for good, each `Mod_<id>` is a module that falls away when its steps are done and leaves the parts inside.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { machineModules } from '../../shared/machine.ts';
import { layoutOf, type LayoutStep } from '../../shared/machines.ts';
import { junkSpec, TIERS, type JunkKind, type PartId } from '../../shared/salvage.ts';
import { TEXT } from '../../shared/text.ts';
import { mergePart } from '../world/bossParts.ts';
import { Kit, settle, type Junk, type Shine, type Piece, type Slot, type Step, type Target, type V } from './junk.ts';

const loader = new GLTFLoader();
let twoSided: THREE.MeshStandardNodeMaterial | null = null;
const cache = new Map<string, Promise<Map<string, THREE.Object3D>>>();

/** The model's nodes by name, each merged into one lit mesh (src/world/bossParts.ts mergePart). */
function loadModel(model: string): Promise<Map<string, THREE.Object3D>> {
  let p = cache.get(model);
  if (!p) {
    p = loader.loadAsync(`./models/machines/${model}.glb`).then((gltf) => {
      const out = new Map<string, THREE.Object3D>();
      for (const node of [...gltf.scene.children]) {
        const merged = mergePart(node);
        // thin shells are seen from both sides
        merged.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh || !(m.material instanceof THREE.MeshStandardNodeMaterial)) return;
          if (!twoSided) {
            twoSided = m.material.clone();
            twoSided.side = THREE.DoubleSide;
          }
          m.material = twoSided;
        });
        out.set(node.name, merged);
      }
      return out;
    });
    cache.set(model, p);
  }
  return p;
}

/** Size of the fasteners and terminals on a full-size model. */
const FASTENER = 0.6;
/** Parts shown at this fraction of their usual size: they sit inside things measured in metres. */
const PART_SCALE = 0.4;
/** How far (before PART_SCALE) a part's centre is above its base. */
const PART_MID = 0.15;

const emptyRolls = (): Record<PartId, { tier: (typeof TIERS)[number]; index: number }[]> =>
  ({ battery: [], motor: [], heatsink: [], compute: [], uranium: [], coil: [], impeller: [], bearing: [], gear: [], valve: [], relay: [] });

export function buildModelJunk(kind: JunkKind, seed: number, level: number): Junk {
  const layout = layoutOf(kind)!;
  const mods = machineModules(kind, seed, level);
  let best = 0;
  for (const m of mods) for (const p of m.parts) best = Math.max(best, TIERS.indexOf(p.tier));
  const kit = new Kit(best, emptyRolls());
  kit.fs = FASTENER;

  const byId = new Map<string, Step>();
  const ofModule = new Map<string, Step[]>();
  const pieces: { piece: Piece; group: THREE.Group; frame: THREE.Group; id: string; shiny: Step[] }[] = [];
  const labels = TEXT.steps as Record<string, string>;
  let lying = 0;

  const make = (ls: LayoutStep, after: Step[], slide: { group: THREE.Group; pop: number[] }): Step => {
    const label = labels[ls.label] ?? ls.label;
    const pos = (ls.pos ?? [0, 0, 0]) as V, nrm = (ls.nrm ?? [0, 1, 0]) as V;
    switch (ls.kind) {
      case 'screw': return kit.screw(label, pos, nrm, after, ls.need ?? 2);
      case 'bolt': return kit.bolt(label, pos, nrm, after, ls.need ?? 2);
      case 'clip': return kit.clip(label, pos, nrm, ls.need ?? 1, after);
      case 'pry': return kit.pry(label, pos, nrm, after);
      case 'lift': {
        // the indicator points the way it comes out, the way the module slides
        const dir = new THREE.Vector3(...(slide.pop as V)).normalize();
        return kit.pull(label, pos, dir.toArray() as V, after, Math.max(6, Math.round((ls.need ?? 3) * 3)), { obj: slide.group, dir, dist: 0.45 });
      }
      case 'grind': return kit.grind(label, (ls.pts ?? []) as V[], after);
      case 'mash': return kit.mash(label, (ls.pts ?? []) as V[], after, ls.need ?? 10, slide.group, { dir: new THREE.Vector3(...(slide.pop as V)).normalize(), dist: 0.14 });
      case 'wire': return kit.wire(label, (ls.pts ?? []) as V[], (ls.key ?? 'black') as 'black', after, ls.r);
    }
  };

  for (const { mod, parts } of mods) {
    // The module's own group moves as it is pulled and falls when it comes off; `frame` holds everything that goes with it
    // (its model, and the inner steps and parts), at the machine's coordinates until the model has arrived.
    const group = new THREE.Group();
    const frame = new THREE.Group();
    group.add(frame);
    kit.g.add(group);
    const outer: Step[] = [], inner: Step[] = [];
    const mine: { ls: LayoutStep; step: Step }[] = [];
    for (const ls of mod.steps) {
      if (ls.with && !ls.with.every((id) => mods.some((m) => m.mod.id === id))) continue; // joins something that is not there
      // what must be done first: a step id, a module (all its steps), or a label within this module; a module that is gone counts as done
      const after = new Set<Step>();
      for (const e of ls.after) {
        const s = byId.get(e);
        if (s) after.add(s);
        else if (ofModule.has(e)) for (const x of ofModule.get(e)!) after.add(x);
        else for (const o of mine) if (o.ls.label === e) after.add(o.step);
      }
      if (ls.inner) for (const o of outer) after.add(o);
      const step = make(ls, [...after], { group, pop: mod.pop });
      mine.push({ ls, step });
      byId.set(ls.id, step);
      (ls.inner ? inner : outer).push(step);
    }
    ofModule.set(mod.id, [...outer, ...inner]);

    const piece = kit.cover(group, outer, mod.pop as V, 0.3);
    const ownedSlots: Slot[] = [];
    if (inner.length || parts.some((p) => p.at.inner)) {
      // it lies where it fell, by the machine, to be taken apart further
      const ang = 0.7 + lying * 2.4, r = 2.5 + (lying % 2) * 0.9;
      lying++;
      piece.inner = { steps: inner, slots: ownedSlots, rest: new THREE.Vector2(Math.cos(ang) * r, Math.sin(ang) * r), resting: false, loaded: false, gone: false };
      for (const s of inner) {
        s.owner = piece;
        frame.add(s.obj);
      }
    }
    pieces.push({ piece, group, frame, id: mod.id, shiny: [...outer, ...inner].filter((s) => s.kind === 'lift' || s.kind === 'mash') });

    for (const p of parts) {
      const innerPart = !!p.at.inner && inner.length > 0;
      const slot = kit.part(p.part, { tier: p.tier, index: p.index }, [0, 0, 0], innerPart ? inner : outer);
      const holder = slot.piece.obj;
      holder.scale.setScalar(PART_SCALE);
      holder.quaternion.set(p.at.quat[0], p.at.quat[1], p.at.quat[2], p.at.quat[3]);
      const mid = new THREE.Vector3(0, PART_MID * PART_SCALE, 0).applyQuaternion(holder.quaternion);
      holder.position.set(p.at.pos[0] - mid.x, p.at.pos[1] - mid.y, p.at.pos[2] - mid.z);
      if (innerPart) {
        slot.owner = piece;
        ownedSlots.push(slot);
        frame.add(holder);
      }
    }
  }
  kit.slots.sort((a, b) => a.index - b.index);

  loadModel(layout.model).then(
    (nodes) => {
      const shell = nodes.get('Shell')?.clone(true);
      if (shell) {
        shell.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
        kit.g.add(shell);
      }
      for (const { piece, group, frame, id, shiny } of pieces) {
        const n = nodes.get(`Mod_${id}`);
        if (!n) continue;
        const mesh = n.clone(true);
        mesh.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
        // a part that is pulled or prised takes the sheen itself
        if (shiny.length) {
          const own: Shine[] = [];
          mesh.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh && m.material instanceof THREE.MeshStandardNodeMaterial) own.push({ mesh: m, plain: m.material, on: false });
          });
          for (const s of shiny) s.shine.push(...own);
        }
        const box = new THREE.Box3().setFromObject(mesh);
        if (box.isEmpty()) continue;
        frame.add(mesh);
        // the module falls and lies about its own middle
        const c = box.getCenter(new THREE.Vector3());
        piece.floorY = c.y - box.min.y;
        frame.position.copy(c).negate();
        group.position.add(c);
        const inn = piece.inner;
        if (inn) {
          inn.loaded = true;
          if (inn.resting) group.position.set(inn.rest.x, piece.floorY, inn.rest.y);
        }
      }
    },
    (e) => console.warn('teardown: machine model failed', layout.model, e),
  ).then(() => {
    // the model arrived and moved things under a root that may no longer be walked every frame
    if (!root.matrixAutoUpdate && root.parent) settle(root);
  });

  const root = new THREE.Group();
  root.add(kit.g);
  const junk: Junk = {
    kind, label: junkSpec(kind).label, tier: TIERS[best], root, scale: 1,
    steps: kit.steps, pieces: kit.pieces, slots: kit.slots, fixed: true,
  };
  root.userData.target = { type: 'junk', junk } satisfies Target;
  return junk;
}
