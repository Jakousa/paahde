// Machines built from a Blender model (tools/blender/machines/<model>.py, layout in shared/machines/<kind>.ts).
// The steps, covers and part mounts come from the layout and are built at once (the markers and fasteners are the same Kit
// pieces the code-built machines use, only smaller); the model's meshes arrive when the file has loaded: `Shell` and `Dress`
// stay for good, each `Mod_<id>` is a module that falls away when its steps are done and leaves the parts inside.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { machineModules } from '../../shared/machine.ts';
import { layoutOf, type LayoutStep } from '../../shared/machines.ts';
import { junkSpec, TIERS, type JunkKind, type PartId } from '../../shared/salvage.ts';
import { TEXT } from '../../shared/text.ts';
import { mergePart } from '../world/bossParts.ts';
import { Kit, type Junk, type Piece, type Step, type Target, type V } from './junk.ts';

const loader = new GLTFLoader();
const cache = new Map<string, Promise<Map<string, THREE.Object3D>>>();

/** The model's nodes by name, each merged into one lit mesh (src/world/bossParts.ts mergePart). */
function loadModel(model: string): Promise<Map<string, THREE.Object3D>> {
  let p = cache.get(model);
  if (!p) {
    p = loader.loadAsync(`./models/machines/${model}.glb`).then((gltf) => {
      const out = new Map<string, THREE.Object3D>();
      for (const node of [...gltf.scene.children]) out.set(node.name, mergePart(node));
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
  const pieces: { piece: Piece; group: THREE.Group; id: string }[] = [];
  const labels = TEXT.steps as Record<string, string>;

  const make = (ls: LayoutStep, after: Step[]): Step => {
    const label = labels[ls.label] ?? ls.label;
    const pos = (ls.pos ?? [0, 0, 0]) as V, nrm = (ls.nrm ?? [0, 1, 0]) as V;
    switch (ls.kind) {
      case 'screw': return kit.screw(label, pos, nrm, after, ls.need ?? 2);
      case 'bolt': return kit.bolt(label, pos, nrm, after, ls.need ?? 2);
      case 'clip': return kit.clip(label, pos, nrm, ls.need ?? 1, after);
      case 'pry': return kit.pry(label, pos, nrm, after);
      case 'lift': return kit.lift(label, pos, nrm, ls.players ?? 1, after, ls.need ?? 3);
      case 'wire': return kit.wire(label, (ls.pts ?? []) as V[], (ls.key ?? 'black') as 'black', after, ls.r);
    }
  };

  for (const { mod, parts } of mods) {
    const mine: { ls: LayoutStep; step: Step }[] = [];
    for (const ls of mod.steps) {
      // what must be done first: a step id, a module (all its steps), or a label within this module; a module that is gone counts as done
      const after = new Set<Step>();
      for (const e of ls.after) {
        const s = byId.get(e);
        if (s) after.add(s);
        else if (ofModule.has(e)) for (const x of ofModule.get(e)!) after.add(x);
        else for (const o of mine) if (o.ls.label === e) after.add(o.step);
      }
      const step = make(ls, [...after]);
      mine.push({ ls, step });
      byId.set(ls.id, step);
    }
    const holds = mine.map((o) => o.step);
    ofModule.set(mod.id, holds);

    const group = new THREE.Group();
    kit.g.add(group);
    pieces.push({ piece: kit.cover(group, holds, mod.pop as V, 0.3), group, id: mod.id });

    for (const p of parts) {
      const slot = kit.part(p.part, { tier: p.tier, index: p.index }, [0, 0, 0], holds);
      const holder = slot.piece.obj;
      holder.scale.setScalar(PART_SCALE);
      holder.quaternion.set(p.at.quat[0], p.at.quat[1], p.at.quat[2], p.at.quat[3]);
      const mid = new THREE.Vector3(0, PART_MID * PART_SCALE, 0).applyQuaternion(holder.quaternion);
      holder.position.set(p.at.pos[0] - mid.x, p.at.pos[1] - mid.y, p.at.pos[2] - mid.z);
    }
  }
  kit.slots.sort((a, b) => a.index - b.index);

  loadModel(layout.model).then(
    (nodes) => {
      const stay = (name: string) => {
        const n = nodes.get(name);
        if (!n) return;
        const c = n.clone(true);
        c.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
        kit.g.add(c);
      };
      stay('Shell');
      stay('Dress');
      for (const { piece, group, id } of pieces) {
        const n = nodes.get(`Mod_${id}`);
        if (!n) continue;
        const inner = n.clone(true);
        inner.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
        const box = new THREE.Box3().setFromObject(inner);
        if (box.isEmpty()) continue;
        // the module falls about its own middle
        const c = box.getCenter(new THREE.Vector3());
        inner.position.sub(c);
        group.position.copy(c);
        group.add(inner);
        piece.floorY = c.y - box.min.y;
      }
    },
    (e) => console.warn('teardown: machine model failed', layout.model, e),
  );

  const root = new THREE.Group();
  root.add(kit.g);
  const junk: Junk = {
    kind, label: junkSpec(kind).label, tier: TIERS[best], root, scale: 1,
    steps: kit.steps, pieces: kit.pieces, slots: kit.slots, fixed: true,
  };
  root.userData.target = { type: 'junk', junk } satisfies Target;
  return junk;
}
