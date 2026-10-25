"""Inventory icons for the items that have no Blender model of their own (docs/icons.md): the base materials (scrap,
cloth), and the things modelled in code (the wrench, src/models/wrench.ts; the carried crash-site machines,
src/teardown/junk.ts), flattened to triangles by tools/icons/dump.mjs first.

    node tools/icons/dump.mjs                                  # writes tools/icons/out/code-models.json
    blender -b --python tools/blender/icons.py                 # all of them
    blender -b --python tools/blender/icons.py -- --kind wrench  # one (repeatable)

Writes public/icons/items/<kind>.png at the item's grid shape, with the camera, lights and outline of every other
icon (items.py setup_render / render_grid_icon). Only icons: no models are exported.
"""

import argparse
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import items as it  # noqa: E402  (helpers only; items.py runs nothing on import)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DUMP = os.path.join(ROOT, 'tools', 'icons', 'out', 'code-models.json')

MATERIALS = {
    'canvas': (0xb89a6a, 0.0, 0.9, 0),
    'canvas_dark': (0x8a7048, 0.0, 0.9, 0),
    'cord': (0x5a3a1e, 0.0, 0.8, 0),
}


# ------------------------------------------------------------------------------------------------ scrap

def build_scrap(mb, rng):
    """A little heap of junk: a dented, rusted sheet bent up at one end, a length of pipe and a flat bar across it, and a
    broken cog leaning on top."""
    sheet = mb.box((0.2, 0.15, 0.008), (0, 0, 0.012), 'rust', rot=(0.0, -0.12, 0.25), cuts=5)
    mb.dent(sheet, (0.03, 0.02, 0.02), 0.07, 0.016)
    for v in sheet:
        if v.co.x < -0.04:
            v.co.z += (-0.04 - v.co.x) * 0.9
    mb.jitter(sheet, rng, 0.002)
    pipe = mb.cyl(0.018, 0.018, 0.2, 10, (0.0, -0.05, 0.03), 'paint_faded_blue', rot=(0, math.pi / 2, -0.5))
    mb.jitter(pipe, rng, 0.0012)
    bar = mb.box((0.22, 0.03, 0.01), (0.01, 0.04, 0.05), 'steel_dull', rot=(0.0, 0.2, 0.7), cuts=3)
    mb.jitter(bar, rng, 0.002)
    N, RP = 12, 0.045
    m = 2 * RP / N
    outer = it.gear_outline(N, RP + m, RP, RP - 1.25 * m, broken=(2, 3, 8), worn=0.001)
    inner = [(0.013 * math.cos(math.atan2(y, x)), 0.013 * math.sin(math.atan2(y, x))) for x, y in outer]
    mb.ring_prism(outer, inner, -0.009, 0.009, 'rust_dark', loc=(0.045, 0.0, 0.07), rot=(1.1, 0.0, 0.7))
    mb.cyl(0.014, 0.014, 0.024, 10, (0.045, 0.0, 0.07), 'steel_dull', rot=(1.1, 0.0, 0.7))
    mb.blob(0.008, (-0.06, 0.05, 0.03), 'corrosion')


# ------------------------------------------------------------------------------------------------ cloth

def build_cloth(mb, rng):
    """A folded tarp, three layers stacked a little askew, tied round the middle with a cord and a knot on top."""
    for i, (sx, sy, rz) in enumerate(((0.22, 0.15, 0.0), (0.21, 0.145, 0.05), (0.2, 0.14, -0.04))):
        mat = 'canvas' if i % 2 == 0 else 'canvas_dark'
        layer = mb.box((sx, sy, 0.024), (0, 0, 0.012 + i * 0.022), mat, rot=(0, 0, rz), cuts=2)
        mb.jitter(layer, rng, 0.002)
    top = 0.012 + 2 * 0.022 + 0.012
    # The cord round the bundle: a flat loop the bundle's height, and the knot's two ears.
    mb.box((0.012, 0.16, top + 0.006), (0, 0, top / 2), 'cord')
    mb.box((0.012, 0.012, 0.004), (0, 0, top + 0.002), 'cord')
    for s in (-1, 1):
        mb.torus(0.012, 0.0035, 10, 6, (s * 0.013, 0, top + 0.008), 'cord', rot=(math.pi / 2, 0, s * 0.5))


BUILT = {'scrap': (build_scrap, (1, 1)), 'cloth': (build_cloth, (1, 1))}

# ------------------------------------------------------------------------------------------- code models

# kind: (grid cells, pose (Euler, rad) applied to the dumped model, already turned Z-up).
CODE = {
    # The wrench (held model: handle up along Z, flat across X) turned face-on to the camera, jaw up and right.
    'wrench': ((1, 1), 'face'),
    'robot_arm': ((2, 2), (0, 0, 0)),
    'control_cabinet': ((2, 3), (math.pi / 2, 0, 0)),  # stood up, its door to the front
    'winch': ((3, 2), (0, 0, 0)),
    'solenoid_valve': ((3, 2), (0, 0, 0)),
    'beacon': ((2, 2), (0, 0, 0)),
}


def code_mesh(kind, d):
    """A mesh from the dump: glTF-style Y-up triangles to Blender's Z-up, one material per flat colour."""
    mesh = bpy.data.meshes.new(kind)
    t = d['tris']
    verts = [(t[i], -t[i + 2], t[i + 1]) for i in range(0, len(t), 3)]
    faces = [(3 * f, 3 * f + 1, 3 * f + 2) for f in range(len(d['mat']))]
    mesh.from_pydata(verts, [], faces)
    for i, m in enumerate(d['mats']):
        mesh.materials.append(it.make_material(f'{kind}_{i}', m['color'], m['metal'], m['rough'], 2 if m['emit'] else 0))
    for p, mi in zip(mesh.polygons, d['mat']):
        p.material_index = mi
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(kind, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def face_on(tilt, turn=math.radians(35)):
    """Turns a flat thing (its face along X, its length along Z) to face the icon camera, turned `turn` away about its
    length so it shows some depth, its length tipped `tilt` from the screen's up."""
    d = it.CAM_DIR
    up = (Vector((0, 0, 1)) - d * d.z).normalized()
    right = up.cross(d)
    length = up * math.cos(tilt) + right * math.sin(tilt)
    side = length.cross(d)
    face = d * math.cos(turn) + side * math.sin(turn)
    return Matrix((face, length.cross(face), length)).transposed().to_euler()


def build(kind, fn, seed):
    mb = it.MeshBuilder()
    fn(mb, it.Rng(seed))
    bmesh.ops.recalc_face_normals(mb.bm, faces=mb.bm.faces)
    mesh = bpy.data.meshes.new(kind)
    mb.bm.to_mesh(mesh)
    mb.bm.free()
    for m in mb.mats:
        mesh.materials.append(bpy.data.materials[m])
    obj = bpy.data.objects.new(kind, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--kind', choices=list(BUILT) + list(CODE), action='append')
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'icons', 'items'))
    args = ap.parse_args(argv)
    kinds = args.kind or list(BUILT) + list(CODE)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, spec in {**it.MATERIALS, **MATERIALS}.items():
        it.make_material(name, *spec)
    dump = None
    if any(k in CODE for k in kinds):
        if not os.path.exists(DUMP):
            sys.exit(f'{DUMP} missing: run node tools/icons/dump.mjs first')
        with open(DUMP) as f:
            dump = json.load(f)

    cam = it.setup_render(bpy.context.scene, 128, 128)
    for i, kind in enumerate(kinds):
        if kind in BUILT:
            fn, cells = BUILT[kind]
            obj = build(kind, fn, i + 1)
        else:
            cells, pose = CODE[kind]
            obj = code_mesh(kind, dump[kind])
            obj.rotation_euler = face_on(math.radians(40)) if pose == 'face' else Euler(pose)
        it.render_grid_icon(cam, [obj], cells, os.path.join(args.out, kind + '.png'))
        print(f'{kind}: {it.tri_count(obj)} tris, {cells[0]}x{cells[1]} cells')


main()
